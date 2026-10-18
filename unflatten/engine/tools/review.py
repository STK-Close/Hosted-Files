"""Review grid: each original beside its rebuilt background (all elements hidden)."""
import glob
import os
import sys

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from unflatten_engine import Engine  # noqa: E402


def main(src, out, tile=300):
    eng = Engine()
    rows = []
    for f in sorted(glob.glob(os.path.join(src, "*.jpg"))):
        img = np.array(Image.open(f).convert("RGB"))
        r = eng.run(img)
        bg = r.layers[1].rgba[..., :3]
        s = tile / img.shape[0]
        size = (int(img.shape[1] * s), tile)
        pair = Image.new("RGB", (2 * size[0] + 6, tile + 18), "white")
        pair.paste(Image.fromarray(img).resize(size, Image.LANCZOS), (0, 18))
        pair.paste(Image.fromarray(bg).resize(size, Image.LANCZOS), (size[0] + 6, 18))
        ImageDraw.Draw(pair).text((2, 2), f"{os.path.basename(f)}: {', '.join(l.name for l in r.objects())}"[:110], fill="black")
        rows.append(pair)
        print(os.path.basename(f), flush=True)
    for k in range(0, len(rows), 4):
        chunk = rows[k:k + 4]
        sheet = Image.new("RGB", (sum(p.width for p in chunk) + 10 * len(chunk), tile + 18), "white")
        x = 0
        for p in chunk:
            sheet.paste(p, (x, 0))
            x += p.width + 10
        sheet.save(f"{out}_{k // 4}.png")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
