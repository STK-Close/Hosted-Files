"""Object proposals from SAM 2.1 (Apache-2.0) for photographic and painted images.

A grid of single-point prompts is decoded against one image embedding. For each
point the most complete confident mask is kept (whole objects, not parts), then
duplicates are suppressed and nesting is resolved so each pixel has one owner.
"""
import os

import cv2
import numpy as np

from .regions import Region, to_lab

MEAN = np.float32([0.485, 0.456, 0.406])
STD = np.float32([0.229, 0.224, 0.225])


class SamSegmenter:
    name = "sam2"
    size = 1024

    def __init__(self, models_dir, points_per_side=16, iou_thresh=0.75, stability_thresh=0.85):
        import onnxruntime as ort

        d = os.path.join(models_dir, "sam2")
        prov = ort.get_available_providers()
        self.encoder = ort.InferenceSession(os.path.join(d, "vision_encoder.onnx"), providers=prov)
        self.decoder = ort.InferenceSession(os.path.join(d, "prompt_encoder_mask_decoder.onnx"), providers=prov)
        self.points_per_side = points_per_side
        self.iou_thresh = iou_thresh
        self.stability_thresh = stability_thresh

    @classmethod
    def load(cls, models_dir):
        if models_dir and os.path.exists(os.path.join(models_dir, "sam2", "vision_encoder.onnx")):
            return cls(models_dir)
        return None

    def _embed(self, rgb):
        h, w = rgb.shape[:2]
        scale = self.size / max(h, w)
        nh, nw = int(round(h * scale)), int(round(w * scale))
        x = cv2.resize(rgb, (nw, nh), interpolation=cv2.INTER_AREA).astype(np.float32) / 255.0
        pad = np.zeros((self.size, self.size, 3), np.float32)
        pad[:nh, :nw] = (x - MEAN) / STD
        out = self.encoder.run(None, {"pixel_values": pad.transpose(2, 0, 1)[None]})
        return out, scale, (nh, nw)

    def _decode(self, emb, point):
        feeds = {
            "input_points": np.float32(point).reshape(1, 1, 1, 2),
            "input_labels": np.ones((1, 1, 1), np.int64),
            "input_boxes": np.zeros((1, 0, 4), np.float32),
            "image_embeddings.0": emb[0], "image_embeddings.1": emb[1], "image_embeddings.2": emb[2],
        }
        iou, masks, _ = self.decoder.run(None, feeds)
        return iou[0, 0], masks[0, 0]  # (3,), (3, 256, 256) logits

    def __call__(self, rgb, progress=None):
        h, w = rgb.shape[:2]
        n = h * w
        emb, scale, (nh, nw) = self._embed(rgb)
        k = self.points_per_side
        grid = [((i + 0.5) / k, (j + 0.5) / k) for j in range(k) for i in range(k)]
        low = 256 * nh // self.size, 256 * nw // self.size
        covered = np.zeros(low, bool)
        props = []
        for idx, (fx, fy) in enumerate(grid):
            if progress and idx % 16 == 0:
                progress(idx / len(grid))
            ly, lx = int(fy * low[0]), int(fx * low[1])
            if covered[ly, lx]:
                continue
            iou, logits = self._decode(emb, (fx * nw, fy * nh))
            best = None
            for m in range(3):
                lg = logits[m][:low[0], :low[1]]
                hi, lo = (lg > 1.0).sum(), (lg > -1.0).sum()
                stability = hi / max(lo, 1)
                area = (lg > 0).sum() / lg.size
                if iou[m] < self.iou_thresh or stability < self.stability_thresh or area > 0.6 or area < 0.0008:
                    continue
                if best is None or area > best[2]:
                    best = (m, float(iou[m] * stability), area)
            if best is None:
                continue
            lg = logits[best[0]][:low[0], :low[1]]
            props.append((best[1], lg))
            covered |= lg > 0

        # Upsample, de-duplicate (mask IoU > 0.7), drop the backdrop.
        masks = []
        for score, lg in sorted(props, key=lambda p: -p[0]):
            full = cv2.resize(lg, (w, h), interpolation=cv2.INTER_LINEAR) > 0
            a = full.sum()
            if a < 0.0008 * n:
                continue
            edges = int(full[0].any()) + int(full[-1].any()) + int(full[:, 0].any()) + int(full[:, -1].any())
            if edges >= 3 and a > 0.35 * n:
                continue
            if any((full & m).sum() / (full | m).sum() > 0.7 for m, _ in masks):
                continue
            masks.append((full, score))

        lab = to_lab(rgb)
        masks.sort(key=lambda t: -t[0].sum())
        kept = []
        for m, score in masks:
            parent = next((p for p in kept if (m & p.mask).sum() > 0.9 * m.sum()), None)
            if parent is not None:
                ring = parent.mask & ~m
                contrast = np.sqrt(((lab[m].mean(0) - lab[ring].mean(0)) ** 2).sum()) if ring.any() else 0
                if m.sum() > 0.3 * parent.mask.sum() or contrast < 20:
                    continue
            kept.append(Region(mask=m, score=score, meta={"edge_uncertainty": max(3, int(0.004 * max(h, w)))}))
        # Smaller elements are painted last, so they own contested pixels.
        for i, r in enumerate(kept):
            for later in kept[i + 1:]:
                r.mask = r.mask & ~later.mask
            r.hard = r.mask.copy()
        kept = [r for r in kept if r.mask.sum() >= 0.0005 * n]
        return kept, {"sam_points": len(grid), "sam_proposals": len(props)}
