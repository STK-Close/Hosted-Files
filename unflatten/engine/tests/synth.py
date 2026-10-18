"""Synthetic flattened images with known ground-truth layers.

Each scene is built from anti-aliased RGBA layers (rendered at 4x and
downsampled) over a known background, so separation quality can be measured
exactly: what each layer should contain, what is hidden behind it, and what the
background looks like underneath.
"""
import cv2
import numpy as np

SS = 4  # supersampling factor


class Scene:
    def __init__(self, name, w, h, background):
        self.name, self.w, self.h = name, w, h
        self.background = background.astype(np.float32) / 255.0  # (h, w, 3)
        self.objects = []  # (label, rgb float (h,w,3), alpha float (h,w)), bottom -> top

    def add(self, label, rgb, alpha):
        self.objects.append((label, rgb, alpha))

    def composite(self, skip=()):
        out = self.background.copy()
        for label, rgb, a in self.objects:
            if label in skip:
                continue
            out = rgb * a[..., None] + out * (1 - a[..., None])
        return out

    def image(self):
        return np.clip(np.rint(self.composite() * 255), 0, 255).astype(np.uint8)

    def visible_alpha(self, label):
        """Alpha of an object after occlusion by everything above it."""
        vis = None
        for lab, _, a in self.objects:
            if vis is not None:
                vis = vis * (1 - a)
            if lab == label:
                vis = a.copy()
        return vis


def _mask(w, h, draw):
    big = np.zeros((h * SS, w * SS), np.uint8)
    draw(big, SS)
    return cv2.resize(big.astype(np.float32) / 255.0, (w, h), interpolation=cv2.INTER_AREA)


def _solid(w, h, color):
    return np.broadcast_to(np.float32(color) / 255.0, (h, w, 3)).copy()


def gradient_bg(w, h, top, bottom):
    t = np.linspace(0, 1, h, dtype=np.float32)[:, None, None]
    return (np.float32(top) * (1 - t) + np.float32(bottom) * t) * np.ones((1, w, 1), np.float32)


def paper_bg(w, h, base, amp=6, seed=1):
    rng = np.random.default_rng(seed)
    noise = rng.normal(0, amp, (h, w, 1)).astype(np.float32)
    noise = cv2.GaussianBlur(noise, (0, 0), 0.8)[..., None]
    return np.clip(np.float32(base) + noise, 0, 255)


def _text(w, h, text, org, scale, thick, font=cv2.FONT_HERSHEY_DUPLEX):
    def draw(img, s):
        cv2.putText(img, text, (org[0] * s, org[1] * s), font, scale * s, 255, thick * s, cv2.LINE_AA)
    return _mask(w, h, draw)


def scene_shapes(w=480, h=360):
    s = Scene("shapes", w, h, gradient_bg(w, h, (235, 240, 250), (170, 190, 225)))
    s.add("circle", _solid(w, h, (215, 40, 50)),
          _mask(w, h, lambda im, k: cv2.circle(im, (170 * k, 170 * k), 90 * k, 255, -1, cv2.LINE_AA)))
    s.add("square", _solid(w, h, (40, 80, 200)),
          _mask(w, h, lambda im, k: cv2.rectangle(im, (210 * k, 150 * k), (330 * k, 270 * k), 255, -1)))
    tri = np.int32([[380, 60], [450, 180], [310, 180]])
    s.add("triangle", _solid(w, h, (40, 160, 70)),
          _mask(w, h, lambda im, k: cv2.fillPoly(im, [tri * k], 255, cv2.LINE_AA)))
    return s


def scene_shadow(w=400, h=320):
    s = Scene("shadow", w, h, gradient_bg(w, h, (245, 238, 225), (225, 215, 195)))
    pts = []
    for i in range(10):
        r = 95 if i % 2 == 0 else 40
        ang = -np.pi / 2 + i * np.pi / 5
        pts.append([200 + r * np.cos(ang), 155 + r * np.sin(ang)])
    star = np.float32(pts)
    star_a = _mask(w, h, lambda im, k: cv2.fillPoly(im, [np.int32(star * k)], 255, cv2.LINE_AA))
    shadow_a = cv2.GaussianBlur(np.roll(np.roll(star_a, 10, 0), 10, 1), (0, 0), 6) * 0.55
    rgb = _solid(w, h, (250, 200, 30))
    a = star_a + shadow_a * (1 - star_a)
    rgb = (rgb * star_a[..., None]) / np.maximum(a[..., None], 1e-6)  # shadow colour is black
    s.add("star", rgb, a)
    return s


def scene_text(w=560, h=300):
    s = Scene("text", w, h, paper_bg(w, h, (238, 230, 214)))
    s.add("title", _solid(w, h, (90, 20, 30)), _text(w, h, "SKULL QUEEN", (40, 120), 2.2, 4))
    s.add("byline", _solid(w, h, (40, 40, 40)), _text(w, h, "a novel by Ligia", (150, 220), 1.0, 2))
    return s


def scene_metallic(w=560, h=240):
    s = Scene("metallic", w, h, gradient_bg(w, h, (25, 20, 35), (10, 8, 15)))
    fill = _text(w, h, "VOW", (120, 170), 4.5, 10)
    outline = _text(w, h, "VOW", (120, 170), 4.5, 16)
    t = np.linspace(0, 1, h, dtype=np.float32)[:, None, None]
    gold = (np.float32((255, 236, 160)) * (1 - t) + np.float32((150, 100, 20)) * t) / 255.0 * np.ones((1, w, 1))
    dark = np.float32((60, 35, 5)) / 255.0
    a = np.maximum(fill, outline)
    rgb = (gold * fill[..., None] + dark * (outline - fill).clip(0)[..., None]) / np.maximum(a[..., None], 1e-6)
    s.add("metal title", np.clip(rgb, 0, 1), a)
    return s


def scene_badge(w=400, h=400):
    s = Scene("badge", w, h, paper_bg(w, h, (30, 60, 50), amp=4, seed=3))
    s.add("badge", _solid(w, h, (230, 200, 120)),
          _mask(w, h, lambda im, k: cv2.circle(im, (200 * k, 200 * k), 140 * k, 255, -1, cv2.LINE_AA)))
    s.add("label", _solid(w, h, (120, 30, 20)), _text(w, h, "SALE", (100, 230), 2.6, 6))
    return s


SCENES = {f.__name__[6:]: f for f in (scene_shapes, scene_shadow, scene_text, scene_metallic, scene_badge)}
