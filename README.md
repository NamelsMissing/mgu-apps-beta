# MGU Apps Beta for BMW iDrive 7

Experimental and test versions of apps for BMW iDrive 7 MGU head units. This is an unofficial project, not affiliated with BMW. Stable/current packages are published in [mgu-apps](https://github.com/NamelsMissing/mgu-apps); this repository has its own **main** branch and MGU Store catalog.

## Available apps

| App | Version | Status | Description |
| --- | --- | --- | --- |
| [**Blitzer Status**](apps/blitzer_status/README.md) | **0.1.0** | Beta | Receives Blitzer.de foreground open/close events sent by iPhone Shortcuts, shows the most recent event, and can optionally draw a thin status line in the instrument-cluster map window. A dedicated network helper opens the CarPlay-side phone port only while the app responds. Starts with the head unit; both link and cluster output are off by default. |
| [**GameSnacks**](apps/mgu_gamesnacks/README.md) | **0.2.0** | Beta | Four small games (2048, Snake, Blocks, Mines) via touch or iDrive controller, plus a separate web-mirror option using a Raspberry Pi or laptop. Parked only. |
| [**Heating Comfort**](apps/g21_wheelheat/README.md) | **0.5.1** | Older beta | Automatic seat and steering-wheel heating with BDC/seat-module detection and saved settings. **The main repository already has 0.5.4; this beta package is older.** Installing this app ID from beta may replace the newer main package. |

## Install with MGU Store

1. Add the source `namelsmissing/mgu-apps-beta`, branch **main**, in MGU Store → Settings → Sources. The name contains a lowercase **L** after “name”.
2. Also keep `namelsmissing/mgu-apps` as a source: GameSnacks uses `idrive7-renderd` / `mgu-inputgate` from the shared ecosystem, and Blitzer Status uses `cluster-render`, as does Custom Cluster.
3. Refresh sources, select the **individual app you want**, and check its version before installing. Do not install the older Heating Comfort beta over a newer main installation unless deliberately testing that version.
4. For Blitzer Status, MGU Store also needs to install its dependency **Blitzer Status Phone Port** (`mgu-cluster-net` **0.1.1**, now provided here). See the [Blitzer Status setup](apps/blitzer_status/README.md) for the two iPhone automations and new event URLs.

Blitzer Status was moved from the main repository without changing its app ID or app version. After switching sources, previously installed devices may need a source refresh and an explicit reinstall or update. The former Custom Cluster Shortcuts URLs are not interchangeable with Blitzer Status URLs.

**Limits:** An iPhone `Is Closed` automation reports that the app left the foreground; it cannot prove whether Blitzer.de is active in the background. The optional KOMBI indicator reflects only the last received Shortcut event. Hardware behaviour, MGU process autostart and connectivity must be checked on the car. Only operate or configure cluster and entertainment features while safely parked.

## Build and tests

The BMW OAP SDK is **not** distributed here. The store uses `tools/build_store_app.py` and the provided kit. Autostart-capable apps preserve `mguAppStartType` in the generated package metadata.

```sh
node tests/blitzer_status.test.js
node tests/blitzer_status_net.test.js
node tests/blitzer_status_autostart.test.js
node tests/gamesnacks.test.js
for t in tests/wheelheat_*.test.js; do node --test "$t"; done
python3 -m pytest tests/test_gamesnacks_mirror.py
```

- App sources: `apps/<id>/`
- Store component versions, paths and dependencies: [mgu-repo.json](mgu-repo.json)
- Blitzer Status phone firewall/service helper: `native/cluster-net/`
- GameSnacks web mirror: `tools/gamesnacks_mirror.py`

## License

Original work: **GPL-3.0-only**, except where stated otherwise. See [LICENSE](LICENSE), the app-local licenses and [third-party notices](THIRD_PARTY_NOTICES.md). Do not publish vehicle identifiers, SDK archives, security tokens or diagnostic logs with private data.
