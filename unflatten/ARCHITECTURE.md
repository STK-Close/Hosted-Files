# Unflatten: architecture, limits, and plan

*One image. Every layer.*

## 1. Architecture

```
Photoshop (UXP panel, plugin/)            Local engine (engine/, Python, 127.0.0.1:7865)
──────────────────────────────            ──────────────────────────────────────────────
[ UNFLATTEN ]                              segment ─► order ─► rebuild bg ─► matte ─► name
  imaging.getPixels (8-bit composite)  ──►   │         │          │            │        │
  POST /jobs (raw pixels, doc colour)        │         │          │            │        └ geometry + CLIP ViT-B/32
  poll /jobs/<id> → progress bar             │         │          │            └ exact bottom-up alpha solve
  GET result (raw RGBA per layer)      ◄──   │         │          └ surface fit │ LaMa │ Telea
  executeAsModal + suspendHistory            │         └ occlusion evidence + silhouette completion
    · original kept, hidden                  └ classical (graphics) │ SAM 2.1 (photos/paintings)
    · createPixelLayer + putPixels
      at engine-supplied bounds
```

**Why a local engine plus a thin panel.** UXP is a JavaScript runtime with no native ML inference, and it cannot start processes. The heavy lifting (ONNX models, image math) belongs in a native process. The panel only moves pixels and creates layers. The engine is a separate module with a stable wire protocol, so you can swap or upgrade any model without touching the panel.

**Why raw pixels instead of PNG.** `imaging.getPixels` returns the composite in the document's own colour space. The panel sends those bytes untouched, and the engine returns RGBA crops that the panel puts back with the *same* colour profile, so no colour conversion happens anywhere. Each layer arrives with its bounds, so positions are exact.

**Undo.** All layer creation happens in one `executeAsModal` call with `hostControl.suspendHistory`, so one Undo removes it. The user's original layers stay in place, renamed `Original (flattened)` (or grouped under that name) and hidden.

### The separation engine

| Stage | Default | Why |
|---|---|---|
| Segment (graphics) | Model-free edge-constrained regions on denoised Lab, background surface fit, counter/hole detection, shadow/glow attachment, glyph-to-text-line grouping | Covers, posters and marketing art are mostly flat fills and gradients with crisp edges. Classical analysis recovers them *exactly*, instantly, and without inventing anything. |
| Segment (photos, paintings) | **SAM 2.1 hiera-tiny** (Apache-2.0, ONNX) point grid. Whole-object preference, de-duplication, a backdrop rule, and part merging when SAM itself says two parts are one object | Best maintained open promptable segmenter that runs on CPU. |
| Stacking order | Pairwise evidence: enclosure, and which convex hull is cut by the other. Text sits above art. | No depth model needed for layered design. |
| Hidden content | Ellipse / rotated-rect / hull completion, accepted only if every added pixel lies under an occluder; 2-px underlap everywhere else | Hiding the upper layer reveals a whole shape, not a hole. Nothing visible is ever painted over. |
| Background | Polynomial surface + matched grain for clean backgrounds; **LaMa** (Apache-2.0) otherwise; OpenCV Telea if no model | LaMa is the strongest permissively licensed CPU-friendly inpainter. Surface fill is exact on gradients. |
| Matte | Bottom-up solve: alpha by projection onto the element's own colour (anti-aliasing), minimum-explaining alpha elsewhere (shadows, glows), noise-aware cut-off; the residual is folded into the background | The visible stack recomposites to the original (55–83 dB PSNR measured); edges carry no background fringe. |
| Name | Geometry for primitives ("Red Circle"), text-line heuristics ("Title Text"), CLIP ViT-B/32 zero-shot over a design vocabulary, uniqueness | Meaningful names, no "Layer 1". |

Every stage is a class with one call signature (`stages/`). The segmenter is chosen per image (`is_graphic`), and the inpainter and namer degrade gracefully when models are missing.

### Alternatives considered

- **Qwen-Image-Layered** (Alibaba, Apache-2.0, Dec 2025): a diffusion model that directly decomposes an image into RGBA layers, including hidden content. It is the closest thing to "Magic Layers" in open weights, but it has about 20B parameters and needs a large GPU. It is the leading candidate for an optional *cloud* tier or high-end-GPU mode, behind the same engine interface. It regenerates pixels, so its output would still be passed through the exact-reconstruction matte to meet "preserve original data".
- **SAM 3** (Meta, Nov 2025): text-prompted concept segmentation. Its licence is custom, not Apache. Evaluate it as a drop-in `Segmenter` once ONNX exports mature.
- **BiRefNet / ViTMatte** (MIT): learned matting for hair and fur on photos. This is the next quality step for the photographic path (Phase 3).
- **Adobe's own Firefly / Photoshop API**: excellent generative fill, but it is a paid cloud service, and calling it from a third-party plugin would need Adobe API credentials. Not needed for the prototype.

## 2. Limits and realistic expectations

