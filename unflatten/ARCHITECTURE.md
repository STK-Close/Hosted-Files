# Unflatten: architecture, limits, and plan

> **Superseded for the product by version 1 (`plugin/`), October 2026.** Photoshop does the subject masks and the background rebuild; the measurements and the decision are in [`docs/PHOTOSHOP_AUDIT.md`](docs/PHOTOSHOP_AUDIT.md), section 8. This document describes the reference engine, which stays the test oracle and the source of the logic being ported.


*One image. Every layer.*

## 1. Architecture

```
Photoshop (UXP panel, plugin-engine-client/) Local engine (engine/, Python, 127.0.0.1:7865)
──────────────────────────────            ──────────────────────────────────────────────
[ UNFLATTEN ]                              understand ─► group ─► mask ─► order ─► rebuild bg ─► matte ─► name
  imaging.getPixels (8-bit composite)  ──►
  POST /jobs (raw pixels, doc colour)       photos, paintings, covers            graphics (flat art)
  poll /jobs/<id> → progress bar            ─────────────────────────            ───────────────────
  GET result (raw RGBA per layer)      ◄──  OWLv2: subjects + accessories        classical regions,
  executeAsModal + suspendHistory           SAM 2.1: whole-subject masks         text lines, shadows,
    · original kept, hidden                 relations: part of / wearing /       figures assembled
    · createPixelLayer + putPixels            holding / separate                 from parts (OWLv2+SAM)
      at engine-supplied bounds             typography (MSER + flat regions,
                                              CLIP-verified), cast shadows,
                                              ink elements on plain surfaces
```

**Why a local engine plus a thin panel.** UXP is a JavaScript runtime with no native ML inference, and it cannot start processes. The heavy lifting (ONNX models, image math) belongs in a native process. The panel only moves pixels and creates layers. The engine is a separate module with a stable wire protocol, so you can swap or upgrade any model without touching the panel.

**Why raw pixels instead of PNG.** `imaging.getPixels` returns the composite in the document's own colour space. The panel sends those bytes untouched, and the engine returns RGBA crops that the panel puts back with the *same* colour profile, so no colour conversion happens anywhere. Each layer arrives with its bounds, so positions are exact.

**Undo.** All layer creation happens in one `executeAsModal` call with `hostControl.suspendHistory`, so one Undo removes it. The user's original layers stay in place, renamed `Original (flattened)` (or grouped under that name) and hidden.

### Processing order (one click)

1. **Analyse.** Classify the image as graphic (flat fills, few colours) or photo/painting/cover, by flatness *and* colour richness. A portrait on a plain backdrop is mostly flat but colour-rich, so it goes to the photo path.
2. **Identify subjects.** OWLv2 (open-vocabulary detection) scores the whole image against a vocabulary of subjects (person, dog, car, tree, flag, chair, sword, …) and accessories (baseball cap, hat, sunglasses, glasses, collar, …).
3. **Whole-subject masks.** SAM 2.1 answers a box prompt, a looser box plus a point, and a point alone, each at three granularities. It keeps the confident answer that best fills the subject's box, and widens the box when the mask runs into its edge. That returns all of a person, not their jacket.
4. **Relations, then grouping.**
   - *Part of:* fragments inside a subject belong to it.
   - *Wearing:* accessories inside a person's box that touch them join the person.
   - *Holding:* small objects inside a person's box that touch them join the person.
   - *Separate:* people never merge with each other; furniture never absorbs its sitter.
   - Same-kind detections that touch merge (three boxes on one flag make one flag).
   - A second "person" that mostly overlaps another is a duplicate and is dropped.
   - Missing limbs and laps are recovered by probing next to each person. A person first only becomes a fuller view of themselves; separate parts are attached after that.
