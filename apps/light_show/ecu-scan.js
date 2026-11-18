'use strict';
// Read-only vehicle analysis: which control units answer, which of them drive exterior
// lights, and which control route Light Show may use on this particular car.
// Only 22 F1 50 (identity) is sent; no session change, no lamp or motor request.
const fs = require('fs');
const path = require('path');
const P = require('./protocol');
const F = require('./flm-control');
const { INDEX, ECU } = require('./sgbd-index');
const VehicleOrder = require('./vehicle-order');

const FILE = 'light-show-vehicle.json';
const hex2 = (n) => ('0' + n.toString(16)).slice(-2).toUpperCase();

// Units at these addresses can carry exterior lighting on F/G-series cars.
// (BimmerLight's module set for E/F/G cars, reduced to addresses an MGU car can have.)
const LIGHT_ROLES = Object.freeze({
    0x10: 'Gateway (ZGW / BCP): vehicle order, identity of the car',
    0x17: 'Rear light module 1 left', 0x1A: 'Rear light module 1 right',
    0x1C: 'Rear light module 2 left', 0x1E: 'Rear light module 2 right',
    0x40: 'Body controller: tail, brake, indicators, fog, reverse, plate',
    0x43: 'Headlamp module left', 0x44: 'Headlamp module right',
    0x72: 'Footwell / rear module (older body)',
});
// Units Light Show recognises but cannot drive yet (no verified telegrams).
const DETECT_ONLY = Object.freeze([0x10, 0x17, 0x1A, 0x1C, 0x1E, 0x72]);

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
        u.support = u.address === 0x40 ? bdc.support : u.address === 0x43 ? routes.flm.left : u.address === 0x44 ? routes.flm.right
            : u.address === 0x10 ? 'gateway' : DETECT_ONLY.indexOf(u.address) >= 0 && u.name ? 'detected' : 'unsupported';
        u.supportText = supportText(u.support);
    });
    const rear = units.filter((u) => [0x17, 0x1A, 0x1C, 0x1E].indexOf(u.address) >= 0 && u.name);
    return { at: new Date(now || Date.now()).toISOString(), method, units, bdc, flm, routes, rear: rear.map((u) => u.name),
        summary: units.length + ' control units, ' + lightUnits.filter((u) => u.address !== 0x10).length + ' with exterior lighting' };
}

/**
 * Like BimmerLight: all units at once (functional 22 F1 50), then every light address that did
 * not answer is asked once more on its own, then the vehicle order from the gateway.
 * progress(text) reports each step.
 */
async function scan(link, log, progress) {
    const say = progress || (() => {});
    let ids = new Map(), method = 'functional 22 F1 50', note = null;
    say('Scanning for modules...');
    try { ids = await link.scan(); }
    catch (e) { note = 'Functional scan failed: ' + (e.message || e); method = 'physical 22 F1 50'; if (log) log.warn('Light Show scan: ' + note); }
    const missing = (link.constructor.SCAN_ADDRESSES || [0x10, 0x40, 0x43, 0x44]).filter((a) => !ids.has(a) || !ids.get(a));
    if (missing.length) method += ' + ' + missing.length + ' single checks';
    for (const address of missing) {
        say('Checking 0x' + hex2(address) + '...');
        try { ids.set(address, await link.readIdentity(address)); }
        catch (e) { if (log) log.info('Light Show scan 0x' + hex2(address) + ': ' + (e.message || e)); }
    }
    const result = profile(ids, method);
    if (note) result.note = note;
    if (ids.has(0x10)) {
        say('Reading the vehicle order...');
        try { result.order = VehicleOrder.decode(await link.readVehicleOrder()); }
        catch (e) { result.orderError = String(e.message || e); }
    }
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
        absent: 'Not found', blocked: 'Needs BDC_G05', detected: 'Found, not mapped yet', gateway: 'Gateway' }[s] || 'Unknown';
}

module.exports = { scan, profile, load, save, supportText, unitName, LIGHT_ROLES, DETECT_ONLY, FILE };
