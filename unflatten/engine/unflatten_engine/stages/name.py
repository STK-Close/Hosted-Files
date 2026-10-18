"""Meaningful layer names: geometry for primitives, CLIP zero-shot for objects."""
import os

import cv2
import numpy as np

COLORS = {
    "Black": (0, 0, 0), "White": (255, 255, 255), "Gray": (128, 128, 128),
    "Silver": (192, 192, 192), "Red": (220, 30, 40), "Crimson": (150, 10, 30),
    "Orange": (245, 130, 30), "Gold": (212, 175, 55), "Yellow": (250, 220, 40),
    "Green": (40, 160, 60), "Olive": (110, 120, 40), "Teal": (0, 128, 128),
    "Cyan": (40, 200, 220), "Blue": (30, 80, 220), "Navy": (20, 30, 90),
    "Purple": (120, 50, 160), "Magenta": (220, 40, 160), "Pink": (245, 160, 190),
    "Brown": (120, 70, 30), "Beige": (225, 205, 165),
}
_COLOR_LAB = {k: cv2.cvtColor(np.float32([[v]]) / 255.0, cv2.COLOR_RGB2LAB)[0, 0] for k, v in COLORS.items()}

VOCAB = [
    # people and figures
    "person", "woman", "man", "girl", "boy", "child", "face", "hand", "eye", "silhouette", "warrior", "queen",
    "king", "angel", "skeleton", "skull", "crowd",
    # nature
    "tree", "forest", "flower", "rose", "leaf", "branch", "vine", "grass", "mountain", "hill", "rock", "cloud",
    "moon", "sun", "star", "sky", "ocean", "wave", "river", "fire", "flame", "smoke", "snowflake", "feather",
    # animals
    "bird", "raven", "crow", "eagle", "owl", "butterfly", "moth", "cat", "dog", "horse", "wolf", "lion", "deer",
    "snake", "dragon", "fish", "insect",
    # objects
    "sword", "dagger", "crown", "key", "book", "candle", "lantern", "bottle", "cup", "glass", "chair", "table",
    "car", "bicycle", "boat", "ship", "airplane", "house", "castle", "tower", "church", "building", "city skyline",
    "bridge", "door", "window", "gate", "clock", "mirror", "ring", "necklace", "jewel", "heart", "mask", "phone",
    "laptop", "camera", "shoe", "bag", "dress", "hat", "food", "fruit", "apple", "cake", "coffee cup",
    # graphic design
    "logo", "icon", "badge", "seal", "emblem", "banner", "ribbon", "frame", "border", "ornament", "flourish",
    "pattern", "arrow", "button", "label", "sticker", "speech bubble", "line", "stripe", "splash",
    "brush stroke", "paint splatter", "text", "lettering", "word", "headline", "circle", "rectangle", "square", "triangle", "ellipse", "hexagon",
]
SHAPES = {"circle", "rectangle", "square", "triangle", "ellipse", "hexagon", "star", "line", "stripe"}
TEXTUAL = {"text", "lettering", "word", "headline"}
TEMPLATES = ["a photo of a {}.", "an illustration of a {}.", "a {} graphic."]
MEAN = np.float32([0.48145466, 0.4578275, 0.40821073])
STD = np.float32([0.26862954, 0.26130258, 0.27577711])


def color_name(rgb_mean):
    lab = cv2.cvtColor(np.float32([[rgb_mean]]) / 255.0, cv2.COLOR_RGB2LAB)[0, 0]
    return min(_COLOR_LAB, key=lambda k: float(((_COLOR_LAB[k] - lab) ** 2).sum()))


