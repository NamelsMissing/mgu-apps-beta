'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../apps/g21_wheelheat/ecu_profile');
const Cycle = require('../apps/g21_wheelheat/cycle_policy');

// Simulated car: map "addr:did" -> raw UDS reply. Missing key = timeout.
function car(replies) {
    const calls = [];
    const probe = async (addr, did) => {
        calls.push([addr, did]);
        const r = replies[addr.toString(16) + ':' + did.toString(16)];
        return r === undefined ? null : r;
    };
    return { probe, calls };
}
const pos = (did, ...payload) => [0x62, did >> 8, did & 255, ...payload];
const nrc = (code) => [0x7F, 0x22, code];

// G21 318d: no seat modules, seat heating via BDC (SVT of the main vehicle).
const G21 = {
    '40:f150': pos(0xF150, 0x0F, 0x26, 0x80),
    '78:f150': pos(0xF150, 0x0F, 0x11, 0x22),
    '40:d074': pos(0xD074, 0, 0, 0, 1, 1),
    '40:e432': pos(0xE432, 0, 0, 20, 20, 0, 0, 0, 0, 0),
    '40:e430': pos(0xE430, 0, 0, 20, 20, 0, 0, 0, 0, 0),
    '40:e434': pos(0xE434, 1, 1, 0),
};
// G05 from issue #2: SM2 comfort seats, BDC seat DIDs answer NRC 0x22.
const G05 = {
    '40:f150': pos(0xF150, 0x0F, 0x26, 0x80),
    '6d:f150': pos(0xF150, 0x0A, 0x01, 0x02),
    '6e:f150': pos(0xF150, 0x0A, 0x01, 0x03),
    '78:f150': pos(0xF150, 0x0F, 0x11, 0x30),
    '40:d074': pos(0xD074, 1, 0, 0x44, 2, 1),
    '40:e432': nrc(0x22),
    '40:e430': nrc(0x22),
    '40:e434': nrc(0x22),
};

test('G21 without seat modules: all channels via BDC, complete profile', async () => {
    const p = await E.detect(car(G21).probe, { now: 1, appVersion: '0.5.0' });
    assert.equal(p.complete, true);
    assert.equal(p.ecus.BDC.index, '0F2680');
    assert.equal(p.ecus.SMFA.present, false);
    assert.deepEqual([p.routes.wheel.route, p.routes.driver.route, p.routes.passenger.route],
        ['bdc', 'bdc', 'bdc']);
    const cfg = { wheelAuto: true, seatDriver: true, seatPassenger: true };
    assert.deepEqual(E.applyRoutes(cfg, p), []);
    assert.deepEqual(cfg, { wheelAuto: true, seatDriver: true, seatPassenger: true });
});

test('G05 with SM2 seat modules: wheel via BDC, seats skipped instead of 8 retries', async () => {
    const p = await E.detect(car(G05).probe, { now: 1 });
    assert.equal(p.complete, true, 'NRC is an answer, not a missing reply');
    assert.equal(p.routes.wheel.route, 'bdc');
    assert.equal(p.routes.driver.route, 'seat-module');
    assert.equal(p.routes.driver.module, 'SMFA');
    assert.equal(p.routes.passenger.module, 'SMBF');
    const cfg = { wheelAuto: true, seatDriver: true, seatPassenger: false };
    const notes = E.applyRoutes(cfg, p);
    assert.equal(cfg.wheelAuto, true);
    assert.equal(cfg.seatDriver, false, 'driver seat removed from the plan');
    assert.equal(notes.length, 1, 'passenger was not selected, so no note');
    assert.match(notes[0], /SMFA 0x6D/);
});

test('NRC 0x22 without seat module keeps the channel (runtime gate decides)', async () => {
    const replies = Object.assign({}, G21, { '40:e432': nrc(0x22) });
    const p = await E.detect(car(replies).probe, { now: 1 });
    assert.equal(p.routes.driver.route, 'bdc-unverified');
    const cfg = { seatDriver: true };
    E.applyRoutes(cfg, p);
    assert.equal(cfg.seatDriver, true);
});

test('NRC 0x31 without seat module marks the channel unavailable', async () => {
    const replies = Object.assign({}, G21, { '40:e430': nrc(0x31) });
    const p = await E.detect(car(replies).probe, { now: 1 });
    assert.equal(p.routes.passenger.route, 'unavailable');
});

test('BDC asleep: nothing is blocked and the profile is incomplete', async () => {
    const c = car({});
    const p = await E.detect(c.probe, { now: 1 });
    assert.equal(p.complete, false);
    assert.equal(p.routes.driver.route, 'unknown');
    assert.deepEqual(c.calls.map(x => x[1]), [0xF150, 0xF150, 0xF150, 0xF150],
        'no heating DID is read when the BDC does not answer');
    const cfg = { wheelAuto: true, seatDriver: true, seatPassenger: true };
    assert.deepEqual(E.applyRoutes(cfg, p), []);
});

test('detection only reads: service 0x22 identification, never VIN', async () => {
    const c = car(G05);
    await E.detect(c.probe, { now: 1 });
    assert(!c.calls.some(([, did]) => did === 0xF190), 'VIN never requested');
    assert(c.calls.every(([addr]) => [0x40, 0x6D, 0x6E, 0x78].includes(addr)));
});

