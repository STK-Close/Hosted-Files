"""Subject-aware segmentation: what a designer would call one element.

OWLv2 (Apache-2.0, open-vocabulary detection) says *what* is in the image:
whole subjects (a person, a dog, a car, a tree) and the things they wear or
hold (a baseball cap, sunglasses, an umbrella). SAM 2.1 turns each detection
box into a whole-subject mask. Relationships are then resolved before any
layer is cut:

  part of   SAM fragments that fall inside a subject's mask belong to it
  wearing   accessories inside a carrier's box and touching it join it
  holding   small objects inside a carrier's box and touching it join it
  separate  two people stay two layers; furniture a person sits on stays apart

Everything else in a photograph is background unless it is a compact,
distinct object that does not run off the frame.
"""
import os
from dataclasses import dataclass, field

import cv2
import numpy as np

from .regions import Region, dilate

# label -> (query phrasings, role). Carriers can wear/hold things.
SUBJECTS = {
    "Person": (["person", "man", "woman", "child"], "carrier"),
    "Dog": (["dog"], "carrier"), "Cat": (["cat"], "carrier"), "Horse": (["horse"], "carrier"),
    "Bird": (["bird"], "carrier"), "Cow": (["cow"], "carrier"), "Sheep": (["sheep"], "carrier"),
    "Car": (["car"], "object"), "Bicycle": (["bicycle"], "object"), "Motorcycle": (["motorcycle"], "object"),
    "Boat": (["boat", "sailing ship"], "object"), "Airplane": (["airplane"], "object"), "Bus": (["bus"], "object"),
    "Tree": (["tree"], "object"), "Flower": (["flower"], "held"), "Potted Plant": (["potted plant"], "object"),
    "Flag": (["flag"], "object"), "Chair": (["chair"], "furniture"), "Table": (["table"], "furniture"),
    "Sofa": (["sofa"], "furniture"), "Lamp": (["lamp"], "object"), "Bottle": (["bottle"], "held"),
    "Cup": (["cup", "mug"], "held"), "Vase": (["vase"], "object"), "Book": (["book"], "held"),
    "Guitar": (["guitar"], "held"), "Umbrella": (["umbrella"], "held"), "Handbag": (["handbag"], "held"),
    "Phone": (["mobile phone"], "held"), "Sword": (["sword"], "held"), "Skull": (["skull"], "object"),
    "Crown": (["crown"], "object"), "Clock": (["clock"], "object"), "Statue": (["statue"], "object"),
    "Castle": (["castle"], "object"), "Moon": (["moon"], "object"), "Candle": (["candle"], "held"),
    "Lantern": (["lantern"], "held"), "Teddy Bear": (["teddy bear"], "held"),
}
ACCESSORIES = {
    "Baseball Cap": ["baseball cap"], "Hat": ["hat", "beanie", "cowboy hat"], "Helmet": ["helmet"],
    "Sunglasses": ["sunglasses"], "Glasses": ["eyeglasses"], "Scarf": ["scarf"], "Headphones": ["headphones"],
    "Hood": ["hood"], "Backpack": ["backpack"], "Collar": ["dog collar"], "Necklace": ["necklace"], "Tie": ["necktie"],
}
TEMPLATES = ["a photo of a {}", "a painting of a {}"]
# Things that are usually the setting rather than an element when a photo has a
# sharp main subject and they are out of focus behind it.
SCENERY = {"Tree", "Bus", "Car", "Boat", "Airplane", "Castle", "Potted Plant", "Flower", "Bicycle", "Motorcycle"}
MEAN = np.float32([0.48145466, 0.4578275, 0.40821073])
STD = np.float32([0.26862954, 0.26130258, 0.27577711])


@dataclass
class Detection:
    label: str
    role: str  # carrier | object | furniture | held | worn | accessory
    score: float
    box: tuple  # x0, y0, x1, y1 in image pixels
    mask: np.ndarray = None
    shadow: np.ndarray = None
    quality: float = 0.0
    parts: list = field(default_factory=list)  # (label, relation, score)

    @property
    def area_box(self):
        x0, y0, x1, y1 = self.box
        return max(x1 - x0, 1) * max(y1 - y0, 1)


def box_overlap(inner, outer):
    """Fraction of `inner` box covered by `outer` box."""
    ix0, iy0, ix1, iy1 = inner
    ox0, oy0, ox1, oy1 = outer
    w = max(0.0, min(ix1, ox1) - max(ix0, ox0))
    h = max(0.0, min(iy1, oy1) - max(iy0, oy0))
    return w * h / max((ix1 - ix0) * (iy1 - iy0), 1e-6)


