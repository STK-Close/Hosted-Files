# Photoshop-first architecture: audit and proof of concept

Status: **audit complete; Photoshop integration test built, awaiting a run in Photoshop.** No part of the pipeline has been migrated yet. The current engine stays as it is, as the reference implementation and the comparison baseline.

## 1. What the product needs, and where it runs today

| Product requirement | Done today by | Lines | Needs AI? |
|---|---|---|---|
| Read the image, create layers, masks, one Undo | `plugin/main.js` (UXP) | 160 | no |
| Decide graphic vs photo | `pipeline.is_graphic` | — | no |
| Find whole subjects (person, dog, car…) and accessories | `stages/subjects.py`: OWLv2 + SAM 2.1 | 766 | **yes** |
| Group parts: wearing, holding, part of, separate | `stages/subjects.py` (rules on boxes and masks) | (same) | no; the rules are plain logic, but they need the labels from detection |
| Tell touching or overlapping people apart | SAM 2.1 masks per detection | (same) | **yes**, unless Photoshop provides per-object masks |
| Flat graphics: shapes, text lines, drop shadows | `stages/segment_classical.py`, `stages/order.py` | 414 | no |
| Typography on photos and covers | `stages/text.py` (MSER + flat regions) + CLIP check | 244 | the finder is plain math; the check uses CLIP |
| Rebuild the background | `stages/inpaint.py`: LaMa, surface fill, harmonisation | 166 | **yes** (LaMa); a native candidate exists |
| Exact edges, no halos, no ghosts | `pipeline.py` matte solve | 451 | no (arithmetic) |
| Descriptive names | `stages/name.py` (geometry, labels, CLIP) | 252 | partly (CLIP) |
| Server, CLI, PSD writer | `server.py`, `__main__.py`, `psd.py` | 311 | no; development only |

So three jobs genuinely need learned models. They are knowing **what** each element is (labels, for grouping and naming), **telling instances apart**, and **rebuilding hidden background**. Everything else is plain logic that can run in the plugin's own JavaScript.

## 2. What Photoshop exposes to a plugin

Verified against Adobe's UXP reference. "batchPlay" means Photoshop's low-level action interface, which is available to plugins but **not documented per command**. Those commands are exactly what the integration test checks.

| Need | Photoshop feature | Access from a plugin | Evidence |
|---|---|---|---|
| Read pixels | `imaging.getPixels` | **Documented API** | already used by Unflatten |
| Write pixels to a new layer | `createPixelLayer` + `imaging.putPixels` | **Documented API** | already used |
| Layer masks | `imaging.getLayerMask` / `putLayerMask` | **Documented API** | reference: single-channel grayscale data |
| Selections from code | `imaging.getSelection` / `putSelection`; `Selection` class (PS 25+): expand, contract, feather, grow, smooth, inverse… | **Documented API** | the Selection class has **no** subject, object or sky method |
| One-step Undo | `core.executeAsModal` + `hostControl.suspendHistory` | **Documented API** | already used |
| Editable text layers (priority 2) | `Document.createTextLayer` / `createLayer(TEXT)` | **Documented API** | probe check 2 |
| Select Subject | Select › Subject | batchPlay `autoCutout` (undocumented; long-standing scripting command) | probe check 2 |
| Remove Background | Quick action | batchPlay `removeBackground` (undocumented) | probe check 2 |
| Object Selection, Object Finder, Mask All Objects | Layer › Mask All Objects | **No published command.** It can only be captured by recording | probe step 1 records it, check 2 replays it |
| Content-Aware Fill (Edit › Fill) | Fill › Content-Aware | batchPlay `fill` with `contentAware` (undocumented). One Adobe Community report says scripting it failed in 25.11 | probe checks 2 and 3 |
| Content-Aware Fill workspace (sampling controls) | interactive workspace | not expected to be scriptable | — |
| Generative Fill | Firefly | batchPlay `syntheticFill`; cloud, uses generative credits | **excluded**, as you asked |
| What an object *is* (labels) | Object Finder shows outlines on hover | no API returns categories | probe reports any names Mask All Objects creates |
| Reading text (OCR) | — | Photoshop has no OCR | — |

