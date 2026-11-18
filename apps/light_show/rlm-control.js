'use strict';
// Rear light modules (separate tail-light control units on newer G-series, e.g. OLED / LCI
// tail lights). Telegrams from the supplied BMW PRGs; not yet tested in a car.
//
// RLM2_1L/1R/2L/2R (RLM2_*.prg): RLM_LICHTFUNKTIONEN, 2E A8 3B <function> <seconds>,
//   seconds 0 = off, 1..254 = on for that time, 255 = permanent (never used here).
// RLM_1L/1R/2L/2R (RLM_*.prg): RLM_KANAL, 2E D6 DA <channel 1-8> <seconds> <PWM %>,
//   seconds 0 = off. Channel 0 (all) is not used.
// The channel routine of RLM2 (31 A5 56) needs a current value in mA and is not used.

const MODULES = Object.freeze({
    0x17: Object.freeze({ slot: '1L', side: 'left', position: 'outer' }),
    0x1A: Object.freeze({ slot: '1R', side: 'right', position: 'outer' }),
    0x1C: Object.freeze({ slot: '2L', side: 'left', position: 'inner' }),
    0x1E: Object.freeze({ slot: '2R', side: 'right', position: 'inner' }),
});
const VARIANTS = Object.freeze({
    0x17: { '0F2C10': 'RLM2_1L', '0F23C0': 'RLM_1L' },
    0x1A: { '0F2C20': 'RLM2_1R', '0F23D0': 'RLM_1R' },
    0x1C: { '0F2C30': 'RLM2_2L', '0F23E0': 'RLM_2L' },
    0x1E: { '0F2C40': 'RLM2_2R', '0F23F0': 'RLM_2R' },
});
// TAB_RLM_LICHTFUNKTIONEN (0x07 "remote lamp" left out)
const FUNCTIONS = Object.freeze({
    0x00: { key: 'pos', name: 'tail / position light', color: 'red' },
    0x01: { key: 'fog', name: 'rear fog light', color: 'red' },
    0x02: { key: 'brake', name: 'brake light', color: 'red' },
    0x03: { key: 'ind', name: 'indicator', color: 'amber' },
    0x04: { key: 'rev', name: 'reversing light', color: 'white' },
    0x05: { key: 'marker', name: 'side marker', color: 'amber' },
    0x06: { key: 'side', name: 'side light', color: 'red' },
    0x08: { key: 'park', name: 'parking light', color: 'red' },
    0x09: { key: 'plate', name: 'licence plate light', color: 'white' },
});
const CHANNELS_RLM1 = 8;
const PWM = Object.freeze([20, 40, 60, 80, 100]);

function moduleAt(address) {
    if (!Object.prototype.hasOwnProperty.call(MODULES, address)) throw new Error('No rear light module at 0x' + Number(address).toString(16));
    return MODULES[address];
}
/** {name, kind: 'fn' (RLM2) | 'ch' (RLM_1)} or null */
function variant(address, index) {
    moduleAt(address);
    const name = VARIANTS[address][index];
    if (!name) return null;
    return { name, kind: name.indexOf('RLM2_') === 0 ? 'fn' : 'ch' };
}
function seconds(ms) { return Math.min(5, Math.max(1, Math.ceil(ms / 1000))); }

/** Telegram (data after the service byte 2E) for kind/item on (ms > 0) or off (ms 0). */
function telegram(kind, item, ms, pwm) {
    const t = ms > 0 ? seconds(ms) : 0;
    if (kind === 'fn') {
        if (!Object.prototype.hasOwnProperty.call(FUNCTIONS, item)) throw new Error('Unknown rear light function');
        return [0xA8, 0x3B, item, t];
    }
    if (kind === 'ch') {
        if (!Number.isInteger(item) || item < 1 || item > CHANNELS_RLM1) throw new Error('Rear light channel must be 1-8');
        const p = PWM.indexOf(pwm) >= 0 ? pwm : 60;
        return [0xD6, 0xDA, item, t, p];
    }
    throw new Error('Unknown rear light route');
}
/** Is this 2E request one of ours (for the link whitelist)? */
function permitted(data) {
    if (!Array.isArray(data)) return false;
    if (data.length === 4 && data[0] === 0xA8 && data[1] === 0x3B)
        return Object.prototype.hasOwnProperty.call(FUNCTIONS, data[2]) && data[3] <= 5;
    if (data.length === 5 && data[0] === 0xD6 && data[1] === 0xDA)
        return data[2] >= 1 && data[2] <= CHANNELS_RLM1 && data[3] <= 5 && PWM.indexOf(data[4]) >= 0;
    return false;
}

module.exports = { MODULES, VARIANTS, FUNCTIONS, CHANNELS_RLM1, module: moduleAt, variant, telegram, permitted, seconds };
