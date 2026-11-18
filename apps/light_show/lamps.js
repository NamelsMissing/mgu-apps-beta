'use strict';
// Every exterior light Light Show can address, with its control route and where it sits on
// the car (for the 3D view and the phone page). Vehicle frame: x to the car's right,
// y up, z forward; metres, roughly a mid-size BMW.
//
// Routes:
//   flm - FLM_KANAL RoutineControl on the headlamp module (one LED channel per module at a time)
//   fn  - BDC timed light function D542 (both sides together, the ECU switches off by itself)
//   out - BDC IOControl E3B5 of one output (experimental: no visible effect on the tested G21)
const F = require('./flm-control');
const P = require('./protocol');
const DiagnosticOutputs = require('./diagnostic-outputs');

const COLORS = Object.freeze({ white: '#eaf3ff', amber: '#ffae2e', red: '#ff3030', fog: '#fff1c4' });
const L = -1, R = 1;
const pt = (side, x, y, z) => [side * x, y, z];
const pair = (x, y, z) => [pt(L, x, y, z), pt(R, x, y, z)];

// Function lamps (route fn): BDC light functions, both sides at once.
const FUNCTIONS = Object.freeze([
    { key: 'high', label: 'High beam', short: 'HIGH', color: 'white', points: pair(0.62, 0.74, 2.30), group: 'front' },
    { key: 'drl', label: 'Daytime lights', short: 'DRL', color: 'white', points: pair(0.70, 0.78, 2.26), group: 'front' },
    { key: 'position', label: 'Position lights', short: 'POS', color: 'white',
        points: pair(0.72, 0.76, 2.24).concat(pair(0.70, 0.92, -2.30)), group: 'front' },
    { key: 'fog', label: 'Front fog lights', short: 'FOG', color: 'fog', points: pair(0.66, 0.34, 2.32), group: 'front' },
]);

// BDC outputs (route out): position and colour per output id.
const OUTPUT_PLACE = Object.freeze({
    0x01: [L, 0.60, 0.72, 2.30, 'white', 'front'], 0x02: [R, 0.60, 0.72, 2.30, 'white', 'front'],
    0x03: [L, 0.72, 0.78, 2.26, 'white', 'front'], 0x04: [R, 0.72, 0.78, 2.26, 'white', 'front'],
    0x07: [L, 0.66, 0.74, 2.30, 'white', 'front'], 0x08: [R, 0.66, 0.74, 2.30, 'white', 'front'],
    0x09: [L, 0.76, 0.76, 2.22, 'white', 'front'], 0x0A: [R, 0.76, 0.76, 2.22, 'white', 'front'],
    0x0B: [L, 0.66, 0.34, 2.32, 'fog', 'front'], 0x0C: [R, 0.66, 0.34, 2.32, 'fog', 'front'],
    0x0D: [L, 0.82, 0.72, 2.16, 'amber', 'front'], 0x0E: [R, 0.82, 0.72, 2.16, 'amber', 'front'],
    0x05: [L, 0.92, 0.62, 1.90, 'amber', 'side'], 0x06: [R, 0.92, 0.62, 1.90, 'amber', 'side'],
    0x10: [L, 0.98, 1.02, 0.92, 'amber', 'side'], 0x11: [R, 0.98, 1.02, 0.92, 'amber', 'side'],
    0x14: [L, 0.72, 0.92, -2.30, 'red', 'rear'], 0x15: [R, 0.72, 0.92, -2.30, 'red', 'rear'],
    0x16: [L, 0.50, 0.94, -2.33, 'red', 'rear'], 0x17: [R, 0.50, 0.94, -2.33, 'red', 'rear'],
    0x18: [L, 0.68, 0.86, -2.30, 'red', 'rear'], 0x19: [R, 0.68, 0.86, -2.30, 'red', 'rear'],
    0x23: [0, 0, 1.38, -2.05, 'red', 'rear'],
    0x1A: [L, 0.60, 0.98, -2.30, 'red', 'rear'], 0x1B: [R, 0.60, 0.98, -2.30, 'red', 'rear'],
    0x1C: [L, 0.55, 0.36, -2.36, 'red', 'rear'], 0x1D: [R, 0.55, 0.36, -2.36, 'red', 'rear'],
    0x1E: [L, 0.42, 0.86, -2.33, 'white', 'rear'], 0x1F: [R, 0.42, 0.86, -2.33, 'white', 'rear'],
    0x20: [L, 0.78, 0.90, -2.26, 'amber', 'rear'], 0x21: [R, 0.78, 0.90, -2.26, 'amber', 'rear'],
    0x22: [0, 0, 0.58, -2.38, 'white', 'rear'],
});

const GROUP_ORDER = Object.freeze({ front: 0, side: 1, rear: 2 });

