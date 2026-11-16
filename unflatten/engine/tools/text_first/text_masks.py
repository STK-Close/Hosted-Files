"""Prototype step 1: find every line of lettering and cut its exact letters,
with local models only (PP-OCR for boxes and reading, SAM 2.1 for the cut).
  python text_masks.py <cover.png> <out_dir>
Writes text_mask.png (0..255), lines.json and a review image.
"""
import json
import os
import sys

import cv2
import numpy as np
from PIL import Image

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
from rapidocr_onnxruntime import RapidOCR  # noqa: E402
from unflatten_engine.stages.segment_sam import SamSegmenter  # noqa: E402

src, out = sys.argv[1:3]
os.makedirs(out, exist_ok=True)
rgb = np.array(Image.open(src).convert("RGB"))
H, W = rgb.shape[:2]
sam = SamSegmenter.load(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "models"))
# Lines at several scales: very large titles are only read whole when the
# image is shrunk. Larger boxes first; a box already covered by a processed
# one of similar height is a duplicate.
ocr = RapidOCR()
found = []
for sc in (1.0, 0.5, 0.3):
    im = rgb if sc == 1.0 else cv2.resize(rgb, None, fx=sc, fy=sc, interpolation=cv2.INTER_AREA)
    r, _ = ocr(im)
    for box, text, score in r or []:
        pts = np.array(box, np.float32) / sc
        found.append((pts, text, float(score)))
found.sort(key=lambda f: -float(np.ptp(f[0][:, 0]) * np.ptp(f[0][:, 1])))
res, taken = [], []
for pts, text, score in found:
    x0, y0 = pts.min(0); x1, y1 = pts.max(0)
    dup = False
    for (a0, b0, a1, b1) in taken:
        ix = max(0, min(x1, a1) - max(x0, a0)); iy = max(0, min(y1, b1) - max(y0, b0))
        if ix * iy >= 0.7 * (x1 - x0) * (y1 - y0) and 0.5 <= (y1 - y0) / (b1 - b0) <= 1.7:
            dup = True; break
    if not dup:
        res.append((pts, text, score)); taken.append((x0, y0, x1, y1))


def sam_box(crop, box):
    """Best SAM mask for a box prompt inside `crop` (crop pixel coordinates)."""
    emb, scale, (nh, nw) = sam._embed(crop)
    iou, masks = sam.decode_box(emb, np.array(box, np.float32) * scale)
    best = None
    for k in np.argsort(-iou):
        m = cv2.resize(masks[k], (sam.size, sam.size), interpolation=cv2.INTER_LINEAR)[:nh, :nw]
        m = cv2.resize(m, (crop.shape[1], crop.shape[0]), interpolation=cv2.INTER_LINEAR)
        x0, y0, x1, y1 = [int(v) for v in box]
        fill = float((m[max(y0, 0):y1, max(x0, 0):x1] > 0).mean())
        # letters fill part of their box; a mask that fills it all is the backdrop
        if 0.08 <= fill <= 0.75:
            return m, float(iou[k]), fill
        if best is None:
            best = (m, float(iou[k]), fill)
    return best


def split_words(ink_cols, min_gap):
    """Column ranges separated by gaps of at least min_gap empty columns."""
    xs = np.where(ink_cols)[0]
    if xs.size == 0:
        return []
    out_, start, prev = [], xs[0], xs[0]
    for x in xs[1:]:
        if x - prev > min_gap:
            out_.append((start, prev + 1)); start = x
        prev = x
    out_.append((start, prev + 1))
    return out_


mask = np.zeros((H, W), np.float32)
lines = []
for box, text, score in res or []:
    pts = np.array(box, np.float32)
    (x0, y0), (x1, y1) = pts.min(0), pts.max(0)
    lh = y1 - y0
    pad = 0.6 * lh
    cx0, cy0, cx1, cy1 = [int(round(v)) for v in (max(0, x0 - pad), max(0, y0 - pad), min(W, x1 + pad), min(H, y1 + pad))]
    crop = rgb[cy0:cy1, cx0:cx1]
    # zoom small lines so the letters are large enough for the model
    z = float(np.clip(110.0 / max(lh, 1), 1.0, 4.0))
    if z > 1.05:
        crop = cv2.resize(crop, None, fx=z, fy=z, interpolation=cv2.INTER_CUBIC)
    lb = [(x0 - cx0) * z - 4, (y0 - cy0) * z - 4, (x1 - cx0) * z + 4, (y1 - cy0) * z + 4]
    m, iou, fill = sam_box(crop, lb)
    line_mask = m > 0
    # long lines: the first cut may hold only some words; cut each remaining gap separately
    bx0, by0, bx1, by1 = [int(max(v, 0)) for v in lb]
    for _ in range(6):
        cols = line_mask[by0:by1, bx0:bx1].any(0)
        gap_min = int(1.2 * lh * z)
        covered = split_words(cols, gap_min)
        gaps, prev = [], 0
        for a, b in covered + [(bx1 - bx0, bx1 - bx0)]:
            if a - prev > gap_min:
                gaps.append((prev, a))
            prev = b
        if not gaps:
            break
        g = max(gaps, key=lambda t: t[1] - t[0])
        m2, iou2, fill2 = sam_box(crop, [bx0 + g[0], by0, bx0 + g[1], by1])
        add = (m2 > 0)
        add[:, :bx0 + g[0]] = False; add[:, bx0 + g[1]:] = False
        if add.sum() < 20:
            break
        line_mask |= add
    # keep only what lies in the (padded) line box
    keep = np.zeros_like(line_mask); keep[max(by0 - 2, 0):by1 + 2, max(bx0 - 2, 0):bx1 + 2] = True
    line_mask &= keep
    lm = line_mask.astype(np.float32)
    if z > 1.05:
        lm = cv2.resize(lm, (cx1 - cx0, cy1 - cy0), interpolation=cv2.INTER_AREA)
    mask[cy0:cy1, cx0:cx1] = np.maximum(mask[cy0:cy1, cx0:cx1], lm)
    lines.append({"text": text, "score": round(float(score), 2), "box": [int(x0), int(y0), int(x1), int(y1)],
                  "sam_iou": round(iou, 2), "fill": round(float(line_mask[by0:by1, bx0:bx1].mean()), 2)})
    print(f"{text!r:45} iou {iou:.2f} fill {lines[-1]['fill']:.2f}", flush=True)

Image.fromarray((np.clip(mask, 0, 1) * 255).astype(np.uint8)).save(f"{out}/text_mask.png")
json.dump(lines, open(f"{out}/lines.json", "w"), indent=1)
vis = rgb.astype(np.float32) * 0.25
sel = mask > 0.5
vis[sel] = rgb[sel]
both = np.hstack([rgb, vis.astype(np.uint8)])
for ln in lines:
    x0, y0, x1, y1 = ln["box"]
    cv2.rectangle(both, (x0, y0), (x1, y1), (0, 255, 0), 2)
Image.fromarray(both).save(f"{out}/text_review.png")
