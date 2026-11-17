#!/usr/bin/env python3
"""GameSnacks web mirror host.

Runs a Chromium browser (Playwright) on a Raspberry Pi or laptop in the car network, opens
https://gamesnacks.com/ and streams the page to the MGU app "MGU GameSnacks". Touches, keys and
navigation from the iDrive screen come back and are replayed in the browser. Nothing from the
website is stored or redistributed; this is an ordinary browser whose screen is shown in the car.

    pip install playwright pillow
    python3 -m playwright install chromium        # or --browser-path /usr/bin/chromium
    python3 tools/gamesnacks_mirror.py            # listens on TCP 18960

The MGU app connects by itself (it looks at the head unit's ARP table for devices on the Wi-Fi
hotspot / USB network). Wire format: apps/mgu_gamesnacks/mirror_protocol.js.
"""

import argparse
import asyncio
import io
import ipaddress
import json
import struct
import sys
import time
import zlib

PROTOCOL = 1
PORT = 18960
MAX_MESSAGE = 16 * 1024 * 1024
HELLO, WELCOME, FRAME, FRAME_ACK, STATUS, INPUT, NAV, PAUSE, ERROR = range(1, 10)
FORMAT_RGBA_ZLIB = 1
VERSION = "0.2.0"
KEYS = {"up": "ArrowUp", "down": "ArrowDown", "left": "ArrowLeft", "right": "ArrowRight",
        "enter": "Enter", "space": " ", "escape": "Escape"}
