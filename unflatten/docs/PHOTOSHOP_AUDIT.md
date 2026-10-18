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
- **Decision (agreed):** size is not traded for accuracy; see section 6.

## 4. Provisional architecture (final choice after the Photoshop measurements)

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

Instructions for running it are in [`probe/HOW_TO_RUN.md`](../probe/HOW_TO_RUN.md). In short: one-time setup, then load the plugin, click **Run safe tests**, and send back the results folder that appears on the Desktop as a zip.

**What the one button does, with no images opened by you and no recording:**

1. **Test images:** it opens its own test images, one by one. These are the public-domain/CC0 acceptance images bundled with the probe; the Unsplash "person against a blue wall" photo is downloaded at run time and not redistributed.
2. **Checks on each image**, each run automatically, timed, and saved:
   - Select Subject: the selection's coverage, and how many separate pieces it has (can people be told apart?);
   - Remove Background;
   - Mask All Objects (per-object layers);
   - Content-Aware Fill behind the subject (did it run without a dialog, did anything outside the hole change);
   - once per run, creating an editable text layer.
3. **Background scenes:** it builds four scenes with a known true background (smooth wall, brick wall, textured paper, and a hole covering 56% of the frame), fills them with Content-Aware Fill and scores them.
4. **Tidying up and saving:** it closes everything it opened without saving. After every single step it writes the report and compact result files (masks run-length encoded, fills cropped to the filled area), so an interrupted run still leaves data.

**Safe vs unsafe**

| Test | Where | Runs |
|---|---|---|
| Everything above | **Run safe tests** | on the button |
| Record a command (only if a command is not found) | separate section | by hand, when asked |
| WebAssembly | separate section marked unsafe; needs two clicks; warns on Photoshop 26.0 | never automatically |

**Comparison on my side** (`engine/tools/compare_probe.py <results folder>`):

- It decodes the same images, and first checks that Photoshop saw the same pixels.
- It runs the engine on each image and LaMa on **Photoshop's exact hole**.
- It reruns the known-truth scenes from the probe's own code.
- It writes `comparison.md` plus side-by-side images.

Metrics, chosen for the two priorities:

| Priority | Measured |
|---|---|
| Complete, grouped subjects | people in the image vs pieces in Select Subject vs engine person layers; whether the detected cap lies inside the person; agreement between the two subject masks; whether Mask All Objects gives per-object layers |
| Fully rebuilt backgrounds | anyone still detectable where a subject was removed; seam visibility; colour match with surroundings; texture kept vs blurred; error against the true background on the scenes |

**Load check.** `unflatten/probe-hello` is a panel with no permissions and no buttons. If the probe fails to load, loading this one tells a problem in the probe apart from a problem in the Photoshop and UXP Developer Tools setup.

**Validation so far.** The probe and the comparison tool were run end to end here against a simulated Photoshop (`probe/test/harness.js`): eight images and four scenes, a 45-file results folder, and a full comparison report. That validates the plumbing and file formats only; Photoshop's real behaviour is what your run measures.

## 6. Decision principles (agreed)

- **Install once, then one click.** A larger one-time download, an admin prompt at installation, or a one-time permission is acceptable. The everyday experience must be: click **Unflatten**, with no other steps, no second application and no manual startup.
- **Accuracy before size.** Separation accuracy and complete backgrounds are not traded for a smaller package. The 8-bit model experiment (section 3) stays informational; full-precision models are the default for any AI that ships in the plugin.
- **No replacement without proof.** The current engine stays as the reference. A Photoshop-native step replaces an engine step only where the probe comparison shows equal or better results on these tests, and the full acceptance set A–D must pass inside Photoshop before the local service is retired.
- **No Generative Fill or paid cloud processing** at this stage.

## 7. Migration plan (after the probe results)

1. **Background:** Content-Aware Fill in the real plugin, with the engine as fallback during development. Compare on tests A–D.
2. **Subjects:** native masks plus ported JavaScript grouping, ordering and matte.
3. **Labels and instances:** the in-plugin AI (WebAssembly or hybrid), packaged with no separate install.
4. **Parity:** acceptance tests A–D pass inside Photoshop; then the local service is retired.
5. **Then priority 2:** editable text, on top of the native text-layer API.
