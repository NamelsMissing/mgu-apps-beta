'use strict';
const { Diag, replyTo, NRC } = require('./tasu');
const P = require('./protocol');
const F = require('./flm-control');

// Addresses the vehicle scan may ask for their identity (BimmerLight's light-module set for
// G-series: gateway, rear light modules, body, headlamps, older footwell/rear modules).
const SCAN_ADDRESSES = Object.freeze([0x10, 0x17, 0x1A, 0x1C, 0x1E, 0x40, 0x43, 0x44, 0x72]);

class Link {
    constructor(signals, log, changed, options) {
        this.allowExperimental = (options && options.allowExperimental) || (() => false);
        this.diag = new Diag(signals, log); this.diag.quiet = true;
        this.log = log; this.changed = changed || (() => {});
        this.available = false; this.index = null; this.identifiedAt = 0;
        this.trace = []; this._busy = false;
        this.verifiedFlm = {};
    }
    async init() {
        await this.diag.init(); this.available = this.diag.available;
        this.diag.on('available', (up) => {
            this.available = !!up; this.index = null; this.identifiedAt = 0; this.verifiedFlm = {}; this.changed();
        });
        return this;
    }
    async request(sid, data, release, address) {
        address = address === undefined ? P.ADDRESS : address;
        const identityOnly = sid === 0x22 && (P.hex(data) === 'F1 50' || (address === 0x10 && P.hex(data) === '3F 06'));
        if (address !== P.ADDRESS && SCAN_ADDRESSES.indexOf(address) >= 0 && [0x43, 0x44].indexOf(address) < 0) {
            // other light-related units: identity and vehicle order only, never control
            if (!identityOnly) throw new Error('Only identity reads are allowed at 0x' + address.toString(16));
        } else if (address !== P.ADDRESS) {
            const validAddress = [0x43, 0x44].indexOf(address) >= 0;
            const readOnly = sid === 0x22 && ['F1 50', 'D9 FC'].indexOf(P.hex(data)) >= 0;
            const session = (sid === 0x10 && (P.hex(data) === '03' || P.hex(data) === '01'))
                || (sid === 0x3E && P.hex(data) === '00');
            const routine = sid === 0x31 && F.isPermittedRoutine(data);
            if (!validAddress || (!readOnly && !this.verifiedFlm[address]) || (!readOnly && !session && !routine))
                throw new Error('Unsupported FLM diagnostic request / module not identified');
        }
        if (this._busy) throw new Error('Diagnostic request already in flight');
        if (!this.available) throw new Error('No BDC diagnostic connection');
        this._busy = true;
        const record = { address, at: new Date().toISOString(), tx: P.hex([sid].concat(data)) };
        this.trace.push(record); if (this.trace.length > 80) this.trace.shift();
        const start = Date.now();
        try {
            const u = await this.diag.physical(address, sid, data, release ? 800 : 400, replyTo(sid, data), {
                maxRetries: 0, callTimeoutMs: 700, hardTimeoutMs: 1200, pendingTimeoutMs: 800,
            });
            record.ms = Date.now() - start; record.rx = u ? P.hex(u) : 'TIMEOUT';
            const controller = address === P.ADDRESS ? 'BDC' : [0x43, 0x44].indexOf(address) >= 0 ? 'FLM' : '0x' + address.toString(16).toUpperCase();
            if (!u || !u.length) throw new Error(controller + ' reply timed out');
            if (u[0] === 0x7F) throw new Error(controller + ' NRC ' + P.hex([u[2]]) + ': ' + (NRC[u[2]] || 'request refused'));
            if (!replyTo(sid, data)(u) || u[0] !== sid + 0x40) throw new Error('Unexpected ' + controller + ' reply');
            return u;
        } catch (e) {
            record.error = String(e.message || e); this.log.warn('Light Show ' + record.tx + ': ' + record.error); throw e;
        } finally { this._busy = false; }
    }
    async identify() {
        this.index = null;
        const u = await this.request(0x22, [0xF1, 0x50]);
        this.index = P.indexOf(u.slice(3, 6)); this.identifiedAt = Date.now();
        if (this.index !== P.INDEX) throw new Error('BDC variant ' + (this.index || 'unknown') + ' is not supported (requires BDC_G05)');
        return this.index;
    }
    async identifyFlm(side) {
        const m = F.moduleFor(side);
        delete this.verifiedFlm[m.address];
        const u = await this.request(0x22, [0xF1, 0x50], false, m.address);
        const index = P.indexOf(u.slice(3, 6));
        const v = index && F.variant(side, index);
        if (!F.usable(side, index, this.allowExperimental()))
            throw new Error((v ? v.name : 'Headlamp ' + side) + ' variant ' + (index || 'unknown') +
                (v && v.support === 'experimental' ? ' is experimental - enable it in Vehicle first' : ' unsupported'));
        this.verifiedFlm[m.address] = index;
        return index;
    }
    /**
     * Read-only vehicle scan: one functional 22 F1 50 to all control units. Resolves with
     * Map(address -> SGBD index string) and the raw replies. No session change, no control.
     */
    async scan(options) {
        if (this._busy) throw new Error('Diagnostic request already in flight');
        if (!this.available) throw new Error('No diagnostic connection (TASU unavailable)');
        this._busy = true;
        const record = { address: 0xDF, at: new Date().toISOString(), tx: '22 F1 50' };
        this.trace.push(record); if (this.trace.length > 80) this.trace.shift();
        const start = Date.now();
        try {
            const replies = await this.diag.functional(0x22, [0xF1, 0x50], Object.assign({ idleMs: 2500, maxMs: 15000 }, options || {}));
            const ids = new Map();
            replies.forEach((u, address) => {
                if (u && u[0] === 0x62 && u[1] === 0xF1 && u[2] === 0x50 && u.length >= 6) ids.set(address, P.indexOf(u.slice(3, 6)));
                else ids.set(address, null);
            });
            record.ms = Date.now() - start; record.rx = ids.size + ' control units answered';
            return ids;
        } catch (e) { record.error = String(e.message || e); throw e; }
        finally { this._busy = false; }
    }
    /** Physical read-only identity of one address (fallback when functional requests are refused). */
    async readIdentity(address) {
        const u = await this.request(0x22, [0xF1, 0x50], false, address);
        return P.indexOf(u.slice(3, 6));
    }
    /** Vehicle order (FA) from the gateway: 22 3F 06, read-only. */
    async readVehicleOrder() { return this.request(0x22, [0x3F, 0x06], false, 0x10); }
    async flmKeepalive(side) { return this.request(0x3E, [0x00], false, F.moduleFor(side).address); }
    async flmSession(side) { return this.request(0x10, [0x03], false, F.moduleFor(side).address); }
    async flmStart(side, channel, pwm = F.DEFAULT_PWM, seconds = F.DEFAULT_SECONDS) {
        return this.request(0x31, F.start(channel, pwm, seconds), false, F.moduleFor(side).address);
    }
    async flmStop(side) { return this.request(0x31, F.stop(), true, F.moduleFor(side).address); }
    async flmDefaultSession(side) { return this.request(0x10, [0x01], true, F.moduleFor(side).address); }
    async readOutputs() { return this.request(0x22, [0xE3, 0xB9]); }
    async readFunctionStatus() { return this.request(0x22, P.FUNCTION_DID); }
    async timed(lights, ms) { return this.request(0x2E, P.timedControl(lights, ms), ms === 0); }
    async session() { return this.request(0x10, [0x03]); }
    async set(output, on) { return this.request(0x2F, P.control(output, on)); }
    async keepalive() { return this.request(0x3E, [0x00]); }
    async release() { return this.request(0x2F, P.release(), true); }
    async defaultSession() { return this.request(0x10, [0x01], true); }
}
module.exports = Link;
module.exports.SCAN_ADDRESSES = SCAN_ADDRESSES;