function flmId(side, channel) { return 'flm:' + side + ':' + channel; }
function parse(id) {
    const s = String(id || '').split(':');
    if (s[0] === 'flm' && (s[1] === 'left' || s[1] === 'right') && /^([1-9]|1[0-5])$/.test(s[2]))
        return { route: 'flm', side: s[1], channel: Number(s[2]) };
    if (s[0] === 'fn' && s.length === 2 && FUNCTIONS.some((f) => f.key === s[1])) return { route: 'fn', key: s[1] };
    if (s[0] === 'out' && s.length === 2 && /^[0-9]{1,2}$/.test(s[1]) && DiagnosticOutputs.OUTPUTS[Number(s[1])])
        return { route: 'out', output: Number(s[1]) };
    return null;
}

/**
 * All lamps for this car. profile: ecu-scan profile (or null before the first scan),
 * names: Names store, options.allowExperimental: FLM02X / FLM2_1 opt-in.
 * Each lamp: {id, route, label, short, group, side, color, hex, points, available, why, ...}
 */
function catalog(profile, names, options) {
    const o = options || {}, routes = profile && profile.routes;
    const out = [];
    const why = (support) => !routes ? 'Run the vehicle scan first'
        : support === 'verified' ? '' : support === 'experimental' ? (o.allowExperimental ? '' : 'Experimental module: enable in Vehicle')
        : support === 'blocked' ? 'Body controller BDC_G05 not found' : support === 'absent' ? 'Module not found in this car'
        : 'Module variant not supported';
    for (const side of ['left', 'right']) {
        const support = routes ? routes.flm[side] : null, s = side === 'left' ? L : R;
        for (let c = 1; c <= 15; c++) {
            const id = flmId(side, c), name = names ? names.name(id) : '';
            out.push({ id, route: 'flm', side, channel: c, group: 'front', color: 'white', hex: COLORS.white,
                label: name || (side === 'left' ? 'Left' : 'Right') + ' headlamp LED ' + c,
                short: (side === 'left' ? 'L' : 'R') + c, named: !!name,
                points: [pt(s, 0.50 + c * 0.017, 0.70 + (c % 3) * 0.022, 2.28 - c * 0.006)],
                module: F.MODULES[side].name, available: !why(support), why: why(support), support });
        }
    }
    const fnSupport = routes ? routes.fn : null;
    for (const f of FUNCTIONS) {
        const id = 'fn:' + f.key;
        out.push({ id, route: 'fn', key: f.key, side: 'both', group: f.group, color: f.color, hex: COLORS[f.color],
            label: (names && names.name(id)) || f.label + ' (both)', short: f.short, points: f.points,
            module: 'BDC_G05 D542', available: !why(fnSupport), why: why(fnSupport), support: fnSupport });
    }
    const outSupport = routes ? routes.out : null;
    for (const group of DiagnosticOutputs.GROUPS) for (const [idNum, label, prg] of group.lights) {
        const p = OUTPUT_PLACE[idNum];
        if (!p) continue;
        const id = 'out:' + idNum, color = p[4];
        out.push({ id, route: 'out', output: idNum, prg, group: p[5],
            side: p[0] === L ? 'left' : p[0] === R ? 'right' : 'centre', color, hex: COLORS[color],
            label: (names && names.name(id)) || label, short: prg, points: [pt(p[0] || 1, p[0] ? p[1] : 0, p[2], p[3])],
            module: 'BDC_G05 E3B5', available: !why(outSupport === 'experimental' ? 'verified' : outSupport),
            why: why(outSupport === 'experimental' ? 'verified' : outSupport), support: outSupport, experimental: true });
    }
    return out;
}

/** Order lamps front to rear, left to right (for waves and the lists). */
function spatialOrder(lamps) {
    return lamps.slice().sort((a, b) => (GROUP_ORDER[a.group] - GROUP_ORDER[b.group])
        || (centroid(b)[2] - centroid(a)[2]) || (centroid(a)[0] - centroid(b)[0]));
}
function centroid(l) {
    const p = l.points, n = p.length;
    return [p.reduce((s, q) => s + q[0], 0) / n, p.reduce((s, q) => s + q[1], 0) / n, p.reduce((s, q) => s + q[2], 0) / n];
}
/** Which side a lamp counts for in left/right effects ('both' and 'centre' are neither). */
function sideOf(l) { return l.side === 'left' || l.side === 'right' ? l.side : null; }

module.exports = { catalog, parse, flmId, spatialOrder, centroid, sideOf, FUNCTIONS, OUTPUT_PLACE, COLORS, GROUP_ORDER };
// Keep protocol import referenced: fn keys must exist in the BDC function table.
FUNCTIONS.forEach((f) => { if (!P.FUNCTIONS[f.key]) throw new Error('Unknown BDC light function ' + f.key); });
