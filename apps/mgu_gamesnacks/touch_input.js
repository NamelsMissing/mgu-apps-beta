'use strict';

// Touch helpers for the MGU renderer's onTouch(phase, x, y): phase 1 = down, 2 = move, 3 = up,
// coordinates in app drawing pixels.
const PHASES = {1: 'down', 2: 'move', 3: 'up'};

function normalizeTouch(phase, x, y, rect) {
    if (!PHASES[phase] || !isFinite(x) || !isFinite(y) || !rect ||
        !isFinite(rect.x) || !isFinite(rect.y) ||
        !(rect.w > 0) || !(rect.h > 0)) return null;
    if (x < rect.x || x > rect.x + rect.w || y < rect.y || y > rect.y + rect.h) return null;
    return {phase: PHASES[phase], x: (x - rect.x) / rect.w, y: (y - rect.y) / rect.h};
}

// Turns raw touches into tap / long press / swipe. A touch that starts outside `rect` is ignored.
// emit(event): {type: 'tap' | 'long', x, y} (0..1 in rect) or {type: 'swipe', dir}.
class Gestures {
    constructor(emit, options) {
        const o = options || {};
        this.emit = emit;
        this.now = o.now || Date.now;
        this.swipePx = o.swipePx || 45;
        this.longMs = o.longMs || 480;
        this.rect = null;
        this.start = null;
    }
    setRect(rect) { this.rect = rect; if (!rect) this.start = null; }
    cancel() { this.start = null; }
    touch(phase, x, y) {
        const r = this.rect;
        if (!r || !isFinite(x) || !isFinite(y)) return;
        if (phase === 1) {
            if (x < r.x || x > r.x + r.w || y < r.y || y > r.y + r.h) { this.start = null; return; }
            this.start = {x, y, at: this.now(), moved: false, longDone: false, lx: x, ly: y};
            return;
        }
        const s = this.start;
        if (!s) return;
        s.lx = x; s.ly = y;
        const dx = x - s.x, dy = y - s.y;
        if (Math.abs(dx) > 16 || Math.abs(dy) > 16) s.moved = true;
        if (phase === 2) return;
        if (phase !== 3) return;
        this.start = null;
        if (s.longDone) return;
        if (Math.max(Math.abs(dx), Math.abs(dy)) >= this.swipePx) {
            this.emit({type: 'swipe', dir: Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up')});
        } else if (!s.moved && this.now() - s.at >= this.longMs) {
            this.emit(this.point('long', s.x, s.y));
        } else this.emit(this.point('tap', s.x, s.y));
    }
    // call regularly: reports a long press while the finger is still down
    poll() {
        const s = this.start;
        if (!s || s.moved || s.longDone || this.now() - s.at < this.longMs) return;
        s.longDone = true;
        this.emit(this.point('long', s.x, s.y));
    }
    point(type, x, y) {
        const r = this.rect;
        return {type, x: Math.max(0, Math.min(1, (x - r.x) / r.w)), y: Math.max(0, Math.min(1, (y - r.y) / r.h))};
    }
}

module.exports = {normalizeTouch, Gestures, PHASES};
