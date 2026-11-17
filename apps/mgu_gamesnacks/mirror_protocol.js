'use strict';

// Wire format between the GameSnacks app (MGU, TCP client) and the mirror host
// (tools/gamesnacks_mirror.py on a Raspberry Pi or laptop, TCP server). Same format in both.
//
//   message = u32 BE length of (type + body) | u8 type | body
//   JSON bodies are UTF-8. FRAME body = u16 width | u16 height | u32 seq | u8 format | data,
//   format 1 = zlib-deflated RGBA rows (width * height * 4 bytes when inflated).

const PROTOCOL = 1;
const PORT = 18960;
const MAX_MESSAGE = 16 * 1024 * 1024;
const TYPE = {
    HELLO: 1,       // MGU -> host  {proto, app, version, width, height, frameWidth, frameHeight}
    WELCOME: 2,     // host -> MGU  {proto, host, version, url}
    FRAME: 3,       // host -> MGU  binary, see above
    FRAME_ACK: 4,   // MGU -> host  {seq}: ready for the next frame
    STATUS: 5,      // host -> MGU  {url, title, loading, error}
    INPUT: 6,       // MGU -> host  {kind: 'touch', phase: 'down'|'move'|'up', x, y} (0..1)
                    //              {kind: 'key', key: 'up'|'down'|'left'|'right'|'enter'|'space'|'escape'}
                    //              {kind: 'wheel', dy} (CSS px, + = down)
    NAV: 7,         // MGU -> host  {action: 'back'|'forward'|'home'|'reload'}
    PAUSE: 8,       // MGU -> host  {paused}
    ERROR: 9,       // host -> MGU  {message}
};
const FORMAT_RGBA_ZLIB = 1;

function encode(type, body) {
    let payload;
    if (Buffer.isBuffer(body)) payload = body;
    else payload = Buffer.from(JSON.stringify(body === undefined ? {} : body), 'utf8');
    const head = Buffer.alloc(5);
    head.writeUInt32BE(payload.length + 1, 0);
    head.writeUInt8(type, 4);
    return Buffer.concat([head, payload]);
}

function encodeFrame(width, height, seq, data, format) {
    const head = Buffer.alloc(9);
    head.writeUInt16BE(width, 0);
    head.writeUInt16BE(height, 2);
    head.writeUInt32BE(seq >>> 0, 4);
    head.writeUInt8(format || FORMAT_RGBA_ZLIB, 8);
    return encode(TYPE.FRAME, Buffer.concat([head, data]));
}

function decodeFrame(body) {
    if (!Buffer.isBuffer(body) || body.length < 9) throw new Error('short frame');
    const width = body.readUInt16BE(0), height = body.readUInt16BE(2);
    if (!width || !height || width > 4096 || height > 4096) throw new Error('bad frame size');
    return {width, height, seq: body.readUInt32BE(4), format: body.readUInt8(8), data: body.slice(9)};
}

function json(body) {
    try {
        const v = JSON.parse(body.toString('utf8'));
        return v && typeof v === 'object' ? v : {};
    } catch (e) { return {}; }
}

// Collects TCP chunks and returns whole messages.
class Decoder {
    constructor() { this.buf = Buffer.alloc(0); }
    push(chunk) {
        this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
        const out = [];
        while (this.buf.length >= 5) {
            const len = this.buf.readUInt32BE(0);
            if (len < 1 || len > MAX_MESSAGE) throw new Error('bad message length ' + len);
            if (this.buf.length < 4 + len) break;
            out.push({type: this.buf.readUInt8(4), body: this.buf.slice(5, 4 + len)});
            this.buf = this.buf.slice(4 + len);
        }
        return out;
    }
}

module.exports = {PROTOCOL, PORT, TYPE, FORMAT_RGBA_ZLIB, MAX_MESSAGE, encode, encodeFrame, decodeFrame, json, Decoder};
