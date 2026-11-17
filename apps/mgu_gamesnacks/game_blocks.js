'use strict';

// Blocks: falling four-square pieces, full rows clear. Own implementation, Node 8 compatible.
// Input: tilt left/right moves, tilt down drops faster, tilt up or turning the controller rotates,
// pressing drops the piece. Touch: tap left / right third moves, tap the middle rotates,
// swipe down drops.

const COLS = 10, ROWS = 20;
const PIECES = [
    {name: 'I', color: '#5bd0f0', cells: [[0, 1], [1, 1], [2, 1], [3, 1]], size: 4},
    {name: 'O', color: '#f2d45c', cells: [[0, 0], [1, 0], [0, 1], [1, 1]], size: 2},
    {name: 'T', color: '#b688f0', cells: [[1, 0], [0, 1], [1, 1], [2, 1]], size: 3},
    {name: 'S', color: '#78dc8c', cells: [[1, 0], [2, 0], [0, 1], [1, 1]], size: 3},
    {name: 'Z', color: '#f2707a', cells: [[0, 0], [1, 0], [1, 1], [2, 1]], size: 3},
    {name: 'J', color: '#6c95f2', cells: [[0, 0], [0, 1], [1, 1], [2, 1]], size: 3},
    {name: 'L', color: '#f5a55a', cells: [[2, 0], [0, 1], [1, 1], [2, 1]], size: 3},
];
const LINE_POINTS = [0, 100, 300, 500, 800];

function rotate(cells, size, turns) {
    let out = cells;
    for (let i = 0; i < ((turns % 4) + 4) % 4; i++) out = out.map(c => [size - 1 - c[1], c[0]]);
    return out;
}

