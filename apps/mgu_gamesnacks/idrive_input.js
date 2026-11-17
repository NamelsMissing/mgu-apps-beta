'use strict';

// iDrive controller (FrontCCU statusRotaryEncoderState, also delivered by mgu-inputgate while
// grabbed) turned into game events. Read-only; never sends anything to the car.
//   {type: 'dir', dir: 'up'|'down'|'left'|'right'}   tilt started (repeats while held, see poll)
//   {type: 'turn', steps}                              +clockwise / -counterclockwise detents
//   {type: 'press'}                                    knob pressed and released quickly
//   {type: 'long'}                                     knob held for longPressMs
const DEFLECTION = {
    MITTELSTELLUNG: 0, NORD_KURZ_GEDRUECKT: 1, NORD_LANG_GEDRUECKT: 2,
    OST_KURZ_GEDRUECKT: 4, OST_LANG_GEDRUECKT: 5,
    SUED_KURZ_GEDRUECKT: 7, SUED_LANG_GEDRUECKT: 8,
    WEST_KURZ_GEDRUECKT: 10, WEST_LANG_GEDRUECKT: 11,
    SIGNAL_UNGUELTIG: 15,
};
const PUSH = {KEINE_BETAETIGUNG: 0, DREHGEBER_KURZ_GEDRUECKT: 1, DREHGEBER_LANG_GEDRUECKT: 2,
    UNWIRKSAM: 3, SIGNAL_UNGUELTIG: 15};
const DIR = {1: 'up', 2: 'up', 4: 'right', 5: 'right', 7: 'down', 8: 'down', 10: 'left', 11: 'left'};
const number = (v, names) => typeof v === 'number' ? v : names[v] === undefined ? 15 : names[v];

class IDriveInput {
    constructor(emit, options) {
        const o = options || {};
        this.emit = emit;
        this.now = o.now || Date.now;
        this.longPressMs = o.longPressMs || 600;
        this.repeatDelay = o.repeatDelay || 260;
        this.repeatEvery = o.repeatEvery || 110;
        this.enabled = false;
        this.repeat = false;
        this.pos = null; this.dir = null; this.dirAt = 0; this.repeatAt = 0;
        this.pressed = false; this.pressedAt = 0; this.longDone = false;
        this.lastSeen = null;
    }
    setEnabled(on) {
        on = !!on;
        if (on === this.enabled) return;
        this.enabled = on;
        this.dir = null; this.pressed = false; this.longDone = false;
    }
    live() { return this.lastSeen !== null && this.now() - this.lastSeen < 1600; }
    raw(v) {
        if (!v) return;
        const pb = number(v.frontRotaryEncoderPushButton, PUSH);
        const df = number(v.frontRotaryEncoderDeflection, DEFLECTION);
        if (pb === 15 && df === 15) return;
        const now = this.now();
        this.lastSeen = now;
        const pos = v.frontRotaryEncoderOperation;
        if (typeof pos === 'number' && isFinite(pos) && pos >= 0 && pos <= 65535) {
            if (this.pos !== null) {
                const steps = ((pos - this.pos + 32768) & 0xffff) - 32768;
                if (this.enabled && steps && Math.abs(steps) <= 64) this.emit({type: 'turn', steps});
            }
            this.pos = pos;
        }
        const dir = df === 15 ? this.dir : DIR[df] || null;
        if (dir !== this.dir) {
            this.dir = dir;
            this.dirAt = now; this.repeatAt = now + this.repeatDelay;
            if (dir && this.enabled) this.emit({type: 'dir', dir});
        }
        if (pb === 15) return;
        const down = pb === 1 || pb === 2;
        if (down && !this.pressed) { this.pressed = true; this.pressedAt = now; this.longDone = false; }
        else if (!down && this.pressed) {
            this.pressed = false;
            if (this.enabled && !this.longDone) this.emit({type: 'press'});
        }
    }
    // call regularly (each frame): long press while held, auto-repeat of a held tilt
    poll() {
        if (!this.enabled) return;
        const now = this.now();
        if (this.pressed && !this.longDone && now - this.pressedAt >= this.longPressMs) {
            this.longDone = true;
            this.emit({type: 'long'});
        }
        if (this.repeat && this.dir && this.live() && now >= this.repeatAt) {
            this.repeatAt = now + this.repeatEvery;
            this.emit({type: 'dir', dir: this.dir});
        }
    }
}

module.exports = {IDriveInput, DEFLECTION, PUSH};
