"""Unflatten pipeline: segment -> order -> reconstruct background -> matte -> name.

Layer colours and alphas are solved bottom-up against what actually lies beneath
each layer, so the visible stack recomposites to the original image (to 8-bit
rounding), and every edge pixel's alpha is the smallest that explains it. That
is what keeps halos and background fringes out of extracted elements.
"""
import math
import os
import time

import cv2
import numpy as np
from scipy import ndimage

from .compose import crop_to_content, min_alpha, projected_alpha, over, psnr, solve_foreground, to_float, to_u8
from .stages.inpaint import AutoInpainter
from .stages.name import Namer
from .stages.order import complete_occluded, stacking_order
from .stages.regions import dilate, erode, extend_labels, labels_from_regions, to_lab
from .stages.segment_classical import ClassicalSegmenter, fit_background
from .types import Layer, Result

DEFAULT_MODELS = os.environ.get(
    "UNFLATTEN_MODELS", os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "models"))


def is_graphic(rgb):
    """Graphic design (flat fills, clean gradients) versus photo/painting."""
    small = cv2.resize(rgb, (256, 256 * rgb.shape[0] // max(rgb.shape[1], 1) or 1), interpolation=cv2.INTER_AREA)
    lab = to_lab(small)
    g = np.abs(np.diff(lab, axis=1)).sum(-1)
    return float((g < 1.5).mean()) > 0.55


class Engine:
    def __init__(self, models_dir=DEFAULT_MODELS, segmenter="auto", sam_points=16):
        self.models_dir = models_dir if models_dir and os.path.isdir(models_dir) else None
        self.mode = segmenter
        self.sam_points = sam_points
        self.classical = ClassicalSegmenter()
        self._sam = None
        self.inpainter = AutoInpainter(self.models_dir)
        self.namer = Namer(self.models_dir)

    @property
    def sam(self):
        if self._sam is None and self.models_dir:
            from .stages.segment_sam import SamSegmenter

            self._sam = SamSegmenter.load(self.models_dir)
            if self._sam:
                self._sam.points_per_side = self.sam_points
        return self._sam

    def capabilities(self):
        return {
            "segmenters": ["classical"] + (["sam2"] if self.models_dir and os.path.exists(
                os.path.join(self.models_dir, "sam2", "vision_encoder.onnx")) else []),
            "inpainter": "lama" if self.inpainter.lama else "telea",
            "namer": "clip" if self.namer.clip else "geometry",
            "cloud": False,
        }

    def _segment(self, rgb, report):
        mode = self.mode
        if mode == "auto":
            mode = "classical" if is_graphic(rgb) or self.sam is None else "sam2"
        if mode == "sam2" and self.sam is not None:
            regions, info = self.sam(rgb, progress=lambda f: report("Finding objects", 0.05 + 0.3 * f))
            lab = to_lab(cv2.medianBlur(rgb, 3))
            cover = np.zeros(rgb.shape[:2], bool)
            for r in regions:
                cover |= r.mask
            model, rms = fit_background(lab, ~dilate(cover, 4))
            info.update(bg_model_lab=model, bg_rms=rms)
            return regions, info, "sam2"
        regions, info = self.classical(rgb)
        return regions, info, "classical"

    def run(self, image, progress=None):
        t0 = time.time()
        timings = {}

        def report(stage, frac):
            if progress:
                progress(stage, float(frac))

        def tick(name):
            nonlocal t0
            timings[name] = round(time.time() - t0, 3)
            t0 = time.time()

        if image.ndim == 2:
            image = np.stack([image] * 3, -1)
        if image.shape[2] == 4:  # composite transparency onto white for analysis
            a = image[..., 3:4].astype(np.float32) / 255.0
            rgb = np.clip(image[..., :3] * a + 255 * (1 - a) + 0.5, 0, 255).astype(np.uint8)
        else:
            rgb = image[..., :3].copy()
        h, w = rgb.shape[:2]
        report("Analyzing image", 0.02)

        # Segment at a working resolution; matting below runs at full resolution.
        work_scale = min(1.0, 2048 / max(h, w))
        work = rgb if work_scale == 1.0 else cv2.resize(
            rgb, (round(w * work_scale), round(h * work_scale)), interpolation=cv2.INTER_AREA)
        regions, info, seg_used = self._segment(work, report)
        if work_scale != 1.0:
            for r in regions:
                r.mask = cv2.resize(r.mask.astype(np.uint8), (w, h), interpolation=cv2.INTER_NEAREST) > 0
                r.hard = cv2.resize(r.hard.astype(np.uint8), (w, h), interpolation=cv2.INTER_NEAREST) > 0
            info["bg_model_lab"] = cv2.resize(info["bg_model_lab"], (w, h), interpolation=cv2.INTER_LINEAR)
        tick("segment")
        report("Separating layers", 0.4)

        band = max(1, math.ceil(1.0 / work_scale))
        labels = labels_from_regions(regions, (h, w))
        grow = max(band + 1, max((r.meta.get("edge_uncertainty", 0) for r in regions), default=0))
        territory = extend_labels(labels, dilate(labels > 0, grow))
        for i, r in enumerate(regions):
            r.mask = territory == i + 1
            r.hard &= r.mask
        regions = [r for r in regions if r.mask.any()]
        order = stacking_order(regions)
        regions = [regions[i] for i in order]
        # Anti-aliased pixels where two elements meet are owned by the upper
        # one; the lower one continues underneath (see `add` below).
        for j in range(len(regions) - 1, 0, -1):
            claim = dilate(regions[j].hard, band + 1)
            for i in range(j):
                take = regions[i].mask & claim & ~erode(regions[i].hard, band) | (regions[i].mask & claim & ~regions[i].hard)
                if take.any():
                    regions[i].mask &= ~take
                    regions[i].hard &= ~take
                    regions[j].mask |= take
        tick("order")

        report("Rebuilding background", 0.5)
        holes = np.zeros((h, w), bool)
        for r in regions:
            holes |= r.mask
        bg_rgb, inpaint_used = self.inpainter(rgb, holes, bg_model_lab=info.get("bg_model_lab"),
                                              bg_rms=info.get("bg_rms", 99.0))
        tick("inpaint")

        report("Refining edges", 0.7)
        target = to_float(rgb)
        # Background grain level: differences below it are texture, not layer content.
        grain = np.abs(rgb.astype(np.int16) - cv2.medianBlur(rgb, 5).astype(np.int16)).max(-1)
        free = grain[~holes] if (~holes).any() else grain.ravel()
        noise = 1.48 * float(np.median(free)) / 255.0
        # x1.42: the rebuilt background carries its own, independent grain
        quiet = 1.42 * max(3.0 * noise, 1.6 * float(np.percentile(free, 99)) / 255.0) + 1.0 / 255
        below = to_float(bg_rgb)
        built = []
        hard_above = [None] * len(regions)
        acc = np.zeros((h, w), bool)
        for i in range(len(regions) - 1, -1, -1):
            hard_above[i] = acc.copy()
            acc |= dilate(regions[i].hard, 1)
        for i, r in enumerate(regions):
            unc = r.meta.get("edge_uncertainty", 0)
            a_min = min_alpha(target, below)
            # Solid body, minus anything indistinguishable from what lies beneath
            # (the counter of a small "e" that segmentation folded into the glyph).
            core = erode(r.hard, max(band, unc))
            looks_below = core & (np.abs(target - below).max(-1) <= quiet)
            if looks_below.any():
                cnt, comp, st, _ = cv2.connectedComponentsWithStats(looks_below.astype(np.uint8), connectivity=8)
                small = np.zeros(cnt, bool)
                small[1:] = st[1:, cv2.CC_STAT_AREA] < 64
                core &= ~small[comp]
            # Near the outline, a pixel is solid only if it is as opaque as its
            # neighbours (2px strokes have no interior to erode into).
            rim = core & ~erode(r.hard, max(band, unc) + 3)
            if rim.any():
                local = cv2.dilate(np.where(r.hard, a_min, 0).astype(np.float32), np.ones((5, 5), np.uint8))
                core &= ~(rim & (a_min < 0.85 * local))
            alpha = np.zeros((h, w), np.float32)
            alpha[r.mask] = a_min[r.mask]
            near_idx = None
            if core.any():
                # Edge pixels next to the solid body: a blend of the body's own
                # colour and what lies beneath (true anti-aliasing), when that fits.
                _, near_idx = ndimage.distance_transform_edt(~core, return_indices=True)
                edge = r.mask & ~core & dilate(core, band + 2)
                if edge.any():
                    iy, ix = near_idx[0][edge], near_idx[1][edge]
                    a_p, fits = projected_alpha(target[edge], below[edge], target[iy, ix],
                                                tol=max(4.0 / 255, quiet))
                    vals = alpha[edge]
                    vals[fits] = a_p[fits]
                    alpha[edge] = vals
            # Thin strokes (small type, hairlines) have no solid core nearby:
            # use the element's ink, the colour of its most opaque pixels.
            far = r.mask & ~core & (~dilate(core, band + 2) if core.any() else True)
            if far.any() and r.hard.any():
                strong = r.hard & (a_min >= np.percentile(a_min[r.hard], 80))
                ink = np.median(target[strong], axis=0)
                a_p, fits = projected_alpha(target[far], below[far], np.broadcast_to(ink, target[far].shape),
                                            tol=max(4.0 / 255, quiet))
                vals = alpha[far]
                vals[fits] = a_p[fits]
                alpha[far] = vals
            if noise > 0.5 / 255:
                # In the transition band, a pixel within grain of the rebuilt
                # background is background; the residual fold below keeps its
                # exact original value in the Background layer.
                calm = r.mask & ~core & (np.abs(target - below).max(-1) < quiet) & (alpha < 0.5)
                alpha[calm] = 0.0
            if unc:  # proposal edges are approximate: ignore faint reconstruction error
                soft = r.mask & ~core
                alpha[soft] = np.clip((alpha[soft] - 0.06) / 0.94, 0, 1)
            alpha[core] = 1.0
            fg = solve_foreground(target, below, alpha)

            # Content hidden under higher layers: a completed silhouette where the
            # shape is unambiguous, and a thin underlap everywhere else, so that
            # moving or hiding an upper layer does not reveal a hairline gap.
            occl = hard_above[i]
            add = dilate(r.hard, 2) & occl & ~r.mask
            cover = np.ones((h, w), np.float32)
            if r.kind == "object":
                full = complete_occluded(r.hard, occl)
                if full is not None:
                    hidden = (full > 0) & occl & ~r.mask
                    cover[hidden & ~add] = full[hidden & ~add]
                    add |= hidden
                    r.meta["completed"] = True
            if add.any() and near_idx is not None:
                iy, ix = near_idx
                fg[add] = target[iy[add], ix[add]]
                alpha[add] = cover[add]

            rgba = np.dstack([to_u8(fg), to_u8(alpha)])
            rgba[rgba[..., 3] == 0, :3] = 0
            q_rgb, q_a = to_float(rgba[..., :3]), to_float(rgba[..., 3])
            below = over(below, q_rgb, q_a)
            built.append((r, rgba))
        tick("matte")

        # Make the stack exact: fold any remaining residual into the background
        # wherever the background is still visible through the layers.
        trans = np.ones((h, w), np.float32)
        contrib = np.zeros((h, w, 3), np.float32)
        for _, rgba in built:
            a = to_float(rgba[..., 3])
            contrib = contrib * (1 - a[..., None]) + to_float(rgba[..., :3]) * a[..., None]
            trans *= 1 - a
        bg_f = to_float(bg_rgb)
        resid = np.abs(bg_f * trans[..., None] + contrib - target).max(-1)
        fix = (resid > 1.5 / 255) & (trans > 0.1)
        if fix.any():
            corrected = (target - contrib) / np.maximum(trans[..., None], 1e-3)
            bg_f[fix] = np.clip(corrected[fix], 0, 1)
            bg_rgb = to_u8(bg_f)

        report("Naming layers", 0.85)
        infos, crops = [], []
        for r, rgba in built:
            c = crop_to_content(rgba)
            crops.append(c)
            if c is None:
                infos.append(None)
                continue
            sel = r.hard if r.hard.any() else r.mask
            ys = np.nonzero(r.hard.any(1))[0]
            infos.append({
                "kind": r.kind, "hard": r.hard, "rgba": c[0],
                "rgb_mean": rgb[sel].mean(0), "text_height": int(ys.max() - ys.min() + 1) if len(ys) else 0,
            })
        valid = [k for k, x in enumerate(infos) if x is not None]
        names = self.namer([infos[k] for k in valid])
        tick("name")

        layers = [Layer("Original (flattened)", np.dstack([rgb, np.full((h, w), 255, np.uint8)]),
                        kind="original", visible=False)]
        layers.append(Layer("Background", np.dstack([bg_rgb, np.full((h, w), 255, np.uint8)]),
                            kind="background", meta={"inpainter": inpaint_used}))
        for k, name in zip(valid, names):
            r, _ = built[k]
            crop, x, y = crops[k]
            layers.append(Layer(name, crop, left=x, top=y, kind="text" if r.kind == "text" else "object",
                                meta={k2: v for k2, v in r.meta.items() if k2 in ("completed", "soft_effect", "glyphs")}))

        from .compose import flatten

        recon = flatten(layers, w, h)
        stats = {
            "segmenter": seg_used, "inpainter": inpaint_used, "namer": "clip" if self.namer.clip else "geometry",
            "layers": len(layers) - 2, "reconstruction_psnr": round(psnr(recon, target), 2),
            "timings": timings, "bg_rms": round(float(info.get("bg_rms", 0)), 3),
        }
        report("Done", 1.0)
        return Result(w, h, layers, stats)


_ENGINE = None


def unflatten(image, progress=None, **kw):
    global _ENGINE
    if _ENGINE is None or kw:
        _ENGINE = Engine(**kw)
    return _ENGINE.run(image, progress)
