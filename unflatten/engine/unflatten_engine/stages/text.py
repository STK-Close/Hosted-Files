"""Typography in photographs, paintings and printed covers.

Glyphs are found as maximally stable extremal regions (MSER, both polarities)
and grouped into lines the way a reader groups them: same ink, similar height,
shared baseline, letter-sized gaps. Each line becomes one layer, cut along the
glyph pixels themselves (counters stay open), so it composes back exactly and
lifts off cleanly. Fast enough to run on every image.
"""
import cv2
import numpy as np

from .regions import Region, dilate, to_lab


def _plausible(w, h, area, h_img):
    if h < 6 or h > 0.3 * h_img or w > 2.6 * h or w < 0.08 * h:
        return False
    return 0.12 < area / float(w * h) < 0.92


def _flat_regions(rgb, n, h_img):
    """Edge-bounded regions of near-constant colour (letters are solid ink with
    crisp edges, even on textured cloth once the weave is smoothed away)."""
    from .segment_classical import gradient_magnitude

    k = 5 if max(rgb.shape[:2]) > 800 else 3
    lab = to_lab(cv2.medianBlur(rgb, k))
    grad = gradient_magnitude(lab)
    t = max(5.0, 3.0 * float(np.median(grad)))
    count, labels, stats, _ = cv2.connectedComponentsWithStats((grad <= t).astype(np.uint8), connectivity=4)
    out = []
    for i in range(1, count):
        x, y, w, h, area = stats[i]
        if area < max(12, 1e-5 * n) or not _plausible(w, h, area, h_img):
            continue
        ys, xs = np.nonzero(labels[y:y + h, x:x + w] == i)
        # grow by the anti-aliased rim the edge band took away
        out.append((int(x), int(y), int(w), int(h), np.stack([xs + x, ys + y], -1)))
    return out


def _glyphs(rgb, gray, n, h_img):
    min_area = max(12, int(1e-5 * n))
    out = []
    smooth = cv2.bilateralFilter(rgb, 7, 40, 5)
    lab = to_lab(smooth)
    channels = [gray, 255 - gray,
                np.clip(lab[..., 1] * 3 + 128, 0, 255).astype(np.uint8),
                np.clip(lab[..., 2] * 3 + 128, 0, 255).astype(np.uint8)]
    mser = cv2.MSER_create(4, min_area, int(0.02 * n), 0.5)
    for img in channels:
        regions, boxes = mser.detectRegions(img)
        for pts, (x, y, w, h) in zip(regions, boxes):
            if _plausible(w, h, len(pts), h_img):
                out.append((x, y, w, h, pts))
    out.extend(_flat_regions(rgb, n, h_img))
    # MSER nests the same glyph at several thresholds: keep the outermost
    out.sort(key=lambda g: -g[2] * g[3])
    kept = []
    for g in out:
        x, y, w, h, _ = g
        dup = False
        for k in kept:
            kx, ky, kw, kh, _ = k
            ix = max(0, min(x + w, kx + kw) - max(x, kx))
            iy = max(0, min(y + h, ky + kh) - max(y, ky))
            if ix * iy > 0.6 * w * h:
                dup = True
                break
        if not dup:
            kept.append(g)
    return kept


def detect_text(rgb, avoid=None, min_glyphs=3, verify=None):
    """Text-line regions. `avoid`: pixels that already belong to a subject
    (a name tag on a jacket is part of the person who wears it). `verify`:
    optional check (image, box) -> bool that a line really is lettering."""
    h, w = rgb.shape[:2]
    n = h * w
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    lab = to_lab(rgb)
    glyphs = _glyphs(rgb, gray, n, h)
    if len(glyphs) < min_glyphs:
        return []
    info = []
    for x, y, gw, gh, pts in glyphs:
        m = np.zeros((h, w), bool)
        m[pts[:, 1], pts[:, 0]] = True
        ink = lab[m].mean(0)
        ring = dilate(m[max(0, y - 3):y + gh + 3, max(0, x - 3):x + gw + 3], 2) & ~m[max(0, y - 3):y + gh + 3, max(0, x - 3):x + gw + 3]
        paper = lab[max(0, y - 3):y + gh + 3, max(0, x - 3):x + gw + 3][ring].mean(0) if ring.any() else ink
        contrast = float(np.sqrt(((ink - paper) ** 2).sum()))
        if contrast < 12:
            continue
        info.append({"box": (x, y, gw, gh), "pts": pts, "ink": ink, "paper": paper, "contrast": contrast})

    k = len(info)
    parent = list(range(k))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    for i in range(k):
        xi, yi, wi, hi = info[i]["box"]
        for j in range(i + 1, k):
            xj, yj, wj, hj = info[j]["box"]
            hb, hs = max(hi, hj), min(hi, hj)
            if hb > 1.8 * hs:
                continue
            overlap = min(yi + hi, yj + hj) - max(yi, yj)
            if overlap < 0.6 * hs:
                continue
            gap = max(xj - (xi + wi), xi - (xj + wj))
            if gap > 0.9 * hb:
                continue
            if np.sqrt(((info[i]["ink"] - info[j]["ink"]) ** 2).sum()) > 22:
                continue
            parent[find(i)] = find(j)

    groups = {}
    for i in range(k):
        groups.setdefault(find(i), []).append(i)
    words, orphans = [], []
    for members in groups.values():
        if len(members) < 2:
            orphans.extend(members)
            continue
        hs = np.array([info[i]["box"][3] for i in members], np.float32)
        cy = np.array([info[i]["box"][1] + info[i]["box"][3] / 2 for i in members], np.float32)
        if hs.std() > 0.35 * hs.mean() or cy.std() > 0.3 * hs.mean():
            continue  # not a run of type
        words.append(members)

    lines = _join(words, info)
    _adopt(lines, orphans, info)
    regions = []
    for members in lines:
        if len(members) < min_glyphs:
            continue
        hs = np.array([info[i]["box"][3] for i in members], np.float32)
        x0 = min(info[i]["box"][0] for i in members)
        x1 = max(info[i]["box"][0] + info[i]["box"][2] for i in members)
        if (x1 - x0) < 1.5 * hs.mean():
            continue
        m = np.zeros((h, w), bool)
        for i in members:
            p = info[i]["pts"]
            m[p[:, 1], p[:, 0]] = True
        if avoid is not None and (m & avoid).sum() > 0.3 * m.sum():
            continue
        if verify is not None:
            ys, xs = np.nonzero(m)
            if not verify(rgb, (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1), mask=m):
                continue
        ink = np.mean([info[i]["ink"] for i in members], 0)
        paper = np.mean([info[i]["paper"] for i in members], 0)
        m |= _complete_line(lab, m, ink, paper, float(hs.mean()), h)
        r = Region(mask=m, kind="text", meta={"glyphs": len(members), "line_height": float(hs.mean())})
        regions.append(r)
    return regions


