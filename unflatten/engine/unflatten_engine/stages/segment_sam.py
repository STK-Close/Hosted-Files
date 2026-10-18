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

    def decode_box(self, emb, box):
        """Box prompt (x0, y0, x1, y1 in model coordinates): the whole object in it."""
        feeds = {
            "input_points": np.zeros((1, 1, 1, 2), np.float32),
            "input_labels": np.full((1, 1, 1), -10, np.int64),  # -10 = no point
            "input_boxes": np.float32(box).reshape(1, 1, 4),
            "image_embeddings.0": emb[0], "image_embeddings.1": emb[1], "image_embeddings.2": emb[2],
        }
        iou, masks, _ = self.decoder.run(None, feeds)
        return iou[0, 0], masks[0, 0]

    def decode_box_point(self, emb, box, point):
        feeds = {
            "input_points": np.float32(point).reshape(1, 1, 1, 2),
            "input_labels": np.ones((1, 1, 1), np.int64),
            "input_boxes": np.float32(box).reshape(1, 1, 4),
            "image_embeddings.0": emb[0], "image_embeddings.1": emb[1], "image_embeddings.2": emb[2],
        }
        iou, masks, _ = self.decoder.run(None, feeds)
        return iou[0, 0], masks[0, 0]

    def _decode(self, emb, point):
        pts = np.float32(point).reshape(1, 1, -1, 2)
        feeds = {
            "input_points": pts,
            "input_labels": np.ones((1, 1, pts.shape[2]), np.int64),
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
                if iou[m] < self.iou_thresh or stability < self.stability_thresh or area > 0.85 or area < 0.0008:
                    continue
                if best is None or area > best[2]:
                    best = (m, float(iou[m] * stability), area)
            if best is None:
                continue
            lg = logits[best[0]][:low[0], :low[1]]
            props.append((best[1], lg))
            covered |= lg > 0

        # Upsample, de-duplicate (mask IoU > 0.7).
        masks = []
        for score, lg in sorted(props, key=lambda p: -p[0]):
            full = cv2.resize(lg, (w, h), interpolation=cv2.INTER_LINEAR) > 0
            if full.sum() < 0.0008 * n:
                continue
            if any((full & m).sum() / (full | m).sum() > 0.7 for m, _ in masks):
                continue
            masks.append((full, score))

        masks = self._drop_backdrop(masks)
        masks = self._merge_parts(emb, masks, scale)

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

    def _merge_parts(self, emb, masks, scale, max_pairs=80):
        """Ask SAM whether touching parts are one object: prompt with a point
        inside each; if the answer covers both, they are merged."""
        if len(masks) < 2:
            return masks
        from scipy import ndimage

        def inner_point(m):
            d = ndimage.distance_transform_edt(np.pad(m, 1))[1:-1, 1:-1]
            y, x = np.unravel_index(np.argmax(d), d.shape)
            return x * scale, y * scale

        k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))
        grown = [cv2.dilate(m.astype(np.uint8), k) > 0 for m, _ in masks]
        pts = [inner_point(m) for m, _ in masks]
        parent = list(range(len(masks)))

        def find(a):
            while parent[a] != a:
                parent[a] = parent[parent[a]]
                a = parent[a]
            return a

        pairs = [(i, j) for i in range(len(masks)) for j in range(i + 1, len(masks))
                 if (grown[i] & masks[j][0]).any()]
        h, w = masks[0][0].shape
        for i, j in pairs[:max_pairs]:
            if find(i) == find(j):
                continue
            iou, logits = self._decode(emb, [pts[i], pts[j]])
            b = int(np.argmax(iou))
            if iou[b] < self.iou_thresh:
                continue
            nh, nw = int(round(h * scale)), int(round(w * scale))
            lg = logits[b][:256 * nh // self.size, :256 * nw // self.size]
            full = cv2.resize(lg, (w, h), interpolation=cv2.INTER_LINEAR) > 0
            union = masks[i][0] | masks[j][0]
            if union.sum() > 0.5 * h * w or iou[b] < 0.85:
                continue
            if (full & union).sum() / max((full | union).sum(), 1) <= 0.75:
                continue
            # A two-point prompt will return the union of two separate things;
            # require that one part alone, at some granularity, also yields the whole.
            if any(self._single_covers(emb, pts[k], union, scale) for k in (i, j)):
                parent[find(j)] = find(i)
        groups = {}
        for i in range(len(masks)):
            groups.setdefault(find(i), []).append(i)
        out = []
        for members in groups.values():
            m = np.zeros_like(masks[0][0])
            for i in members:
                m |= masks[i][0]
            out.append((m, max(masks[i][1] for i in members)))
        return out

    def _single_covers(self, emb, point, union, scale):
        h, w = union.shape
        nh, nw = int(round(h * scale)), int(round(w * scale))
        iou, logits = self._decode(emb, point)
        for m in range(3):
            if iou[m] < 0.7:
                continue
            lg = logits[m][:256 * nh // self.size, :256 * nw // self.size]
            full = cv2.resize(lg, (w, h), interpolation=cv2.INTER_LINEAR) > 0
            if (full & union).sum() / max((full | union).sum(), 1) > 0.75:
                return True
        return False

    @staticmethod
    def _drop_backdrop(masks):
        """The backdrop is the one region that owns most of the image border."""
        if not masks:
            return masks
        h, w = masks[0][0].shape
        perim = 2 * (h + w)
        contact = [int(m[0].sum() + m[-1].sum() + m[:, 0].sum() + m[:, -1].sum()) for m, _ in masks]
        i = int(np.argmax(contact))
        if contact[i] > 0.35 * perim:
            return masks[:i] + masks[i + 1:]
        return masks
