"""Render a Result as a contact sheet: original, background, then each layer on a checkerboard."""
import numpy as np
from PIL import Image, ImageDraw


def checker(w, h, s=8):
    y, x = np.mgrid[0:h, 0:w]
    return np.where(((x // s + y // s) % 2)[..., None] == 0, 200, 255).astype(np.uint8).repeat(3, -1)


def sheet(result, original, thumb=260):
    tiles = [("Original", original[..., :3])]
    for l in result.layers:
        if l.kind == "original":
            continue
        full = np.zeros((result.height, result.width, 4), np.uint8)
        h, w = l.rgba.shape[:2]
        full[l.top:l.top + h, l.left:l.left + w] = l.rgba
        a = full[..., 3:4] / 255.0
        tiles.append((l.name, (full[..., :3] * a + checker(result.width, result.height) * (1 - a)).astype(np.uint8)))
    scale = thumb / max(result.width, result.height)
    tw, th = int(result.width * scale), int(result.height * scale)
    out = Image.new("RGB", (len(tiles) * (tw + 8) + 8, th + 30), "white")
    d = ImageDraw.Draw(out)
    for i, (name, img) in enumerate(tiles):
        x = 8 + i * (tw + 8)
        out.paste(Image.fromarray(img).resize((tw, th), Image.LANCZOS), (x, 24))
        d.text((x, 6), name, fill="black")
    return out
