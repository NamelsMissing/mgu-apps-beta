'use strict';

/**
 * Control-unit detection for Heating Comfort (read-only, UDS service 0x22).
 *
 * Why: the BDC paths 0xE432 / 0xE430 (seat heating) only exist on cars
 * WITHOUT separate seat modules. A G05 with SM2 comfort seats (SMFA 0x6D,
 * SMBF 0x6E) rejects them with NRC 0x22 although the seat heating works,
 * and ISTA labels the BDC branch "seat heating (when no seat module is
 * installed)". A G21 without seat modules uses the BDC path.
 *
 * Detection only ever REMOVES a heating channel from the automatic plan.
 * It never grants a write: every 0x2E request still needs the fresh 0x22
 * readback of its own DID in SafeDiag.
 *
 * Identification uses the standard BMW DID 0xF150 (three-byte SGBD index),
 * the same request BimmerLink sends to identify ECU variants. VIN (F190)
 * and serial numbers are never read or stored.
 */

const SCHEMA = 1;
const PROFILE_KEY = '_ecuProfile';
const ID_DID = 0xF150;
const DID = { wheel: 0xD074, driver: 0xE432, passenger: 0xE430, seatCoded: 0xE434 };
// Seat modules FAS_G11 / BFS_G11 and IHKA_G05 (docs/sgbd-seat-heating.md).
const MODULE_DID = { seat: 0xD714, coded: 0xD701 };
const IHKA_DID = { status: 0xD8DB };

// SGBD names for the identities this app reads (from apps/light_show/sgbd-index.js).
// Seat-module and IHKA layouts are decoded ONLY for the variants listed in
// DECODES; other variants are shown raw.
const SGBD = {
    0x40: { '0F2680': 'BDC_G05', '0F2050': 'BDC_G11', '0F19C0': 'BDC' },
    0x6D: { '0F21F0': 'FAS_G11', '0F2CB0': 'FAS_I20', '0F1960': 'FAS_12', '0F1220': 'FAS_01' },
    0x6E: { '0F21F0': 'BFS_G11', '0F2CB0': 'BFS_I20', '0F1960': 'BFS_12', '0F1220': 'BFS_01' },
    0x78: { '0F2830': 'IHKA_G05', '0F2838': 'IHKA_G09', '0F21B0': 'IHKA_G11' },
};
const DECODES = new Set(['FAS_G11', 'BFS_G11', 'IHKA_G05']);
const sgbdName = (addr, index) => (SGBD[addr] && SGBD[addr][index]) || null;

const CANDIDATES = [
    { id: 'BDC', addr: 0x40, name: 'Body Domain Controller' },
    { id: 'SMFA', addr: 0x6D, name: 'Seat module driver' },
    { id: 'SMBF', addr: 0x6E, name: 'Seat module passenger' },
    { id: 'IHKA', addr: 0x78, name: 'Climate control' },
];

// Channel -> BDC DID and the seat module that takes over when installed.
const CHANNELS = {
    wheel: { label: 'Steering wheel', did: DID.wheel, module: null },
    driver: { label: 'Driver seat', did: DID.driver, module: 'SMFA' },
    passenger: { label: 'Passenger seat', did: DID.passenger, module: 'SMBF' },
};

// Routes that remove a channel from the automatic plan.
const BLOCKING = new Set(['seat-module', 'unavailable']);

const hex = (n, w) => Number(n).toString(16).toUpperCase().padStart(w || 2, '0');
const bytes = a => Array.from(a || []).map(n => hex(n)).join(' ');

/** Reduce one raw UDS reply (or null = no answer) to a storable result. */
function classify(did, uds) {
    if (!uds || !uds.length) return { state: 'timeout' };
    const hi = did >> 8, lo = did & 255;
    if (uds[0] === 0x62 && uds[1] === hi && uds[2] === lo)
        return { state: 'ok', payload: Array.from(uds).slice(3, 3 + 40) };
    if (uds[0] === 0x7F && uds[1] === 0x22) return { state: 'nrc', nrc: uds[2] };
    return { state: 'error', raw: bytes(uds).slice(0, 47) };
}

/** An ECU that answered anything (positive or NRC) is installed. */
const answered = r => !!r && (r.state === 'ok' || r.state === 'nrc');

/**
 * Probe all candidates. `probe(addr, did)` must perform one physical 0x22
 * read and resolve to the raw UDS reply, or null on timeout.
 */