PRIVATE = [ipaddress.ip_network(n) for n in
           ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.0/8", "169.254.0.0/16")]


def encode(kind, body):
    payload = body if isinstance(body, (bytes, bytearray)) else json.dumps(body).encode("utf-8")
    return struct.pack(">IB", len(payload) + 1, kind) + payload


def encode_frame(width, height, seq, data):
    return encode(FRAME, struct.pack(">HHIB", width, height, seq & 0xFFFFFFFF, FORMAT_RGBA_ZLIB) + data)


async def read_message(reader):
    head = await reader.readexactly(5)
    length, kind = struct.unpack(">IB", head)
    if length < 1 or length > MAX_MESSAGE:
        raise ValueError("bad message length %d" % length)
    return kind, await reader.readexactly(length - 1)


def parse_json(body):
    try:
        value = json.loads(body.decode("utf-8"))
        return value if isinstance(value, dict) else {}
    except (ValueError, UnicodeDecodeError):
        return {}


def clamp_size(value, low, high, default):
    try:
        return max(low, min(high, int(value)))
    except (TypeError, ValueError):
        return default


def peer_allowed(address, allow):
    try:
        ip = ipaddress.ip_address(address)
    except ValueError:
        return False
    return any(ip in net for net in allow)


def jpeg_to_rgba(jpeg, width, height):
    """Decode a JPEG screencast frame to exactly width x height RGBA bytes."""
    from PIL import Image
    image = Image.open(io.BytesIO(jpeg)).convert("RGBA")
    if image.size != (width, height):
        image = image.resize((width, height), Image.BILINEAR)
    return image.tobytes("raw", "RGBA")


class Session:
    """One MGU connection driving one browser page."""

    def __init__(self, browser, args, reader, writer, log):
        self.browser, self.args, self.reader, self.writer, self.log = browser, args, reader, writer, log
        self.context = self.page = self.cdp = None
        self.view = (1476, 508)
        self.frame_size = (886, 305)
        self.latest = None          # newest JPEG not sent yet
        self.waiting_ack = False
        self.ack_at = 0.0
        self.seq = 0
        self.paused = False
        self.closed = False
        self.wake = asyncio.Event()
        self.touching = False

    def send(self, kind, body):
        if not self.closed:
            self.writer.write(encode(kind, body))

    async def open(self, hello):
        width = clamp_size(hello.get("width"), 200, 2560, 1476)
        height = clamp_size(hello.get("height"), 120, 1440, 508)
        self.view = (width, height)
        self.frame_size = (clamp_size(hello.get("frameWidth"), 64, width, width),
                           clamp_size(hello.get("frameHeight"), 32, height, height))
        self.context = await self.browser.new_context(
            viewport={"width": width, "height": height}, device_scale_factor=1,
            has_touch=True, is_mobile=False, locale=self.args.locale)
        self.page = await self.context.new_page()
        self.cdp = await self.context.new_cdp_session(self.page)
        self.cdp.on("Page.screencastFrame", self.on_screencast)
        self.page.on("framenavigated", lambda frame: self.schedule_status() if frame == self.page.main_frame else None)
        self.page.on("load", lambda *_: self.schedule_status())
        await self.start_screencast()
        self.send(WELCOME, {"proto": PROTOCOL, "host": self.args.name, "version": VERSION, "url": self.args.start_url})
        try:
            await self.page.goto(self.args.start_url, wait_until="domcontentloaded", timeout=30000)
        except Exception as exc:  # network down, DNS ... the page shows Chromium's error page
            self.send(ERROR, {"message": "Could not open %s: %s" % (self.args.start_url, str(exc).splitlines()[0][:160])})
        await self.send_status()

    async def start_screencast(self):
        await self.cdp.send("Page.startScreencast", {
            "format": "jpeg", "quality": self.args.jpeg_quality,
            "maxWidth": self.frame_size[0], "maxHeight": self.frame_size[1], "everyNthFrame": 1})

    def on_screencast(self, event):
        asyncio.ensure_future(self.ack_screencast(event.get("sessionId")))
        try:
            import base64
            self.latest = base64.b64decode(event["data"])
        except (KeyError, ValueError):
            return
        self.wake.set()

    async def ack_screencast(self, session_id):
        try:
            await self.cdp.send("Page.screencastFrameAck", {"sessionId": session_id})
        except Exception:
            pass

    def schedule_status(self):
        asyncio.ensure_future(self.send_status())

    async def send_status(self):
        if self.closed or not self.page:
            return
        try:
            title = await self.page.title()
        except Exception:
            title = ""
        self.send(STATUS, {"url": self.page.url, "title": title[:120], "loading": False})

    async def frame_pump(self):
        loop = asyncio.get_event_loop()
        while not self.closed:
            try:
                await asyncio.wait_for(self.wake.wait(), timeout=2.0)
            except asyncio.TimeoutError:
                pass
            self.wake.clear()
            if self.waiting_ack and time.monotonic() - self.ack_at > 3.0:
                self.waiting_ack = False  # lost ack: don't stall forever
            if self.closed or self.paused or self.waiting_ack or self.latest is None:
                continue
            jpeg, self.latest = self.latest, None
            width, height = self.frame_size
            try:
                rgba = await loop.run_in_executor(None, jpeg_to_rgba, jpeg, width, height)
                packed = await loop.run_in_executor(None, zlib.compress, rgba, 1)
            except Exception as exc:
                self.log("frame dropped: %s" % exc)
                continue
            self.seq += 1
            self.waiting_ack, self.ack_at = True, time.monotonic()
            self.writer.write(encode_frame(width, height, self.seq, packed))
            try:
                await self.writer.drain()
            except ConnectionError:
                return

    async def on_input(self, msg):
        kind = msg.get("kind")
        width, height = self.view
        if kind == "touch":
            phase = msg.get("phase")
            try:
                x = max(0.0, min(1.0, float(msg.get("x")))) * width
                y = max(0.0, min(1.0, float(msg.get("y")))) * height
            except (TypeError, ValueError):
                return
            if phase == "down":
                self.touching = True
                await self.cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": x, "y": y}]})
            elif phase == "move" and self.touching:
                await self.cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [{"x": x, "y": y}]})
            elif phase == "up" and self.touching:
                self.touching = False
                await self.cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
        elif kind == "key" and msg.get("key") in KEYS:
            await self.page.keyboard.press(KEYS[msg["key"]])
        elif kind == "wheel":
            try:
                dy = max(-2000.0, min(2000.0, float(msg.get("dy"))))
            except (TypeError, ValueError):
                return
            await self.page.mouse.move(width / 2, height / 2)
            await self.page.mouse.wheel(0, dy)

    async def on_nav(self, msg):
        action = msg.get("action")
        try:
            if action == "back":
                await self.page.go_back(wait_until="domcontentloaded", timeout=15000)
            elif action == "forward":
                await self.page.go_forward(wait_until="domcontentloaded", timeout=15000)
            elif action == "home":
                await self.page.goto(self.args.start_url, wait_until="domcontentloaded", timeout=30000)
            elif action == "reload":
                await self.page.reload(wait_until="domcontentloaded", timeout=30000)
        except Exception as exc:
            self.send(ERROR, {"message": "%s failed: %s" % (action, str(exc).splitlines()[0][:160])})
        await self.send_status()

    async def on_pause(self, paused):
        if paused == self.paused:
            return
        self.paused = paused
        try:
            if paused:
                await self.cdp.send("Page.stopScreencast")
                await self.cdp.send("Page.setWebLifecycleState", {"state": "frozen"})
            else:
                await self.cdp.send("Page.setWebLifecycleState", {"state": "active"})
                self.waiting_ack = False
                await self.start_screencast()
        except Exception as exc:
            self.log("pause/resume: %s" % exc)

    async def run(self):
        kind, body = await asyncio.wait_for(read_message(self.reader), timeout=10)
        hello = parse_json(body)
        if kind != HELLO or hello.get("proto") != PROTOCOL:
            self.send(ERROR, {"message": "expected HELLO, protocol %d" % PROTOCOL})
            return
        await self.open(hello)
        pump = asyncio.ensure_future(self.frame_pump())
        try:
            while True:
                kind, body = await read_message(self.reader)
                if kind == FRAME_ACK:
                    self.waiting_ack = False
                    self.wake.set()
                    continue
                msg = parse_json(body)
                try:
                    if kind == INPUT:
                        await self.on_input(msg)
                    elif kind == NAV:
                        await self.on_nav(msg)
                    elif kind == PAUSE:
                        await self.on_pause(bool(msg.get("paused")))
                except Exception as exc:  # a closed page etc. must not end the session
                    self.log("command %d failed: %s" % (kind, exc))
        finally:
            self.closed = True
            self.wake.set()
            pump.cancel()

    async def close(self):
        self.closed = True
        if self.context:
            try:
                await self.context.close()
            except Exception:
                pass


