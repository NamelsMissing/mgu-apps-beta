'use strict';
// Offline end-to-end run of main.js with a simulated car (no vehicle access).
// Checks: detection runs once TASU is online, the profile is saved and reused
// on the next start, and a G05 with seat modules plans only the wheel.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('module');
const realDiag = require('../kit/runtime/diag');

const APP = path.join(__dirname, '../apps/g21_wheelheat');
const pos = (did, ...p) => [0x62, did >> 8, did & 255, ...p];
const G05 = {
    '40:f150': pos(0xF150, 0x0F, 0x26, 0x80), '6d:f150': pos(0xF150, 0x0A, 1, 2),
    '6e:f150': pos(0xF150, 0x0A, 1, 3), '78:f150': pos(0xF150, 0x0F, 0x11, 0x30),
    '40:d074': pos(0xD074, 0, 0, 0, 1, 1), '40:e432': [0x7F, 0x22, 0x22],
    '40:e430': [0x7F, 0x22, 0x22], '40:e434': [0x7F, 0x22, 0x22],
};

function boot(dir, car, requests) {
    let def;
    const settingsFile = path.join(dir, 'settings.json');
    const values = Object.assign({ autoEnabled: true, belowTemp: 8, minVehicleOffMins: 30,
        wheelAuto: true, wheelMins: 3, seatDriver: true, seatPassenger: false,
        seatLevel: 3, seatMins: 4, testNextStartup: false },
    fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')) : {});
    const listeners = [];
    const save = () => fs.writeFileSync(settingsFile, JSON.stringify(values));
    const settings = {
        file: settingsFile, loadSource: 'test', saveError: null,
        get: k => values[k],
        set(k, v) { values[k] = v; save(); listeners.forEach(fn => fn(k, v)); },
        setMany(c) { Object.assign(values, c); save(); },
        onChange: fn => listeners.push(fn),
    };
    const watchers = {};
    class FakeDiag {
        constructor() { this.p = {}; this.available = true; }
        async init() {}
        async physical(addr, sid, data) {
            const did = (data[0] << 8) | data[1];
            requests.push([addr, sid, did]);
            if (sid === 0x22) {
                const r = car[addr.toString(16) + ':' + did.toString(16)];
                return r === undefined ? null : r;
            }
            if (sid === 0x2E) return [0x6E, data[0], data[1]];
            return null;
        }
    }
    const stubs = {
        './kit/mgu': { run: d => { def = d; } },
        './kit/gauges': { frame() {}, panel() {} },
        './kit/diag': Object.assign({}, realDiag, { Diag: FakeDiag }),
    };
    const original = Module._load;
    Module._load = function (request, parent, ...rest) {
        if (parent && parent.filename && parent.filename.startsWith(APP) && stubs[request])
            return stubs[request];
        return original.call(this, request, parent, ...rest);
    };
    for (const k of Object.keys(require.cache)) if (k.startsWith(APP)) delete require.cache[k];
    try { require(path.join(APP, 'main.js')); } finally { Module._load = original; }
    const timers = [];
    const realSetInterval = global.setInterval;
    global.setInterval = (fn, ms) => { const h = realSetInterval(fn, ms); timers.push(h); return h; };
    const ctx = {
        settings, dataDir: dir, app: { startReason: 'TEST' },
        log: { info() {}, warn() {}, error() {} },
        signals: { watch: async (iface, _v, handlers) => {
            watchers[iface] = handlers; return { available: true }; } },
        ui: { onClick() {}, onVisible() {}, isVisible: () => false, image() {} },
        loop() {}, theme: () => ({}), canvas: () => ({}),
    };
    def.start(ctx);
    global.setInterval = realSetInterval;
    return { values, watchers, stop: () => timers.forEach(clearInterval) };
}
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (fn()) return true; await wait(50); }
    return false;
}

test('G05 with seat modules: profile detected, saved, reused; seat never written', { timeout: 30000 }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wheelheat-ecu-'));
    const requests = [];
    const a = boot(dir, G05, requests);
    try {
        assert(await until(() => typeof a.values._ecuProfile === 'string', 8000), 'profile saved');
        const saved = JSON.parse(a.values._ecuProfile);
        assert.equal(saved.routes.driver.route, 'seat-module');
        assert.equal(saved.routes.wheel.route, 'bdc');
        // Cold ignition after a long OFF period.
        const veh = a.watchers['de.bmw.infrastructure.VehicleCondition'].VehicleCondition;
        const spd = a.watchers['de.bmw.infotainment.vehicle.Vehicle2'].statusCarSpeed2;
        const tmp = a.watchers['de.bmw.infrastructure.EnvironmentalInformation'].ExteriorTemperature;
        veh({ statusConditionVehicle: 5 });
        veh({ statusConditionVehicle: 10 });
        spd({ speedVehicleCentreOfGravity: 0 });
        tmp({ temperatureExterior: 93 }); // 6.5 C
        const events = () => JSON.parse(fs.readFileSync(path.join(dir, 'heating_events.json'), 'utf8'));
        assert(await until(() => events().some(e => e.kind === 'SKIP' &&
            /Driver seat: SMFA 0x6D installed/.test(e.message)), 5000), 'driver seat skipped with reason');
        const writes = requests.filter(r => r[1] === 0x2E);
        assert(!writes.some(r => r[2] === 0xE432 || r[2] === 0xE430), 'no seat write via BDC');
        assert(events().some(e => e.kind === 'ECU ROUTE' && /Driver seat: seat-module/.test(e.message)));
    } finally { a.stop(); }

    // Second start: stored profile reused after one BDC identification read.
    const second = [];
    const b = boot(dir, G05, second);
    try {
        const events = () => JSON.parse(fs.readFileSync(path.join(dir, 'heating_events.json'), 'utf8'));
        assert(await until(() => events().some(e => /BDC identity matches stored profile/.test(e.message)), 8000));
        const ids = second.filter(r => r[1] === 0x22 && r[2] === 0xF150);
        assert.deepEqual(ids.map(r => r[0]), [0x40], 'only the BDC is re-identified');
    } finally { b.stop(); }
});
