"""Alpha compositing and the exact-reconstruction foreground solve."""
import numpy as np

from .types import Layer


def to_float(img):
    return img.astype(np.float32) / 255.0


def to_u8(img):
    return np.clip(np.rint(img * 255.0), 0, 255).astype(np.uint8)


def over(dst_rgb, src_rgb, alpha):
    """Composite straight-alpha src over an opaque dst (all float32 0..1)."""
    a = alpha[..., None]
    return src_rgb * a + dst_rgb * (1.0 - a)


def min_alpha(image, below, eps=1e-4):
    """Smallest alpha per pixel such that some colour F in [0,1] satisfies
    image = a*F + (1-a)*below.  This is the most transparent layer that still
    reproduces the original exactly over what lies beneath it."""
    up = np.where(image > below + eps, (image - below) / np.maximum(1.0 - below, eps), 0.0)
    down = np.where(image < below - eps, (below - image) / np.maximum(below, eps), 0.0)
    return np.clip(np.maximum(up, down).max(axis=-1), 0.0, 1.0)


def solve_foreground(image, below, alpha, eps=1e-3):
    """Colour F that reproduces `image` over `below` at the given alpha."""
    a = alpha[..., None]
    fg = np.where(a > eps, (image - (1.0 - a) * below) / np.maximum(a, eps), image)
    return np.clip(fg, 0.0, 1.0)


def layer_to_canvas(layer: Layer, width, height):
    """Place a cropped layer on a full canvas, returning float rgb and alpha."""
    rgb = np.zeros((height, width, 3), np.float32)
    alpha = np.zeros((height, width), np.float32)
    h, w = layer.rgba.shape[:2]
    x0, y0 = max(layer.left, 0), max(layer.top, 0)
    x1, y1 = min(layer.left + w, width), min(layer.top + h, height)
    if x1 <= x0 or y1 <= y0:
        return rgb, alpha
    crop = layer.rgba[y0 - layer.top:y1 - layer.top, x0 - layer.left:x1 - layer.left]
    rgb[y0:y1, x0:x1] = to_float(crop[..., :3])
    alpha[y0:y1, x0:x1] = to_float(crop[..., 3])
    return rgb, alpha


def flatten(layers, width, height, skip=()):
    """Composite visible layers bottom->top into an opaque float RGB image."""
    out = np.zeros((height, width, 3), np.float32)
    for layer in layers:
        if not layer.visible or layer.name in skip:
            continue
        rgb, alpha = layer_to_canvas(layer, width, height)
        out = over(out, rgb, alpha)
    return out


def crop_to_content(rgba, pad=0):
    """Trim fully transparent margins. Returns (cropped, left, top) or None if empty."""
    ys, xs = np.nonzero(rgba[..., 3])
    if len(ys) == 0:
        return None
    h, w = rgba.shape[:2]
    y0, y1 = max(ys.min() - pad, 0), min(ys.max() + 1 + pad, h)
    x0, x1 = max(xs.min() - pad, 0), min(xs.max() + 1 + pad, w)
    return rgba[y0:y1, x0:x1].copy(), int(x0), int(y0)


def psnr(a, b, mask=None):
    diff = (a.astype(np.float64) - b.astype(np.float64)) ** 2
    if mask is not None:
        if not mask.any():
            return float("inf")
        diff = diff[mask]
    mse = diff.mean()
    return float("inf") if mse == 0 else float(10 * np.log10(1.0 / mse))


def projected_alpha(image, below, color, tol=4.0 / 255):
    """Alpha for pixels that mix a known element colour with what is beneath:
    the projection of (image - below) onto (color - below). Returns alpha and a
    mask of pixels where that two-colour model actually fits."""
    d = color - below
    n2 = (d * d).sum(-1)
    a = np.clip(((image - below) * d).sum(-1) / np.maximum(n2, 1e-6), 0.0, 1.0)
    err = np.abs(below + a[..., None] * d - image).max(-1)
    return a, (err < tol) & (n2 > (12.0 / 255) ** 2)
