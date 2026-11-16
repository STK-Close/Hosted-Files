"""Run the engine over a folder of images and write one contact sheet per image
plus a 'hide test' strip: the stack with each object layer hidden in turn."""
import glob
import json
import os
import sys
import time

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from contact_sheet import sheet  # noqa: E402

from unflatten_engine import Engine  # noqa: E402
from unflatten_engine.compose import flatten, to_u8  # noqa: E402


def hide_strip(result, thumb=260):
    tiles = []
    for layer in result.objects():
        img = to_u8(flatten(result.layers, result.width, result.height, skip={layer.name}))
        tiles.append(Image.fromarray(img))
    if not tiles:
        return None
    s = thumb / max(result.width, result.height)
    tw, th = int(result.width * s), int(result.height * s)
    out = Image.new("RGB", (len(tiles) * (tw + 8) + 8, th + 8), "white")
    for i, t in enumerate(tiles):
        out.paste(t.resize((tw, th), Image.LANCZOS), (8 + i * (tw + 8), 4))
    return out


def main(src, dst):
    os.makedirs(dst, exist_ok=True)
    eng = Engine()
    report = {}
    for f in sorted(glob.glob(os.path.join(src, "*.jpg")) + glob.glob(os.path.join(src, "*.png"))):
        name = os.path.splitext(os.path.basename(f))[0]
        img = np.array(Image.open(f).convert("RGB"))
        t = time.time()
        r = eng.run(img)
        report[name] = {"seconds": round(time.time() - t, 1), "layers": [l.name for l in r.objects()],
                        **{k: r.stats[k] for k in ("segmenter", "inpainter", "reconstruction_psnr")}}
        print(name, report[name], flush=True)
        sheet(r, img, thumb=260).save(os.path.join(dst, f"{name}_sheet.png"))
        strip = hide_strip(r)
        if strip:
            strip.save(os.path.join(dst, f"{name}_hide.png"))
    json.dump(report, open(os.path.join(dst, "report.json"), "w"), indent=1)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