test('stored profile survives a restart and is reused only for the same BDC', async () => {
    const p = await E.detect(car(G05).probe, { now: 1 });
    const loaded = E.load(E.serialize(p));
    assert.deepEqual(loaded, p);
    assert.equal(E.reuseDecision(loaded, '0F2680').reuse, true);
    assert.equal(E.reuseDecision(loaded, '0F2680').verified, true);
    assert.equal(E.reuseDecision(loaded, '0F2590').reuse, false, 'other car / BDC -> redetect');
    const offline = E.reuseDecision(loaded, null);
    assert.deepEqual([offline.reuse, offline.verified], [true, false]);
    assert.equal(E.reuseDecision(null, '0F2680').reuse, false);
    const incomplete = await E.detect(car({}).probe, { now: 1 });
    assert.equal(E.reuseDecision(incomplete, '0F2680').reuse, false);
});

test('corrupt or foreign stored values are ignored', () => {
    for (const raw of [undefined, '', '{', '{"schema":99}', JSON.stringify({ schema: 1, ecus: {} }), 42])
        assert.equal(E.load(raw), null);
});

test('summary and labels are readable', async () => {
    const p = await E.detect(car(G05).probe, { now: 1 });
    assert.match(E.summary(p), /^BDC BDC_G05 \| SMFA 0A0102 \| SMBF 0A0103 \| IHKA 0F1130/);
    assert.equal(E.routeLabel(p, 'driver'), 'Seat module SMFA (automatic control not supported yet)');
    assert.equal(E.routeLabel(null, 'driver'), 'not detected yet');
});

test('one-shot parking test can be armed at runtime and applies to one ignition only', () => {
    const M = 60000, t0 = 1e9;
    const c = new Cycle.VehicleCycle({}, 30, false);
    c.observe(10, t0);
    c.observe(5, t0 + M);
    assert.equal(c.armTest(), true);
    c.observe(10, t0 + 7 * M);
    assert.equal(c.canStart(), true, 'issue #2: 6 min parked must pass when armed');
    assert.match(c.reason, /ONE-SHOT TEST/);
    assert.equal(c.testBypass, false, 'consumed on that ignition');
    c.consume();
    c.observe(5, t0 + 8 * M);
    c.observe(10, t0 + 10 * M);
    assert.equal(c.canStart(), false, 'next short stop is blocked again');
});

// FAS_G11 / IHKA_G05 layouts from docs/sgbd-seat-heating.md
const G05_SGBD = Object.assign({}, G05, {
    '6d:f150': pos(0xF150, 0x0F, 0x21, 0xF0), '6e:f150': pos(0xF150, 0x0F, 0x21, 0xF0),
    '78:f150': pos(0xF150, 0x0F, 0x28, 0x30),
    '6d:d701': pos(0xD701, ...new Array(15).fill(0), 2, 0, 0, 0, 0, 0, 0, 0, 0, 0),
    '6e:d701': pos(0xD701, ...new Array(15).fill(0), 2, 0, 0, 0, 0, 0, 0, 0, 0, 0),
    '6d:d714': pos(0xD714, 2, 31, 40, 29, 35, 0, 0, 0),
    '78:d8db': pos(0xD8DB, ...new Array(19).fill(0), 2, 0, 0, 0, 0, 0, 0, 0),
});

test('G05 seat modules are named from F150 and decoded read-only', async () => {
    const c = car(G05_SGBD);
    const p = await E.detect(c.probe, { now: 1 });
    assert.equal(p.ecus.SMFA.sgbd, 'FAS_G11');
    assert.equal(p.ecus.SMBF.sgbd, 'BFS_G11');
    assert.equal(p.ecus.IHKA.sgbd, 'IHKA_G05');
    assert.equal(p.ecus.SMFA.seatHeatingCoded, '2-circuit', 'matches E-Sys SHZ_TYP = 2_Kreis');
    const m = await E.readModuleSeat(c.probe, p, 'driver');
    assert.deepEqual(m.decoded, { level: 2, cushionC: 31, cushionPwm: 40, backC: 29, backPwm: 35 });
    assert.equal(m.ihkaLevel, 2);
    assert.equal(await E.readModuleSeat(c.probe, p, 'wheel'), null, 'BDC channels are not module reads');
    assert(c.calls.every(([, did]) => did !== undefined));
    assert.equal(E.decodeModuleSeat([255, 0, 0]), null, '255 = invalid level');
    assert.equal(E.decodeModuleSeat([1, 0x80, 255])['cushionC'], null);
});

test('unknown seat-module variant is shown raw, never decoded', async () => {
    const p = await E.detect(car(G05).probe, { now: 1 });
    assert.equal(p.ecus.SMFA.sgbd, null);
    assert.equal(p.ecus.SMFA.seatHeatingCoded, null);
    const m = await E.readModuleSeat(car(Object.assign({}, G05,
        { '6d:d714': pos(0xD714, 2, 0, 0, 0, 0) })).probe, p, 'driver');
    assert.equal(m.decoded, null);
    assert.equal(m.raw, '02 00 00 00 00');
});
