"""Model-free segmentation for graphic images (covers, posters, marketing art).

Graphic design is mostly regions of flat colour or smooth gradient separated by
crisp edges, over a background that is flat, a gradient, or a fine texture.
That structure is recovered exactly without any learned model:

  1. edge-constrained connected regions on a lightly denoised Lab image
  2. background = dominant border-connected region, modelled as a smooth surface
  3. counters/holes that match the background become transparent
  4. soft deviations from the background surface (drop shadows, glows) are
     attached to the object they touch
  5. glyph-sized regions of one colour on one baseline are grouped into text lines
"""
import cv2
import numpy as np

from .regions import Region, dilate, extend_labels, to_lab


def gradient_magnitude(lab):
    gx = np.zeros_like(lab)
    gy = np.zeros_like(lab)
    gx[:, 1:-1] = (lab[:, 2:] - lab[:, :-2]) * 0.5
    gy[1:-1] = (lab[2:] - lab[:-2]) * 0.5
    return np.sqrt((gx ** 2 + gy ** 2).sum(-1))


def fit_background(lab, mask, degree=2, samples=40000):
    """Least-squares polynomial surface per Lab channel over `mask`, with one
    outlier-rejection pass. Returns (model image, rms residual)."""
    h, w = mask.shape
    ys, xs = np.nonzero(mask)
    if len(ys) < 16:
        med = np.median(lab.reshape(-1, 3), axis=0)
        return np.broadcast_to(med, lab.shape).astype(np.float32), 99.0
    rng = np.random.default_rng(0)
    if len(ys) > samples:
        pick = rng.choice(len(ys), samples, replace=False)
        ys, xs = ys[pick], xs[pick]

    def basis(y, x):
        y = y / max(h - 1, 1) * 2 - 1
        x = x / max(w - 1, 1) * 2 - 1
        terms = [np.ones_like(x)]
        for d in range(1, degree + 1):
            for i in range(d + 1):
                terms.append(x ** (d - i) * y ** i)
        return np.stack(terms, -1)

    A = basis(ys.astype(np.float32), xs.astype(np.float32))
    v = lab[ys, xs]
    coef, *_ = np.linalg.lstsq(A, v, rcond=None)
    res = np.sqrt(((A @ coef - v) ** 2).sum(-1))
    keep = res < max(np.percentile(res, 90), 1.0)
    coef, *_ = np.linalg.lstsq(A[keep], v[keep], rcond=None)
    rms = float(np.sqrt(np.mean(((A[keep] @ coef - v[keep]) ** 2).sum(-1))))
    gy, gx = np.mgrid[0:h, 0:w].astype(np.float32)
    model = (basis(gy.ravel(), gx.ravel()) @ coef).reshape(h, w, 3).astype(np.float32)
    return model, rms


def absorb_small(labels, lab, min_area, rounds=4):
    """Relabel regions smaller than `min_area` to the adjacent label whose mean
    colour is closest (vectorised over all 4-neighbour label boundaries)."""
    for _ in range(rounds):
        n = int(labels.max()) + 1
        area = np.bincount(labels.ravel(), minlength=n)
        if not (area[(area > 0)] < min_area).any():
            break
        means = np.stack([np.bincount(labels.ravel(), lab[..., c].ravel(), minlength=n) for c in range(3)], -1)
        means /= np.maximum(area, 1)[:, None]
        a = np.concatenate([labels[:, :-1].ravel(), labels[:-1].ravel()])
        b = np.concatenate([labels[:, 1:].ravel(), labels[1:].ravel()])
        diff = a != b
        a, b = a[diff], b[diff]
        a, b = np.concatenate([a, b]), np.concatenate([b, a])  # both directions
        small = area[a] < min_area
        a, b = a[small], b[small]
        if len(a) == 0:
            break
        # prefer large neighbours, then closest colour
        cost = np.sqrt(((means[a] - means[b]) ** 2).sum(-1)) + (area[b] < min_area) * 1000.0
        order = np.lexsort((cost, a))
        a, b = a[order], b[order]
        first = np.r_[True, a[1:] != a[:-1]]
        remap = np.arange(n)
        remap[a[first]] = b[first]
        labels = remap[labels]
    return labels


