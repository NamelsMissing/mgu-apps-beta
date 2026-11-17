'use strict';

// Snake: eat, grow, don't hit the wall or yourself. Own implementation, Node 8 compatible.
// Input: swipe / tilt sets the direction; turning the controller turns left or right;
// a tap beside the head turns towards it.

const COLS = 30, ROWS = 12;
const VEC = {up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0]};
const CW = {up: 'right', right: 'down', down: 'left', left: 'up'};
const CCW = {up: 'left', left: 'down', down: 'right', right: 'up'};
const OPPOSITE = {up: 'down', down: 'up', left: 'right', right: 'left'};

class Snake {
    constructor(options) {
        this.random = (options && options.random) || Math.random;
        this.id = 'snake';
        this.title = 'Snake';
        this.repeat = false;
        this.cols = COLS; this.rows = ROWS;
        this.reset();
    }
    reset() {
        const y = Math.floor(ROWS / 2);
        this.body = [[6, y], [5, y], [4, y]];
        this.dir = 'right';
        this.queue = [];
        this.score = 0; this.over = false; this.started = false;
        this.acc = 0;
        this.placeFood();
    }
    interval() { return Math.max(70, 150 - this.score * 3); }
    placeFood() {
        const free = [];
        for (let y = 0; y < ROWS; y++) {
            for (let x = 0; x < COLS; x++) {
                if (!this.body.some(p => p[0] === x && p[1] === y)) free.push([x, y]);
            }
        }
        this.food = free.length ? free[Math.min(free.length - 1, Math.floor(this.random() * free.length))] : null;
    }
    lastDir() { return this.queue.length ? this.queue[this.queue.length - 1] : this.dir; }
    turn(dir) {
        if (!VEC[dir] || this.queue.length >= 2) return;
        const last = this.lastDir();
        if (dir === last || dir === OPPOSITE[last]) return;
        this.queue.push(dir);
        this.started = true;
    }
    action(name) {
        if (this.over) { if (name === 'press' || name === 'tap') this.reset(); return; }
        if (name === 'cw') this.turn(CW[this.lastDir()]);
        else if (name === 'ccw') this.turn(CCW[this.lastDir()]);
        else if (name === 'press' || name === 'tap') this.started = true;
        else this.turn(name);
    }
    // nx, ny: 0..1 inside the board
    tap(nx, ny) {
        if (this.over || !this.started) { this.action('tap'); return; }
        const head = this.body[0];
        const hx = (head[0] + 0.5) / COLS, hy = (head[1] + 0.5) / ROWS;
        const d = this.lastDir();
        if (d === 'left' || d === 'right') this.turn(ny < hy ? 'up' : 'down');
        else this.turn(nx < hx ? 'left' : 'right');
    }
    step() {
        if (this.queue.length) this.dir = this.queue.shift();
        const v = VEC[this.dir], head = this.body[0];
        const next = [head[0] + v[0], head[1] + v[1]];
        const eating = this.food && next[0] === this.food[0] && next[1] === this.food[1];
        const body = eating ? this.body : this.body.slice(0, -1);
        if (next[0] < 0 || next[1] < 0 || next[0] >= COLS || next[1] >= ROWS ||
            body.some(p => p[0] === next[0] && p[1] === next[1])) {
            this.over = true;
            return;
        }
        this.body = [next].concat(body);
        if (eating) { this.score++; this.placeFood(); if (!this.food) this.over = true; }
    }
    update(dt) {
        if (this.over || !this.started) return;
        this.acc += Math.min(dt, 500);
        while (this.acc >= this.interval() && !this.over) {
            this.acc -= this.interval();
            this.step();
        }
    }
    message() {
        if (this.over) return 'Game over - tap or press to play again';
        if (!this.started) return 'Swipe, tilt or tap to start';
        return '';
    }
    hint() { return 'Swipe or tilt to steer, turn the controller to turn left / right.'; }
    boardBox(box) {
        const cell = Math.floor(Math.min(box.w / COLS, box.h / ROWS));
        const w = cell * COLS, h = cell * ROWS;
        return {x: box.x + Math.floor((box.w - w) / 2), y: box.y + Math.floor((box.h - h) / 2), w, h, cell};
    }
    draw(cv, box, t) {
        const b = this.boardBox(box), cell = b.cell, w = b.w, h = b.h, x0 = b.x, y0 = b.y;
        cv.roundRect(x0 - 6, y0 - 6, w + 12, h + 12, 12, '#1d2e40');
        cv.fillRect(x0, y0, w, h, '#14222f');
        if (this.food) {
            cv.circle(x0 + (this.food[0] + 0.5) * cell, y0 + (this.food[1] + 0.5) * cell, cell * 0.36, '#ff7a6b');
        }
        this.body.forEach((p, i) => {
            const pad = i === 0 ? 1 : 3;
            cv.roundRect(x0 + p[0] * cell + pad, y0 + p[1] * cell + pad, cell - pad * 2, cell - pad * 2,
                Math.max(3, cell * 0.25), i === 0 ? t.accent : '#7fd7a6');
        });
    }
}

module.exports = {Snake, COLS, ROWS};