def box_iou(a, b):
    inter = box_overlap(a, b) * (a[2] - a[0]) * (a[3] - a[1])
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / max(union, 1e-6)


class OwlDetector:
    """OWLv2 B/16 ensemble via ONNX. One forward pass scores every query."""

    size = 960

    def __init__(self, models_dir, subject_thresh=0.14, accessory_thresh=0.22):
        import onnxruntime as ort
        from tokenizers import Tokenizer

        d = os.path.join(models_dir, "owlv2")
        self.session = ort.InferenceSession(os.path.join(d, "model.onnx"), providers=ort.get_available_providers())
        tok = Tokenizer.from_file(os.path.join(d, "tokenizer.json"))
        self.queries = []  # (label, role)
        texts = []
        for label, (phrases, role) in SUBJECTS.items():
            for p in phrases:
                for t in TEMPLATES:
                    self.queries.append((label, role))
                    texts.append(t.format(p))
        for label, phrases in ACCESSORIES.items():
            for p in phrases:
                for t in TEMPLATES:
                    self.queries.append((label, "accessory"))
                    texts.append(t.format(p))
        n = 16
        self.ids = np.zeros((len(texts), n), np.int64)
        self.att = np.zeros((len(texts), n), np.int64)
        for i, t in enumerate(texts):
            ids = tok.encode(t).ids[:n]
            self.ids[i, :len(ids)] = ids
            self.att[i, :len(ids)] = 1
        self.subject_thresh = subject_thresh
        self.accessory_thresh = accessory_thresh

    @classmethod
    def load(cls, models_dir):
        if models_dir and os.path.exists(os.path.join(models_dir, "owlv2", "model.onnx")):
            return cls(models_dir)
        return None

    def __call__(self, rgb):
        h, w = rgb.shape[:2]
        side = max(h, w)
        pad = np.full((side, side, 3), 0.5, np.float32)
        pad[:h, :w] = rgb.astype(np.float32) / 255.0
        x = cv2.resize(pad, (self.size, self.size), interpolation=cv2.INTER_AREA)
        x = ((x - MEAN) / STD).transpose(2, 0, 1)[None].astype(np.float32)
        logits, boxes = self.session.run(["logits", "pred_boxes"], {
            "input_ids": self.ids, "attention_mask": self.att, "pixel_values": x})[:2]
        scores = 1.0 / (1.0 + np.exp(-logits[0]))  # (patches, queries)
        boxes = boxes[0] * side  # cx, cy, w, h
        xyxy = np.stack([boxes[:, 0] - boxes[:, 2] / 2, boxes[:, 1] - boxes[:, 3] / 2,
                         boxes[:, 0] + boxes[:, 2] / 2, boxes[:, 1] + boxes[:, 3] / 2], -1)
        xyxy = np.clip(xyxy, 0, [w, h, w, h])

        # best query per label, per patch
        labels = {}
        for q, (label, role) in enumerate(self.queries):
            prev = labels.get(label)
            labels[label] = (role, scores[:, q] if prev is None else np.maximum(prev[1], scores[:, q]))
        dets = []
        for label, (role, s) in labels.items():
            thresh = self.accessory_thresh if role == "accessory" else self.subject_thresh
            for i in np.argsort(-s)[:20]:
                if s[i] < thresh:
                    break
                b = tuple(float(v) for v in xyxy[i])
                if (b[2] - b[0]) < 8 or (b[3] - b[1]) < 8:
                    continue
                if any(d.label == label and box_iou(d.box, b) > 0.5 for d in dets):
                    continue
                dets.append(Detection(label, role, float(s[i]), b))
        return dets


def guided_filter(guide, src, r, eps):
    """He et al. guided filter: edge-aware smoothing of `src` following `guide`."""
    k = (2 * r + 1, 2 * r + 1)
    mean = lambda x: cv2.boxFilter(x, -1, k, borderType=cv2.BORDER_REFLECT)  # noqa: E731
    mi, mp = mean(guide), mean(src)
    cov = mean(guide * src) - mi * mp
    var = mean(guide * guide) - mi * mi
    a = cov / (var + eps)
    b = mp - a * mi
    return mean(a) * guide + mean(b)


