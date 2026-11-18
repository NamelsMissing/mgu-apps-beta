# mgu-apps-beta

Beta tests of [mgu-apps](https://github.com/NamelsMissing/mgu-apps): apps for the BMW iDrive 7
head unit (MGU) that are not ready for the main store source yet. Unofficial, not from BMW.

| App | Status | What it's for |
| --- | --- | --- |
| [**Heating Comfort**](apps/g21_wheelheat/README.md) | Beta 0.5.1 | Automatic seat and steering-wheel heating with control-unit detection: BDC or separate seat modules, profile saved for the next start. Same app id as in mgu-apps, so installing from here replaces the main version. |
| [**GameSnacks**](apps/mgu_gamesnacks/README.md) | Beta | Four small games (2048, Snake, Blocks, Mines) played by touch or iDrive controller, plus a web mirror that shows gamesnacks.com from a browser on a Raspberry Pi or laptop in the car. Only while parked. |

## Install with MGU Store

1. In MGU Store add the GitHub source `NamelsMissing/mgu-apps-beta`, branch **main**.
2. Keep the main source `NamelsMissing/mgu-apps` as well: GameSnacks needs `idrive7-renderd`
   and `mgu-inputgate`, which are installed from there.
3. Refresh the source and install **MGU GameSnacks**.

Light Show moved to the main source `NamelsMissing/mgu-apps` (0.4.5).

## Layout

- `apps/<id>/` - the apps, one folder each; `mgu-repo.json` - the store manifest.
- `kit/` and `tools/build_store_app.py` - the build used by the store, copied from mgu-apps
  (`kit/` contains parts of [cauliflowermossgrape/idrive7-apps](https://github.com/cauliflowermossgrape/idrive7-apps),
  MIT, see `THIRD_PARTY_NOTICES.md`). The BMW `oap-sdk/` is not part of this repository.
- `tools/gamesnacks_mirror.py` - the web-mirror host for the Pi / laptop.

## Tests (PC, no car needed)

```sh
node tests/gamesnacks.test.js
for t in tests/wheelheat_*.test.js; do node --test "$t"; done
python3 -m pytest tests/test_gamesnacks_mirror.py
```

License: GPL-3.0-only for original project code (see `LICENSE`), third-party parts as noted in
`THIRD_PARTY_NOTICES.md`.
