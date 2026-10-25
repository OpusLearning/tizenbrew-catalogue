# App Catalogue for TizenBrew

A TizenBrew app module that lets you browse a small, checked list of TV apps with the remote, read what each one
does and needs, and add or open TizenBrew modules without typing package names.

It was built and tested on a Samsung QN90B (2022, Tizen 6.5) with TizenBrew 2.0.5.

## Add it to TizenBrew (once)

1. Open TizenBrew, go to the **Module Manager** (box icon), choose **Add GitHub Module**.
2. Type: `OpusLearning/tizenbrew-catalogue@v1.0.0` and press OK / move away from the field.
3. Back on TizenBrew's home screen, open **App Catalogue**.

The pinned tag (`@v1.0.0`) makes jsDelivr serve exactly this release. Without it you get the latest commit on
`main`, which jsDelivr may cache for up to a week.

## What it can and cannot do

| Entry type | In the catalogue |
|---|---|
| **TizenBrew module** | **Add** saves it to TizenBrew's module list and checks it loaded; **Open** launches it. |
| **Standalone app** (WGT/TPK) | Shows whether it is installed on this TV and **Open**s it if so. It does **not** install it: Samsung TVs only accept packages signed with a certificate made for that TV, which has to be done on a PC (Apps2Samsung or Tizen Studio, then Apps2Samsung or TizenBrew Installer). |
| **Not available** | Explains why and what to use instead. |

Nothing is reported as added or installed unless TizenBrew or the TV says so.

**Getting back here:** an app you open replaces the catalogue on screen. Leave it (Back/Home) and open TizenBrew again.
Turn on *Settings → Open the catalogue when TizenBrew starts* to land here automatically. This remembers the
previous autolaunch setting and restores it when you turn it off. Hold **Up** while TizenBrew starts to reach
its own home screen.

## How it works

- Module pages in TizenBrew have no Tizen API (`tizen`/`webapis` are undefined). The catalogue talks to
  TizenBrew's own service at `ws://127.0.0.1:8081` with the same messages TizenBrew's UI uses
  (`GetModules`, `ModuleAction add`/`autolaunch`, `LaunchModule`). It never removes a module it did not add.
  If an add fails, it rolls back only its own change.
- `service/service.js` is a small helper that TizenBrew starts with the catalogue. It listens on
  `127.0.0.1:8093` only. It asks the TV's local app API (`127.0.0.1:8001`) whether a catalogue standalone app is
  installed and opens it. It refuses app ids that are not in the catalogue, and it reads TizenBrew's autolaunch
  setting without changing it.
- Catalogue data lives in `data/catalogue.json`. The build validates it: strict package-id patterns, kinds,
  sources and licences. Text is only ever displayed (`textContent`), never run.

## Build and test

```
npm ci
npm run build    # validates data/catalogue.json, regenerates app/ and service/ (deterministic)
npm test         # unit, helper-service and remote-only UI tests (headless Chrome; set CHROME=/path if needed)
npm run check    # app/ and service/ match a fresh build; no private addresses, ids or keys
```

`app/` and `service/` are committed because TizenBrew loads files straight from jsDelivr.

## Licence

MIT. See `ATTRIBUTION.md` for the apps listed and their licences.