class SubjectSegmenter:
    """Photo/painting path: subjects first, then the few distinct extras."""

    name = "subjects"

    def __init__(self, sam, detector):
        self.sam = sam
        self.detector = detector

    def _subject_mask(self, emb, scale, low, gray, box, max_spill=0.4):
        """Whole subject, not a part of it. SAM answers every prompt at three
        granularities (part, larger part, whole) and detector boxes can be
        tight or offset, so gather candidates from the box, a looser box with
        a point on the subject, and the point alone; keep the confident one
        that best fills the box without spilling far outside it."""
        h, w = gray.shape
        x0, y0, x1, y1 = box
        bw, bh = max(x1 - x0, 1), max(y1 - y0, 1)
        loose = (max(0, x0 - 0.2 * bw), max(0, y0 - 0.2 * bh), min(w, x1 + 0.2 * bw), min(h, y1 + 0.2 * bh))
        lx0, ly0, lx1, ly1 = [int(round(v)) for v in loose]
        in_box = np.zeros((h, w), bool)
        in_box[int(y0):int(np.ceil(y1)), int(x0):int(np.ceil(x1))] = True
        in_loose = np.zeros((h, w), bool)
        in_loose[ly0:ly1, lx0:lx1] = True
        point = np.float32(((x0 + x1) / 2, (y0 + y1) / 2))
        answers = [self.sam.decode_box(emb, np.float32(box) * scale)]
        first = None
        for iou, logits in answers[:1]:
            first = refine_logits(logits[int(np.argmax(iou))][:low[0], :low[1]], gray, (h, w))
        if first.any():
            from scipy import ndimage

            d = ndimage.distance_transform_edt(np.pad(first, 1))[1:-1, 1:-1]
            py, px = np.unravel_index(np.argmax(d), d.shape)
            point = np.float32((px, py))
        centre = np.float32(((x0 + x1) / 2, (y0 + y1) / 2))
        for p in (point, centre):
            answers.append(self.sam.decode_box_point(emb, np.float32(loose) * scale, p * scale))
            answers.append(self.sam._decode(emb, p * scale))
        best, best_score, best_q = None, -1.0, 0.0
        box_area = bw * bh
        for iou, logits in answers:
            for k in range(3):
                if iou[k] < 0.75:
                    continue
                m = refine_logits(logits[k][:low[0], :low[1]], gray, (h, w))
                a = m.sum()
                spill = (m & ~in_loose).sum() / max(a, 1)
                if a == 0 or spill > (max_spill if iou[k] >= 0.9 else 0.1):
                    continue
                fill = (m & in_box).sum() / box_area
                score = float(iou[k]) * min(fill / 0.45, 1.0)
                if score > best_score:
                    best, best_score, best_q = m, score, float(iou[k])
        if best is None:
            return first, float(np.max(answers[0][0]))
        # A mask pressed against the edge of the search box is cut off by it:
        # widen the box on that side and ask again.
        for _ in range(3):
            ys, xs = np.nonzero(best)
            grow = [xs.min() <= lx0 + 1 and lx0 > 0, ys.min() <= ly0 + 1 and ly0 > 0,
                    xs.max() >= lx1 - 2 and lx1 < w, ys.max() >= ly1 - 2 and ly1 < h]
            if not any(grow):
                break
            lx0 = max(0, lx0 - int(0.5 * bw)) if grow[0] else lx0
            ly0 = max(0, ly0 - int(0.5 * bh)) if grow[1] else ly0
            lx1 = min(w, lx1 + int(0.5 * bw)) if grow[2] else lx1
            ly1 = min(h, ly1 + int(0.5 * bh)) if grow[3] else ly1
            iou, logits = self.sam.decode_box_point(emb, np.float32((lx0, ly0, lx1, ly1)) * scale, point * scale)
            k = int(np.argmax(iou))
            m = refine_logits(logits[k][:low[0], :low[1]], gray, (h, w))
            # accept only a continuation of the same subject, not a merge with a neighbour
            if iou[k] < 0.8 or (m & best).sum() < 0.9 * best.sum() or m.sum() > 2.5 * best.sum():
                break
            best, best_q = m, float(iou[k])
        return best, best_q

    def _mask(self, emb, scale, low, rgb_gray, box=None, point=None):
        h, w = rgb_gray.shape
        if box is not None:
            iou, logits = self.sam.decode_box(emb, np.float32(box) * scale)
        else:
            iou, logits = self.sam._decode(emb, np.float32(point) * scale)
        best = int(np.argmax(iou))
        lg = logits[best][:low[0], :low[1]]
        return refine_logits(lg, rgb_gray, (h, w)), float(iou[best])

    def __call__(self, rgb, detections, progress=None, find_text=None):
        h, w = rgb.shape[:2]
        n = h * w
        gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY).astype(np.float32) / 255.0
        emb, scale, (nh, nw) = self.sam._embed(rgb)
        low = (256 * nh // self.sam.size, 256 * nw // self.sam.size)

        # 1. whole-subject masks
        dets = sorted(detections, key=lambda d: -d.score)
        dets = drop_group_boxes(dets)
        subjects, accessories = [], []
        for d in dets:
            if d.role in ("accessory", "furniture"):  # the box is the object
                d.mask, d.quality = self._mask(emb, scale, low, gray, box=d.box)
            else:
                d.mask, d.quality = self._subject_mask(emb, scale, low, gray, d.box,
                                                       max_spill=0.4 if d.role == "carrier" else 0.25)
                if d.mask.any():
                    d.box = mask_box(d.mask)
            area = d.mask.sum()
            floor = 0.6 if d.role == "carrier" else 0.7
            if d.quality < floor or area < 0.001 * n or area < 0.12 * d.area_box:
                continue
            if area > 0.9 * n:
                continue  # the whole frame is not a subject
            (accessories if d.role == "accessory" else subjects).append(d)
        subjects = merge_same_label(dedupe(subjects), max(2, int(0.004 * max(h, w))))
        accessories = [a for a in accessories if not any(
            b is not a and b.score > a.score and box_iou(a.box, b.box) > 0.6 for b in accessories)]

        # 2. relationships: wearing / holding / separate
        carriers = [s for s in subjects if s.role == "carrier"]
        reach = max(3, int(0.01 * max(h, w)))
        kept = []
        for s in subjects:
            host = None
            if s.role in ("held", "worn"):
                host = best_host(s, carriers, reach)
            if host is not None:
                host.mask = host.mask | s.mask
                host.parts.append((s.label, "wearing" if s.role == "worn" else "holding", s.score))
            else:
                kept.append(s)
        for a in accessories:
            host = best_host(a, carriers, reach)
            if host is not None:
                host.mask = host.mask | a.mask
                host.parts.append((a.label, "wearing", a.score))
        subjects = [s for s in kept if s.mask.any()]
        if progress:
            progress(0.5)

        # 3. contested pixels go to the subject nearer the camera (lower box bottom)
        subjects.sort(key=lambda s: s.box[3])
        before = {id(s): s.mask.sum() for s in subjects}
        for i, s in enumerate(subjects):
            for nearer in subjects[i + 1:]:
                if s.role == "carrier" and nearer.role == "furniture":
                    continue  # a person in front of the chair keeps their pixels
                s.mask = s.mask & ~nearer.mask
        for i, s in enumerate(subjects):
            if s.role == "furniture":
                for c in subjects:
                    if c.role == "carrier":
                        s.mask = s.mask & ~c.mask
        # a "person" that mostly overlapped another person was a second look at
        # the same one (a head-and-shoulders box inside a full-figure box)
        subjects = [s for s in subjects if not (s.role == "carrier" and s.mask.sum() < 0.4 * before[id(s)])]

        # 4. limbs and props SAM left off a person (a raised fist, a held cup)
        self._complete_carriers(emb, scale, low, gray, subjects, reach)

        # 5. scenery: out-of-focus things behind a sharp main subject are setting
        subjects = drop_scenery(subjects, gray)

        # 6. cast shadows go with the subject that casts them
        attach_cast_shadows(rgb, subjects)

        # 7. typography, then the distinct extras the vocabulary does not name
        texts = find_text(None) if find_text else []
        # a line printed on a subject (a name tag, a shirt logo, a sign on a door
        # in a drawing) is part of that subject
        kept_text = []
        for t in texts:
            tb = mask_box(t.mask)
            tarea = (tb[2] - tb[0]) * (tb[3] - tb[1])
            worn = any((t.mask & c.mask).sum() > 0.7 * t.mask.sum() and tarea < 0.25 * c.area_box
                       for c in subjects)
            on_people = np.zeros((h, w), bool)
            for c in subjects:
                if c.role == "carrier":
                    on_people |= c.mask
            # lettering that lies on people is worn, or their features misread as type
            worn = worn or (t.mask & on_people).sum() > 0.6 * t.mask.sum()
            if not worn:
                kept_text.append(t)
        texts = kept_text
        text_px = np.zeros((h, w), bool)
        for t in texts:
            text_px |= t.mask
        for s in subjects:
            s.mask = s.mask & ~text_px
        claimed = text_px.copy()
        for s in subjects:
            claimed |= s.mask
        inked = ink_elements(rgb, claimed, subjects, texts)
        for m in inked:
            claimed |= m
        extras = self._extras(emb, scale, low, gray, claimed, carriers, reach, progress) + inked

        regions = []
        unc = max(2, int(0.003 * max(h, w)))  # how much of the edge is uncertain
        reach = max(4, int(0.008 * max(h, w)))  # how far the cut (and the rebuild) reaches past it
        for s in subjects:
            if s.mask.sum() < 0.0008 * n:
                continue
            body = s.mask
            full = body | s.shadow if s.shadow is not None else body
            regions.append(Region(mask=full, hard=body.copy(), score=s.score, meta={
                "edge_uncertainty": unc, "edge_reach": reach, "subject": s.label, "parts": s.parts, "role": s.role,
                "box": s.box}))
        for m in extras:
            regions.append(Region(mask=m, meta={"edge_uncertainty": unc, "edge_reach": reach}))
        for t in texts:
            t.meta["edge_reach"] = max(3, int(0.004 * max(h, w)))
        regions.extend(texts)
        info = {"detections": [(d.label, round(d.score, 2)) for d in dets],
                "subjects": [r.meta.get("subject") for r in regions]}
        return regions, info

    def _complete_carriers(self, emb, scale, low, gray, subjects, reach, probes=20):
        """Probe a person's box where the mask is missing, next to the mask (a
        raised fist, a hand on a hip). A confident piece that touches the person,
        stays inside the box and belongs to nobody else joins them."""
        h, w = gray.shape
        # pass 1: each person may only become a fuller view of themselves; pass 2:
        # separate parts. Otherwise a neighbour takes a piece of a person (a lap,
        # a sleeve) before that person is completed.
        for fuller_only in (True, False):
            for c in [s for s in subjects if s.role == "carrier"]:
                self._complete_one(emb, scale, low, gray, subjects, reach, probes, c, fuller_only)

    def _complete_one(self, emb, scale, low, gray, subjects, reach, probes, c, fuller_only):
        h, w = gray.shape
        x0, y0, x1, y1 = c.box
        bw, bh = x1 - x0, y1 - y0
        # detector boxes are often tight; a lap, a trailing hand or a hem pokes out
        x0, x1 = int(max(0, x0 - 0.25 * bw)), int(min(w, x1 + 0.25 * bw))
        y0, y1 = int(max(0, y0 - 0.1 * bh)), int(min(h, y1 + 0.1 * bh))
        box = np.zeros((h, w), bool)
        box[y0:y1, x0:x1] = True
        near = int(0.12 * max(x1 - x0, y1 - y0))
        taken = np.zeros((h, w), bool)
        for o in subjects:
            taken |= o.mask
        band = box & ~taken & dilate(c.mask, near) & ~dilate(c.mask, 2)
        for _ in range(probes):
            if not band.any():
                break
            # farthest-from-mask point of the remaining band: the likeliest missing limb
            d = cv2.distanceTransform((~c.mask).astype(np.uint8), cv2.DIST_L2, 3)
            d[~band] = 0
            y, x = np.unravel_index(np.argmax(d), d.shape)
            m, q = self._mask(emb, scale, low, gray, point=(x, y))
            band[max(0, y - 6):y + 7, max(0, x - 6):x + 7] = False  # never probe the same spot twice
            if m.any():
                band &= ~dilate(m, 3)
            new = m & ~c.mask  # judge only what the piece would add
            a = new.sum()
            if a == 0:
                continue
            # An answer covering most of the person is a fuller view of them and may
            # add a lot (a lap, both legs); a separate piece must stay small.
            fuller = (m & c.mask).sum() >= 0.6 * c.mask.sum()
            if fuller_only and not fuller:
                continue
            if fuller:
                ok = q >= 0.6 and a <= 2.0 * c.mask.sum() and (m & box).sum() >= 0.8 * m.sum()
            else:
                ok = q >= 0.7 and a <= 0.4 * c.mask.sum() and (m & box).sum() >= 0.85 * m.sum() \
                    and (dilate(m, reach) & c.mask).any()
            if not ok or any((new & o.mask).sum() > 0.2 * a for o in subjects if o is not c):
                continue
            c.mask = c.mask | new
            band &= ~c.mask

    def _extras(self, emb, scale, low, gray, claimed, carriers, reach, progress, k=8):
        """Compact, self-contained things SAM finds outside every subject.
        Anything touching the frame edge or covering much of it is scenery."""
        h, w = gray.shape
        n = h * w
        found = []
        for j in range(k):
            for i in range(k):
                x, y = (i + 0.5) / k * w, (j + 0.5) / k * h
                if claimed[int(y), int(x)] or any(m[int(y), int(x)] for m in found):
                    continue
                m, q = self._mask(emb, scale, low, gray, point=(x, y))
                a = m.sum()
                if q < 0.88 or a < 0.002 * n or a > 0.12 * n:
                    continue
                border = m[0].sum() + m[-1].sum() + m[:, 0].sum() + m[:, -1].sum()
                if border > 0:
                    continue
                if (m & claimed).sum() > 0.3 * a:
                    continue
                ys, xs = np.nonzero(m)
                fill = a / max((np.ptp(xs) + 1) * (np.ptp(ys) + 1), 1)
                if fill < 0.35:
                    continue  # sprawling shapes are texture, not an element
                if any((m & f).sum() > 0.5 * min(a, f.sum()) for f in found):
                    continue
                found.append(m)
            if progress:
                progress(0.5 + 0.5 * (j + 1) / k)
        out = []
        for m in found:
            box = mask_box(m)
            host = None
            for c in carriers:
                if box_overlap(box, c.box) > 0.8 and (dilate(m, reach) & c.mask).any():
                    host = c
                    break
            if host is not None:
                host.mask |= m  # an unnamed part of a subject (a badge, a bag strap)
            else:
                out.append(m & ~claimed)
        return [m for m in out if m.sum() > 0.001 * n]


def refine_logits(lg, gray, shape):
    """Upsample SAM's 256px logits and snap the edge to image edges."""
    h, w = shape
    p = 1.0 / (1.0 + np.exp(-np.clip(cv2.resize(lg, (w, h), interpolation=cv2.INTER_LINEAR), -20, 20)))
    r = max(2, int(0.004 * max(h, w)))
    q = guided_filter(gray, p.astype(np.float32), r, 1e-3)
    return q > 0.5


def ink_elements(rgb, claimed, subjects, texts=()):
    """Covers, posters, prints: on a plain surface (cloth, paper, a flat field)
    every drawing and ornament is ink that differs from that surface. Strokes
    close together form one element; masks of detected drawings that are mostly
    bare surface are tightened to their strokes. The surface is estimated with
    every claimed element removed, so a person is never mistaken for surface;
    photographs, whose backgrounds are not plain, are left alone."""
    h, w = rgb.shape[:2]
    n = h * w
    if any(s.role == "carrier" and s.mask.sum() > 0.15 * n for s in subjects):
        return []
    f = 4 if max(h, w) > 600 else 2
    sw, sh = w // f, h // f
    small = cv2.resize(rgb, (sw, sh), interpolation=cv2.INTER_AREA)
    hole = cv2.resize(dilate(claimed, 2 * f).astype(np.uint8), (sw, sh), interpolation=cv2.INTER_NEAREST)
    if hole.mean() > 0.6:
        return []
    filled = cv2.inpaint(small, hole * 255, 5, cv2.INPAINT_TELEA) if hole.any() else small
    surface = cv2.resize(cv2.medianBlur(filled, 21), (w, h), interpolation=cv2.INTER_LINEAR)
    img = cv2.medianBlur(rgb, 3)
    diff = np.abs(img.astype(np.int16) - surface.astype(np.int16)).max(-1).astype(np.float32)
    free = ~claimed
    mad = float(np.median(diff[free])) if free.any() else 0.0
    ink = diff > max(18.0, 12.0 + 3.5 * 1.48 * mad)
    if ink[free].mean() > 0.15:
        return []  # not a plain surface
    text_px = np.zeros((h, w), bool)
    for t in texts:
        text_px |= t.mask
    ink &= ~dilate(text_px, 2)  # lettering is already its own element
    # detected drawings whose masks are mostly bare surface: keep only the strokes
    for s in subjects:
        if s.mask.any() and (s.mask & ink).sum() < 0.3 * s.mask.sum():
            s.mask = s.mask & dilate(ink, 2)
    r = max(3, int(0.012 * max(h, w)))
    blobs = cv2.morphologyEx(ink.astype(np.uint8), cv2.MORPH_CLOSE,
                             cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1)))
    cnt, comp, stats, _ = cv2.connectedComponentsWithStats(blobs, connectivity=8)
    out = []
    for c in range(1, cnt):
        x, y, bw, bh, area = stats[c]
        if area < 20 or area > 0.4 * n:
            continue
        if x == 0 or y == 0 or x + bw >= w or y + bh >= h:
            continue  # frames, rules and borders running off the edge stay in the artwork
        strokes = (comp == c) & ink
        if strokes.sum() < 0.02 * area:
            continue
        element = dilate(strokes, 1) & (comp == c)
        line = _on_text_line(element, texts)
        if line is not None:  # a letter, or a piece of one, the text finder missed
            line.mask = line.mask | element
            line.hard = line.mask.copy()
            continue
        if area < 0.002 * n:
            continue
        owner = next((s for s in subjects if (strokes & s.mask).sum() > 0.5 * strokes.sum()), None)
        if owner is not None:  # a detected drawing: cut along its strokes, not SAM's blob
            owner.mask = (owner.mask & dilate(ink, 2)) | element
            continue
        if (element & claimed).sum() > 0.3 * element.sum():
            continue
        out.append(element & ~claimed)
    return [m for m in out if m.any()]