class Blocks {
    constructor(options) {
        this.random = (options && options.random) || Math.random;
        this.id = 'blocks';
        this.title = 'Blocks';
        this.repeat = true;
        this.reset();
    }
    reset() {
        this.board = [];
        for (let i = 0; i < ROWS; i++) this.board.push(new Array(COLS).fill(null));
        this.score = 0; this.lines = 0; this.level = 1; this.over = false;
        this.bag = [];
        this.next = this.draw7();
        this.acc = 0;
        this.spawn();
    }
    draw7() {
        if (!this.bag.length) {
            this.bag = PIECES.map((p, i) => i);
            for (let i = this.bag.length - 1; i > 0; i--) {
                const j = Math.min(i, Math.floor(this.random() * (i + 1)));
                const tmp = this.bag[i]; this.bag[i] = this.bag[j]; this.bag[j] = tmp;
            }
        }
        return this.bag.pop();
    }
    spawn() {
        const kind = this.next;
        this.next = this.draw7();
        const p = PIECES[kind];
        this.piece = {kind, rot: 0, x: Math.floor((COLS - p.size) / 2), y: kind === 0 ? -1 : 0};
        if (!this.fits(this.piece)) this.over = true;
    }
    cells(piece) {
        const p = PIECES[piece.kind];
        return rotate(p.cells, p.size, piece.rot).map(c => [c[0] + piece.x, c[1] + piece.y]);
    }
    fits(piece) {
        return this.cells(piece).every(c => c[0] >= 0 && c[0] < COLS && c[1] < ROWS &&
            (c[1] < 0 || !this.board[c[1]][c[0]]));
    }
    shift(dx, dy) {
        const moved = {kind: this.piece.kind, rot: this.piece.rot, x: this.piece.x + dx, y: this.piece.y + dy};
        if (!this.fits(moved)) return false;
        this.piece = moved;
        return true;
    }
    turn(dir) {
        for (const kick of [0, -1, 1, -2, 2]) {
            const moved = {kind: this.piece.kind, rot: this.piece.rot + dir, x: this.piece.x + kick, y: this.piece.y};
            if (this.fits(moved)) { this.piece = moved; return true; }
        }
        return false;
    }
    lock() {
        const color = PIECES[this.piece.kind].color;
        let above = false;
        this.cells(this.piece).forEach(c => {
            if (c[1] < 0) above = true;
            else this.board[c[1]][c[0]] = color;
        });
        if (above) { this.over = true; return; }
        const kept = this.board.filter(row => row.some(v => !v));
        const cleared = ROWS - kept.length;
        while (kept.length < ROWS) kept.unshift(new Array(COLS).fill(null));
        this.board = kept;
        if (cleared) {
            this.score += LINE_POINTS[cleared] * this.level;
            this.lines += cleared;
            this.level = 1 + Math.floor(this.lines / 10);
        }
        this.acc = 0;
        this.spawn();
    }
    drop() {
        let n = 0;
        while (this.shift(0, 1)) n++;
        this.score += n * 2;
        this.lock();
    }
    softDrop() {
        if (this.shift(0, 1)) { this.score += 1; this.acc = 0; } else this.lock();
    }
    interval() { return Math.max(90, 800 - (this.level - 1) * 70); }
    action(name) {
        if (this.over) { if (name === 'press' || name === 'tap') this.reset(); return; }
        if (name === 'left') this.shift(-1, 0);
        else if (name === 'right') this.shift(1, 0);
        else if (name === 'down') this.softDrop();
        else if (name === 'up' || name === 'cw') this.turn(1);
        else if (name === 'ccw') this.turn(-1);
        else if (name === 'press' || name === 'drop') this.drop();
    }
    tap(nx) {
        if (this.over) { this.reset(); return; }
        if (nx < 0.34) this.action('left');
        else if (nx > 0.66) this.action('right');
        else this.action('cw');
    }
    swipe(dir) {
        if (dir === 'down') this.action('drop');
        else if (dir === 'up') this.action('cw');
        else this.action(dir);
    }
    update(dt) {
        if (this.over) return;
        this.acc += Math.min(dt, 1000);
        while (this.acc >= this.interval() && !this.over) {
            this.acc -= this.interval();
            if (!this.shift(0, 1)) this.lock();
        }
    }
    ghostY() {
        let g = {kind: this.piece.kind, rot: this.piece.rot, x: this.piece.x, y: this.piece.y};
        while (this.fits({kind: g.kind, rot: g.rot, x: g.x, y: g.y + 1})) g.y++;
        return g;
    }
    message() { return this.over ? 'Game over - tap or press to play again' : ''; }
    hint() { return 'Tap left / right to move, middle to rotate, swipe down to drop.'; }
    stats() { return [['Lines', this.lines], ['Level', this.level]]; }
    draw(cv, box, t) {
        const cell = Math.floor(Math.min(box.h / ROWS, box.w / COLS));
        const w = cell * COLS, h = cell * ROWS;
        const x0 = box.x + Math.floor((box.w - w) / 2), y0 = box.y + Math.floor((box.h - h) / 2);
        cv.roundRect(x0 - 5, y0 - 5, w + 10, h + 10, 9, '#1d2e40');
        cv.fillRect(x0, y0, w, h, '#14222f');
        const square = (cx, cy, color, x, y, c) => {
            cv.roundRect((x === undefined ? x0 : x) + cx * (c || cell) + 1, (y === undefined ? y0 : y) + cy * (c || cell) + 1,
                (c || cell) - 2, (c || cell) - 2, 3, color);
        };
        for (let r = 0; r < ROWS; r++) {
            for (let c = 0; c < COLS; c++) if (this.board[r][c]) square(c, r, this.board[r][c]);
        }
        if (!this.over) {
            this.cells(this.ghostY()).forEach(c => { if (c[1] >= 0) square(c[0], c[1], '#2d4258'); });
            const color = PIECES[this.piece.kind].color;
            this.cells(this.piece).forEach(c => { if (c[1] >= 0) square(c[0], c[1], color); });
        }
        // next piece, right of the well
        const nx = x0 + w + 40, ny = y0 + 10, nc = Math.round(cell * 0.9), p = PIECES[this.next];
        cv.text('NEXT', nx, ny + 14, 18, '#90b0c9');
        p.cells.forEach(c => square(c[0], c[1], p.color, nx, ny + 30, nc));
        void t;
    }
}

module.exports = {Blocks, PIECES, COLS, ROWS, rotate};
