'use strict';

/**
 * MGU GameSnacks 0.2.0 - small games for the parked car.
 *  - Four own mini-games drawn natively on the head unit (2048, Snake, Blocks, Mines).
 *  - Web mirror: a Chromium on a Raspberry Pi / laptop in the car network opens gamesnacks.com
 *    (tools/gamesnacks_mirror.py); the picture is shown here, touches and the controller go back.
 * Everything runs only while the car stands still (fresh speed signal <= 0.5 km/h).
 * The app never writes to vehicle control units.
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const {setImage} = require('./kit/record');
const {Game2048} = require('./game_2048');
const {Snake} = require('./game_snake');
const {Blocks} = require('./game_blocks');
const {Mines} = require('./game_mines');
const {Gestures} = require('./touch_input');
const {IDriveInput} = require('./idrive_input');
const {MirrorClient} = require('./mirror_client');

const W = 1600, H = 520, IMAGE = 72;
const BOARD = {x: 440, y: 28, w: 1130, h: 470};
const FRAME = {x: 128, y: 18, w: 1462, h: 494};
const GAMES = [
    {make: () => new Game2048(), blurb: 'Slide and merge tiles', best: 'high'},
    {make: () => new Snake(), blurb: 'Eat and grow', best: 'high'},
    {make: () => new Blocks(), blurb: 'Fill and clear rows', best: 'high'},
    {make: () => new Mines(), blurb: 'Find the safe fields', best: 'low'},
];

function label(cv, value, x, y, size, color, extra) {
    cv.text(String(value).replace(/[^\x20-\x7e]/g, '?'), x, y, size, color, extra || {});
}
function clip(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 2) + '..' : s; }

mgu.run({
    async start(ctx) {
        const log = ctx.log;
        let page = 'home', selected = 0, game = null, gameIndex = 0;
        let speed = null, speedAt = 0, lastInputgateAt = 0, grabbed = false;
        let lastTick = Date.now(), frameShown = false, mirrorTouch = false;
        const safe = () => speed !== null && Date.now() - speedAt < 5000 && speed <= 0.5;
        const lockReason = () => speed === null || Date.now() - speedAt >= 5000
            ? 'Waiting for the vehicle speed signal' : 'Paused while the car is moving';
        const accent = () => ctx.settings.get('theme') === 'amber' ? '#f5ac5c' : '#5bc8f5';

        // ---- best scores (app data folder) ----
        const scoreFile = path.join(ctx.dataDir, 'gamesnacks-scores.json');
        let best = {};
        try { best = JSON.parse(fs.readFileSync(scoreFile, 'utf8')) || {}; } catch (e) { best = {}; }
        function record(g, value) {
            const kind = GAMES[gameIndex].best, old = best[g.id];
            if (typeof value !== 'number' || !(value > 0)) return;
            if (old !== undefined && (kind === 'high' ? value <= old : value >= old)) return;
            best[g.id] = value;
            try { fs.writeFileSync(scoreFile, JSON.stringify(best)); } catch (e) { log.warn('GameSnacks scores: ' + e.message); }
        }
        const bestText = id => {
            const v = best[id];
            if (v === undefined) return '-';
            return id === 'mines' ? Math.round(v / 1000) + ' s' : String(v);
        };
        function noteResult() {
            if (!game) return;
            if (game.id === 'mines') { if (game.won) record(game, game.time); } else record(game, game.score);
        }

        // ---- vehicle speed: fail closed ----
        ctx.signals.watch('de.bmw.infotainment.vehicle.Vehicle2', '1', {
            statusCarSpeed2: message => {
                const raw = message && message.speedVehicleCentreOfGravity;
                if (typeof raw === 'number' && isFinite(raw) && raw >= 0 && raw !== 65535) {
                    speed = raw * 0.015625;
                    speedAt = Date.now();
                }
            },
        }, log, {pollMs: 2000}).catch(err => log.warn('GameSnacks speed: ' + err.message));

        // ---- web mirror ----
        const mirror = new MirrorClient({
            log, dataDir: ctx.dataDir,
            onFrame: (w, h, rgba) => { setImage(IMAGE, w, h, rgba); frameShown = true; },
        });
        const applyQuality = () => {
            const before = mirror.quality;
            mirror.setView(FRAME.w, FRAME.h, ctx.settings.get('mirrorQuality'));
            if (before !== mirror.quality && mirror.socket) mirror.drop('Quality changed - reconnecting');
        };
        applyQuality();
        ctx.settings.onChange(key => { if (key === 'mirrorQuality') applyQuality(); });

        // ---- game input ----
        function act(name) {
            if (!game || !safe()) return;
            const wasOver = game.over;
            game.action(name);
            if (!wasOver && game.over) noteResult();
        }
        function gesture(e) {
            if (!game || !safe()) return;
            const wasOver = game.over;
            if (e.type === 'tap') { if (game.tap) game.tap(e.x, e.y); else game.action('tap'); }
            else if (e.type === 'long') { if (game.long) game.long(e.x, e.y); }
            else if (e.type === 'swipe') { if (game.swipe) game.swipe(e.dir); else game.action(e.dir); }
            if (!wasOver && game.over) noteResult();
        }
        const gestures = new Gestures(gesture);
        const idrive = new IDriveInput(e => {
            if (page === 'mirror') {
                if (!safe()) return;
                if (e.type === 'dir') mirror.key(e.dir);
                else if (e.type === 'turn') mirror.wheel(e.steps * 90);
                else if (e.type === 'press') mirror.key('enter');
                else if (e.type === 'long') mirror.nav('back');
                return;
            }
            if (e.type === 'dir') act(e.dir);
            else if (e.type === 'turn') {
                const n = Math.min(5, Math.abs(e.steps));
                for (let i = 0; i < n; i++) act(e.steps > 0 ? 'cw' : 'ccw');
            } else act(e.type);
        });
        if (ctx.controller && ctx.controller.onInput) ctx.controller.onInput(v => {
            lastInputgateAt = Date.now();
            idrive.raw(v);
        });
        ctx.signals.watch('de.bmw.infotainment.controlelements.FrontCCU', '1', {
            statusRotaryEncoderState: v => { if (Date.now() - lastInputgateAt > 1000) idrive.raw(v); },
        }, log).catch(e => log.warn('GameSnacks FrontCCU: ' + e.message));

        function syncCapture() {
            const want = (page === 'game' || page === 'mirror') && safe() &&
                ctx.ui.isVisible('MAIN') && (!ctx.ui.hasFocus || ctx.ui.hasFocus('MAIN'));
            if (want === grabbed) return;
            grabbed = want;
            idrive.setEnabled(want);
            if (ctx.controller) ctx.controller.grab(want);
        }
        const captureTimer = setInterval(syncCapture, 200);
        if (ctx.ui.onFocus) ctx.ui.onFocus(syncCapture);
        process.on('exit', () => {
            clearInterval(captureTimer);
            if (grabbed && ctx.controller) ctx.controller.grab(false);
            mirror.stop();
        });

        if (typeof ctx.onTouch === 'function') ctx.onTouch((phase, x, y) => {
            if (page === 'game') { gestures.touch(phase, x, y); return; }
            if (page !== 'mirror' || !mirror.socket || !safe()) { mirrorTouch = false; return; }
            const inside = x >= FRAME.x && x <= FRAME.x + FRAME.w && y >= FRAME.y && y <= FRAME.y + FRAME.h;
            if (phase === 1 && !inside) return;
            if (phase !== 1 && !mirrorTouch) return;
            const nx = Math.max(0, Math.min(1, (x - FRAME.x) / FRAME.w));
            const ny = Math.max(0, Math.min(1, (y - FRAME.y) / FRAME.h));
            mirrorTouch = phase !== 3;
            mirror.touch(phase === 1 ? 'down' : phase === 2 ? 'move' : 'up', nx, ny);
        });

        // ---- navigation ----
        function openGame(index) {
            noteResult();
            gameIndex = index; selected = index;
            game = GAMES[index].make();
            const g = game;
            gestures.setRect(g.boardBox ? g.boardBox(BOARD) : BOARD);
            idrive.repeat = !!g.repeat;
            page = 'game'; lastTick = Date.now();
            leaveMirror();
        }
        function openMirror() {
            noteResult();
            gestures.setRect(null);
            page = 'mirror'; selected = GAMES.length;
            mirror.start();
        }
        function leaveMirror() { mirror.stop(); frameShown = false; mirrorTouch = false; }
        function home() {
            noteResult();
            if (page === 'mirror') leaveMirror();
            gestures.setRect(null);
            page = 'home';
        }
        function newGame() {
            if (page === 'game' && game) { noteResult(); openGame(gameIndex); }
            else if (page === 'mirror') mirror.nav('home');
            else openGame(selected < GAMES.length ? selected : 0);
        }
        ctx.ui.onClick('BTN_HOME', home);
        ctx.ui.onClick('BTN_MIRROR', () => { if (page === 'mirror') home(); else openMirror(); });
        ctx.ui.onClick('BTN_NEW', newGame);

        // ---- drawing ----
        function button(cv, title, x, y, w, h, run, key, fill) {
            cv.roundRect(x, y, w, h, 11, fill || '#254563');
            label(cv, title, x + w / 2, y + h / 2 + 7, 20, '#f2f8ff', {align: 'center'});
            cv.target(x, y, w, h, run, key, 11);
        }
        function lockBadge(cv) {
            label(cv, safe() ? 'PARKED' : 'PLAY LOCKED', 1553, 47, 16, safe() ? '#90e6be' : '#ffbaaf', {align: 'right'});
        }
        function icon(cv, id, x, y, a) {
            if (id === '2048') {
                [['#e8edf2', 0, 0], ['#f59563', 1, 0], ['#edcf72', 0, 1], ['#3a4d61', 1, 1]].forEach(s =>
                    cv.roundRect(x + s[1] * 44, y + s[2] * 44, 40, 40, 8, s[0]));
            } else if (id === 'snake') {
                [[0, 2], [1, 2], [2, 2], [2, 1], [3, 1]].forEach((p, i) =>
                    cv.roundRect(x + p[0] * 22, y + p[1] * 22, 20, 20, 5, i === 4 ? a : '#7fd7a6'));
                cv.circle(x + 3.5 * 22 + 12, y + 0.5 * 22 + 10, 8, '#ff7a6b');
            } else if (id === 'blocks') {
                [['#b688f0', 1, 0], ['#b688f0', 0, 1], ['#b688f0', 1, 1], ['#b688f0', 2, 1],
                    ['#5bd0f0', 0, 3], ['#5bd0f0', 1, 3], ['#5bd0f0', 2, 3], ['#5bd0f0', 3, 3]].forEach(s =>
                    cv.roundRect(x + s[1] * 22, y + s[2] * 22, 20, 20, 4, s[0]));
            } else if (id === 'mines') {
                for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) cv.roundRect(x + c * 22, y + r * 22 + 10, 20, 20, 4, r === 1 && c === 2 ? '#22364a' : '#3a5068');
                cv.circle(x + 2 * 22 + 10, y + 22 + 20, 6, '#101820');
            } else {
                cv.roundRect(x, y + 4, 88, 66, 10, '#20344a');
                cv.fillRect(x, y + 4, 88, 14, a);
                cv.circle(x + 8, y + 11, 3, '#0c1726'); cv.circle(x + 17, y + 11, 3, '#0c1726');
                cv.roundRect(x + 20, y + 30, 48, 30, 6, '#3a5068');
                cv.quad([[x + 39, y + 37], [x + 52, y + 45], [x + 52, y + 46], [x + 39, y + 54]], '#f2f8ff');
            }
        }
        function drawHome(cv, a) {
            label(cv, 'MGU / GAMESNACKS', 47, 48, 23, '#a8cbe0');
            lockBadge(cv);
            const tiles = GAMES.map((g, i) => {
                const proto = g.make();
                return {id: proto.id, title: proto.title, blurb: g.blurb, foot: 'Best ' + bestText(proto.id), run: () => openGame(i)};
            });
            const conn = mirror.state === 'connected' ? 'Connected' : 'Pi / laptop browser';
            tiles.push({id: 'mirror', title: 'Web mirror', blurb: 'gamesnacks.com', foot: conn, run: openMirror});
            tiles.forEach((t, i) => {
                const x = 40 + i * 308, y = 82, w = 292, h = 330, cur = i === selected;
                cv.roundRect(x, y, w, h, 18, cur ? '#20435b' : '#182a3c');
                if (cur) cv.strokeRoundRect(x, y, w, h, 18, 3, a);
                icon(cv, t.id, x + 34, y + 40, a);
                label(cv, t.title, x + 34, y + 190, 32, '#f1f8ff');
                label(cv, t.blurb, x + 34, y + 226, 19, '#a7bed2');
                label(cv, t.foot, x + 34, y + 296, 18, i === GAMES.length ? '#9fd6f2' : '#ffd08b');
                cv.target(x, y, w, h, t.run, 'TILE_' + t.id, 18);
            });
            label(cv, safe() ? 'Tap a tile to play. Only while the car stands still.'
                : lockReason() + ' - games start once the car stands still.', 47, 470, 20, safe() ? '#b4cbe0' : '#ffc994');
        }
        function drawGame(cv, a) {
            const g = game;
            label(cv, g.title, 47, 70, 40, '#f7fbff');
            cv.fillRect(47, 88, 340, 3, a);
            const rows = [['Score', g.id === 'mines' ? g.score + ' / ' + (g.cols * g.rows - g.mines) : g.score],
                ['Best', bestText(g.id)]].concat(g.stats ? g.stats() : []);
            rows.forEach((r, i) => {
                label(cv, r[0].toUpperCase(), 47, 128 + i * 44, 16, '#90b0c9');
                label(cv, r[1], 387, 128 + i * 44, 26, '#f2f8ff', {align: 'right'});
            });
            const hint = g.hint(), words = hint.split(' ');
            let line = '', y = 330;
            words.forEach(word => {
                if ((line + ' ' + word).length > 34) { label(cv, line, 47, y, 16, '#8aa6bd'); y += 22; line = word; }
                else line = line ? line + ' ' + word : word;
            });
            if (line) label(cv, line, 47, y, 16, '#8aa6bd');
            button(cv, 'New game', 47, 440, 160, 52, () => openGame(gameIndex), 'NEW_GAME');
            button(cv, 'Games', 227, 440, 160, 52, home, 'HOME');
            g.draw(cv, BOARD, {accent: a});
            const msg = !safe() ? lockReason() : g.message();
            if (msg) {
                const w = Math.min(1100, 60 + msg.length * 11);
                cv.roundRect(BOARD.x + (BOARD.w - w) / 2, BOARD.y + BOARD.h / 2 - 34, w, 68, 14, '#0a1420e0');
                label(cv, msg, BOARD.x + BOARD.w / 2, BOARD.y + BOARD.h / 2 + 8, 22, safe() ? '#ffffff' : '#ffc994', {align: 'center'});
            }
        }
        function drawMirror(cv, a) {
            const st = mirror.status || {};
            const tools = [['Back', () => mirror.nav('back')], ['Home', () => mirror.nav('home')],
                ['Reload', () => mirror.nav('reload')], ['Exit', home]];
            tools.forEach((t, i) => button(cv, t[0], 12, 18 + i * 62, 104, 52, t[1], 'MIRROR_' + t[0].toUpperCase(),
                i === 3 ? '#3c3448' : '#254563'));
            const on = mirror.state === 'connected';
            cv.circle(24, 296, 7, on ? '#6eebbb' : '#ffc483');
            label(cv, on ? 'LIVE' : 'WAIT', 38, 302, 16, on ? '#90e6be' : '#ffd095');
            label(cv, safe() ? 'PARKED' : 'LOCKED', 12, 334, 15, safe() ? '#90e6be' : '#ffbaaf');
            if (on && frameShown && safe()) {
                cv.image(IMAGE, FRAME.x, FRAME.y, FRAME.w, FRAME.h);
                if (st.error) {
                    cv.roundRect(FRAME.x + 20, FRAME.y + FRAME.h - 58, FRAME.w - 40, 42, 9, '#482d34');
                    label(cv, clip(st.error, 120), FRAME.x + 36, FRAME.y + FRAME.h - 30, 17, '#ffccbb');
                }
                return;
            }
            cv.roundRect(FRAME.x, FRAME.y, FRAME.w, FRAME.h, 18, '#14263a');
            const x = FRAME.x + 40;
            if (!safe()) {
                label(cv, 'Web mirror paused', x, 90, 34, '#f7fbff');
                label(cv, lockReason() + '. The browser on the mirror host is frozen meanwhile.', x, 132, 20, '#ffc994');
                return;
            }
            label(cv, on ? 'Connected to ' + clip(mirror.host && mirror.host.name, 40) + ' - waiting for the picture'
                : 'Looking for the mirror host', x, 90, 32, '#f7fbff');
            const lines = [
                'The web mirror shows a Chromium browser that runs on a Raspberry Pi or laptop in the car.',
                '1.  Connect the Pi / laptop to the BMW Wi-Fi hotspot (or the head unit\'s USB network).',
                '2.  On it run:  python3 tools/gamesnacks_mirror.py   (from the mgu-apps-beta repository)',
                '3.  This page connects by itself to port 18960 and shows gamesnacks.com. Touch works as on a phone.',
                'Controller: tilt = arrow keys, turn = scroll, press = Enter, long press = back.',
                'Other address: put {"hosts": ["192.168.1.20"]} into mirror-host.json in the app data folder.',
            ];
            lines.forEach((l, i) => label(cv, l, x, 140 + i * 34, 19, i === 0 ? '#b7d2e8' : '#93afc6'));
            label(cv, 'Status: ' + clip(mirror.detail || mirror.state, 110), x, 372, 18, '#ffd095');
            if (mirror.tried.length) label(cv, 'Checked: ' + clip(mirror.tried.join(', '), 120), x, 400, 16, '#7f9bb2');
            void a;
        }

        ctx.loop('MAIN', 20, () => {
            syncCapture();
            const now = Date.now(), dt = now - lastTick;
            lastTick = now;
            const visible = ctx.ui.isVisible('MAIN');
            if (page === 'game' && game && safe() && visible) {
                gestures.poll();
                idrive.poll();
                const wasOver = game.over;
                game.update(dt);
                if (!wasOver && game.over) noteResult();
            } else if (page === 'mirror') {
                idrive.poll();
                mirror.setPaused(!safe() || !visible);
            }
            const cv = ctx.canvas(W, H), a = accent();
            cv.clear('#0c1726');
            if (page !== 'mirror') cv.fillRect(0, 0, W, 8, a);
            if (page === 'game' && game) drawGame(cv, a);
            else if (page === 'mirror') drawMirror(cv, a);
            else drawHome(cv, a);
            return ctx.ui.image('MAIN_GFX', cv);
        });
    },
});
