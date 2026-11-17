# MGU GameSnacks 0.2.0 (experimental)

Small games for the parked car on the BMW iDrive 7 (MGU) screen, in two parts:

- **Four own mini-games**, drawn natively on the head unit: **2048**, **Snake**, **Blocks**
  and **Mines**. They are written for this app (no third-party game code or art) and work
  offline. Best scores are kept in the app data folder.
- **Web mirror**: a Chromium browser on a Raspberry Pi or laptop in the car opens
  [gamesnacks.com](https://gamesnacks.com/). Its picture is shown on the iDrive screen, and
  touches and the iDrive controller are sent back - like a browser on the head unit.

UI language: English. The app never writes to vehicle control units. It is not an official
Google or BMW application.

## Only while parked

Games and the mirror run only while a **fresh, valid vehicle-speed signal** (Vehicle2, at most
5 s old) says **0.5 km/h or less**. Without the signal or when the car moves, the games pause,
the mirror picture is hidden and the browser on the mirror host is frozen
(`Page.setWebLifecycleState frozen`) until the car stands still again.

## Mini-games

| Game | Touch | iDrive controller |
| --- | --- | --- |
| 2048 | swipe | tilt |
| Snake | swipe, or tap beside the head to turn there | tilt; turn = turn left / right |
| Blocks | tap left / right third = move, middle = rotate, swipe down = drop | tilt left / right / down, turn = rotate, press = drop |
| Mines | tap = open, hold = flag | tilt or turn = move cursor, press = open, long press = flag |

Bar buttons: **Games** (start page), **Web mirror**, **New game**, **Settings**. After game over,
a tap or press starts the next round. The controller is captured only while a game or the mirror
is open, the car is parked and the app has focus (needs `mgu-inputgate`, like GameStation);
otherwise the FrontCCU signal is read as a fallback.

## Web mirror

The head unit has no HTML5 engine, so the browser runs elsewhere and the MGU only shows its
picture:

```
Pi / laptop                                   MGU (this app)
Chromium (Playwright) -- gamesnacks.com
   screencast JPEG -> RGBA, zlib  ---- TCP 18960 ---->  picture on the iDrive screen
   touch / keys / back / reload   <-----------------   touch, controller, toolbar
```

1. Put the Pi or laptop on the car's network: the BMW Wi-Fi hotspot, or the head unit's USB
   network. It needs internet itself (its own LTE stick or phone tethering) to load
   gamesnacks.com.
2. Install once on it:
   ```sh
   pip install playwright pillow
   python3 -m playwright install chromium     # or use --browser-path /usr/bin/chromium
   ```
3. Start the host from this repository (`NamelsMissing/mgu-apps-beta`): `python3 tools/gamesnacks_mirror.py`
   (options: `--start-url`, `--port`, `--allow 172.16.222.0/24`, `--mute`, `--headful`).
4. On the iDrive open **Web mirror**. The app finds the host by itself: it tries every device in
   the head unit's ARP table on port 18960. A fixed address can be put into
   `mirror-host.json` in the app data folder: `{"hosts": ["192.168.1.20", "pi.local:18960"]}`.

On the mirror page: touch works as on a phone (tap, drag to scroll). Toolbar: **Back**,
**Home** (start page), **Reload**, **Exit**. Controller: tilt = arrow keys, turn = scroll,
press = Enter, long press = back. **Settings → Web mirror picture** chooses Fast / Balanced /
Sharp (40 / 60 / 100 % of the 1462 x 494 picture area; Sharp means more Wi-Fi traffic).

Sound plays on the Pi / laptop (its speaker or the car's AUX/Bluetooth), not through the MGU.

Nothing from the website is stored or redistributed: the host is an ordinary browser whose
screen is shown in the car. GameSnacks' own terms of use apply as for any visit of the site.
The host accepts connections only from private networks by default and serves one car at a time.

### Not yet confirmed in the car

- Whether an OAP app may open outgoing TCP connections to devices on the hotspot / USB network
  (no head-unit firewall rule is opened; the app only connects outwards).
- Whether `/proc/net/arp` is readable inside the OAP sandbox (otherwise use `mirror-host.json`).
- Frame rate and CPU load at each picture setting on the real MGU (the picture is inflated with
  Node's zlib off the main thread and drawn by `mgu-renderd`).
- Touch routing through `mgu-renderd` / `mgu-inputgate` on the real head unit.
- How GameSnacks pages lay out in the wide 1462 x 494 viewport.

## Tests (PC, no car needed)

```sh
node tests/gamesnacks.test.js                 # games, touch, controller, protocol, mirror client
python3 -m pytest tests/test_gamesnacks_mirror.py   # host; end-to-end with headless Chromium if installed
```

## Changes in 0.2.0

- Replaces the 0.1.x licence-review preview (which had no playable game) with four playable
  own mini-games and the web mirror.
- The list of licence candidates (`REVIEW.md`) and the read-only browser probe
  (`tools/probe_mgu_web_runtime.sh`) are gone: original GameSnacks games are still not copied
  into the app; the mirror shows the website instead.
