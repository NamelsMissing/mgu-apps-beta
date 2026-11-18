# Heating Comfort / AutoHeating

**Status: Stable** · **Platform: BMW MGU / iDrive 7**

Automatically control the seat and steering-wheel heating on a compatible BMW. The app also provides manual controls and a diagnostics view.

## Features

| Feature | Description |
| --- | --- |
| Automatic heating | Starts a heating cycle when the saved settings and vehicle conditions allow it. |
| Temperature settings | Choose when automatic heating should activate. |
| Heating duration | Configure the heating period and repeat-cycle delay. |
| Manual stop | Stop the app's active heating cycle. |
| Diagnostics | View heating commands, ECU responses and session logs in a scrollable console. |
| QR logs | Export current-session diagnostic information locally using QR codes. |

## Control-unit detection (beta 0.5.x)

Heating Comfort no longer assumes the G21 layout. Once the diagnostic connection is up, it reads
the standard BMW identification `22 F150` (read-only, no VIN) from these addresses:

| Address | Control unit | Used for |
| --- | --- | --- |
| `0x40` | BDC | steering wheel `D074`, seat heating `E432` / `E430` on cars without seat modules |
| `0x6D` / `0x6E` | SMFA / SMBF (seat modules) | detection only |
| `0x78` | IHKA | detection only |

The result decides the route for each channel:

- **BDC**: the channel works as before (G21 and other cars without seat modules).
- **Seat module**: the car has separate seat modules (for example a G05 with comfort seats). The BDC seat
  path is not used there, so the channel is left out of the automatic plan instead of failing eight
  times. Control through the seat modules is not supported yet.
- **Not available** (NRC 0x31) is left out as well. Unclear results keep the channel; the normal
  readback check still decides every write.

The profile is saved in the app settings. On the next start only the BDC identification is read
again; if it matches, the saved profile is reused, otherwise everything is detected again.
Diagnostics → **RE-DETECT ECUs** forces a new detection.

Since 0.5.1 the identities are named (e.g. `BDC_G05`, `FAS_G11`, `IHKA_G05`). For seats on a seat
module the Diagnostics tab shows the actual level read-only from the seat module (`22 D714`) and,
as a cross-check, from the IHKA (`22 D8DB`). The DIDs come from the SGBDs, see
[`docs/sgbd-seat-heating.md`](../../docs/sgbd-seat-heating.md); they are not yet confirmed on a car. Detection can only remove channels,
never allow a write.

The "Test next ignition ON" switch now also works while the app is already running, and it applies
to exactly one ignition.

## Install and enable

1. Add `NamelsMissing/mgu-apps` to **MGU Store** and select the **main** branch.
2. Install **G21 Heating Comfort** (`g21_wheelheat`).
3. Open the app and enable **Automatic heating on cold startup** in Settings.
4. Adjust the temperature, duration and repeat-cycle settings.

The app package includes the MGU **autostart** setting. This allows the process to start with the head unit, but it does **not** mean heating always turns on: the saved enable switch and required vehicle checks must also pass.

## Important limitations

- Automatic heating needs valid vehicle signals and a response from the body control unit (BDC).
- An accepted command or a timer in the app does not by itself prove that the seat or steering wheel physically heated.
- Automatic heating can attempt activation while driving when its checks pass. The vehicle ECU can still reject a request. Manual diagnostic writes retain the standstill restriction.
- The Diagnostics tab displays the latest valid ECU response. Switching heating ON/OFF manually is not treated as unstable readback; raw replies are retained in the session log.
- Available functions and ECU data may differ across BMW models and firmware.
- Settings are intended to persist across app restarts and updates. Use the Log view to troubleshoot any saving or autostart problems.
- QR logs are generated locally; they do not need an internet connection.

**Safety:** Test and configure the app while parked. Do not assume a heating request was successful without checking the actual vehicle behavior.

For Store setup and update details, see [Store Installation](../../STORE_INSTALLATION.md).