- **Graphic design** (flat or gradient art, type, shapes, drop shadows, textured paper): strong. All synthetic acceptance scenes pass.
- **Photographs and paintings**: usable but not yet product quality. On the "We Can Do It!" poster the figure comes out as one clean layer and the backdrop is rebuilt. The bandana is merged with the headline banner, and the rebuilt backdrop has a smudge. On Hokusai's *Great Wave*, the wave itself is not separated, because it is effectively the whole scene and point prompts return pieces. This needs learned layer decomposition or text-prompted segmentation.
- **Single-component text** (touching letters) is named by CLIP ("Banner") until OCR lands in Phase 4.
- **Documents**: 8-bit RGB only in this prototype. 16-bit, CMYK and Lab documents get a clear message.
- **Speed** (4-core CPU, no GPU): graphics take 0.1–0.5 s at 0.2 MP. Photos take about 15 s at 1 MP, mostly SAM's encoder plus 256 point decodes, and LaMa. Segmentation runs at ≤2048 px, while matting and output stay at full resolution. A GPU (CUDA or CoreML execution provider) cuts this several-fold with no code change.
- **Memory**: full-resolution float masks. Very large documents (100 MP+) need tiled matting (Phase 5).
- **Not verified inside Photoshop yet.** This container has no Photoshop. The panel script itself was run unmodified against the live engine with a recording mock of the UXP API (`plugin/test/harness.js`), but the first real test is loading it in Photoshop. Known risk: some UXP versions reject `http://localhost` network permissions. The manifest lists both loopback forms, and the fallback is `"domains": "all"`.

## 3. Costs and dependencies

Everything runs locally, and nothing is sent to the cloud, so no consent prompt is needed. If a cloud tier is ever added, it will be opt-in with disclosure at setup.

| Dependency | Licence | Size |
|---|---|---|
| SAM 2.1 hiera-tiny (ONNX, onnx-community) | Apache-2.0 | 155 MB |
| LaMa (ONNX, Carve) | Apache-2.0 | 208 MB |
| CLIP ViT-B/32 (ONNX, Xenova) | MIT | 580 MB (text model used once to cache embeddings) |
| numpy, scipy, OpenCV, Pillow, onnxruntime, tokenizers | BSD/MIT/Apache | pip |

Running costs: zero. Commercial distribution: all of the above permit it. Adobe Marketplace listing is free.

## 4. Acceptance tests (`engine/tests`, 37 tests, all passing)

The synthetic scenes are built from anti-aliased ground-truth RGBA layers: overlapping shapes on a gradient, a star with a soft drop shadow, two lines of text on textured paper, gradient "metallic" type with an outline, and lettering on a badge over textured green.

| Requirement | Measure | Threshold | Measured |
|---|---|---|---|
| Layers recomposite to the original | PSNR, all visible layers vs input | ≥ 45 dB | 67–83 dB |
| Every object on its own layer, no merges/duplicates | IoU with ground truth; one-to-one; layer count | IoU ≥ 0.85 | 0.99–1.00 |
| Transparent, no halos or fragments | Object over magenta vs ground truth; stray opacity | ≥ 30 dB; < 0.5 % | 31–61 dB; ≈ 0 |
| Hiding a layer removes it cleanly | Stack minus layer vs scene minus object | ≥ 28 dB | 31–59 dB |
| Background reconstruction | Rebuilt background vs truth under objects | ≥ 32 dB | passes |
| Shadows travel with objects | Soft alpha present in star layer | — | passes |
| Occluded shapes completed | Circle under square ≥ 97 % recovered | — | passes |
| Names meaningful and unique | Exact names on primitives and text | — | passes |
| Original preserved, hidden; full-size background | Structure checks | — | passes |
| Panel ↔ engine protocol | Real socket round trip, bad uploads rejected | — | passes |
| Model stages | SAM path exact; LaMa touches only the hole | — | passes |

## 5. Plan

1. **Phase 1, separation engine: done (prototype).** See above.
2. **Phase 2, Photoshop integration: built, awaiting a real-Photoshop run.** Load `plugin/` with the UXP Developer Tool and run against sample covers.
3. **Phase 3, quality:**
   - Learned matting (BiRefNet/ViTMatte) on the photo path.
   - Text-prompted segmentation (SAM 3 or Grounding-style detector) to fix scene-scale objects like the Great Wave.
   - A real-image benchmark set with hand-made ground truth.
   - LaMa at higher resolution (tiled refinement).
4. **Phase 4, editable text:**
   - Add OCR (PaddleOCR / PP-OCR, Apache-2.0, ONNX) to the text-line regions the engine already finds.
   - Pick the font with a matcher against installed fonts, fitting size, tracking and colour by rendering and comparing.
   - Create native text layers with `doc.createTextLayer`, keeping the raster layer hidden beneath as reference.
5. **Phase 5, optimization and distribution:**
   - Bundle the engine as a signed background helper (PyInstaller or a C++ onnxruntime build), installed with the plugin and auto-started.
   - Alternatively, use a UXP hybrid plugin to load native inference in-process.
   - GPU execution providers, tiling for 100 MP+ documents, 16-bit support, and a CCX package for the Adobe Marketplace.
