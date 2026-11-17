'use strict';

// "2048": slide numbered tiles, equal tiles merge. Own implementation, Node 8 compatible.
// Input: swipe or iDrive tilt in four directions. Press/tap after game over starts again.

const SIZE = 4;
const TILE = {
    2: ['#e8edf2', '#24313d'], 4: ['#dfe7ee', '#24313d'], 8: ['#f3b27a', '#ffffff'],
    16: ['#f59563', '#ffffff'], 32: ['#f67c5f', '#ffffff'], 64: ['#f65e3b', '#ffffff'],
    128: ['#edcf72', '#ffffff'], 256: ['#edcc61', '#ffffff'], 512: ['#edc850', '#ffffff'],
    1024: ['#edc53f', '#ffffff'], 2048: ['#edc22e', '#ffffff'],
};

class Game2048 {
    constructor(options) {
        this.random = (options && options.random) || Math.random;
        this.id = '2048';
        this.title = '2048';
        this.repeat = false;
        this.reset();
    }
    reset() {
        this.grid = [];
        for (let i = 0; i < SIZE * SIZE; i++) this.grid.push(0);
        this.score = 0; this.over = false; this.won = false; this.wonShown = false;
        this.spawn(); this.spawn();
    }
    empty() {
        const cells = [];
        this.grid.forEach((v, i) => { if (!v) cells.push(i); });
        return cells;
    }
    spawn() {
        const cells = this.empty();
        if (!cells.length) return false;
        const i = cells[Math.min(cells.length - 1, Math.floor(this.random() * cells.length))];
        this.grid[i] = this.random() < 0.9 ? 2 : 4;
        return true;
    }
    // line: values from the side the tiles move towards. Returns {line, gained}.
    static slide(line) {
        const vals = line.filter(v => v), out = [];
        let gained = 0;
        for (let i = 0; i < vals.length; i++) {
            if (i + 1 < vals.length && vals[i] === vals[i + 1]) {
                out.push(vals[i] * 2); gained += vals[i] * 2; i++;
            } else out.push(vals[i]);
        }
        while (out.length < line.length) out.push(0);
        return {line: out, gained};
    }
    indices(dir, k) {
        // the k-th row/column, ordered from the edge in direction dir
        const idx = [];
        for (let j = 0; j < SIZE; j++) {
            if (dir === 'left') idx.push(k * SIZE + j);
            else if (dir === 'right') idx.push(k * SIZE + (SIZE - 1 - j));
            else if (dir === 'up') idx.push(j * SIZE + k);
            else idx.push((SIZE - 1 - j) * SIZE + k);
        }
        return idx;
    }
    move(dir) {
        if (this.over || ['left', 'right', 'up', 'down'].indexOf(dir) < 0) return false;
        let moved = false;
        for (let k = 0; k < SIZE; k++) {
            const idx = this.indices(dir, k);
            const r = Game2048.slide(idx.map(i => this.grid[i]));
            idx.forEach((i, j) => {
                if (this.grid[i] !== r.line[j]) moved = true;
                this.grid[i] = r.line[j];
            });
            this.score += r.gained;
        }
        if (moved) {
            this.spawn();
            if (!this.won && this.grid.some(v => v >= 2048)) this.won = true;
            if (!this.canMove()) this.over = true;
        }
        return moved;
    }
    canMove() {
        if (this.empty().length) return true;
        for (let r = 0; r < SIZE; r++) {
            for (let c = 0; c < SIZE; c++) {
                const v = this.grid[r * SIZE + c];
                if (c + 1 < SIZE && this.grid[r * SIZE + c + 1] === v) return true;
                if (r + 1 < SIZE && this.grid[(r + 1) * SIZE + c] === v) return true;
            }
        }
        return false;
    }
    action(name) {
        if (this.over && (name === 'press' || name === 'tap')) { this.reset(); return; }
        if (this.won && !this.wonShown && (name === 'press' || name === 'tap')) { this.wonShown = true; return; }
        this.move(name);
    }
    tap() { this.action('tap'); }
    update() {}
    message() {
        if (this.over) return 'No moves left - tap or press to play again';
        if (this.won && !this.wonShown) return '2048 reached! Keep going for a higher score';
        return '';
    }
    hint() { return 'Swipe or tilt the controller to slide the tiles.'; }
    draw(cv, box, t) {
        const side = Math.min(box.w, box.h), gap = Math.round(side * 0.025);
        const x0 = box.x + (box.w - side) / 2, y0 = box.y + (box.h - side) / 2;
        const cell = (side - gap * (SIZE + 1)) / SIZE;
        cv.roundRect(x0, y0, side, side, 16, '#2a3a4c');
        for (let i = 0; i < SIZE * SIZE; i++) {
            const v = this.grid[i], r = Math.floor(i / SIZE), c = i % SIZE;
            const x = x0 + gap + c * (cell + gap), y = y0 + gap + r * (cell + gap);
            const style = TILE[v] || (v ? ['#3c3a32', '#ffffff'] : ['#3a4d61', '#ffffff']);
            cv.roundRect(x, y, cell, cell, 10, style[0]);
            if (v) {
                const digits = String(v).length;
                const size = Math.round(cell * (digits <= 2 ? 0.46 : digits === 3 ? 0.38 : 0.3));
                cv.text(String(v), x + cell / 2, y + cell / 2 + size * 0.36, size, style[1], {align: 'center'});
            }
        }
    }
}

module.exports = {Game2048};