def shape_name(mask):
    """Geometric primitive for a solid mask, or None."""
    m8 = mask.astype(np.uint8)
    contours, _ = cv2.findContours(m8, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    if len(contours) != 1:
        return None
    c = contours[0]
    area = cv2.contourArea(c)
    if area < 50:
        return None
    perim = cv2.arcLength(c, True)
    hull_area = cv2.contourArea(cv2.convexHull(c))
    solidity = area / max(hull_area, 1)
    (_, _), (rw, rh), _ = cv2.minAreaRect(c)
    rect_fill = area / max(rw * rh, 1)
    aspect = max(rw, rh) / max(min(rw, rh), 1)
    circ = 4 * np.pi * area / max(perim ** 2, 1)
    approx = cv2.approxPolyDP(c, 0.02 * perim, True)
    if rect_fill > 0.95 and aspect > 6:
        return "Stripe"
    if rect_fill > 0.95:
        return "Square" if aspect < 1.08 else "Rectangle"
    if circ > 0.85 and solidity > 0.97:
        return "Circle" if aspect < 1.08 else "Ellipse"
    if len(approx) == 3 and solidity > 0.95:
        return "Triangle"
    if len(approx) == 6 and solidity > 0.95:
        return "Hexagon"
    if len(approx) == 10 and 0.4 < solidity < 0.8:
        return "Star"
    return None


class ClipNamer:
    """CLIP ViT-B/32 (MIT) zero-shot classification over a design vocabulary."""

    def __init__(self, models_dir):
        import onnxruntime as ort
        from tokenizers import Tokenizer

        d = os.path.join(models_dir, "clip")
        prov = ort.get_available_providers()
        self.vision = ort.InferenceSession(os.path.join(d, "vision_model.onnx"), providers=prov)
        cache = os.path.join(d, "vocab_embeds.npy")
        if os.path.exists(cache) and np.load(cache).shape[0] == len(VOCAB):
            self.text = np.load(cache)
        else:
            text = ort.InferenceSession(os.path.join(d, "text_model.onnx"), providers=prov)
            tok = Tokenizer.from_file(os.path.join(d, "tokenizer.json"))
            emb = []
            for word in VOCAB:
                vs = []
                for t in TEMPLATES:
                    ids = np.array([tok.encode(t.format(word)).ids], np.int64)
                    vs.append(text.run(None, {"input_ids": ids})[0][0])
                v = np.mean([x / np.linalg.norm(x) for x in vs], 0)
                emb.append(v / np.linalg.norm(v))
            self.text = np.stack(emb).astype(np.float32)
            np.save(cache, self.text)

    @classmethod
    def load(cls, models_dir):
        if models_dir and os.path.exists(os.path.join(models_dir, "clip", "vision_model.onnx")):
            return cls(models_dir)
        return None

    def classify(self, rgba_crop):
        """Top label and probability for an RGBA crop shown on neutral gray."""
        a = rgba_crop[..., 3:4].astype(np.float32) / 255.0
        img = rgba_crop[..., :3].astype(np.float32) * a + 128.0 * (1 - a)
        h, w = img.shape[:2]
        side = max(h, w)
        canvas = np.full((side, side, 3), 128.0, np.float32)
        canvas[(side - h) // 2:(side - h) // 2 + h, (side - w) // 2:(side - w) // 2 + w] = img
        x = cv2.resize(canvas, (224, 224), interpolation=cv2.INTER_AREA) / 255.0
        x = ((x - MEAN) / STD).transpose(2, 0, 1)[None].astype(np.float32)
        e = self.vision.run(None, {"pixel_values": x})[0][0]
        e = e / np.linalg.norm(e)
        logits = 100.0 * self.text @ e
        p = np.exp(logits - logits.max())
        p /= p.sum()
        i = int(np.argmax(p))
        return VOCAB[i], float(p[i])


class Namer:
    def __init__(self, models_dir=None):
        self.clip = ClipNamer.load(models_dir)

    def __call__(self, layers_info):
        """layers_info: dicts with kind, mask (canvas bool), rgba (crop), rgb_mean,
        text_height. Returns unique names in the same order."""
        names = []
        text_heights = sorted({i["text_height"] for i in layers_info if i["kind"] == "text"}, reverse=True)
        for info in layers_info:
            kind = info["kind"]
            if kind == "text":
                h = info["text_height"]
                if h == text_heights[0] and len(text_heights) > 1:
                    names.append("Title Text")
                elif h < 0.5 * text_heights[0]:
                    names.append("Small Text")
                else:
                    names.append("Text")
                continue
            if kind == "shadow":
                names.append("Shadow")
                continue
            color = color_name(info["rgb_mean"])
            shape = shape_name(info["hard"])
            if shape:
                names.append(f"{color} {shape}")
                continue
            if self.clip is not None:
                label, prob = self.clip.classify(info["rgba"])
                if prob >= 0.12:
                    if label in TEXTUAL:
                        names.append("Text")
                        continue
                    label = label.title()
                    names.append(f"{color} {label}" if label.lower() in SHAPES else label)
                    continue
            names.append(f"{color} Graphic")
        return unique(names)


def unique(names):
    seen, out = {}, []
    total = {n: names.count(n) for n in names}
    for n in names:
        seen[n] = seen.get(n, 0) + 1
        out.append(f"{n} {seen[n]}" if total[n] > 1 else n)
    return out