def _complete_line(lab, m, ink, paper, lh, h_img):
    """Letters the glyph finder missed (an S on worn cloth, a thin I) but that
    share the line's ink and sit on its baseline join the line."""
    ys, xs = np.nonzero(m)
    y0, y1 = max(0, int(ys.min() - 0.15 * lh)), min(h_img, int(ys.max() + 0.15 * lh) + 1)
    x0, x1 = max(0, int(xs.min() - 2 * lh)), min(lab.shape[1], int(xs.max() + 2 * lh) + 1)
    band = lab[y0:y1, x0:x1]
    d_ink = np.sqrt(((band - ink) ** 2).sum(-1))
    d_paper = np.sqrt(((band - paper) ** 2).sum(-1))
    cand = (d_ink < 0.5 * d_paper).astype(np.uint8)
    cand = cv2.morphologyEx(cand, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
    cnt, comp, stats, _ = cv2.connectedComponentsWithStats(cand, connectivity=8)
    known = m[y0:y1, x0:x1]
    out = np.zeros_like(m)
    for c in range(1, cnt):
        x, y, w, hh, area = stats[c]
        if hh < 0.4 * lh or hh > 1.6 * lh or w > 2.6 * hh or area < 0.12 * w * hh:
            continue
        piece = comp == c
        if (piece & known).sum() > 0.5 * area:
            continue  # already part of the line
        out[y0:y1, x0:x1] |= piece
    return out


def _box(members, info):
    x0 = min(info[i]["box"][0] for i in members)
    y0 = min(info[i]["box"][1] for i in members)
    x1 = max(info[i]["box"][0] + info[i]["box"][2] for i in members)
    y1 = max(info[i]["box"][1] + info[i]["box"][3] for i in members)
    hgt = float(np.median([info[i]["box"][3] for i in members]))
    ink = np.mean([info[i]["ink"] for i in members], 0)
    return x0, y0, x1, y1, hgt, ink


def _join(words, info):
    """Words sharing a baseline, size and ink, a word-space apart, form a line."""
    lines = []
    for wd in sorted(words, key=lambda m: _box(m, info)[0]):
        x0, y0, x1, y1, hgt, ink = _box(wd, info)
        host = None
        for ln in lines:
            lx0, ly0, lx1, ly1, lh, link = _box(ln, info)
            same_row = min(y1, ly1) - max(y0, ly0) > 0.6 * min(y1 - y0, ly1 - ly0)
            same_size = max(hgt, lh) < 1.6 * min(hgt, lh)
            near = x0 - lx1 < 1.6 * max(hgt, lh)
            if same_row and same_size and near and np.sqrt(((ink - link) ** 2).sum()) < 30:
                host = ln
                break
        if host is None:
            lines.append(list(wd))
        else:
            host.extend(wd)
    return lines


def _adopt(lines, orphans, info):
    """Single glyphs the pairwise test missed (a capital beside lowercase, an
    'I', an '!') join the line they sit on."""
    changed = True
    while changed:
        changed = False
        for o in list(orphans):
            ox, oy, ow, oh = info[o]["box"]
            for ln in lines:
                lx0, ly0, lx1, ly1, lh, ink = _box(ln, info)
                if not 0.4 * lh <= oh <= 1.9 * lh:
                    continue
                if min(oy + oh, ly1) - max(oy, ly0) < 0.6 * min(oh, ly1 - ly0):
                    continue
                if ox > lx1 + 1.2 * lh or ox + ow < lx0 - 1.2 * lh:
                    continue
                if np.sqrt(((info[o]["ink"] - ink) ** 2).sum()) > 30:
                    continue
                ln.append(o)
                orphans.remove(o)
                changed = True
                break
