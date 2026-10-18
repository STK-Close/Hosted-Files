# Unflatten

**One image. Every layer.** A Photoshop plugin that turns a flattened image into individually named, transparent, editable layers, plus a reconstructed background and the original kept as a hidden backup.

**Version 1 (`plugin/`) is Photoshop-native:** Photoshop finds the subjects (Select Subject, Mask All Objects) and rebuilds the background (Generative Fill, checked automatically, or Content-Aware Fill). The plugin turns those into layers that recombine exactly to the original. No separate application. How it was chosen: [`docs/PHOTOSHOP_AUDIT.md`](docs/PHOTOSHOP_AUDIT.md). Install and use: [`plugin/HOW_TO_INSTALL.md`](plugin/HOW_TO_INSTALL.md).

The Python engine (`engine/`) is the reference implementation. It holds the naming, cover and graphics logic that comes to the plugin next, in a native add-on.

![Synthetic test scenes: original, rebuilt background, extracted layers](docs/synthetic_results.png)

## Layout

```
unflatten/
  plugin/            Unflatten for Photoshop, version 1 (one button, Photoshop-native)
    core.js            layer logic: which masks become layers, order, exact matte, fill check
    main.js            the one-click flow inside Photoshop
    test/              unit tests and a simulated Photoshop replaying real 27.11 results
  plugin-engine-client/  earlier panel that talks to the local engine (development only)
  engine/            reference separation engine (Python + ONNX)
    unflatten_engine/  pipeline, stages/, server, PSD writer, CLI
    tests/             acceptance tests on ground-truth scenes
    download_models.py fetch OWLv2, SAM 2.1, LaMa, CLIP (≈ 1.6 GB, permissive licences)
  probe/             Photoshop integration test panel (development only)
  docs/PHOTOSHOP_AUDIT.md  Photoshop-first audit, capability matrix, recommendation
  ARCHITECTURE.md    decisions, limits, costs, acceptance criteria, plan
```

## Run it

**Version 1 in Photoshop:** see [`plugin/HOW_TO_INSTALL.md`](plugin/HOW_TO_INSTALL.md). Nothing else to install or start.

**The reference engine** (development):

```bash
cd unflatten/engine
pip install -r requirements.txt
python download_models.py          # optional: graphics work without models
python -m unflatten_engine.server  # leave running; listens on 127.0.0.1:7865 only
```

In Photoshop 2023 (24.1) or later:

1. Open the **UXP Developer Tool** and choose **Add Plugin**. Select `unflatten/plugin-engine-client/manifest.json`, then click **Load**.
2. Open an 8-bit RGB image and choose **Plugins ▸ Unflatten**.
3. Click **Unflatten**.

The new layers appear above your original, which is hidden as `Original (flattened)`. One **Undo** reverts everything.

If the panel reports it can't reach the engine even though the server is running, your UXP version may be rejecting the localhost permission. Change `"domains"` in `plugin-engine-client/manifest.json` to `"all"` and reload the plugin.

### Without Photoshop

```bash
python -m unflatten_engine cover.png -o cover_layers/
```

This writes `cover_layers/cover.psd` (a real layered PSD), one PNG per layer, and `report.json` with timings and reconstruction quality.

### Tests

```bash
cd unflatten/engine && python -m pytest -q          # 37 synthetic-scene tests (fast)
python -m pytest -q -m real                          # acceptance A-D on real images (downloads them, ~6 min on CPU)
node ../plugin/test/core.test.js                     # version 1 layer logic
node ../plugin/test/harness.js                       # version 1 one-click flow, simulated Photoshop
node ../plugin-engine-client/test/harness.js <raw.rgb> <w> <h>  # engine-client panel vs a running engine
```