5. **Scenery stays background.** Trees, vehicles and buildings that are out of focus behind a sharp main subject, or are distant details, are left in the background.
6. **Cast shadows** next to a subject (surface darker than the surface farther away predicts) join that subject as soft alpha.
7. **Typography.**
   - *Detection:* lines come from MSER on luminance and colour channels plus flat-region glyphs, grouped by ink, height, baseline and spacing.
   - *Verification:* CLIP judges each line's glyph shapes alone, as black on white.
   - *Completion:* each line is completed with same-ink pixels on its baseline.
   - *Ownership:* lettering lying on a person (a name tag, a shirt logo) is part of them.
8. **Ink elements.** On plain surfaces (cloth, paper, flat poster fields), drawings and ornaments are found as ink that differs from the surface. Masks of detected drawings are tightened to their strokes.
9. **Order, rebuild, matte, name.** Unchanged from the first version, with the reconstruction rules below.

### Background reconstruction rules

- The background is rebuilt under *every* extracted element and covers the whole canvas (opaque everywhere).
- An element's cut reaches 0.8% of the image past its mask, so edge fringe and JPEG halos are never left in the inpainting context.
- **Fill choice.** A polynomial surface is used only for genuinely smooth backgrounds (residual noise ≤ 3 levels). Textured cloth, paper and walls go to **LaMa**, which rebuilds texture.
- **Seam harmonisation.** The fill's colour mismatch along each hole border is measured and spread smoothly inward, so no shade-shifted hole shape remains.
- **No ghosts.** The background only takes back pixels that look like background. An element's anti-aliased rim (pixels that are a blend of its ink and the backdrop) always stays with the element. This is what removed the outline traces of people and letters.
- **Hidden parts of lower layers.** Where an upper element hides part of a lower one, the hidden part is rebuilt by double inpainting (inpaint the occluded area over "background plus this element only"; keep what differs from the bare background). Flat shapes use exact silhouette completion.

### Models

| Stage | Model | Licence | Size |
|---|---|---|---|
| Subjects, accessories | OWLv2 B/16 ensemble (ONNX, Xenova) | Apache-2.0 | 614 MB |
| Masks | SAM 2.1 hiera-tiny (ONNX, onnx-community) | Apache-2.0 | 155 MB |
| Background | LaMa (ONNX, Carve) | Apache-2.0 | 208 MB |
| Names, text verification | CLIP ViT-B/32 (ONNX, Xenova) | MIT | 580 MB |

Libraries: numpy, scipy, OpenCV, Pillow, onnxruntime, tokenizers. Everything runs locally; nothing is sent to the cloud; running cost is zero. Every licence permits commercial distribution.

### Alternatives considered

- **Qwen-Image-Layered** (Alibaba, Apache-2.0): decomposes an image into RGBA layers with hidden content, but it has about 20B parameters and needs a large GPU. It is the candidate for an optional cloud or high-end-GPU tier behind the same engine interface.
- **SAM 3** (Meta): text-prompted concept segmentation, under a custom licence. It could replace the OWLv2 + SAM 2.1 pair once ONNX exports mature.
- **Grounding DINO tiny** (Apache-2.0): comparable to OWLv2, with more complex post-processing. **RF-DETR** (Apache-2.0): faster, but COCO classes only (no hats, no trees).
- **Larger-context inpainting:** LaMa at higher resolution, or a diffusion inpainter, would address the very-large-hole limit below. Two cheaper attempts were tried and rejected because they looked worse: strip-wise LaMa over a smooth pre-fill, and a naive exemplar shift-copy.

## 2. Limits and realistic expectations

