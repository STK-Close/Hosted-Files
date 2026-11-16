"""Prototype step 2: lift the lettering onto its own layer (exact matte), fill
behind it, then separate the subjects on the text-free image.
  python layers.py <cover.png> <out_dir>   (after text_masks.py)"""
import json, os, sys, time
import cv2, numpy as np
from PIL import Image, ImageDraw
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
from unflatten_engine.compose import to_float, to_u8, min_alpha, solve_foreground, layer_to_canvas
from unflatten_engine.pipeline import Engine

src, out = sys.argv[1:3]
rgb = np.array(Image.open(src).convert("RGB")); H, W = rgb.shape[:2]
soft = np.asarray(Image.open(f"{out}/text_mask.png")).astype(np.float32) / 255
engine = Engine()
t = time.time()
# the hole: the letters plus their glow / drop shadow / outline
r = max(4, int(round(0.006 * max(H, W))))
hole = cv2.dilate((soft > 0.3).astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))) > 0
clean = engine.inpainter.lama(rgb, hole)
Image.fromarray(clean).save(f"{out}/text_free.png")
tgt, below = to_float(rgb), to_float(clean)
a = np.where(hole, np.maximum(soft, min_alpha(tgt, below)), 0).astype(np.float32)
a[a < 0.03] = 0
fg = solve_foreground(tgt, below, a)
text_rgba = np.dstack([to_u8(fg), to_u8(a)])
Image.fromarray(text_rgba).save(f"{out}/layer_text.png")
t_text = time.time() - t; t = time.time()
result = engine.run(clean)
t_obj = time.time() - t
names = []
for k, l in enumerate(result.layers):
    if l.kind == "original": continue
    full = np.zeros((H, W, 4), np.uint8)
    hh, ww = l.rgba.shape[:2]
    full[l.top:l.top + hh, l.left:l.left + ww] = l.rgba
    Image.fromarray(full).save(f"{out}/layer_{k:02d}_{l.name.replace(' ', '_')}.png")
    names.append((l.name, full))
# recomposition check: background + objects + text
comp = np.zeros((H, W, 3), np.float32)
for _, f in names:
    al = f[..., 3:].astype(np.float32) / 255; comp = f[..., :3] * al + comp * (1 - al)
al = text_rgba[..., 3:].astype(np.float32) / 255; comp = text_rgba[..., :3] * al + comp * (1 - al)
err = np.abs(comp - rgb).max(-1)
info = {"text_seconds": round(t_text, 1), "object_seconds": round(t_obj, 1), "layers": [n for n, _ in names] + ["Text"],
        "recompose_mean_abs": round(float(np.abs(comp - rgb).mean()), 3), "pixels_off_by_more_than_3": round(float((err > 3).mean()), 4)}
json.dump(info, open(f"{out}/layers.json", "w"), indent=1); print(json.dumps(info))

def on_checker(rgba):
    h, w = rgba.shape[:2]; y, x = np.mgrid[0:h, 0:w]; c = (((x // 24 + y // 24) % 2) * 50 + 180).astype(np.float32)[..., None]
    al = rgba[..., 3:].astype(np.float32) / 255
    return (rgba[..., :3] * al + c * (1 - al)).astype(np.uint8)
tiles = [("original", rgb), ("text removed", clean), ("Text", on_checker(text_rgba))] + [(n, on_checker(f)) for n, f in names]
th = 520; ims = []
for name, tl in tiles:
    im = Image.fromarray(tl); im.thumbnail((1000, th)); c = Image.new("RGB", (im.width, th + 16), "white"); c.paste(im, (0, 16))
    ImageDraw.Draw(c).text((2, 2), name, fill="black"); ims.append(c)
sheet = Image.new("RGB", (sum(i.width for i in ims) + 6 * len(ims), th + 16), "white"); x = 0
for i in ims: sheet.paste(i, (x, 0)); x += i.width + 6
sheet.save(f"{out}/sheet.png")
