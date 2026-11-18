'use strict';
// Light Show 0.4 (beta): vehicle scan, lamp catalog, effects, runner safety, phone server.
// PC only, no car: the diagnostic link is a fake that records every request.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const APP = path.join(__dirname, '../apps/light_show');
const Scan = require(APP + '/ecu-scan');
const Lamps = require(APP + '/lamps');
const Effects = require(APP + '/effects');
const { Names, Observations, migrateKey } = require(APP + '/store');
const Journal = require(APP + '/journal');
const Runner = require(APP + '/runner');
const F = require(APP + '/flm-control');
const Car3D = require(APP + '/car3d');
const { WebServer, privateAddress } = require(APP + '/web-server');
const page = require(APP + '/web-page');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'light-show-'));
const ids = (pairs) => new Map(pairs);

/* ---------- vehicle scan ---------- */
{
    const g21 = Scan.profile(ids([[0x40, '0F2680'], [0x43, '0F26C0'], [0x44, '0F26D0'], [0x60, null]]), 'test');
    assert.deepStrictEqual(g21.routes, { flm: { left: 'verified', right: 'verified' }, fn: 'verified', out: 'experimental' });
    assert.strictEqual(g21.bdc.name, 'BDC_G05');
    assert.strictEqual(g21.flm.left.name, 'FLM02_L');
    const laser = Scan.profile(ids([[0x40, '0F2680'], [0x43, '0F26C8'], [0x44, '0F26D8']]), 'test');
    assert.deepStrictEqual(laser.routes.flm, { left: 'experimental', right: 'experimental' });
    const other = Scan.profile(ids([[0x40, '0F2050'], [0x43, '0F26C0']]), 'test');
    assert.strictEqual(other.bdc.support, 'unsupported');
    assert.strictEqual(other.routes.flm.left, 'blocked', 'no FLM route without BDC_G05');
    assert.strictEqual(other.routes.flm.right, 'absent');
    assert.strictEqual(other.routes.fn, 'unsupported');
    console.log('ok: scan profiles (G21 verified, FLM02X experimental, foreign BDC blocked)');
}

/* ---------- catalog ---------- */
{
    const g21 = Scan.profile(ids([[0x40, '0F2680'], [0x43, '0F26C0'], [0x44, '0F26D0']]), 'test');
    const all = Lamps.catalog(g21, null, {});
    assert.strictEqual(all.filter((l) => l.route === 'flm').length, 30);
    assert.strictEqual(all.filter((l) => l.route === 'fn').length, 4);
    assert.ok(all.filter((l) => l.route === 'out').length >= 30, 'all BDC exterior outputs listed');
    assert.ok(all.every((l) => l.available));
    assert.ok(all.some((l) => l.group === 'rear' && l.color === 'red'));
    all.forEach((l) => assert.deepStrictEqual(Lamps.parse(l.id) && Lamps.parse(l.id).route, l.route));
    const laser = Scan.profile(ids([[0x40, '0F2680'], [0x43, '0F26C8'], [0x44, '0F26D8']]), 'test');
    assert.ok(Lamps.catalog(laser, null, {}).filter((l) => l.route === 'flm').every((l) => !l.available && /Experimental/.test(l.why)));
    assert.ok(Lamps.catalog(laser, null, { allowExperimental: true }).filter((l) => l.route === 'flm').every((l) => l.available));
    assert.ok(Lamps.catalog(null, null, {}).every((l) => !l.available), 'nothing before the first scan');
    assert.strictEqual(Lamps.parse('flm:left:16'), null);
    assert.strictEqual(Lamps.parse('out:999'), null);
    console.log('ok: lamp catalog follows the scan and the experimental switch');
}

