"""Background reconstruction behind extracted elements."""
import os

import cv2
import numpy as np

from .regions import dilate


class SurfaceInpainter:
    """Exact for flat and gradient backgrounds: fills holes from the fitted
    background surface plus matched grain, no model required."""

    name = "surface"

    def __call__(self, rgb, mask, bg_rms=99.0, **_):
        if bg_rms > 4.0:
            return None
        known = ~dilate(mask, 2)
        if known.sum() < 64:
            return None
        h, w = mask.shape
        ys, xs = np.nonzero(known)
        if len(ys) > 60000:
            pick = np.random.default_rng(0).choice(len(ys), 60000, replace=False)
            ys, xs = ys[pick], xs[pick]

        def basis(y, x):
            y = y / max(h - 1, 1) * 2 - 1
            x = x / max(w - 1, 1) * 2 - 1
            return np.stack([np.ones_like(x), x, y, x * x, x * y, y * y, x ** 3, x * x * y, x * y * y, y ** 3], -1)

        A = basis(ys.astype(np.float64), xs.astype(np.float64))
        coef, *_ = np.linalg.lstsq(A, rgb[ys, xs].astype(np.float64), rcond=None)
        resid = rgb[ys, xs] - A @ coef
        noise = resid.std(0)
        if noise.max() > 12:
            return None  # not a clean surface after all
        gy, gx = np.nonzero(mask)
        fill = basis(gy.astype(np.float64), gx.astype(np.float64)) @ coef
        if noise.max() > 1.0:  # matched grain so the fill does not read as a smooth patch
            fill += np.random.default_rng(0).normal(0, 1, fill.shape) * noise
        out = rgb.copy()
        out[gy, gx] = np.clip(np.rint(fill), 0, 255).astype(np.uint8)
        return out


class TeleaInpainter:
    name = "telea"

    def __call__(self, rgb, mask, **_):
        return cv2.inpaint(rgb, mask.astype(np.uint8) * 255, 5, cv2.INPAINT_TELEA)


class LamaInpainter:
    """LaMa (Apache-2.0) via ONNX at its native 512px. Large images are
    processed per masked area with surrounding context, and only masked
    pixels are written back so untouched background stays bit-exact."""

    name = "lama"
    size = 512

    def __init__(self, model_path):
        import onnxruntime as ort

        self.session = ort.InferenceSession(model_path, providers=ort.get_available_providers())

    @classmethod
    def load(cls, models_dir):
        path = os.path.join(models_dir, "lama", "lama_fp32.onnx")
        return cls(path) if os.path.exists(path) else None

    def _run(self, rgb, mask):
        s = self.size
        img = cv2.resize(rgb, (s, s), interpolation=cv2.INTER_AREA).astype(np.float32) / 255.0
        m = cv2.resize(mask.astype(np.uint8), (s, s), interpolation=cv2.INTER_NEAREST)
        m = (cv2.dilate(m, np.ones((3, 3), np.uint8)) > 0).astype(np.float32)
        out = self.session.run(None, {"image": img.transpose(2, 0, 1)[None], "mask": m[None, None]})[0][0]
        out = out.transpose(1, 2, 0)
        if out.max() <= 1.5:
            out = out * 255.0
        return cv2.resize(np.clip(out, 0, 255).astype(np.uint8), (rgb.shape[1], rgb.shape[0]),
                          interpolation=cv2.INTER_CUBIC)

    def __call__(self, rgb, mask, **_):
        out = rgb.copy()
        h, w = mask.shape
        count, comp, stats, _ = cv2.connectedComponentsWithStats(dilate(mask, 8).astype(np.uint8), connectivity=8)
        for c in range(1, count):
            x, y, bw, bh = stats[c, :4]
            side = int(max(bw, bh) * 1.6) + 32  # context around the hole
            side = min(max(side, 256), max(h, w))
            cx, cy = x + bw // 2, y + bh // 2
            x0 = int(np.clip(cx - side // 2, 0, max(w - side, 0)))
            y0 = int(np.clip(cy - side // 2, 0, max(h - side, 0)))
            x1, y1 = min(x0 + side, w), min(y0 + side, h)
            sub_mask = mask[y0:y1, x0:x1] & (comp[y0:y1, x0:x1] == c)
            if not sub_mask.any():
                continue
            filled = self._run(out[y0:y1, x0:x1], sub_mask)
            region = out[y0:y1, x0:x1]
            region[sub_mask] = filled[sub_mask]
        return out


class AutoInpainter:
    """Surface fill when the background is a clean surface, LaMa otherwise,
    OpenCV Telea when no model is installed."""

    def __init__(self, models_dir=None):
        self.surface = SurfaceInpainter()
        self.lama = LamaInpainter.load(models_dir) if models_dir else None
        self.telea = TeleaInpainter()

    def __call__(self, rgb, mask, **kw):
        if not mask.any():
            return rgb.copy(), "none"
        out = self.surface(rgb, mask, **kw)
        if out is not None:
            return out, self.surface.name
        if self.lama is not None:
            return self.lama(rgb, mask), self.lama.name
        return self.telea(rgb, mask), self.telea.name
