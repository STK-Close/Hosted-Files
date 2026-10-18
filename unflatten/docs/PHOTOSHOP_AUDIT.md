# Photoshop-first architecture: audit and proof of concept

Status: **measured in Photoshop 27.1 and 27.11 (macOS, 18 October 2026), free and generative methods; results in [section 8](#8-measured-results-photoshop-271), current recommendation at the end of that section.** No part of the pipeline has been migrated yet. The current engine stays as it is, as the reference implementation and the comparison baseline.

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

## 4. Provisional architecture (superseded by the measured recommendation in section 8)

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

## 8. Measured results (Photoshop 27.1)

Run on Photoshop 27.1.0, UXP 9.0.2, macOS (Intel), probe 0.2.4, on the eight acceptance images and four known-truth scenes. Full tables: [`probe_results/2026-10-18/comparison.md`](probe_results/2026-10-18/comparison.md).

### What runs unattended inside one click

| Operation | Command | Unattended? | Time per image |
|---|---|---|---|
| Select Subject | `autoCutout` | yes, on all 8 | 1.9–2.7 s (11 s on one gold-lettered cover) |
| Remove Background | `removeBackground` | yes, on all 8 | 1.2–2.7 s (10 s on the same cover) |
| Mask All Objects | `autoMaskGenerate` `{sampleAllLayers: false, hardEdge: true}`, found by recording; not published by Adobe | yes, on all 8 | 4–15 s |
| Content-Aware Fill | `fill` with `contentAware` + colour adaptation | yes, when the hole leaves enough to sample; changed nothing outside the hole | 1.7–4 s |
| Editable text layer | documented API | yes | < 0.1 s |

Three things a plugin must handle, all found by this run:

- **Colour setup.** The imaging API refuses to write pixels into grayscale documents, untagged ones, and ones with an embedded profile it does not know ("c2"). Six of the eight images were like that. The fix: convert to RGB and assign sRGB when the profile is unusable. Assigning keeps pixel values unchanged.
- **Huge holes.** Content-Aware Fill raises an alert when the hole is nearly the whole image ("not enough source pixels"). Dialogs being switched off does not stop this alert. It happened when Select Subject took 97% of a cover.
- **Unknown commands.** Replaying a command name Photoshop does not know also raises an alert. Only verified descriptors may be used.

### Subjects

| | Photoshop | Engine |
|---|---|---|
| Single person, cap kept with the person | Select Subject: yes (cap 75% inside) | yes (75–76%) |
| Five people (crew) | Select Subject: one piece. **Mask All Objects: 11 objects; all 5 people match engine layers (IoU 0.63–0.94), plus flags, chairs and the table** | 11 named layers |
| Six people (family) | Select Subject: one piece. **Mask All Objects: 6 objects, one per person (IoU 0.81–0.96)**, visibly cleaner: whole bodies and feet, no specks | 6 people, some speckle and partial legs |
| Book covers | Mask All Objects returns the whole cover as one object; Select Subject took 97% of one cover | each drawing, title and text line separately |
| Names | none ("Object 1", "Object 2"…) | descriptive ("Person Wearing Baseball Cap", "Flag 1", "Chair 2") |

So on photos, **Photoshop's Mask All Objects gives better instance masks than the engine's SAM masks**, but no names. On graphics and covers, Photoshop gives nothing usable, and the engine's path is required.

### Backgrounds

On Photoshop's own hole (the whole Select Subject area, so 20–54% of the image):

- **Small and medium holes on photos and posters** (single person; the Rosie poster; the Philadelphia cover): **Content-Aware Fill is better.** Seams are less visible, it keeps texture where the engine's fill (LaMa) blurs, and colour matches as well or better.
- **Large holes on group photos** (crew 47%, family 49%; the seated man 50%): **neither is acceptable.**
  - Content-Aware Fill clones recognisable pieces into the hole: flag fragments, the blanket pattern of the people removed, a column of tree. These read as ghosts.
  - LaMa leaves a dark blur.
  - The metrics favour Content-Aware Fill here (more "detail") but the pictures show the cloning, so the pictures decide.
- **Known-truth scenes:**
  - Plain wall and paper: even.
  - Brick: the engine is more accurate (24.9 vs 18.8 dB; 21.8 vs 16.5 dB on the 56% hole). Content-Aware Fill bends the brick courses.

### Recommendation

**Photoshop does the photo cut-outs and the everyday background fill; the plugin's own AI names things and handles graphics; large holes get a dedicated strategy before migration.**

1. **Subject masks on photos:** Mask All Objects, plus Select Subject for a single-subject image. The engine's grouping rules (wearing, holding, separate) and the exact-edge matte, ported to the plugin's JavaScript, then work on Photoshop's masks.
2. **Names:** the in-plugin detector (OWLv2) labels each Photoshop object by overlap. Measured overlap with the engine's people is 0.63–0.96, so matching is reliable.
3. **Graphics and covers:** the engine's existing path. That is the classical segmentation, the text finder and SAM for drawn figures. Photoshop has no equivalent.
4. **Background:** Content-Aware Fill for holes up to about a third of the image. For larger holes, decide by a follow-up measurement. Candidates:
   - fill one object at a time, smallest first, so each hole is small and samples clean background;
   - LaMa only on the parts Content-Aware Fill cannot sample.

   LaMa stays in the package until that measurement says otherwise.
5. **Packaging:** still open. The in-plugin AI (OWLv2, CLIP, SAM for covers, perhaps LaMa) needs either WebAssembly or the hybrid add-on. WebAssembly is present in UXP 9.0.2 (`typeof WebAssembly` is "object"), but the unsafe probe test has not been run yet.

The engine remains the reference until acceptance tests A–D pass inside Photoshop (section 6).

### Second run: Photoshop 27.11, fill strategies (18 October 2026)

Photoshop 27.11.0 with UXP 9.4.1, probe 0.3.0. Select Subject, Remove Background and Mask All Objects behaved as on 27.1 (same coverage and same object counts; Mask All Objects took 6–22 s). Four Content-Aware Fill strategies were run on one shared hole per image:

- **Clearing the hole first changes nothing.** "All at once" and "all at once, cleared" gave identical pixels, so Content-Aware Fill already ignores the selected pixels. The blanket-pattern ghost on the family photo is sampled from outside the hole.
- **Splitting the fill makes it worse.** Filling one object at a time, or in rings from the edge, produced patchy blocks and visible steps on the group photos. On the known-truth brick scenes it scored lower: 13.5–15.1 dB, against 16.1–16.3 dB for a single fill and 21.8–23.1 dB for the engine.
- **Mask All Objects also returns scenery** (the steps behind the seated man), which made that hole 88% of the image. Probe 0.4.0 leaves out objects that touch three image edges and lie mostly outside Select Subject's selection.

Conclusion for the free path: a single Content-Aware Fill for small and medium holes; nothing tested so far rebuilds large group holes acceptably without credits.

### Direction agreed after the second run

Unflatten is one plugin with two background methods: **generative** (Generative Fill and possibly Enhance Edge; uses Adobe credits; the main target, since it will be used where credits are plentiful) and **free** (Content-Aware Fill and the plugin's own AI). The free method is the automatic fallback when there is no network, an outage, a refusal by Adobe's content filters, or no credits. Probe 0.4.0 measures the generative method on the same holes.

### Third run: generative methods, Photoshop 27.11 (18 October 2026)

Probe 0.4.1 replayed recorded commands on the same holes as Content-Aware Fill and the engine. Pictures and tables: [`probe_results/2026-10-18-run3-generative/`](probe_results/2026-10-18-run3-generative/comparison.md).

**Driving it from a plugin.**
- Generative Fill is `syntheticFill` with an empty prompt, workflow `in_painting`.
- It runs from a plugin only when its recorded `_target`, `documentID` and `layerID` are kept and pointed at the current document. Without them Photoshop raises "Generative Fill is not currently available", an alert that dialog settings do not suppress.
- About 8–12 s per fill.
- Enhance Edge is `modernRefineEdge`. It writes a new layer, about 7 s, 20 credits.

**Backgrounds: Generative Fill is the best method measured on photos.**

| | Generative Fill | Content-Aware Fill | Engine (LaMa) |
|---|---|---|---|
| Brick wall, 56% hole (PSNR vs truth) | **22.8 dB** | 16.1 dB | 21.8 dB |
| Brick wall, three figures | **26.1 dB** | 16.3 dB | 23.1 dB |
| Family photo | clean brick wall, faint marks at the ground | blanket-pattern ghost | dark blur |
| Crew photo | believable backdrop, both flags intact | cloned flag pieces | smeared flag edge |
| Man on the steps | steps and railing continued | tree column cloned in | washed out |
| Woman against the wall | clean | clean | dark smudge |
| Rosie poster (flat artwork) | **invents a teal shape** in the empty yellow | clean | clean |

- **Visible seams:** Generative Fill had the least visible seams on six of the seven images.
- **Pixels outside the hole:** it also changes 0.3–2.7% of pixels just outside the hole. Unflatten takes the fill only inside the hole, so this does not matter.
- **Flat artwork:** on flat artwork, an empty prompt makes it add something. The poster failure is caught by the measures already computed: colour difference to the surroundings ΔE 20.4, against 1–9 elsewhere, and texture 1.31 against the surroundings.

**Enhance Edge: not adopted for now.** It keeps the mask and rewrites the edge colours on a new layer. At full zoom the edges are softer, not clearly cleaner ([zoom](probe_results/2026-10-18-run3-generative/enhance_edge_zoom.jpg)). The probe saved the layer's colours but not its transparency, so the comparison is incomplete. At 20 credits per subject (120 for a six-person photo) it is not worth adding before a fair test. The exact-edge matte already guarantees that layers recombine to the original without fringes.

### Recommendation after three runs

One plugin, one click.

1. **Subjects (photos):**
   - Mask All Objects for separate people and objects, plus Select Subject for single-subject images.
   - The plugin names them by overlap with its own detector, and applies the ported grouping rules and exact-edge matte.
2. **Subjects (covers, posters, graphics):** the engine's classical segmentation and text finder, ported to the plugin. Photoshop returns the whole cover as one object.
3. **Background, generative mode (default where credits are available):**
   - Generative Fill on the combined hole, then an automatic check of the result's colour and texture against the surroundings.
   - If the check fails, use the next Generative Fill variation; if that fails too, use Content-Aware Fill.
   - Flat graphics (the existing graphic test) go straight to Content-Aware Fill.
4. **Background, free mode:** Content-Aware Fill in one pass for small and medium holes; the plugin's own inpainter only if it is packaged. It is also the automatic fallback when there is no network, Adobe refuses the image, or there are no credits.
5. **Packaging of the plugin's own AI: hybrid add-on.**
   - **The test:** the WebAssembly test was run twice on Photoshop 27.11 (UXP 9.4.1, macOS Intel). Both times it stopped at its first step: instantiating a 41-byte module that adds two numbers. Nothing returned in 48 minutes, and Photoshop had to be force-quit both times.
   - **Conclusion:** WebAssembly is not usable in this host, independent of model size or speed. In a sandbox that mimics UXP, the same ONNX Runtime Web setup ran the SAM 2.1 encoder in 17 s, matching native output exactly. The blocker is the host, not the approach.
   - **Chosen route:** the plugin's own AI ships as a UXP hybrid add-on (C++ with native ONNX Runtime, built for macOS Apple silicon, macOS Intel and Windows). It runs at native speed and can use several cores. The cost is a one-time install with an administrator prompt, plus code signing and notarisation for distribution.