**Can native features run inside one click?** In principle, yes. batchPlay commands run inside `executeAsModal` with `dialogOptions: "dontDisplay"`, so no dialog appears, and the whole operation stays one Undo step. Three things still need confirming in a real Photoshop:

- that each command runs without asking for input;
- how long each takes;
- whether Select Subject runs on the device or in Adobe's cloud. This depends on a Photoshop preference (Preferences › Image Processing). Cloud mode would send the image to Adobe, which matters for privacy.

**Recording real commands.** Adobe's documented way to discover a command is to listen to action notifications while doing the step by hand. The probe does that, so it learns the exact commands your Photoshop version uses rather than relying on guesses.

## 3. Running the remaining AI without a separate application

| Route | No separate app? | Install experience | Risks and costs |
|---|---|---|---|
| **Plain JavaScript in the plugin** | yes | nothing extra | fine for the matte, grouping, ordering and text-line finder; no learned models |
| **WebAssembly in the plugin** (ONNX Runtime Web) | yes | nothing extra | officially supported by UXP. Photoshop 2025 (26.0) was reported to crash on *any* WebAssembly, with no fix posted as of the last report. CPU only, slower, memory-limited. Probe step 5 tests your version |
| **Hybrid plugin** (C++ add-on with ONNX Runtime, shipped inside the plugin) | yes | **admin password prompt** at install and update | official Adobe route. Needs builds for macOS Apple-silicon, macOS Intel and Windows; Apple notarisation (developer account); native build pipeline. Full native speed, GPU possible later |
| Local background service (today) | **no** | separate start | rejected by the requirements; development only |
| Cloud API | yes | network, possibly cost | deferred, as you asked |

**Model footprint**, measured on the acceptance images:

- **Full-precision set** (OWLv2, SAM 2.1, CLIP vision): about 1.1 GB. LaMa adds 0.2 GB if Content-Aware Fill does not win.
- **Off-the-shelf 8-bit versions:** about 0.3 GB, but not usable as they are.
  - False objects appear: "Skull" and "Umbrella" on the Rosie poster, "Bottle" and "Candle" on the crew photo.
  - People are miscounted: 6 instead of 5 on the crew photo, 5 instead of 6 on the family photo.
  - They are not faster on CPU.
  - `tools/quant_compare.py` reproduces this.
- **Half-precision** (about 0.55 GB for the set) usually keeps accuracy; it is the next experiment.
- **Delivery:** models can live in the package or be fetched automatically on first run, with a progress bar and no user steps.

## 4. Recommended architecture (simplest that meets the requirements)

**Photoshop does the pixel work; the plugin carries a small brain.**

1. **Photoshop:**
   - subject cut-outs (Select Subject, plus Mask All Objects if it gives per-object masks);
   - background rebuild (Content-Aware Fill), **if** check 3 shows it matches or beats LaMa;
   - layers, masks, text layers, Undo.
2. **Plugin JavaScript, no models:**
   - splitting a multi-person selection into separate people where they don't touch;
   - grouping rules (wearing, holding, separate);
   - stacking order;
   - the exact-edge matte (so layers recombine to the original and leave no ghosts);
   - the typography line finder;
   - naming.

   These are ports of existing engine logic.
3. **In-plugin AI, only for what Photoshop cannot answer:**
   - *what* each subject is (labels for naming and grouping);
   - instance masks for people who touch, if Photoshop doesn't provide them.

   The packaging route (WebAssembly or hybrid add-on) is chosen from probe step 5. Minimal model set: OWLv2 plus SAM 2.1 decoder and encoder.
4. **The current engine** stays as the reference and test oracle until the Photoshop-native path passes the same acceptance tests A–D **inside Photoshop**. Then the local service is retired.