async function detect(probe, meta) {
    const now = meta && Number.isFinite(meta.now) ? meta.now : Date.now();
    const ecus = {};
    for (const c of CANDIDATES) {
        let r;
        try { r = classify(ID_DID, await probe(c.addr, ID_DID)); }
        catch (e) { r = { state: 'error', raw: String(e && e.message || e).slice(0, 60) }; }
        const index = r.state === 'ok' && r.payload.length >= 3 ?
            bytes(r.payload.slice(0, 3)).replace(/ /g, '') : null;
        ecus[c.id] = { addr: c.addr, present: answered(r), state: r.state, index,
            sgbd: index ? sgbdName(c.addr, index) : null,
            nrc: r.nrc === undefined ? null : r.nrc };
    }
    // Read-only seat-module coding (D701 byte 15) for the profile.
    for (const id of ['SMFA', 'SMBF']) {
        if (!ecus[id].present) continue;
        let r;
        try { r = classify(MODULE_DID.coded, await probe(ecus[id].addr, MODULE_DID.coded)); }
        catch (e) { r = { state: 'error' }; }
        ecus[id].seatHeatingCoded = r.state === 'ok' && DECODES.has(ecus[id].sgbd) ?
            codedSeatHeating(r.payload) : null;
    }
    const reads = {};
    if (ecus.BDC.present) {
        for (const key of ['wheel', 'driver', 'passenger', 'seatCoded']) {
            let r;
            try { r = classify(DID[key], await probe(0x40, DID[key])); }
            catch (e) { r = { state: 'error', raw: String(e && e.message || e).slice(0, 60) }; }
            reads[key] = r;
        }
    }
    return build(ecus, reads, now, meta && meta.appVersion);
}

function build(ecus, reads, now, appVersion) {
    const routes = {};
    for (const [key, ch] of Object.entries(CHANNELS)) routes[key] = route(key, ch, ecus, reads);
    // Incomplete = something we need did not answer at all (asleep / no TASU).
    // An incomplete profile is shown and used, but detection repeats.
    const complete = !!ecus.BDC && ecus.BDC.present &&
        Object.values(reads).every(r => r.state !== 'timeout' && r.state !== 'error');
    return { schema: SCHEMA, detectedAt: now, appVersion: appVersion || null,
        complete, ecus, reads, routes };
}

function route(key, ch, ecus, reads) {
    const r = reads[key];
    if (!ecus.BDC || !ecus.BDC.present)
        return { route: 'unknown', reason: 'BDC 0x40 did not answer' };
    if (r && r.state === 'ok') return { route: 'bdc', reason: 'BDC 0x' + hex(ch.did, 4) + ' readable' };
    const mod = ch.module && ecus[ch.module];
    if (mod && mod.present)
        return { route: 'seat-module', module: ch.module, addr: mod.addr,
            reason: ch.module + ' 0x' + hex(mod.addr) + ' installed; BDC seat path not used' };
    if (r && r.state === 'nrc' && r.nrc === 0x31)
        return { route: 'unavailable', reason: 'BDC 0x' + hex(ch.did, 4) + ' not supported (NRC 31)' };
    // NRC 0x22 without seat module: may be a temporary condition. Keep the
    // channel; the normal runtime readback gate still decides every write.
    if (r && r.state === 'nrc')
        return { route: 'bdc-unverified', reason: 'BDC 0x' + hex(ch.did, 4) + ' NRC ' + hex(r.nrc) };
    return { route: 'unknown', reason: 'no reply for 0x' + hex(ch.did, 4) };
}

/** FAS_G11/BFS_G11 RES_0xD701_D byte 15: 0 not coded, 1/2 one/two circuits. */
function codedSeatHeating(payload) {
    const v = Array.isArray(payload) && payload.length > 15 ? payload[15] : null;
    return v === 0 ? 'not coded' : v === 1 ? '1-circuit' : v === 2 ? '2-circuit' : null;
}

/** FAS_G11/BFS_G11 RES_0xD714_D: level, cushion/back temperature and PWM. */
function decodeModuleSeat(payload) {
    if (!Array.isArray(payload) || payload.length < 1 || ![0, 1, 2, 3].includes(payload[0])) return null;
    const temp = n => n === undefined || n === 0x80 ? null : (n > 127 ? n - 256 : n);
    const pwm = n => n === undefined || n === 255 ? null : n;
    return { level: payload[0], cushionC: temp(payload[1]), cushionPwm: pwm(payload[2]),
        backC: temp(payload[3]), backPwm: pwm(payload[4]) };
}

/** IHKA_G05 RES_0xD8DB_D bytes 19/20: front left/right seat heating level. */
function decodeIhkaSeats(payload) {
    if (!Array.isArray(payload) || payload.length < 21) return null;
    const lvl = n => [0, 1, 2, 3].includes(n) ? n : null;
    return { left: lvl(payload[19]), right: lvl(payload[20]) };
}