class MirrorServer:
    def __init__(self, args, log=None):
        self.args = args
        self.log = log or (lambda text: print(time.strftime("%H:%M:%S"), text, flush=True))
        self.playwright = self.browser = None
        self.current = None
        self.server = None
        self.allow = [ipaddress.ip_network(n, strict=False) for n in args.allow] if args.allow else PRIVATE

    async def start(self):
        from playwright.async_api import async_playwright
        self.playwright = await async_playwright().start()
        launch = {"headless": not self.args.headful,
                  "args": ["--autoplay-policy=no-user-gesture-required"] + (["--mute-audio"] if self.args.mute else [])}
        if self.args.browser_path:
            launch["executable_path"] = self.args.browser_path
        self.browser = await self.playwright.chromium.launch(**launch)
        self.server = await asyncio.start_server(self.handle, self.args.bind, self.args.port)
        self.log("GameSnacks mirror %s listening on %s:%d, start page %s"
                 % (VERSION, self.args.bind, self.args.port, self.args.start_url))

    async def handle(self, reader, writer):
        peer = (writer.get_extra_info("peername") or ("?",))[0]
        if not peer_allowed(peer, self.allow):
            self.log("refused %s (not in --allow)" % peer)
            writer.close()
            return
        if self.current:  # one car at a time: a new connection replaces the old one
            self.current.writer.close()
        session = Session(self.browser, self.args, reader, writer, self.log)
        self.current = session
        self.log("MGU connected from %s" % peer)
        try:
            await session.run()
        except (asyncio.IncompleteReadError, ConnectionError, asyncio.TimeoutError):
            pass
        except Exception as exc:
            self.log("session error: %s" % exc)
        finally:
            await session.close()
            if self.current is session:
                self.current = None
            writer.close()
            self.log("MGU %s disconnected" % peer)

    async def stop(self):
        if self.server:
            self.server.close()
            await self.server.wait_closed()
        if self.browser:
            await self.browser.close()
        if self.playwright:
            await self.playwright.stop()


def parse_args(argv=None):
    p = argparse.ArgumentParser(description="Mirror a Chromium page (GameSnacks) to the MGU GameSnacks app.")
    p.add_argument("--port", type=int, default=PORT)
    p.add_argument("--bind", default="0.0.0.0", help="address to listen on (default all)")
    p.add_argument("--start-url", default="https://gamesnacks.com/")
    p.add_argument("--allow", action="append", metavar="CIDR",
                   help="only accept the MGU from these networks (default: private networks)")
    p.add_argument("--name", default="GameSnacks mirror", help="name shown on the iDrive screen")
    p.add_argument("--locale", default="de-DE")
    p.add_argument("--jpeg-quality", type=int, default=75)
    p.add_argument("--browser-path", help="use this Chromium instead of Playwright's download")
    p.add_argument("--headful", action="store_true", help="show the browser window on this computer too")
    p.add_argument("--mute", action="store_true", help="mute the browser (sound plays on this computer)")
    return p.parse_args(argv)


async def main_async(args):
    server = MirrorServer(args)
    await server.start()
    try:
        await asyncio.Event().wait()
    finally:
        await server.stop()


def main(argv=None):
    args = parse_args(argv)
    try:
        asyncio.run(main_async(args))
    except KeyboardInterrupt:
        pass
    except ImportError as exc:
        print("Missing dependency (%s). Install with: pip install playwright pillow && "
              "python3 -m playwright install chromium" % exc, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
