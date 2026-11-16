"""Stacking order and occlusion completion."""
import cv2
import numpy as np

from .regions import dilate


def _hull(mask):
    pts = cv2.findNonZero(mask.astype(np.uint8))
    out = np.zeros(mask.shape, np.uint8)
    if pts is not None:
        cv2.fillConvexPoly(out, cv2.convexHull(pts), 1)
    return out > 0


def _enclosure(inner, outer):
    ring = dilate(inner, 1) & ~inner
    return (ring & outer).sum() / max(ring.sum(), 1)


def stacking_order(regions):
    """Return region indices bottom -> top.

    Pairwise evidence for adjacent regions A, B:
      * B wrapped by A (most of B's outline touches A)  -> B above A
      * A's convex hull reaches into B much more than B's into A -> B cuts A,
        so B is above (a square overlapping a circle notches the circle)
    Ties fall back to area: larger elements sit lower.
    """
    n = len(regions)
    hulls = [_hull(r.mask) for r in regions]
    grown = [dilate(r.mask, 2) for r in regions]
    above = {i: set() for i in range(n)}  # above[i] = regions that must sit above i
    for i in range(n):
        for j in range(i + 1, n):
            if not (grown[i] & regions[j].mask).any():
                continue
            a, b = regions[i], regions[j]
            if _enclosure(b.mask, a.mask) > 0.6:
                above[i].add(j)
                continue
            if _enclosure(a.mask, b.mask) > 0.6:
                above[j].add(i)
                continue
            ca = (hulls[i] & b.mask).sum() / max(b.area, 1)
            cb = (hulls[j] & a.mask).sum() / max(a.area, 1)
            if ca > cb + 0.02:
                above[i].add(j)
            elif cb > ca + 0.02:
                above[j].add(i)
        if regions[i].kind == "text":  # lettering sits on the art it labels
            for j in range(n):
                if j != i and regions[j].kind != "text" and (grown[i] & regions[j].mask).any():
                    above[i].discard(j)
                    above[j].add(i)

    below_count = {i: 0 for i in range(n)}
    for i in range(n):
        for j in above[i]:
            below_count[j] += 1
    order, ready = [], [i for i in range(n) if below_count[i] == 0]
    remaining = set(range(n))
    while remaining:
        if not ready:  # cycle: break it at the largest remaining region
            ready = [max(remaining, key=lambda k: regions[k].area)]
        ready.sort(key=lambda k: -regions[k].area)
        i = ready.pop(0)
        if i not in remaining:
            continue
        order.append(i)
        remaining.discard(i)
        for j in above[i]:
            below_count[j] -= 1
            if below_count[j] == 0 and j in remaining:
                ready.append(j)
    return order


def _raster(shape, draw, ss=4):
    """Anti-aliased coverage (0..1) of a shape drawn at `ss`x supersampling."""
    h, w = shape
    big = np.zeros((h * ss, w * ss), np.uint8)
    draw(big, ss)
    return cv2.resize(big.astype(np.float32) / 255.0, (w, h), interpolation=cv2.INTER_AREA)


def complete_occluded(mask, occluders):
    """Coverage (0..1) of a plausible full silhouette for a partly hidden
    element, or None.

    Tries an ellipse fitted to the unoccluded outline, the minimum-area
    rectangle, and the convex hull. A candidate is accepted only if it contains
    the visible element and every pixel it adds lies under an occluder, so a
    completion never paints over anything visible."""
    if mask.sum() < 64 or not (dilate(mask, 2) & occluders).any():
        return None
    m8 = mask.astype(np.uint8)
    contours, _ = cv2.findContours(m8, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    if len(contours) != 1:
        return None
    contour = contours[0][:, 0]
    near_occ = dilate(occluders, 2)
    free = contour[~near_occ[contour[:, 1], contour[:, 0]]]
    shape = mask.shape

    candidates = []
    if len(free) >= 12:
        (cx, cy), (ew, eh), ang = cv2.fitEllipse(free.astype(np.float32))
        if ew > 2 and eh > 2:
            box = ((cx, cy), (ew, eh), ang)
            outline = cv2.ellipse(np.zeros_like(m8), box, 1, 1)
            # the ellipse must actually describe the free outline
            dist = cv2.distanceTransform(1 - outline, cv2.DIST_L2, 3)
            if np.percentile(dist[free[:, 1], free[:, 0]], 90) < 1.5:
                # contour points are boundary pixel centres: the edge is half a pixel out
                big = ((cx + 0.5, cy + 0.5), (ew + 1, eh + 1), ang)
                candidates.append(_raster(shape, lambda im, k: cv2.ellipse(
                    im, ((big[0][0] * k, big[0][1] * k), (big[1][0] * k, big[1][1] * k), ang), 255, -1)))
    (rx, ry), (rw, rh), ra = cv2.minAreaRect(cv2.findNonZero(m8))
    pts = cv2.boxPoints(((rx + 0.5, ry + 0.5), (rw + 1, rh + 1), ra))
    candidates.append(_raster(shape, lambda im, k: cv2.fillConvexPoly(im, np.int32(np.round(pts * k)), 255)))
    candidates.append(_hull(mask).astype(np.float32))

    best = None
    area = mask.sum()
    rim = dilate(mask, 2)
    for cov in candidates:
        c = cov > 0.5
        added = c & ~mask
        if added.sum() < 0.01 * area:
            continue
        if (mask & ~c).sum() > 0.02 * area:
            continue
        if (added & ~occluders & ~rim).sum() > max(0.02 * added.sum(), 4):
            continue
        if best is None or c.sum() > (best > 0.5).sum():
            best = cov
    return best