/** Read-only live state of a seat handled by a seat module (Diagnostics). */
async function readModuleSeat(probe, profile, key) {
    const r = profile && profile.routes[key];
    if (!r || r.route !== 'seat-module') return null;
    const ecu = profile.ecus[r.module];
    const res = classify(MODULE_DID.seat, await probe(ecu.addr, MODULE_DID.seat));
    const decoded = res.state === 'ok' && DECODES.has(ecu.sgbd) ? decodeModuleSeat(res.payload) : null;
    let ihka = null;
    const ih = profile.ecus.IHKA;
    if (ih && ih.present && DECODES.has(ih.sgbd)) {
        const st = classify(IHKA_DID.status, await probe(ih.addr, IHKA_DID.status));
        const both = st.state === 'ok' ? decodeIhkaSeats(st.payload) : null;
        ihka = both ? (key === 'driver' ? both.left : both.right) : null;
    }
    return { at: Date.now(), module: r.module, sgbd: ecu.sgbd, state: res.state,
        nrc: res.nrc === undefined ? null : res.nrc, decoded, ihkaLevel: ihka,
        raw: res.state === 'ok' ? bytes(res.payload) : '' };
}

/** Parse the stored settings value; anything unexpected is treated as absent. */
function load(raw) {
    if (typeof raw !== 'string' || !raw) return null;
    try {
        const p = JSON.parse(raw);
        if (!p || p.schema !== SCHEMA || !p.ecus || !p.routes || !p.ecus.BDC) return null;
        for (const key of Object.keys(CHANNELS)) if (!p.routes[key]) return null;
        return p;
    } catch (_) { return null; }
}

const serialize = profile => JSON.stringify(profile);

/**
 * Decide at startup whether the stored profile can be reused.
 * bdcIndex: fresh 22 F150 result of the BDC as stored in a profile
 * (e.g. '0F2680'), or null if the BDC did not answer.
 */
function reuseDecision(saved, bdcIndex) {
    if (!saved) return { reuse: false, reason: 'no stored profile' };
    if (!saved.complete) return { reuse: false, reason: 'stored profile incomplete' };
    if (bdcIndex === null || bdcIndex === undefined)
        return { reuse: true, verified: false, reason: 'BDC not reachable; stored profile kept' };
    if (saved.ecus.BDC.index !== bdcIndex)
        return { reuse: false, reason: 'BDC identity changed (' + saved.ecus.BDC.index + ' -> ' + bdcIndex + ')' };
    return { reuse: true, verified: true, reason: 'BDC identity matches stored profile' };
}

/** Remove channels that this car cannot heat via the BDC. Returns notes. */
function applyRoutes(cfg, profile) {
    const skipped = [];
    if (!profile) return skipped;
    const map = { wheel: 'wheelAuto', driver: 'seatDriver', passenger: 'seatPassenger' };
    for (const [key, setting] of Object.entries(map)) {
        const r = profile.routes[key];
        if (cfg[setting] && r && BLOCKING.has(r.route)) {
            cfg[setting] = false;
            skipped.push(CHANNELS[key].label + ': ' + r.reason);
        }
    }
    return skipped;
}

/** Short user-facing route text for one channel. */
function routeLabel(profile, key) {
    const r = profile && profile.routes[key];
    if (!r) return 'not detected yet';
    switch (r.route) {
        case 'bdc': return 'BDC';
        case 'bdc-unverified': return 'BDC (not confirmed)';
        case 'seat-module': return 'Seat module ' + r.module + ' (automatic control not supported yet)';
        case 'unavailable': return 'Not available';
        default: return 'Unknown';
    }
}

/** One-line summary for log, Diagnostics tab and QR export. */
function summary(profile) {
    if (!profile) return 'no control-unit profile';
    const ecu = CANDIDATES.map(c => {
        const e = profile.ecus[c.id];
        return c.id + ' ' + (!e ? '?' : e.present ? (e.sgbd || e.index || 'NRC ' + hex(e.nrc)) : '-');
    }).join(' | ');
    return ecu + ' || wheel=' + profile.routes.wheel.route +
        ' driver=' + profile.routes.driver.route +
        ' passenger=' + profile.routes.passenger.route +
        (profile.complete ? '' : ' (incomplete)');
}

module.exports = { SCHEMA, PROFILE_KEY, ID_DID, DID, MODULE_DID, IHKA_DID, SGBD, CANDIDATES, CHANNELS,
    sgbdName, codedSeatHeating, decodeModuleSeat, decodeIhkaSeats, readModuleSeat,
    classify, detect, build, load, serialize, reuseDecision, applyRoutes,
    routeLabel, summary };
