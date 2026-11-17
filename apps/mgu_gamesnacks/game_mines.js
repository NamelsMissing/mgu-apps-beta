'use strict';

// Mines: open every field without a mine. Own implementation, Node 8 compatible.
// Touch: tap opens, hold flags. Controller: tilt or turn moves the cursor, press opens,
// a long press flags. The first field opened is never a mine.

const COLS = 18, ROWS = 8, MINES = 22;
const NUMBER = ['', '#7fb8ff', '#7fe0a0', '#ff8f8f', '#c9a0ff', '#ffbb6e', '#6fe3e3', '#f0f0f0', '#b0b8c0'];

class Mines {
    constructor(options) {
        this.random = (options && options.random) || Math.random;
        this.id = 'mines';
        this.title = 'Mines';
        this.repeat = true;
        this.cols = COLS; this.rows = ROWS; this.mines = MINES;
        this.reset();
    }
    reset() {
        const n = COLS * ROWS;
        this.mine = new Array(n).fill(false);
        this.open = new Array(n).fill(false);
        this.flag = new Array(n).fill(false);
        this.count = new Array(n).fill(0);
        this.placed = false; this.over = false; this.won = false;
        this.cursor = Math.floor(ROWS / 2) * COLS + Math.floor(COLS / 2);
        this.score = 0; this.time = 0;
    }
    neighbours(i) {
        const out = [], x = i % COLS, y = Math.floor(i / COLS);
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                if (!dx && !dy) continue;
                const nx = x + dx, ny = y + dy;
                if (nx >= 0 && ny >= 0 && nx < COLS && ny < ROWS) out.push(ny * COLS + nx);
            }
        }
        return out;
    }
    place(safe) {
        const keep = [safe].concat(this.neighbours(safe));
        const pool = [];
        for (let i = 0; i < COLS * ROWS; i++) if (keep.indexOf(i) < 0) pool.push(i);
        for (let k = 0; k < MINES && pool.length; k++) {
            const j = Math.min(pool.length - 1, Math.floor(this.random() * pool.length));
            this.mine[pool[j]] = true;
            pool.splice(j, 1);
        }
        for (let i = 0; i < COLS * ROWS; i++) {
            this.count[i] = this.neighbours(i).filter(n => this.mine[n]).length;
        }
        this.placed = true;
    }
    reveal(i) {
        if (this.over || this.open[i] || this.flag[i]) return;
        if (!this.placed) this.place(i);
        if (this.mine[i]) { this.open[i] = true; this.over = true; return; }
        const stack = [i];
        while (stack.length) {
            const c = stack.pop();
            if (this.open[c] || this.flag[c]) continue;
            this.open[c] = true;
            if (this.count[c] === 0) this.neighbours(c).forEach(n => { if (!this.open[n]) stack.push(n); });
        }
        this.score = this.open.filter(Boolean).length;
        if (this.score === COLS * ROWS - MINES) { this.won = true; this.over = true; }
    }
    // opening a number whose flags are complete opens the rest around it
    chord(i) {
        if (!this.open[i] || !this.count[i]) return;
        const around = this.neighbours(i);
        if (around.filter(n => this.flag[n]).length !== this.count[i]) return;
        around.forEach(n => this.reveal(n));
    }
    toggleFlag(i) {
        if (this.over || this.open[i]) return;
        this.flag[i] = !this.flag[i];
    }
    openAt(i) { if (this.open[i]) this.chord(i); else this.reveal(i); }
    moveCursor(dx, dy) {
        const x = (this.cursor % COLS + dx + COLS) % COLS;
        const y = (Math.floor(this.cursor / COLS) + dy + ROWS) % ROWS;
        this.cursor = y * COLS + x;
    }
    action(name) {
        if (this.over) { if (name === 'press' || name === 'tap') this.reset(); return; }
        if (name === 'left') this.moveCursor(-1, 0);
        else if (name === 'right') this.moveCursor(1, 0);
        else if (name === 'up') this.moveCursor(0, -1);
        else if (name === 'down') this.moveCursor(0, 1);
        else if (name === 'cw') this.cursor = (this.cursor + 1) % (COLS * ROWS);
        else if (name === 'ccw') this.cursor = (this.cursor + COLS * ROWS - 1) % (COLS * ROWS);
        else if (name === 'press') this.openAt(this.cursor);
        else if (name === 'long') this.toggleFlag(this.cursor);
    }
    cellAt(nx, ny) {
        const x = Math.floor(nx * COLS), y = Math.floor(ny * ROWS);
        if (x < 0 || y < 0 || x >= COLS || y >= ROWS) return -1;
        return y * COLS + x;
    }
    tap(nx, ny) {
        if (this.over) { this.reset(); return; }
        const i = this.cellAt(nx, ny);
        if (i < 0) return;
        this.cursor = i;
        this.openAt(i);
    }
    long(nx, ny) {
        const i = this.cellAt(nx, ny);
        if (i < 0) return;
        this.cursor = i;
        this.toggleFlag(i);
    }
    swipe() {}
    update(dt) { if (this.placed && !this.over) this.time += dt; }
    flags() { return this.flag.filter(Boolean).length; }
    message() {
        if (this.won) return 'Cleared in ' + Math.round(this.time / 1000) + ' s - tap or press for a new field';
        if (this.over) return 'Boom - tap or press for a new field';
        return '';
    }
    hint() { return 'Tap to open, hold to flag. Controller: move, press opens, long press flags.'; }
    stats() { return [['Mines left', MINES - this.flags()], ['Time', Math.floor(this.time / 1000) + ' s']]; }
    // the board's own box inside the game area (touch maps to it)
    boardBox(box) {
        const cell = Math.floor(Math.min(box.w / COLS, box.h / ROWS));
        const w = cell * COLS, h = cell * ROWS;
        return {x: box.x + Math.floor((box.w - w) / 2), y: box.y + Math.floor((box.h - h) / 2), w, h, cell};
    }
    draw(cv, box, t) {
        const b = this.boardBox(box), cell = b.cell;
        cv.roundRect(b.x - 6, b.y - 6, b.w + 12, b.h + 12, 12, '#1d2e40');
        for (let i = 0; i < COLS * ROWS; i++) {
            const x = b.x + (i % COLS) * cell, y = b.y + Math.floor(i / COLS) * cell;
            const shownMine = this.mine[i] && (this.open[i] || (this.over && !this.won));
            const fill = this.open[i] ? (this.mine[i] ? '#a63a3a' : '#22364a') : '#3a5068';
            cv.roundRect(x + 2, y + 2, cell - 4, cell - 4, 6, fill);
            if (shownMine) cv.circle(x + cell / 2, y + cell / 2, cell * 0.22, '#101820');
            else if (this.open[i] && this.count[i]) {
                const s = Math.round(cell * 0.5);
                cv.text(String(this.count[i]), x + cell / 2, y + cell / 2 + s * 0.36, s, NUMBER[this.count[i]], {align: 'center'});
            } else if (this.flag[i]) {
                cv.fillRect(x + cell * 0.42, y + cell * 0.22, 3, cell * 0.56, '#e8eef4');
                cv.quad([[x + cell * 0.45, y + cell * 0.22], [x + cell * 0.74, y + cell * 0.34],
                    [x + cell * 0.74, y + cell * 0.35], [x + cell * 0.45, y + cell * 0.46]], '#ff6a5a');
            }
            if (i === this.cursor && !this.over) cv.strokeRoundRect(x + 1, y + 1, cell - 2, cell - 2, 7, 3, t.accent);
        }
    }
}

module.exports = {Mines, COLS, ROWS, MINES};