/* ---------- effects ---------- */
const g21Lamps = Lamps.catalog(Scan.profile(ids([[0x40, '0F2680'], [0x43, '0F26C0'], [0x44, '0F26D0']]), 't'), null, {});
const base = { stepMs: 500, gapMs: 100, cycles: 2, pwm: 60 };
{
    for (const e of Effects.EFFECTS) {
        const sel = ['flm:left:1', 'flm:right:1', 'flm:left:5', 'flm:right:5', 'out:24', 'out:25'];
        const p = Effects.plan(sel, g21Lamps, Object.assign({ effect: e.id }, base));
        const byId = {}; g21Lamps.forEach((l) => { byId[l.id] = l; });
        p.steps.forEach((s) => {
            const sides = s.on.map((id) => byId[id]).filter((l) => l.route === 'flm').map((l) => l.side);
            assert.strictEqual(new Set(sides).size, sides.length, e.id + ': one channel per headlamp module per step');
        });
        assert.ok(p.estimateMs > 0 && p.estimateMs <= 180000);
    }
    const ww = Effects.plan(['flm:left:1', 'flm:right:1'], g21Lamps, Object.assign({ effect: 'wigwag' }, base));
    assert.deepStrictEqual(ww.steps.map((s) => s.on), [['flm:left:1'], ['flm:right:1']]);
    assert.throws(() => Effects.plan(['flm:left:1'], g21Lamps, Object.assign({ effect: 'wigwag' }, base)), /left and on the right/);
    assert.throws(() => Effects.plan(['flm:left:1'], g21Lamps, Object.assign({ effect: 'chase' }, base, { stepMs: 123 })), /step time/);
    assert.throws(() => Effects.plan([], g21Lamps, Object.assign({ effect: 'chase' }, base)), /at least one/);
    console.log('ok: every effect respects the one-channel-per-module rule and the limits');
}

/* ---------- names / observations / journal migration ---------- */
{
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'light-show-channel-names.json'), JSON.stringify({ names: { 'left:3': 'Low beam', 'right:20': 'x' } }));
    fs.writeFileSync(path.join(dir, 'light-show-observations.json'), JSON.stringify([
        { route: 'flm', side: 'left', channel: 3, result: 'visible, no unusual noise', cleanupConfirmed: true },
        { route: 'flm', side: 'left', channel: 4, result: 'visible, no unusual noise', cleanupConfirmed: false },
        { route: 'flm', side: 'right', channel: 2, result: 'visible, no unusual noise', cleanupConfirmed: true },
        { route: 'flm', side: 'right', channel: 2, result: 'visible and unusual noise', cleanupConfirmed: true },
    ]));
    const names = new Names(dir), obs = new Observations(dir);
    assert.strictEqual(names.name('flm:left:3'), 'Low beam');
    assert.strictEqual(obs.status('flm:left:3'), 'visible');
    assert.strictEqual(obs.status('flm:left:4'), 'untested', 'unconfirmed release never counts as visible');
    assert.strictEqual(obs.status('flm:right:2'), 'noise', 'noise wins');
    names.set('fn:high', 'Fernlicht');
    assert.strictEqual(new Names(dir).name('fn:high'), 'Fernlicht');
    assert.throws(() => names.set('fn:high', '<script>'), /Name must/);
    assert.strictEqual(migrateKey('left:15'), 'flm:left:15');
    assert.deepStrictEqual(Journal.migrate({ route: 'flm_show', sides: ['left', 'right'] }), { flmSides: ['left', 'right'] });
    assert.deepStrictEqual(Journal.migrate({ route: 'single', outputId: 24 }), { outputs: [24], bdcSession: true });
    const j = new Journal(dir);
    assert.throws(() => j.mark('0F2050', { flmSides: ['left'] }), /BDC_G05/);
    j.mark('0F2680', { flmSides: ['left'], outputs: [24] });
    assert.deepStrictEqual(new Journal(dir).control(), { flmSides: ['left'], fns: [], outputs: [24], bdcSession: true });
    fs.writeFileSync(path.join(dir, 'light-show-recovery.json'), '{broken');
    assert.strictEqual(new Journal(dir).control(), null, 'unreadable marker needs the manual light check');
    console.log('ok: 0.3.x names, observations and recovery markers are taken over safely');
}