def _on_text_line(element, texts):
    ex0, ey0, ex1, ey1 = mask_box(element)
    for t in texts:
        tx0, ty0, tx1, ty1 = mask_box(t.mask)
        lh = t.meta.get("line_height", ty1 - ty0)
        overlap = min(ey1, ty1) - max(ey0, ty0)
        gap = max(ex0 - tx1, tx0 - ex1)
        if overlap > 0.6 * (ey1 - ey0) and (ey1 - ey0) < 1.6 * lh and gap < 1.5 * lh:
            return t
    return None


def attach_cast_shadows(rgb, subjects, reach_frac=0.08):
    """A person against a wall throws a shadow on it. Lifting the person off and
    leaving the shadow behind leaves a dark ghost (and the rebuild extends it).
    Shadow = surface next to the subject that is darker than the surface farther
    away predicts, by a roughly uniform factor across channels, and connected to
    the subject. It joins the subject's layer as soft alpha (solved later)."""
    h, w = rgb.shape[:2]
    ss = [s for s in subjects if s.role in ("carrier", "object", "furniture") and s.mask.any()]
    if not ss:
        return
    body = np.zeros((h, w), bool)
    for s in ss:
        body |= s.mask
    reach = max(6, int(reach_frac * max(h, w)))
    lum = rgb.astype(np.float32).mean(-1)
    dist = cv2.distanceTransform((~body).astype(np.uint8), cv2.DIST_L2, 3)
    far = (dist > reach) & (dist < 3 * reach)
    if far.sum() < 1000:
        return
    sigma = reach
    wgt = cv2.GaussianBlur(far.astype(np.float32), (0, 0), sigma)
    expect = cv2.GaussianBlur(lum * far, (0, 0), sigma) / np.maximum(wgt, 1e-3)
    # where the far ring gives no evidence, do not guess
    valid = wgt > 0.05
    ratio = lum / np.maximum(expect, 1.0)
    rgbf = rgb.astype(np.float32)
    chroma = rgbf / np.maximum(rgbf.sum(-1, keepdims=True), 1.0)
    near = (dist > 0) & (dist <= reach) & valid
    dark = near & (ratio < 0.82)
    # hue-neutral darkening: chromaticity close to the far surface's
    exp_chroma = cv2.GaussianBlur(chroma * far[..., None], (0, 0), sigma) / np.maximum(wgt[..., None], 1e-3)
    dark &= np.abs(chroma - exp_chroma).max(-1) < 0.06
    dark = cv2.morphologyEx(dark.astype(np.uint8), cv2.MORPH_OPEN, np.ones((3, 3), np.uint8)) > 0
    cnt, comp = cv2.connectedComponents((dark | body).astype(np.uint8), connectivity=8)
    for s in ss:
        ids = np.unique(comp[s.mask])
        mine = dark & np.isin(comp, ids[ids > 0])
        # nearest subject wins contested shadow pixels
        if mine.any():
            others = [o for o in ss if o is not s]
            if others:
                d_s = cv2.distanceTransform((~s.mask).astype(np.uint8), cv2.DIST_L2, 3)
                for o in others:
                    d_o = cv2.distanceTransform((~o.mask).astype(np.uint8), cv2.DIST_L2, 3)
                    mine &= ~(d_o < d_s)
            s.shadow = mine & ~body


