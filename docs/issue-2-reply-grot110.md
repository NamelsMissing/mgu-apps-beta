# Entwurf: Antwort an Grot110 (Issue #2 in mgu-apps)

Stand 18.11.2026, für Heating Comfort 0.5.1 beta. Noch nicht gepostet. Zum Posten den Block unten
kopieren; für eine Benachrichtigung `@Grot110` voranstellen.

---

```markdown
Hi Grot110,

thank you for the very thorough test report. It answered the main open question.

### What your results show

- **Automatic steering-wheel heating works on the G05.** ON, OFF after the set time and the BDC acknowledgements all behaved as intended.
- **The NRC 0x22 on `E432`/`E430` is not a fault.** Your ISTA observation explains it: that BDC branch only exists on cars *without* separate seat modules. Your G05 has SMFA (`0x6D`) and SMBF (`0x6E`), so the BDC seat path is simply not coded there. My G21 has no seat modules, which is why it uses the BDC path.
- The app behaved safely: no seat command was sent without a valid readback. Retrying eight times was pointless on your car, though.
- **"Test next ignition ON" was a real bug.** The switch was only read when the app process started, so it did nothing while the head unit stayed on between ignitions.

### Your questions

1. **`E432`/`E430` with SM2 seat modules:** no, they are not expected to work through BDC_BODY3 on your configuration.
2. **Different read path:** yes. Based on the SGBDs (`FAS_G11`/`BFS_G11`, `IHKA_G05`):
   - seat modules SMFA/SMBF: `22 D714` returns the seat heating level (0–3) plus cushion/backrest temperature and PWM;
   - IHKA4: `22 D8DB` returns the front left/right seat heating level in bytes 19/20.
3. **Read-only information that would help:** see the test list below.

### New beta: Heating Comfort 0.5.1

It is available from the beta source `NamelsMissing/mgu-apps-beta` (branch `main`). It uses the same app ID, so it replaces 0.4.20 and keeps your settings.

- **Control-unit detection (read-only, `22 F150`, no VIN):** BDC, SMFA, SMBF and IHKA. The result is saved and reused on the next start. **RE-DETECT ECUs** on the Diagnostics tab runs it again.
- On your car the driver/passenger seat should now be shown as **"Skipped: Seat module SMFA/SMBF"** and is no longer planned. The steering wheel keeps working through the BDC.
- The Diagnostics tab shows the **actual seat heating level read from the seat module** (with IHKA as a cross-check), read-only.
- The one-shot parking-time test now works while the app is running and applies to exactly one ignition.

**The app still sends nothing to the seat modules.** Automatic seat control through SMFA/SMBF will only come after the read values are confirmed on a real car.

### Could you check (read-only)?

1. After installing 0.5.1, tap **RE-DETECT ECUs** and send a screenshot of the Diagnostics tab. The "Control units" line should show something like `BDC BDC_G05 | SMFA FAS_G11 | SMBF BFS_G11 | IHKA IHKA_G05`. If a raw code is shown instead of a name, that code is exactly what I need.
2. Using the original BMW button, set the driver seat to levels **0, 1, 2 and 3**, and refresh the Diagnostics tab for each. Does the shown level match? Then the same for the passenger seat.
3. A **QR log export** after these steps. It contains the raw replies of `D714` and `D8DB`.
4. If you have time: one automatic cycle with the steering wheel and driver seat enabled. Expected result: wheel ON/OFF as before, driver seat skipped with a clear reason, no retries.
5. Optional, but very useful for the next step: in ISTA, is there a seat heating **control/activation** test for SMFA (not only status)? If so:
   - Does the level stay set after the ISTA test ends, or does the seat fall back?
   - Does it need an extended diagnostic session?

### Alternative: BMW's own automatic seat heating (coding)

There may be a simpler route for your car that needs no diagnostic writes from the app at all. G-series cars have a **built-in automatic seat and steering-wheel heating** that switches on below an outside temperature you set in iDrive. It is normally not enabled. It has to be coded in two control units:

- **Head unit (HU_MGU):** "Seat heating front automatic activation (1 of 2)" (`AKT_AUTO_SITZE_FRONT`) and "Steering wheel heating automatic activation (1 of 2)" (`AKT_AUTO_LENKRADHEIZUNG`).
- **BDC_BODY3:** "Seat heating automatic activation (2 of 2)" (`IKF_ENABLE`: driver / driver + passenger / all seats) and "Steering wheel heating automatic activation (2 of 2)" (`LHZ_CCM_IKF`).

In BimmerCode these options have exactly these names. Related ones that may also be useful:

- **Seat module:** "Seat heating/cooling setting memory" (`SA_MEMORY_ZEIT`: 0 min / 15 min / 24 h / infinite) keeps the last seat heating level for the next start.
- **BDC:** the steering wheel heating memory option (`NACHLAUFZEIT_LENKRADHEIZUNG`) restores the wheel heating state on the next start.

What I don't know is whether the BMW automatic really switches the seats on a car with SM2 seat modules (the BDC requests, SMFA/SMBF execute). If you are comfortable coding it, I would be very interested in the result. Please make a backup of the original coding first. My app does not code anything and will not change these settings.

If the BMW automatic works on your car, Heating Comfort could simply leave the seats to the car and only handle the steering wheel and the timing, without ever writing to the seat modules.

As before, please remove the VIN and any personal data from screenshots.

Thanks again, this helps a lot!
```
