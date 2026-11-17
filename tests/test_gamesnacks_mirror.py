"""Tests for tools/gamesnacks_mirror.py.

Pure protocol tests always run. The end-to-end test drives a real headless Chromium through
Playwright against a local page (no Internet) and is skipped when Playwright or its browser is
not installed.
"""

import asyncio
import json
import struct
import sys
import unittest
import urllib.parse
import zlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import gamesnacks_mirror as gm  # noqa: E402

PAGE = """<!doctype html><html><head><title>start</title><style>
html,body{margin:0;height:100%;background:#ff0000}
#b{position:absolute;left:0;top:0;width:50%;height:100%;background:#0000ff}
</style></head><body><div id=b></div><script>
document.getElementById('b').addEventListener('click', function () {
  document.title = 'tapped'; document.body.style.background = '#00ff00';
  document.getElementById('b').style.background = '#00ff00';
});
document.addEventListener('keydown', function (e) { document.title = 'key ' + e.key; });
</script></body></html>"""


def chromium_available():
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            p.chromium.launch(headless=True).close()
        return True
    except Exception:
        return False


class ProtocolTest(unittest.TestCase):
    def test_encode_matches_wire_format(self):
        raw = gm.encode(gm.STATUS, {"title": "x"})
        length, kind = struct.unpack(">IB", raw[:5])
        self.assertEqual(kind, gm.STATUS)
        self.assertEqual(length, len(raw) - 4)
        self.assertEqual(json.loads(raw[5:].decode()), {"title": "x"})

    def test_frame_header(self):
        raw = gm.encode_frame(3, 2, 7, b"abc")
        self.assertEqual(raw[4], gm.FRAME)
        self.assertEqual(struct.unpack(">HHIB", raw[5:14]), (3, 2, 7, gm.FORMAT_RGBA_ZLIB))
        self.assertEqual(raw[14:], b"abc")

    def test_peer_filter_defaults_to_private_networks(self):
        self.assertTrue(gm.peer_allowed("172.16.222.97", gm.PRIVATE))
        self.assertTrue(gm.peer_allowed("192.168.4.2", gm.PRIVATE))
        self.assertFalse(gm.peer_allowed("8.8.8.8", gm.PRIVATE))
        self.assertFalse(gm.peer_allowed("nonsense", gm.PRIVATE))

    def test_sizes_are_clamped(self):
        self.assertEqual(gm.clamp_size("99999", 64, 1000, 5), 1000)
        self.assertEqual(gm.clamp_size(None, 64, 1000, 5), 5)


@unittest.skipUnless(chromium_available(), "Playwright Chromium not installed")
class EndToEndTest(unittest.TestCase):
    def test_frames_touch_key_and_pause(self):
        asyncio.run(self.scenario())

    async def scenario(self):
        url = "data:text/html," + urllib.parse.quote(PAGE)
        args = gm.parse_args(["--port", "0", "--bind", "127.0.0.1", "--start-url", url, "--mute"])
        logs = []
        server = gm.MirrorServer(args, log=logs.append)
        await server.start()
        port = server.server.sockets[0].getsockname()[1]
        reader, writer = await asyncio.open_connection("127.0.0.1", port)

        def send(kind, body):
            writer.write(gm.encode(kind, body))

        async def until(pred, timeout=15):
            loop = asyncio.get_event_loop()
            end = loop.time() + timeout
            while loop.time() < end:
                kind, body = await asyncio.wait_for(gm.read_message(reader), timeout=end - loop.time())
                if kind == gm.FRAME:
                    w, h, seq, fmt = struct.unpack(">HHIB", body[:9])
                    rgba = zlib.decompress(body[9:])
                    self.assertEqual(len(rgba), w * h * 4)
                    send(gm.FRAME_ACK, {"seq": seq})
                    result = pred(("frame", (w, h, rgba)))
                else:
                    result = pred((kind, gm.parse_json(body)))
                if result:
                    return result
            self.fail("timed out")

        try:
            send(gm.HELLO, {"proto": 1, "width": 400, "height": 200, "frameWidth": 200, "frameHeight": 100})
            welcome = await until(lambda m: m[1] if m[0] == gm.WELCOME else None)
            self.assertEqual(welcome["proto"], 1)

            def pixel(frame, fx, fy):
                w, h, rgba = frame
                i = (int(fy * h) * w + int(fx * w)) * 4
                return tuple(rgba[i:i + 3])

            # first frame: left half blue, right half red, scaled to 200 x 100
            frame = await until(lambda m: m[1] if m[0] == "frame" and pixel(m[1], 0.75, 0.5)[0] > 200 else None)
            self.assertEqual(frame[:2], (200, 100))
            self.assertGreater(pixel(frame, 0.25, 0.5)[2], 200)

            # a tap on the left half clicks the element (touch start + end)
            send(gm.INPUT, {"kind": "touch", "phase": "down", "x": 0.25, "y": 0.5})
            send(gm.INPUT, {"kind": "touch", "phase": "up", "x": 0.25, "y": 0.5})
            await until(lambda m: m[0] == "frame" and pixel(m[1], 0.25, 0.5)[1] > 200)

            send(gm.INPUT, {"kind": "key", "key": "left"})
            send(gm.NAV, {"action": "reload"})
            status = await until(lambda m: m[1] if m[0] == gm.STATUS and m[1].get("title") == "start" else None)
            self.assertTrue(status["url"].startswith("data:text/html"))

            # paused: no frames; resumed: frames again
            send(gm.PAUSE, {"paused": True})
            send(gm.PAUSE, {"paused": False})
            await until(lambda m: m[0] == "frame")
        finally:
            writer.close()
            await server.stop()


if __name__ == "__main__":
    unittest.main()