def sharpness(gray, mask):
    lap = cv2.Laplacian(gray, cv2.CV_32F, ksize=3)
    inner = cv2.erode(mask.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0
    return float(np.abs(lap[inner]).mean()) if inner.sum() > 50 else 0.0


def drop_scenery(subjects, gray):
    """With a sharp main subject, out-of-focus trees, vehicles and buildings
    behind it belong to the background, as a designer would treat them."""
    people = [s for s in subjects if s.role == "carrier"]
    if not people:
        return subjects
    main = max(people, key=lambda s: s.mask.sum())
    ref = sharpness(gray, main.mask)
    if ref <= 0:
        return subjects
    keep = []
    for s in subjects:
        if s.label in SCENERY and (sharpness(gray, s.mask) < 0.55 * ref or s.mask.sum() < 0.1 * main.mask.sum()):
            continue  # blurred behind the subject, or a distant detail of the setting
        keep.append(s)
    return keep


def mask_box(m):
    ys, xs = np.nonzero(m)
    return float(xs.min()), float(ys.min()), float(xs.max() + 1), float(ys.max() + 1)


def best_host(item, carriers, reach):
    """The carrier that wears or holds `item`: its box mostly contains the item
    and their masks touch."""
    best, best_score = None, 0.0
    grown = dilate(item.mask, reach) if item.mask is not None else None
    for c in carriers:
        if c is item:
            continue
        inside = box_overlap(item.box, c.box)
        if inside < 0.6:
            continue
        if grown is not None and not (grown & c.mask).any():
            continue
        if item.mask is not None and item.mask.sum() > 0.6 * c.mask.sum():
            continue
        score = inside * c.score
        if score > best_score:
            best, best_score = c, score
    return best


def drop_group_boxes(dets):
    """A 'person' box that spans two or more confident people is the group, not a person."""
    out = []
    for d in dets:
        inner = [o for o in dets if o is not d and o.label == d.label and o.score >= 0.8 * d.score
                 and box_overlap(o.box, d.box) > 0.85 and o.area_box < 0.7 * d.area_box]
        if len(inner) >= 2:
            continue
        out.append(d)
    return out


def merge_same_label(subjects, reach):
    """Several boxes on one flag, one tree, one table: one element. Things of the
    same kind merge when their masks touch; people and animals never do."""
    out = []
    for s in sorted(subjects, key=lambda s: -s.mask.sum()):
        host = None
        if s.role != "carrier":
            grown = dilate(s.mask, reach)
            for o in out:
                if o.label == s.label and (grown & o.mask).any():
                    host = o
                    break
        if host is None:
            out.append(s)
        else:
            host.mask = host.mask | s.mask
            host.box = mask_box(host.mask)
            host.score = max(host.score, s.score)
    return out


def dedupe(subjects):
    """Same thing found under two labels (man / person, boat / ship): keep the stronger."""
    kept = []
    # people and animals first: a chair mask that swallowed its sitter loses
    for s in sorted(subjects, key=lambda s: (s.role != "carrier", -s.score * s.quality)):
        if s.role == "carrier":
            others = np.zeros_like(s.mask)
            for k in kept:
                if k.role == "carrier":
                    others |= k.mask
            if (s.mask & others).sum() > 0.8 * s.mask.sum():
                continue
        dup = False
        for k in kept:
            inter = (s.mask & k.mask).sum()
            if inter / max((s.mask | k.mask).sum(), 1) > 0.7:
                dup = True
                break
        if not dup:
            kept.append(s)
    return kept


def group_regions(regions, rgb, detections, sam):
    """Graphic path: classical regions that make up one detected subject (an
    illustrated figure split into flat colour areas) become one region.
    Typography always stays separate."""
    if not detections or sam is None:
        return regions, []
    h, w = rgb.shape[:2]
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY).astype(np.float32) / 255.0
    emb, scale, (nh, nw) = sam._embed(rgb)
    low = (256 * nh // sam.size, 256 * nw // sam.size)
    grouped = []
    used = set()
    for d in sorted(detections, key=lambda d: -d.score):
        # in flat artwork only figures are assembled from parts; a circle that the
        # detector calls a moon stays a circle, and its lettering stays lettering
        if d.role != "carrier":
            continue
        iou, logits = sam.decode_box(emb, np.float32(d.box) * scale)
        b = int(np.argmax(iou))
        if iou[b] < 0.75:
            continue
        m = refine_logits(logits[b][:low[0], :low[1]], gray, (h, w))
        members = [i for i, r in enumerate(regions)
                   if i not in used and r.kind != "text" and (r.mask & m).sum() > 0.6 * r.area]
        if len(members) < 2:
            continue
        union = np.zeros((h, w), bool)
        hard = np.zeros((h, w), bool)
        for i in members:
            union |= regions[i].mask
            hard |= regions[i].hard
            used.add(i)
        grouped.append(Region(mask=union, hard=hard, meta={"subject": d.label, "parts": [], "role": d.role}))
    rest = [r for i, r in enumerate(regions) if i not in used]
    return rest + grouped, [g.meta["subject"] for g in grouped]
