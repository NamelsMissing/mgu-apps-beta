'use strict';
// Read-only vehicle analysis: which control units answer, which of them drive exterior
// lights, and which control route Light Show may use on this particular car.
// Only 22 F1 50 (identity) is sent; no session change, no lamp or motor request.
const fs = require('fs');
const path = require('path');
const P = require('./protocol');
const F = require('./flm-control');
const { INDEX, ECU } = require('./sgbd-index');

const FILE = 'light-show-vehicle.json';
const hex2 = (n) => ('0' + n.toString(16)).slice(-2).toUpperCase();

// Units at these addresses can carry exterior lighting on F/G-series cars.
const LIGHT_ROLES = Object.freeze({
    0x40: 'Body controller: tail, brake, indicators, fog, reverse, plate',
    0x41: 'Headlamp module left (older)', 0x42: 'Headlamp module right (older)',
    0x43: 'Headlamp module left', 0x44: 'Headlamp module right',
    0x4F: 'Light effect module', 0x72: 'Footwell module (older body)',
});

function unitName(address, index) {
    const key = hex2(address) + ' ' + index;
    return index && Object.prototype.hasOwnProperty.call(INDEX, key) ? INDEX[key] : null;
}

/**
 * Turn identities (Map address -> index|null) into a profile:
 * { at, method, units[], bdc, flm:{left,right}, routes:{flm:{left,right}, fn, out}, summary }
 */
function profile(ids, method, now) {
    const units = [];
    ids.forEach((index, address) => {
        const name = unitName(address, index);
        units.push({ address, addressHex: '0x' + hex2(address), index: index || null,
            name: name || null, role: ECU[address] || null, light: LIGHT_ROLES[address] || null });
    });
    units.sort((a, b) => a.address - b.address);
    const at = (a) => units.find((u) => u.address === a) || null;
    const bdcUnit = at(0x40);
    const bdc = {
        present: !!bdcUnit, index: bdcUnit && bdcUnit.index, name: bdcUnit && bdcUnit.name,
        support: bdcUnit && bdcUnit.index === P.INDEX ? 'verified' : bdcUnit ? 'unsupported' : 'absent',
    };
    const flm = {};
    for (const side of ['left', 'right']) {
        const u = at(F.MODULES[side].address);
        const v = u && u.index ? F.variant(side, u.index) : null;
        flm[side] = { present: !!u, address: F.MODULES[side].address, index: u && u.index,
            name: v ? v.name : u && u.name, support: !u ? 'absent' : v ? v.support : 'unsupported' };
    }
    const flmRoute = (s) => s === 'absent' || s === 'unsupported' || bdc.support === 'verified' ? s : 'blocked';
    const routes = {
        // FLM_KANAL also needs the BDC as the app's gateway check before any session.
        flm: { left: flmRoute(flm.left.support), right: flmRoute(flm.right.support) },
        fn: bdc.support === 'verified' ? 'verified' : 'unsupported',
        out: bdc.support === 'verified' ? 'experimental' : 'unsupported',
    };
    const lightUnits = units.filter((u) => u.light);
    lightUnits.forEach((u) => {
        u.support = u.address === 0x40 ? bdc.support : u.address === 0x43 ? routes.flm.left : u.address === 0x44 ? routes.flm.right : 'unsupported';
        u.supportText = supportText(u.support);
    });
    return { at: new Date(now || Date.now()).toISOString(), method, units, bdc, flm, routes,
        summary: units.length + ' control units, ' + lightUnits.length + ' with exterior lighting' };
}

/** Functional scan first; when the transport refuses it, ask the three light addresses directly. */
async function scan(link, log) {
    let ids = null, method = 'functional 22 F1 50', note = null;
    try { ids = await link.scan(); }
    catch (e) { note = 'Functional scan failed: ' + (e.message || e); if (log) log.warn('Light Show scan: ' + note); }
    if (!ids || !ids.size) {
        method = 'physical 22 F1 50 (0x40, 0x43, 0x44)';
        ids = new Map();
        for (const address of [0x40, 0x43, 0x44]) {
            try { ids.set(address, await link.readIdentity(address)); }
            catch (e) { if (log) log.info('Light Show scan 0x' + hex2(address) + ': ' + (e.message || e)); }
        }
    }
    const result = profile(ids, method);
    if (note) result.note = note;
    return result;
}

function load(dir) {
    try {
        const v = JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8'));
        return v && Array.isArray(v.units) && v.routes ? v : null;
    } catch (_) { return null; }
}
function save(dir, value) {
    const file = path.join(dir, FILE);
    fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 1));
    fs.renameSync(file + '.tmp', file);
}

/** Short human text for a support level. */
function supportText(s) {
    return { verified: 'Supported', experimental: 'Experimental', unsupported: 'Not supported',
        absent: 'Not found', blocked: 'Needs BDC_G05' }[s] || 'Unknown';
}

module.exports = { scan, profile, load, save, supportText, unitName, LIGHT_ROLES, FILE };