def _delta_e(a, b):
    return float(np.sqrt(((np.asarray(a) - np.asarray(b)) ** 2).sum()))


class ClassicalSegmenter:
    name = "classical"

    def __init__(self, edge_threshold=6.0):
        self.edge_threshold = edge_threshold

    def __call__(self, rgb):
        h, w = rgb.shape[:2]
        n = h * w
        k = 3 if max(h, w) < 1200 else 5
        smooth = cv2.medianBlur(rgb, k)
        lab_s = to_lab(smooth)
        grad = gradient_magnitude(lab_s)
        t = max(self.edge_threshold, 4.0 * float(np.median(grad)))
        flat = grad <= t

        count, labels = cv2.connectedComponents(flat.astype(np.uint8), connectivity=4)
        labels = labels.astype(np.int32)
        labels[~flat] = 0
        labels = extend_labels(labels, np.ones_like(flat))

        # Absorb specks (noise, grain, the counter of a small "e") into the
        # most similar-coloured neighbour.
        min_keep = max(12, int(2e-5 * n))
        labels = absorb_small(labels, lab_s, min_keep)
        ids = np.unique(labels)

        means = {i: lab_s[labels == i].mean(0) for i in ids}
        border = np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]])
        bcount = np.bincount(border, minlength=labels.max() + 1)
        seed = int(np.argmax(bcount))
        perim = len(border)
        bg_ids = {seed}
        for i in ids:
            if i != seed and bcount[i] > 0.02 * perim and _delta_e(means[i], means[seed]) < 12:
                bg_ids.add(int(i))
        bg = np.isin(labels, list(bg_ids))
        model, rms = fit_background(lab_s, bg)
        hole_tol = max(6.0, 2.5 * rms)

        regions = {}
        for i in ids:
            if i in bg_ids:
                continue
            m = labels == i
            ys, xs = np.nonzero(m)
            touches_border = ys.min() == 0 or xs.min() == 0 or ys.max() == h - 1 or xs.max() == w - 1
            dev = np.median(np.sqrt(((lab_s[m] - model[m]) ** 2).sum(-1)))
            if not touches_border and dev < hole_tol and m.sum() < 0.25 * n:
                bg |= m  # a counter or gap that shows the background
                continue
            regions[int(i)] = m

        regions = self._merge_enclosed(regions, bg, lab_s)
        out = [Region(mask=m, meta={"color": lab_s[m].mean(0)}) for m in regions.values()]
        out = self._group_text(out, h, w)
        out = self._attach_soft(out, lab_s, model, rms, bg, min_keep)
        return out, {"bg_rms": rms, "edge_threshold": t, "bg_model_lab": model}

    @staticmethod
    def _merge_enclosed(regions, bg, lab):
        """A region wrapped entirely by one other region and large relative to it
        (the fill inside an outline, a bevel face) is part of that object. Small
        enclosed regions (lettering on a badge) stay separate."""
        changed = True
        while changed:
            changed = False
            keys = sorted(regions, key=lambda k: regions[k].sum())
            for k in keys:
                m = regions[k]
                ring = dilate(m, 1) & ~m
                if ring.sum() == 0 or (ring & bg).sum() > 0.02 * ring.sum():
                    continue
                best, share = None, 0.0
                for j, other in regions.items():
                    if j == k:
                        continue
                    s = (ring & other).sum() / ring.sum()
                    if s > share:
                        best, share = j, s
                if best is None or share <= 0.9:
                    continue
                if m.sum() >= 0.25 * regions[best].sum():
                    regions[best] = regions[best] | m
                    del regions[k]
                    changed = True
                    break
                # A counter (the hole in an A or O) shows whatever surrounds the
                # enclosing glyph: give it to that surrounding element.
                outer = dilate(regions[best], 2) & ~regions[best] & ~m
                color = lab[m].mean(0)
                for j, other in regions.items():
                    if j in (k, best) or not (outer & other).any():
                        continue
                    if _delta_e(color, lab[other].mean(0)) < 10:
                        regions[j] = other | m
                        del regions[k]
                        changed = True
                        break
                if changed:
                    break
        return regions

    @staticmethod
    def _group_text(regions, h, w):
        """Union glyph-like regions sharing colour and baseline into text lines."""
        n = len(regions)
        if n < 3:
            return regions
        boxes = [r.bbox() for r in regions]
        cand = [i for i, (x0, y0, x1, y1) in enumerate(boxes)
                if (y1 - y0) < 0.5 * h and regions[i].area < 0.06 * h * w]
        parent = list(range(n))

        def find(a):
            while parent[a] != a:
                parent[a] = parent[parent[a]]
                a = parent[a]
            return a

        for ii, i in enumerate(cand):
            xi0, yi0, xi1, yi1 = boxes[i]
            hi = yi1 - yi0
            for j in cand[ii + 1:]:
                xj0, yj0, xj1, yj1 = boxes[j]
                hj = yj1 - yj0
                if _delta_e(regions[i].meta["color"], regions[j].meta["color"]) > 15:
                    continue
                hb, hs = max(hi, hj), min(hi, hj)
                gap = max(xj0 - xi1, xi0 - xj1)
                overlap = min(yi1, yj1) - max(yi0, yj0)
                same_line = overlap >= 0.4 * hs and hb <= 2.5 * hs and gap <= 0.8 * hb
                # i/j dots, accents and punctuation sitting on or above a glyph
                mark = hs < 0.45 * hb and gap <= 0.35 * hb and overlap > -0.6 * hb
                if same_line or mark:
                    parent[find(i)] = find(j)

        groups = {}
        for i in range(n):
            groups.setdefault(find(i), []).append(i)
        out = []
        for members in groups.values():
            if len(members) >= 3:
                mask = np.zeros_like(regions[0].mask)
                for i in members:
                    mask |= regions[i].mask
                out.append(Region(mask=mask, kind="text",
                                  meta={"color": regions[members[0]].meta["color"], "glyphs": len(members)}))
            else:
                out.extend(regions[i] for i in members)
        return out

    @staticmethod
    def _attach_soft(regions, lab_s, model, rms, bg, min_keep):
        """Soft departures from the background surface: shadows and glows."""
        if rms > 8.0:
            return regions  # background too busy to model; leave soft effects in it
        dev = np.sqrt(((lab_s - model) ** 2).sum(-1))
        strong = bg & (dev > max(3.0, 3.0 * rms))
        weak = bg & (dev > max(1.2, 1.5 * rms))  # hysteresis: keep the faint tail of a shadow
        count, comp = cv2.connectedComponents(weak.astype(np.uint8), connectivity=8)
        seeded = np.unique(comp[strong])
        h, w = bg.shape
        for c in seeded[seeded > 0]:
            m = comp == c
            near = dilate(m, 3)
            contact = [(near & r.mask).sum() for r in regions]
            if contact and max(contact) > 0:  # any size: anti-aliased tips belong to their object
                owner = regions[int(np.argmax(contact))]
                owner.mask = owner.mask | m
                owner.meta["soft_effect"] = True
            else:
                if m.sum() < min_keep * 4:
                    continue
                ys, xs = np.nonzero(m)
                if ys.min() == 0 or xs.min() == 0 or ys.max() == h - 1 or xs.max() == w - 1:
                    continue  # vignette / lighting: part of the background
                regions.append(Region(mask=m, kind="shadow", hard=np.zeros_like(m),
                                      meta={"color": lab_s[m].mean(0)}))
            bg &= ~m
        return regions
