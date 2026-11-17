'use strict';

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const APP = path.join(__dirname, '../apps/mgu_gamesnacks');
const {Game2048} = require(APP + '/game_2048');
const {Snake} = require(APP + '/game_snake');
const {Blocks, PIECES, rotate} = require(APP + '/game_blocks');
const {Mines, COLS: MCOLS, ROWS: MROWS, MINES} = require(APP + '/game_mines');
const {normalizeTouch, Gestures} = require(APP + '/touch_input');
const {IDriveInput} = require(APP + '/idrive_input');
const P = require(APP + '/mirror_protocol');
const {MirrorClient, parseArp, parseHost} = require(APP + '/mirror_client');

function seeded(seed) {
    let s = seed >>> 0;
    return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

// ---- manifest / store ----
const spec = JSON.parse(fs.readFileSync(path.join(APP, 'app.json'), 'utf8'));
const store = JSON.parse(fs.readFileSync(path.join(__dirname, '../mgu-repo.json'), 'utf8'));
assert.strictEqual(spec.id, 'mgu_gamesnacks');
assert.ok(spec.signals['de.bmw.infotainment.vehicle.Vehicle2']);
assert.ok(spec.signals['de.bmw.infotainment.controlelements.FrontCCU']);
assert.ok(store.components.some(c => c.id === spec.id && c.version === spec.version && c.title === spec.title));
// the build copies only top-level .js files: no sub-folders with code
fs.readdirSync(APP).forEach(f => assert.ok(!fs.statSync(path.join(APP, f)).isDirectory(), f + ' is a folder'));
console.log('ok: manifest and store entry');

// ---- 2048 ----
assert.deepStrictEqual(Game2048.slide([2, 2, 2, 2]), {line: [4, 4, 0, 0], gained: 8});
assert.deepStrictEqual(Game2048.slide([2, 0, 2, 4]), {line: [4, 4, 0, 0], gained: 4});
assert.deepStrictEqual(Game2048.slide([4, 4, 8, 0]), {line: [8, 8, 0, 0], gained: 8});
{
    const g = new Game2048({random: seeded(1)});
    assert.strictEqual(g.grid.filter(Boolean).length, 2);
    g.grid = [2, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    assert.ok(g.move('left'));
    assert.strictEqual(g.grid[0], 4);
    assert.strictEqual(g.score, 4);
    assert.strictEqual(g.grid.filter(Boolean).length, 2, 'one new tile after a move');
    g.grid = [2, 4, 2, 4, 4, 2, 4, 2, 2, 4, 2, 4, 4, 2, 4, 2];
    assert.ok(!g.canMove());
    g.grid = [2, 4, 2, 4, 4, 2, 4, 2, 2, 4, 2, 4, 4, 2, 2, 8]; // 2 next to 2 in the last row
    assert.ok(g.canMove());
    g.over = true; g.action('press');
    assert.ok(!g.over && g.score === 0, 'press restarts after game over');
}
console.log('ok: 2048 merging, scoring, game over');

// ---- Snake ----
{
    const s = new Snake({random: seeded(2)});
    assert.ok(!s.started);
    s.update(1000);
    assert.deepStrictEqual(s.body[0], [6, 6], 'waits for the first input');
    s.action('right');
    s.action('press');
    s.update(s.interval());
    assert.deepStrictEqual(s.body[0], [7, 6]);
    s.action('left');               // reverse is ignored
    s.update(s.interval());
    assert.deepStrictEqual(s.body[0], [8, 6]);
    s.action('cw');                 // right -> down
    s.update(s.interval());
    assert.deepStrictEqual(s.body[0], [8, 7]);
    s.food = [8, 8];
    s.update(s.interval());
    assert.strictEqual(s.score, 1);
    assert.strictEqual(s.body.length, 4);
    for (let i = 0; i < 20 && !s.over; i++) s.update(s.interval());
    assert.ok(s.over, 'hits the bottom wall');
    // tap above the head while moving right turns up
    const t = new Snake({random: seeded(3)});
    t.action('press');
    t.tap(0.5, 0.0);
    assert.deepStrictEqual(t.queue, ['up']);
}
console.log('ok: snake steering, growth, wall');

// ---- Blocks ----
{
    assert.deepStrictEqual(rotate([[0, 0]], 3, 1), [[2, 0]]);
    const b = new Blocks({random: seeded(4)});
    assert.strictEqual(PIECES.length, 7);
    const seen = {};
    b.bag = [];
    for (let i = 0; i < 7; i++) seen[b.draw7()] = true;
    assert.strictEqual(Object.keys(seen).length, 7, 'bag deals all seven pieces');
    b.reset();
    const x = b.piece.x;
    b.action('left');
    assert.strictEqual(b.piece.x, x - 1);
    for (let i = 0; i < 12; i++) b.action('left');
    assert.ok(b.cells(b.piece).every(c => c[0] >= 0), 'stays inside the well');
    // fill the bottom row except where an I piece lands
    b.reset();
    b.board[19] = new Array(10).fill('#fff');
    for (let c = 3; c <= 6; c++) b.board[19][c] = null;
    b.piece = {kind: 0, rot: 0, x: 3, y: -1};
    b.action('press');
    assert.strictEqual(b.lines, 1);
    assert.ok(b.score >= 100);
    assert.ok(b.board[19].every(v => !v), 'cleared row removed');
    // gravity
    const y = b.piece.y;
    b.update(b.interval());
    assert.strictEqual(b.piece.y, y + 1);
    // stacking to the top ends the game
    for (let i = 0; i < 40 && !b.over; i++) b.action('press');
    assert.ok(b.over);
}
console.log('ok: blocks moves, rotation, line clear, game over');

// ---- Mines ----
{
    const m = new Mines({random: seeded(5)});
    const first = 3 * MCOLS + 5;
    m.reveal(first);
    assert.ok(m.placed);
    assert.strictEqual(m.mine.filter(Boolean).length, MINES);
    assert.ok(!m.mine[first] && m.neighbours(first).every(n => !m.mine[n]), 'first field and its neighbours are safe');
    assert.ok(m.open[first] && m.count[first] === 0 && m.score > 1, 'flood fill opened an area');
    const hidden = m.mine.findIndex((v, i) => !v && !m.open[i]);
    m.toggleFlag(hidden);
    assert.ok(m.flag[hidden]);
    m.reveal(hidden);
    assert.ok(!m.open[hidden], 'flagged field does not open');
    m.toggleFlag(hidden);
    // open every safe field -> win
    for (let i = 0; i < MCOLS * MROWS; i++) if (!m.mine[i]) m.reveal(i);
    assert.ok(m.won && m.over);
    const n = new Mines({random: seeded(6)});
    n.reveal(0);
    const mine = n.mine.indexOf(true);
    n.reveal(mine);
    assert.ok(n.over && !n.won);
    // controller cursor
    const c = new Mines({random: seeded(7)});
    const start = c.cursor;
    c.action('right'); c.action('down');
    assert.strictEqual(c.cursor, start + 1 + MCOLS);
    c.action('long');
    assert.ok(c.flag[c.cursor]);
}
console.log('ok: mines safe first field, flood fill, flags, win/lose');

// ---- touch ----
assert.deepStrictEqual(normalizeTouch(1, 100, 200, {x: 0, y: 100, w: 200, h: 200}), {phase: 'down', x: 0.5, y: 0.5});
assert.strictEqual(normalizeTouch(4, 100, 200, {x: 0, y: 100, w: 200, h: 200}), null);
{
    let now = 0;
    const got = [];
    const g = new Gestures(e => got.push(e), {now: () => now});
    g.setRect({x: 100, y: 100, w: 200, h: 100});
    g.touch(1, 150, 150); now = 100; g.touch(3, 152, 151);
    assert.deepStrictEqual(got.pop(), {type: 'tap', x: 0.25, y: 0.5});
    g.touch(1, 150, 150); g.touch(2, 260, 160); g.touch(3, 270, 160);
    assert.deepStrictEqual(got.pop(), {type: 'swipe', dir: 'right'});
    g.touch(1, 150, 120); g.touch(3, 150, 199);
    assert.deepStrictEqual(got.pop(), {type: 'swipe', dir: 'down'});
    now = 1000; g.touch(1, 200, 150); now = 1600; g.poll();
    assert.strictEqual(got.pop().type, 'long');
    g.touch(3, 200, 150);
    assert.strictEqual(got.length, 0, 'no tap after a long press');
    g.touch(1, 10, 10); g.touch(3, 10, 10);
    assert.strictEqual(got.length, 0, 'touch outside the board ignored');
}
console.log('ok: touch tap / swipe / long press');

// ---- iDrive ----
{
    let now = 0;
    const got = [];
    const d = new IDriveInput(e => got.push(e), {now: () => now});
    d.raw({frontRotaryEncoderOperation: 10, frontRotaryEncoderDeflection: 0, frontRotaryEncoderPushButton: 0});
    d.setEnabled(true);
    d.raw({frontRotaryEncoderOperation: 12, frontRotaryEncoderDeflection: 0, frontRotaryEncoderPushButton: 0});
    assert.deepStrictEqual(got.pop(), {type: 'turn', steps: 2});
    d.raw({frontRotaryEncoderOperation: 65535, frontRotaryEncoderDeflection: 0, frontRotaryEncoderPushButton: 0});
    assert.deepStrictEqual(got.pop(), {type: 'turn', steps: -13}, 'wraps around 0');
    d.raw({frontRotaryEncoderOperation: 65535, frontRotaryEncoderDeflection: 'WEST_KURZ_GEDRUECKT', frontRotaryEncoderPushButton: 0});
    assert.deepStrictEqual(got.pop(), {type: 'dir', dir: 'left'});
    d.repeat = true; now = 200; d.poll();
    assert.strictEqual(got.length, 0);
    now = 300; d.poll();
    assert.deepStrictEqual(got.pop(), {type: 'dir', dir: 'left'}, 'held tilt repeats');
    d.raw({frontRotaryEncoderOperation: 65535, frontRotaryEncoderDeflection: 0, frontRotaryEncoderPushButton: 1});
    d.raw({frontRotaryEncoderOperation: 65535, frontRotaryEncoderDeflection: 0, frontRotaryEncoderPushButton: 0});
    assert.deepStrictEqual(got.pop(), {type: 'press'});
    d.raw({frontRotaryEncoderOperation: 65535, frontRotaryEncoderDeflection: 0, frontRotaryEncoderPushButton: 1});
    now = 1000; d.poll();
    assert.deepStrictEqual(got.pop(), {type: 'long'});
    d.raw({frontRotaryEncoderOperation: 65535, frontRotaryEncoderDeflection: 0, frontRotaryEncoderPushButton: 0});
    assert.strictEqual(got.length, 0, 'release after long press is not a press');
    d.setEnabled(false);
    d.raw({frontRotaryEncoderOperation: 3, frontRotaryEncoderDeflection: 7, frontRotaryEncoderPushButton: 0});
    assert.strictEqual(got.length, 0, 'disabled: nothing emitted');
}
console.log('ok: iDrive tilt, turn, press, long press, repeat');

// ---- protocol ----
{
    const dec = new P.Decoder();
    const a = P.encode(P.TYPE.STATUS, {title: 'x'});
    const f = P.encodeFrame(2, 1, 9, Buffer.from([1, 2, 3]));
    const all = Buffer.concat([a, f]);
    const out = dec.push(all.slice(0, 7)).concat(dec.push(all.slice(7)));
    assert.strictEqual(out.length, 2);
    assert.deepStrictEqual(P.json(out[0].body), {title: 'x'});
    const fr = P.decodeFrame(out[1].body);
    assert.deepStrictEqual([fr.width, fr.height, fr.seq, fr.format], [2, 1, 9, 1]);
    const bad = Buffer.alloc(5); bad.writeUInt32BE(P.MAX_MESSAGE + 1, 0);
    assert.throws(() => new P.Decoder().push(bad));
    assert.deepStrictEqual(P.json(Buffer.from('nope')), {});
}
console.log('ok: mirror protocol framing');

// ---- discovery ----
{
    const arp = 'IP address       HW type     Flags       HW address            Mask     Device\n' +
        '172.16.222.42    0x1         0x2         b8:27:eb:00:00:01     *        wlan_bridge\n' +
        '172.16.222.43    0x1         0x0         00:00:00:00:00:00     *        wlan_bridge\n' +
        '160.48.199.1     0x1         0x2         02:00:00:00:00:02     *        eth0\n';
    assert.deepStrictEqual(parseArp(arp), [{ip: '172.16.222.42', device: 'wlan_bridge'}, {ip: '160.48.199.1', device: 'eth0'}]);
    assert.deepStrictEqual(parseHost('pi.local:9000', 18960), {host: 'pi.local', port: 9000});
    assert.deepStrictEqual(parseHost('10.0.0.2', 18960), {host: '10.0.0.2', port: 18960});
    assert.strictEqual(parseHost('a b', 1), null);
    const c = new MirrorClient({dataDir: '/x', readFile: f => f.endsWith('mirror-host.json') ? '{"hosts":["10.0.0.9","172.16.222.42"]}' : arp});
    assert.deepStrictEqual(c.candidates().map(h => h.host), ['10.0.0.9', '172.16.222.42', '160.48.199.1']);
    c.setView(1462, 494, 'fast');
    assert.deepStrictEqual(c.frameSize(), {width: 585, height: 198});
}
console.log('ok: host discovery from ARP table and mirror-host.json');

// ---- client against a local fake host ----
(async () => {
    const received = [];
    const server = net.createServer(sock => {
        const dec = new P.Decoder();
        sock.on('data', chunk => dec.push(chunk).forEach(m => {
            received.push(m);
            if (m.type === P.TYPE.HELLO) {
                const hello = P.json(m.body);
                sock.write(P.encode(P.TYPE.WELCOME, {proto: 1, host: 'test host', url: 'https://gamesnacks.com/'}));
                const w = hello.frameWidth, h = hello.frameHeight, rgba = Buffer.alloc(w * h * 4, 7);
                sock.write(P.encodeFrame(w, h, 1, zlib.deflateSync(rgba)));
                sock.write(P.encode(P.TYPE.STATUS, {url: 'https://gamesnacks.com/', title: 'GameSnacks'}));
            }
        }));
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsn-'));
    fs.writeFileSync(path.join(dir, 'mirror-host.json'), JSON.stringify({hosts: ['127.0.0.1:' + port]}));
    let frame = null;
    const client = new MirrorClient({dataDir: dir, port: 1, readFile: f => f.indexOf('/proc/') === 0 ? '' : fs.readFileSync(f, 'utf8'),
        onFrame: (w, h, rgba, seq) => { frame = {w, h, rgba, seq}; }});
    client.setView(400, 200, 'balanced');
    client.start();
    const wait = async cond => { for (let i = 0; i < 100 && !cond(); i++) await new Promise(r => setTimeout(r, 20)); assert.ok(cond()); };
    await wait(() => frame && client.status.title === 'GameSnacks');
    assert.strictEqual(client.state, 'connected');
    assert.strictEqual(client.host.name, 'test host');
    assert.deepStrictEqual([frame.w, frame.h, frame.rgba[0], frame.seq], [240, 120, 7, 1]);
    client.touch('down', 0.5, 0.5); client.key('enter'); client.nav('back'); client.setPaused(true);
    await wait(() => received.some(m => m.type === P.TYPE.PAUSE));
    const types = received.map(m => m.type);
    [P.TYPE.HELLO, P.TYPE.FRAME_ACK, P.TYPE.INPUT, P.TYPE.NAV, P.TYPE.PAUSE].forEach(t => assert.ok(types.indexOf(t) >= 0, 'sent ' + t));
    assert.deepStrictEqual(P.json(received.find(m => m.type === P.TYPE.HELLO).body).frameWidth, 240);
    client.stop();
    assert.strictEqual(client.state, 'idle');
    server.close();
    console.log('ok: mirror client connects, shows frames, sends input / navigation / pause');
})().catch(e => { console.error(e); process.exit(1); });
