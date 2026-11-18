# Light Show 0.4.1 (beta)

Exterior light shows for BMW G-series cars with the iDrive 7 head unit (MGU), in the spirit of
Bimmerlight: pick lights, pick an effect, start, from the BMW screen or from your phone.
Unofficial, not from BMW. Use only parked in P, standing still, on private ground, with nobody
in front of the car. Don't look into the headlights.

## What's new compared to 0.3.4 (mgu-apps)

| | 0.3.4 | 0.4.0 beta |
|---|---|---|
| Lights | Headlamp LED channels (FLM02) | Headlamp LED channels, BDC light functions (high beam, DRL, position, fog) and every BDC exterior output (tail, brake, third brake light, indicators, side markers, rear fog, reverse, plate) |
| Which car | Fixed addresses and FLM02 only | **Vehicle scan** reads the identity of every control unit and offers only what this car has |
| Effects | 6 patterns | 9 effects: Wig-Wag, Dual Flash, Chase, Knight Rider, Front-to-Rear Wave, All Flash, Alternating, Heartbeat, Sparkle |
| Screen | Text menus | Canvas UI with tabs, rotating 3D car whose lamps light up during the show |
| Phone | - | **Phone remote**: QR code on the BMW screen opens a web page with the same functions and a 3D car you can turn |

Names and test results from 0.3.x are taken over (same app id, same data folder).

## Pages on the BMW screen

- **Show** - 3D car, effect library, step time, pause, repeats, headlamp LED brightness, Start / Stop.
- **Lights** - every light the scan found. Select one, press **Test**, then say what you saw:
  *Lit, quiet* / *Nothing* / *Noise*. Only lights confirmed "lit, quiet" (and whose release was
  acknowledged) can be added to a show. *Rename* cycles through preset names; any name can be
  typed on the phone.
- **Vehicle** - the scan (read-only, `22 F1 50` to all control units), the support level of the
  body controller and both headlamp modules, the list of all units, the switch for experimental
  headlamp modules, and the manual "lights checked" confirmation if a recovery file is unreadable.
- **Phone** - QR code, status of the firewall helper, the server and the phone connection.

## Vehicle scan (modelled on BimmerLight)

1. One functional `22 F1 50` to all control units.
2. Every light address that did not answer is asked once more on its own: gateway 0x10,
   rear light modules 0x17 / 0x1A / 0x1C / 0x1E, body 0x40, headlamps 0x43 / 0x44, 0x72.
3. The vehicle order (`22 3F 06`) is read from the gateway; option codes such as 5AZ (Laserlight)
   or 552 (Adaptive LED) are shown as a hint.

Only identity and the vehicle order are read at these extra addresses; the app sends no other
request there. Rear light modules (RLM_1/2, RLM2_1/2, e.g. OLED / laser tail lights) are
recognised but not controlled yet: their telegrams are not mapped.

## Supported control units

| Unit | Identity | Status |
|---|---|---|
| Body controller 0x40 | `BDC_G05` (`0F2680`) | Required gateway check. Light functions D542: high beam seen on the G21. Outputs E3B5: **experimental** (no visible effect on the G21) |
| Headlamp 0x43 / 0x44 | `FLM02_L/R` (`0F26C0/D0`) | Tested on a G21 with basic LED headlights |
| Headlamp 0x43 / 0x44 | `FLM02X_L/R` (`0F26C8/D8`), `FLM2_1_L/R` (`0F26CC/DC`) | **Experimental**, only after the switch on *Vehicle*. Same family (adaptive LED / laser hardware), never driven yet |
| Headlamp | `FLM01`, `FLM03`, `LHM2`, `FLE` | Recognised, not supported |
| Rear light modules 0x17-0x1E | `RLM_1/2`, `RLM2_1/2` | Recognised, not controlled yet |
| Gateway 0x10 | `ZGW_01`, `ZGW_SP18`, `BCP_SP21` | Identity and vehicle order only |

Whether the laser element of laser headlights sits on any FLM channel is unknown. If a channel
turns on something unexpected, like a very bright spot or the headlight adjusting itself, press
STOP and leave that channel out.

## Phone remote

1. Install **Light Show Phone Port** (`mgu-light-net`) from this source as well: it opens TCP
   18880 on the car Wi-Fi only while Light Show answers its health probe.
2. Connect the phone to the car's Wi-Fi hotspot, open *Phone* on the BMW screen and scan the code.
3. The link holds a random token that changes with every start of the app.

The page polls the app; every action goes through the same checks as the BMW screen (P,
standstill, identities, tested lights). No Internet is needed.

## Safety

- Before every request: P and a current speed signal of 0 km/h. Losing either stops the show.
- Before anything is switched: BDC_G05 and every used headlamp module are identified.
- A recovery file is written before the first session or lamp request. It is removed only after
  every touched unit acknowledged its STOP / OFF and the default session; otherwise STOP (or the
  next app start) releases them again.
- Every lamp has a finite time in the control unit (FLM seconds, D542 duration) and an explicit OFF.
- One FLM module plays one LED channel at a time; effects split steps accordingly.
- Requests go one by one through BMW's diagnostic transport (about 100-500 ms each in the car),
  so shows are slower and less exact than with an OBD adapter.

Acknowledgements are protocol answers, not light measurements.

## Tests

```sh
node tests/light_show.test.js
```
