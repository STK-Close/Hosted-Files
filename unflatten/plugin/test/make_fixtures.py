"""Builds the plugin harness fixtures from a probe run (real Photoshop masks and
fills), at half resolution, gzipped raw arrays (Node reads them without image
libraries). Run once; the fixtures are committed.

  python test/make_fixtures.py <safe-test results dir> <generative results dir>
"""
import gzip, json, os, sys
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "engine", "tools"))
sys.path.insert(0, os.path.join(HERE, "..", "..", "engine"))
from compare_probe import unrle, load_original, load_crop  # noqa: E402

safe, gen = sys.argv[1:3]
r3 = json.load(open(os.path.join(safe, "unflatten-probe-report.json")))
r4 = json.load(open(os.path.join(gen, "unflatten-probe-report.json")))
g4 = {g["id"]: g for g in r4["generative"]["images"]}


def half(a, mask=False):
    im = Image.fromarray(a)
    im = im.resize((a.shape[1] // 2, a.shape[0] // 2), Image.NEAREST if mask else Image.BOX)
    return np.asarray(im)


def save(path, a):
    with gzip.open(path, "wb") as f:
        f.write(np.ascontiguousarray(a, np.uint8).tobytes())


for iid in ("C_family", "D_rosie"):
    im = next(i for i in r3["images"] if i["id"] == iid)
    rgb = load_original(iid)
    h, w = rgb.shape[:2]
    out = os.path.join(HERE, "fixtures", iid)
    os.makedirs(out, exist_ok=True)
    save(f"{out}/rgb.u8.gz", half(rgb))
    save(f"{out}/subject.u8.gz", half(unrle(f"{safe}/{iid}_select_subject.rle", w * h).reshape(h, w).astype(np.uint8), True))
    mao = next(c for c in im["checks"] if c["name"].endswith("Mask All Objects"))["detail"]
    objs = [o for o in mao["objects"] if "file" in o]
    for k, o in enumerate(objs):
        save(f"{out}/object{k}.u8.gz", half(unrle(f"{safe}/{o['file']}", w * h).reshape(h, w).astype(np.uint8), True))
    f = g4[iid]["fills"][0]
    x0, y0, x1, y1 = f["bbox"]
    filled = rgb.copy()
    filled[y0:y1, x0:x1] = load_crop(gen, f)
    save(f"{out}/generative.u8.gz", half(filled))
    json.dump({"width": w // 2, "height": h // 2, "objects": len(objs), "source": "Unflatten Probe runs on Photoshop 27.11, 18 Oct 2026"},
              open(f"{out}/meta.json", "w"))
    print(iid, w // 2, h // 2, len(objs))
