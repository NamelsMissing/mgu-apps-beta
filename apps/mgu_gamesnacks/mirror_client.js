'use strict';

// Web mirror client: finds the mirror host on the car's Wi-Fi / USB network, receives the remote
// browser's picture and sends touches, keys and navigation back. The MGU only opens outgoing TCP
// connections; no firewall rule on the head unit is needed for that.
const net = require('net');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const P = require('./mirror_protocol');

// /proc/net/arp: IP address, HW type, Flags, HW address, Mask, Device
function parseArp(text) {
    const out = [];
    String(text || '').split('\n').slice(1).forEach(line => {
        const f = line.trim().split(/\s+/);
        if (f.length < 6) return;
        const flags = parseInt(f[2], 16);
        if (!(flags & 2) || f[3] === '00:00:00:00:00:00') return;
        if (!/^\d+\.\d+\.\d+\.\d+$/.test(f[0])) return;
        out.push({ip: f[0], device: f[5]});
    });
    return out;
}

// "host", "host:port" -> {host, port}
function parseHost(value, defaultPort) {
    const s = String(value || '').trim();
    const m = /^([A-Za-z0-9.\-]+)(?::(\d{1,5}))?$/.exec(s);
    if (!m) return null;
    const port = m[2] ? Number(m[2]) : defaultPort;
    if (!(port > 0 && port < 65536)) return null;
    return {host: m[1], port};
}

const QUALITY = {fast: 0.4, balanced: 0.6, sharp: 1};