- **Graphic design** (flat or gradient art, type, shapes, drop shadows, textured paper): strong; all synthetic scenes pass.
- **Photos, paintings, book covers:** subjects come out whole and the rebuilt backgrounds are clean on the acceptance images (table below), with these exceptions:
  - **Very large holes.** When removed subjects cover about half the frame (six people standing together), LaMa at its 512 px working size fills the middle with a dark, blurred mean. The wall around it is rebuilt correctly. The fix is larger-context or diffusion inpainting (Phase 3).
  - **Big holes over complex scenery** (a seated person in front of trees and steps) are plausible but soft.
  - **Vocabulary gaps.** Objects outside the detector vocabulary get generic or wrong names: the Apollo–Soyuz model is "Lamp" and only half extracted, and line drawings are called "Dog".
  - **Hood vs hat.** A hood reads as a hat ("Person Wearing Hat").
  - **Missed letters.** A letter missed by text detection on worn cloth can remain in the background (rare after line completion).
- **Speed** (4-core CPU, no GPU): photos take 17–45 s per image at about 1 MP (OWLv2 4–6 s, SAM prompts, LaMa). Graphics take seconds. A GPU execution provider cuts this several-fold with no code change.
- **Documents:** 8-bit RGB only in this prototype.
- **Not verified inside Photoshop yet.** The panel script runs unmodified against the live engine through a recording mock of the UXP API (`plugin-engine-client/test/harness.js`); the first real test is loading it in Photoshop.

## 3. Acceptance tests

### Synthetic scenes with ground truth (`pytest`, 37 tests, all passing)

| Requirement | Measure | Threshold | Measured |
|---|---|---|---|
| Layers recomposite to the original | PSNR, all visible layers vs input | ≥ 45 dB | 66–83 dB |
| Every object on its own layer, no merges/duplicates | IoU with ground truth; one-to-one | IoU ≥ 0.85 | 0.99–1.00 |
| Transparent, no halos or fragments | Object over magenta vs ground truth | ≥ 28 dB* | 29–61 dB |
| Hiding a layer removes it cleanly | Stack minus layer vs scene minus object | ≥ 28 dB | 31–59 dB |
| Background reconstruction | Rebuilt background vs truth under objects | ≥ 32 dB | passes |

\* Lowered from 30 dB on purpose. The anti-aliased rim of an element now always stays with the element, so the rebuilt background never shows its outline. On grainy paper, a 2 px text stroke's rim carries a little grain (29 dB).

### Real images (`pytest -m real`, downloaded on first use, not redistributed)

Shared checks for every image:

- the layers recomposite to the original at ≥ 45 dB;
- the background is opaque everywhere;
- every element has a transparent surround;
- OWLv2 finds no person in the rebuilt background where one was removed.

| Test | Image | Checks | Result |
|---|---|---|---|
| A: person against blue wall | Unsplash portrait | one complete person layer; wall behind matches its surroundings (ΔE ≤ 8) | **pass** |
| B: person wearing baseball cap | CC0 portraits (red cap, black cap) | one layer named "Person Wearing Baseball Cap"; the detected cap is inside it; no separate cap layer | **pass**, **pass** |
| C: several people | NASA ASTP crew (5) | ≥ 4 person layers, each one piece; background behind each matches surroundings | **pass** |
| C: several people | 1901 family portrait (6) | same | **fail**: all six people extracted whole, but the wall behind the group is rebuilt with a dark blur (very-large-hole limit) |
| D: covers / poster | *This Simian World*, *Travels in Philadelphia*, *We Can Do It!* | type separated into lines; no fragmentation (≤ 8–10 layers); no lettering left in the background | **pass**, **pass**, **pass** |

## 4. Plan

1. **Phase 1, separation engine: done.**
2. **Phase 2, Photoshop integration: built, awaiting a real-Photoshop run.**
3. **Phase 3, quality:**
   - Larger-context inpainting for very large holes (tiled high-resolution LaMa or a diffusion inpainter, local or opt-in cloud).
   - Learned matting (BiRefNet/ViTMatte) for hair.
   - A wider subject vocabulary.
4. **Phase 4, editable text:** OCR on the text lines already found, font matching, and native text layers.
5. **Phase 5, optimisation and distribution:**
   - A bundled, auto-started engine.
   - GPU providers.
   - Tiling for very large documents, 16-bit support, and a Marketplace package.
