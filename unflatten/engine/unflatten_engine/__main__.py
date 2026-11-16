"""Command line: python -m unflatten_engine image.png [-o out_dir]"""
import argparse
import json
import os
import sys
import time

import numpy as np
from PIL import Image

from .pipeline import Engine
from .psd import write_psd


def main(argv=None):
    ap = argparse.ArgumentParser(prog="unflatten", description="One image. Every layer.")
    ap.add_argument("image")
    ap.add_argument("-o", "--out", default=None, help="output folder (default: <image>_layers)")
    ap.add_argument("--segmenter", default="auto", choices=["auto", "classical", "sam2"])
    ap.add_argument("--models", default=None, help="model folder (default: engine/models)")
    a = ap.parse_args(argv)

    img = np.array(Image.open(a.image).convert("RGBA"))
    if (img[..., 3] == 255).all():
        img = img[..., :3]
    stem = os.path.splitext(os.path.basename(a.image))[0]
    out = a.out or os.path.join(os.path.dirname(os.path.abspath(a.image)), stem + "_layers")
    os.makedirs(out, exist_ok=True)

    kw = {"segmenter": a.segmenter}
    if a.models:
        kw["models_dir"] = a.models
    engine = Engine(**kw)
    t = time.time()
    result = engine.run(img, progress=lambda s, f: print(f"  {f * 100:5.1f}%  {s}", file=sys.stderr))
    elapsed = time.time() - t

    write_psd(os.path.join(out, stem + ".psd"), result)
    manifest = []
    for i, layer in enumerate(result.layers):
        fn = f"{i:02d}_{layer.name.replace(' ', '_').replace('/', '-')}.png"
        Image.fromarray(layer.rgba, "RGBA").save(os.path.join(out, fn))
        manifest.append({"name": layer.name, "file": fn, "kind": layer.kind, "visible": layer.visible,
                         **layer.bounds, **layer.meta})
    report = {"image": a.image, "width": result.width, "height": result.height,
              "seconds": round(elapsed, 2), "stats": result.stats, "layers": manifest}
    with open(os.path.join(out, "report.json"), "w") as f:
        json.dump(report, f, indent=2)
    print(json.dumps({k: report[k] for k in ("seconds", "stats")}, indent=2))
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