/* ---------- runner ---------- */
class FakeLink {
    constructor(o) { this.o = o || {}; this.log = []; this.index = null; }
    rec(x) { this.log.push(x); if (this.o.failOn === x) throw new Error('NRC 22 on ' + x); return Promise.resolve([0x00]); }
    identify() { this.index = this.o.bdc || '0F2680'; if (this.index !== '0F2680') return Promise.reject(new Error('BDC variant')); return this.rec('id:bdc'); }
    identifyFlm(side) { if (!F.usable(side, this.o.flm || F.MODULES[side].index, this.o.exp)) return Promise.reject(new Error('FLM variant unsupported')); return this.rec('id:' + side); }
    session() { return this.rec('bdc:03'); }
    defaultSession() { return this.rec('bdc:01'); }
    keepalive() { return this.rec('bdc:3E'); }
    flmSession(s) { return this.rec(s + ':03'); }
    flmDefaultSession(s) { return this.rec(s + ':01'); }
    flmKeepalive(s) { return this.rec(s + ':3E'); }
    flmStart(s, c, pwm, sec) { F.start(c, pwm, sec); return this.rec(s + ':start' + c); }
    flmStop(s) { return this.rec(s + ':stop'); }
    timed(k, ms) { return this.rec('fn:' + k + ':' + ms); }
    set(id, on) { return this.rec('out:' + id + ':' + on); }
}
function runnerWith(link, guardReason) {
    const dir = tmp(), journal = new Journal(dir);
    let reason = guardReason || null;
    const guard = { reason: () => (typeof reason === 'function' ? reason() : reason) };
    const r = new Runner({ link, guard, journal, log: { warn() {}, info() {} }, sleep: () => Promise.resolve() });
    return { r, journal, setReason: (x) => { reason = x; } };
}
const byId = {}; g21Lamps.forEach((l) => { byId[l.id] = l; });
(async () => {
    {
        const link = new FakeLink(), { r, journal } = runnerWith(link);
        const plan = Effects.plan(['flm:left:1', 'flm:right:1', 'fn:high', 'out:24'], g21Lamps, Object.assign({ effect: 'chase' }, base, { cycles: 1 }));
        const res = await r.play(plan, byId);
        assert.ok(res.ok, JSON.stringify(res));
        const l = link.log;
        assert.deepStrictEqual(l.slice(0, 3), ['id:bdc', 'id:left', 'id:right'], 'identities before anything else');
        assert.ok(l.indexOf('left:start1') > l.indexOf('left:03'), 'session before control');
        assert.ok(l.indexOf('left:stop') > l.indexOf('left:start1'));
        assert.ok(l.indexOf('out:24:0') > l.indexOf('out:24:1'));
        assert.deepStrictEqual(l.slice(-7), ['left:stop', 'right:stop', 'fn:high:0', 'out:24:0', 'left:01', 'right:01', 'bdc:01'], 'full release at the end');
        assert.ok(!journal.pending());
        assert.strictEqual(r.status().state, 'IDLE');
        console.log('ok: a mixed show identifies, controls, switches off and releases every unit');
    }
    {
        const link = new FakeLink(), { r, journal } = runnerWith(link, 'Select P (Park)');
        const res = await r.test(byId['flm:left:1'], {});
        assert.ok(!res.ok); assert.deepStrictEqual(link.log, [], 'nothing sent when not parked');
        assert.ok(!journal.pending());
    }
    {
        let n = 0;
        const link = new FakeLink(), { r, journal } = runnerWith(link, () => (++n > 12 ? 'Vehicle must be stationary' : null));
        const plan = Effects.plan(['flm:left:1', 'flm:right:1'], g21Lamps, Object.assign({ effect: 'wigwag' }, base, { cycles: 10 }));
        const res = await r.play(plan, byId);
        assert.ok(res.ok && /stationary/.test(res.error), 'guard loss ends the show');
        assert.deepStrictEqual(link.log.slice(-4), ['left:stop', 'right:stop', 'left:01', 'right:01']);
        assert.ok(!journal.pending());
        console.log('ok: leaving P stops the show and still releases everything');
    }
    {
        const link = new FakeLink({ failOn: 'left:01' }), { r, journal } = runnerWith(link);
        await r.test(byId['flm:left:1'], {});
        assert.ok(journal.pending(), 'unconfirmed release keeps the marker');
        assert.strictEqual(r.status().state, 'ERROR');
        link.o.failOn = null;
        await r.stop();
        assert.ok(!journal.pending(), 'STOP releases what is left');
        console.log('ok: a failed release keeps the recovery marker until STOP succeeds');
    }
    {
        const link = new FakeLink({ flm: '0F26C8' }), { r, journal } = runnerWith(link);
        const laserLamp = Object.assign({}, byId['flm:left:1']);
        const res = await r.test(laserLamp, {});
        assert.ok(!res.ok && /unsupported/.test(res.error));
        assert.ok(!journal.pending()); assert.ok(link.log.every((x) => x.indexOf('id:') === 0));
        console.log('ok: experimental headlamp module refused without opt-in, nothing switched');
    }

    /* ---------- car3d ---------- */
    let polys = 0, dots = 0;
    Car3D.render({ poly: (p) => { polys++; assert.ok(p.length >= 3); }, dot: () => dots++ },
        { x: 0, y: 0, w: 600, h: 300, yaw: 0.8, pitch: -0.3 }, [{ points: [[0.6, 0.74, 2.3]], hex: '#ffffff', on: true }]);
    assert.ok(polys > 10 && dots >= 3);
    assert.ok(page.indexOf('Car3D') > 0 && page.indexOf('/api/state') > 0);
    console.log('ok: 3D car renders and the phone page embeds it');

    /* ---------- phone server ---------- */
    assert.ok(privateAddress('172.16.222.5') && privateAddress('192.168.1.2') && !privateAddress('8.8.8.8'));
    let shown = 0;
    const srv = new WebServer({ state: () => ({ hello: 1 }), stop: () => ({ ok: true }), show: (b) => { shown = b.effect; return { ok: true }; } },
        { warn() {} }, { port: 0, token: 'abc', address: () => '127.0.0.1' });
    srv.start();
    await new Promise((res) => srv.http.on('listening', res));
    const port = srv.http.address().port;
    const get = (p, opts) => new Promise((res, rej) => {
        const req = http.request(Object.assign({ host: '127.0.0.1', port, path: p }, opts || {}), (r) => {
            let b = ''; r.on('data', (d) => { b += d; }); r.on('end', () => res({ status: r.statusCode, body: b, headers: r.headers }));
        });
        req.on('error', rej);
        if (opts && opts.body) req.write(opts.body);
        req.end();
    });
    assert.strictEqual((await get('/?t=wrong')).status, 403);
    assert.strictEqual((await get('/?t=abc')).status, 200);
    assert.deepStrictEqual(JSON.parse((await get('/api/state?t=abc')).body), { hello: 1 });
    const h = await get('/.mgu-light-show-health');
    assert.strictEqual(h.status, 200); assert.strictEqual(h.headers['x-mgu-light-show'], '1');
    const posted = await get('/api/show?t=abc', { method: 'POST', body: JSON.stringify({ effect: 'chase' }), headers: { 'Content-Type': 'application/json' } });
    assert.strictEqual(posted.status, 200); assert.strictEqual(shown, 'chase');
    assert.strictEqual((await get('/api/scan?t=abc', { method: 'POST', body: '{}' })).status, 404, 'unknown action refused');
    assert.strictEqual((await get('/api/show?t=abc', { method: 'POST', body: 'x'.repeat(9000) })).status, 413);
    assert.ok(/:18880\/\?t=/.test(new WebServer({}, null, { token: 't', address: () => '172.16.222.97' }).url()));
    srv.stop();
    console.log('ok: phone server needs the pairing token, answers the helper probe, limits requests');
})().catch((e) => { console.error(e); process.exit(1); });