class MirrorClient {
    constructor(options) {
        const o = options || {};
        this.log = o.log || {info() {}, warn() {}};
        this.dataDir = o.dataDir || '.';
        this.port = o.port || P.PORT;
        this.now = o.now || Date.now;
        this.connectTimeout = o.connectTimeout || 900;
        this.readFile = o.readFile || (f => fs.readFileSync(f, 'utf8'));
        this.connect = o.connect || ((port, host) => net.connect(port, host));
        this.onFrame = o.onFrame || (() => {});
        this.view = {width: 1476, height: 508};
        this.quality = 'balanced';
        this.state = 'idle';           // idle | searching | connected
        this.detail = '';
        this.host = null;
        this.status = {};
        this.tried = [];
        this.socket = null;
        this.active = false;
        this.paused = false;
        this.frames = 0; this.frameAt = 0;
        this.timer = null;
        this.scanning = false;
    }
    configFile() { return path.join(this.dataDir, 'mirror-host.json'); }
    // hosts from mirror-host.json ({"hosts": ["192.168.1.20", "pi.local:18960"]}), then ARP neighbours
    candidates() {
        const list = [], seen = {};
        const add = h => { if (h && !seen[h.host + ':' + h.port]) { seen[h.host + ':' + h.port] = true; list.push(h); } };
        try {
            const cfg = JSON.parse(this.readFile(this.configFile()));
            (Array.isArray(cfg.hosts) ? cfg.hosts : cfg.host ? [cfg.host] : [])
                .forEach(h => add(parseHost(h, this.port)));
        } catch (e) { /* optional file */ }
        try { parseArp(this.readFile('/proc/net/arp')).forEach(n => add({host: n.ip, port: this.port})); }
        catch (e) { /* no ARP table in this sandbox */ }
        return list;
    }
    setView(width, height, quality) {
        this.view = {width: Math.round(width), height: Math.round(height)};
        if (QUALITY[quality]) this.quality = quality;
    }
    frameSize() {
        const q = QUALITY[this.quality] || QUALITY.balanced;
        return {width: Math.max(64, Math.round(this.view.width * q)), height: Math.max(32, Math.round(this.view.height * q))};
    }
    start() {
        if (this.active) return;
        this.active = true;
        this.scan();
    }
    stop() {
        this.active = false;
        clearTimeout(this.timer); this.timer = null;
        this.drop('closed');
        this.state = 'idle';
    }
    later(ms) {
        clearTimeout(this.timer);
        if (this.active) this.timer = setTimeout(() => this.scan(), ms);
    }
    scan() {
        if (!this.active || this.socket || this.scanning) return;
        const list = this.candidates();
        this.state = 'searching';
        this.tried = list.map(h => h.host + ':' + h.port);
        if (!list.length) {
            this.detail = 'No device found on the car network yet';
            this.later(4000);
            return;
        }
        this.scanning = true;
        let i = 0;
        const next = () => {
            if (!this.active) { this.scanning = false; return; }
            if (i >= list.length) {
                this.scanning = false;
                this.detail = 'No mirror host answered on port ' + this.port;
                this.later(4000);
                return;
            }
            const h = list[i++];
            this.detail = 'Trying ' + h.host + ':' + h.port;
            this.tryHost(h, ok => { if (ok) this.scanning = false; else next(); });
        };
        next();
    }
    tryHost(h, done) {
        let finished = false, welcomed = false;
        const sock = this.connect(h.port, h.host);
        const decoder = new P.Decoder();
        const finish = ok => { if (!finished) { finished = true; clearTimeout(t); done(ok); } };
        const t = setTimeout(() => { sock.destroy(); finish(false); }, this.connectTimeout + 2000);
        sock.setNoDelay && sock.setNoDelay(true);
        const connectTimer = setTimeout(() => { if (!welcomed && sock.connecting) { sock.destroy(); finish(false); } }, this.connectTimeout);
        sock.on('connect', () => {
            clearTimeout(connectTimer);
            const f = this.frameSize();
            sock.write(P.encode(P.TYPE.HELLO, {proto: P.PROTOCOL, app: 'mgu_gamesnacks', version: '0.2.0',
                width: this.view.width, height: this.view.height, frameWidth: f.width, frameHeight: f.height}));
        });
        sock.on('data', chunk => {
            let msgs;
            try { msgs = decoder.push(chunk); } catch (e) { sock.destroy(); finish(false); return; }
            msgs.forEach(m => {
                if (!welcomed) {
                    if (m.type !== P.TYPE.WELCOME) return;
                    const w = P.json(m.body);
                    if (w.proto !== P.PROTOCOL) { this.detail = 'Mirror host speaks another protocol'; sock.destroy(); finish(false); return; }
                    welcomed = true;
                    this.attach(sock, h, w);
                    finish(true);
                } else this.receive(m);
            });
        });
        sock.on('error', () => { clearTimeout(connectTimer); });
        sock.on('close', () => {
            clearTimeout(connectTimer);
            if (!welcomed) { finish(false); return; }
            if (this.socket === sock) this.drop('Mirror host disconnected');
        });
    }
    attach(sock, h, welcome) {
        if (!this.active) { sock.destroy(); return; }
        this.socket = sock;
        this.host = {host: h.host, port: h.port, name: String(welcome.host || h.host).slice(0, 40), version: String(welcome.version || '')};
        this.state = 'connected';
        this.detail = '';
        this.status = {url: welcome.url || ''};
        this.log.info('[GameSnacks] mirror connected to ' + h.host + ':' + h.port);
        if (this.paused) this.send(P.TYPE.PAUSE, {paused: true});
    }
    drop(reason) {
        const sock = this.socket;
        this.socket = null; this.host = null;
        if (sock) { try { sock.destroy(); } catch (e) { /* closed */ } }
        if (this.active) {
            this.state = 'searching';
            this.detail = reason || '';
            this.later(1500);
        }
    }
    receive(m) {
        if (m.type === P.TYPE.FRAME) {
            let frame;
            try { frame = P.decodeFrame(m.body); } catch (e) { this.log.warn('[GameSnacks] mirror frame: ' + e.message); return; }
            if (frame.format !== P.FORMAT_RGBA_ZLIB) return;
            zlib.inflate(frame.data, (err, rgba) => {
                if (!err && rgba.length === frame.width * frame.height * 4) {
                    this.frames++; this.frameAt = this.now();
                    this.onFrame(frame.width, frame.height, rgba, frame.seq);
                } else if (err) this.log.warn('[GameSnacks] mirror inflate: ' + err.message);
                this.send(P.TYPE.FRAME_ACK, {seq: frame.seq});
            });
        } else if (m.type === P.TYPE.STATUS) {
            this.status = P.json(m.body);
        } else if (m.type === P.TYPE.ERROR) {
            this.status = Object.assign({}, this.status, {error: String(P.json(m.body).message || 'error')});
        }
    }
    send(type, body) {
        if (!this.socket) return false;
        try { this.socket.write(P.encode(type, body)); return true; } catch (e) { return false; }
    }
    touch(phase, x, y) { return this.send(P.TYPE.INPUT, {kind: 'touch', phase, x, y}); }
    key(key) { return this.send(P.TYPE.INPUT, {kind: 'key', key}); }
    wheel(dy) { return this.send(P.TYPE.INPUT, {kind: 'wheel', dy}); }
    nav(action) { return this.send(P.TYPE.NAV, {action}); }
    setPaused(paused) {
        paused = !!paused;
        if (paused === this.paused) return;
        this.paused = paused;
        this.send(P.TYPE.PAUSE, {paused});
    }
}

module.exports = {MirrorClient, parseArp, parseHost, QUALITY};