Decisions the probe results will settle:

| If the probe shows… | Then |
|---|---|
| Content-Aware Fill runs automatically and scores ≥ LaMa on the accuracy test and on real photos | use it for every background rebuild; drop LaMa from the package |
| Content-Aware Fill fails or is worse (for example on large holes) | keep a learned inpainter in the in-plugin AI |
| Select Subject is automatic and accurate | use it for subject masks; AI only labels and splits touching people |
| Mask All Objects can be recorded and replayed, with per-object masks | instances come from Photoshop; the AI only supplies labels |
| WebAssembly runs stably | in-plugin AI via ONNX Runtime Web, no native builds |
| WebAssembly crashes | hybrid C++ add-on |

## 5. The Photoshop integration test (`unflatten/probe`)

This is a separate development panel ("Unflatten Probe"). It works on duplicates and on its own test documents, never on your files.

**Load it:** UXP Developer Tool › Add Plugin › `unflatten/probe/manifest.json` › Load. Then open Plugins › Unflatten Probe.

1. **Record:** click Record, then by hand run Select › Subject, Edit › Fill › Content-Aware, and Layer › Mask All Objects (if your version has it). Click Stop. This captures the exact commands.
2. **Run checks:** open a photo and click Run checks. It times and reports:
   - Select Subject (coverage, how many separate pieces it finds);
   - Remove Background;
   - Mask All Objects (layers created);
   - Content-Aware Fill behind the subject (did it run without a dialog, did anything outside the hole change, how visible its outline is);
   - creating an editable text layer.

   Use the test images listed below.
3. **Run accuracy test:** builds four scenes whose true background is known (smooth blue wall, brick wall, textured paper, and a hole covering 56% of the frame). It fills them with Content-Aware Fill and scores the result against the truth.
4. **Save:** pick a folder. It writes `unflatten-probe-report.json` plus every result document as a PSD. Send those back and I'll do the full comparison.
5. **WebAssembly:** a tiny module test. Save your work first; Photoshop 2025 v26.0 was reported to crash here.

**Optional comparison with the current engine.** If the engine is running on the same machine (`python -m unflatten_engine.server`), the probe also runs it on the identical masks. It adds those results as hidden layers named "Engine · …" next to Photoshop's, and puts both sets of scores in the report.

Before release I ran the probe end to end in Node against a simulated Photoshop (`probe/test/harness.js`). That covers its control flow, metrics, report and engine comparison. The simulation says nothing about how Photoshop behaves; that is what your run will show. For reference, the engine's own scores on the probe's synthetic scenes were:

| Scene | Hole | LaMa (dB) | Seam (1 = invisible) |
|---|---|---|---|
| Blue wall | 19% | 38.4 | 0.92 |
| Brick wall | 19% | 24.9 | 1.28 |
| Paper | 19% | 32.7 | 0.96 |
| Brick wall | 56% | 21.8 | 1.57 |

**Suggested images for check 2** (all public domain or CC0, from Wikimedia Commons):

- Person wearing a baseball cap: *Bogdan Bondarenko2.jpg*, *Robbie Pierce.jpg*
- Several people: *Portrait of ASTP crews - restoration.jpg*; *Widow, two daughters and three grandchildren of the last Navajo chief…(CHS-3265).jpg*
- Covers: *This Simian World - book cover.png*, *Cover--Travels in Philadelphia.png*
- Poster: *We Can Do It!.jpg*

## 6. Migration plan (after the probe results)

1. **Background:** Content-Aware Fill in the real plugin, with the engine as fallback during development. Compare on tests A–D.
2. **Subjects:** native masks plus ported JavaScript grouping, ordering and matte.
3. **Labels and instances:** the in-plugin AI (WebAssembly or hybrid), packaged with no separate install.
4. **Parity:** acceptance tests A–D pass inside Photoshop; then the local service is retired.
5. **Then priority 2:** editable text, on top of the native text-layer API.
