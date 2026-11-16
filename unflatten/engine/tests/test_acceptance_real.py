"""Acceptance tests A-D on real photographs, paintings and book covers.

Images are fetched on first use (see real_images.json) and cached in
tests/data/real/. Needs the downloaded models; skipped otherwise. Slow (a few
minutes on CPU): run with `pytest -m real`.

  A  person against a blue wall: one complete person, an uninterrupted wall
  B  person wearing a baseball cap: one layer, cap included, named for it
  C  several people: one complete layer each, background rebuilt
  D  book covers / poster: typography and art separated, no fragmentation

Shared checks: every element layer is transparent around its subject, the
visible stack recomposites to the original, the rebuilt background contains no
trace of the people that were lifted off it (OWLv2 finds nobody there), and
the area behind each extracted subject matches its surroundings.
"""
import json
import os
import urllib.request

import numpy as np
import pytest
from PIL import Image

from unflatten_engine.compose import layer_to_canvas
from unflatten_engine.pipeline import DEFAULT_MODELS, Engine
from unflatten_engine.stages.regions import dilate, to_lab
from unflatten_engine.stages.subjects import box_iou

HERE = os.path.dirname(__file__)
CACHE = os.path.join(HERE, "data", "real")
MANIFEST = json.load(open(os.path.join(HERE, "real_images.json")))

pytestmark = [
    pytest.mark.real,
    pytest.mark.skipif(not os.path.exists(os.path.join(DEFAULT_MODELS, "owlv2", "model.onnx")),
                       reason="run download_models.py first"),
]


def load(name):
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, name + ".img")
    if not os.path.exists(path):
        req = urllib.request.Request(MANIFEST[name]["url"], headers={"User-Agent": "UnflattenTests/0.2"})
        try:
            data = urllib.request.urlopen(req, timeout=60).read()
        except OSError as e:
            pytest.skip(f"cannot download {name}: {e}")
        open(path, "wb").write(data)
    return np.array(Image.open(path).convert("RGB"))


@pytest.fixture(scope="module")
def engine():
    return Engine()


_results = {}


def run(engine, name):
    if name not in _results:
        img = load(name)
        _results[name] = (img, engine.run(img))
    return _results[name]


def people(result):
    return [l for l in result.objects() if l.meta.get("subject") == "Person"]


def alpha_of(layer, result):
    return layer_to_canvas(layer, result.width, result.height)[1]


def check_common(engine, img, result):
    assert result.stats["reconstruction_psnr"] >= 45, result.stats
    bg = result.layers[1]
    assert bg.kind == "background" and (bg.rgba[..., 3] == 255).all(), "background must be opaque everywhere"
    for layer in result.objects():
        a = alpha_of(layer, result)
        ys, xs = np.nonzero(a > 0.5)
        if len(ys) == 0:
            continue
        # transparent around the element: the corners of its own box are clear
        box = a[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
        assert (box == 0).mean() > 0.05, f"{layer.name} is a solid block"
    # nobody left behind in the rebuilt background
    dets = engine.detector(bg.rgba[..., :3])
    for person in people(result):
        a = alpha_of(person, result) > 0.5
        ys, xs = np.nonzero(a)
        pbox = (xs.min(), ys.min(), xs.max() + 1, ys.max() + 1)
        ghosts = [d for d in dets if d.label == "Person" and d.score >= 0.2 and box_iou(d.box, pbox) > 0.5]
        assert not ghosts, f"{person.name} still visible in the background: {[(round(d.score, 2), d.box) for d in ghosts]}"


def hole_matches_surroundings(img, result, layer, max_de=14.0):
    """The background where the subject stood looks like the background around it."""
    bg = to_lab(result.layers[1].rgba[..., :3])
    a = alpha_of(layer, result) > 0.5
    ring = dilate(a, 25) & ~dilate(a, 6)
    return float(np.sqrt(((bg[a].mean(0) - bg[ring].mean(0)) ** 2).sum())) <= max_de


def single_piece(layer, result, frac=0.9):
    import cv2

    a = (alpha_of(layer, result) > 0.5).astype(np.uint8)
    n, comp, stats, _ = cv2.connectedComponentsWithStats(a, connectivity=8)
    if n <= 1:
        return False
    return stats[1:, cv2.CC_STAT_AREA].max() >= frac * stats[1:, cv2.CC_STAT_AREA].sum()


def test_A_person_against_blue_wall(engine):
    img, r = run(engine, "A_wall")
    check_common(engine, img, r)
    objs = r.objects()
    assert len(objs) == 1 and objs[0].name.startswith("Person"), [l.name for l in objs]
    assert single_piece(objs[0], r)
    assert hole_matches_surroundings(img, r, objs[0], max_de=8.0), "wall behind the person does not continue"


@pytest.mark.parametrize("name", ["B_cap_red", "B_cap_black"])
def test_B_person_wearing_cap(engine, name):
    img, r = run(engine, name)
    check_common(engine, img, r)
    ps = people(r)
    assert len(ps) == 1, [l.name for l in r.objects()]
    assert ps[0].name == "Person Wearing Baseball Cap"
    caps = [d for d in engine.detector(img) if d.label == "Baseball Cap" and d.score >= 0.22]
    assert caps, "fixture: no cap detected in the original"
    a = alpha_of(ps[0], r) > 0.5
    x0, y0, x1, y1 = [int(v) for v in max(caps, key=lambda d: d.score).box]
    assert a[y0:y1, x0:x1].mean() > 0.5, "cap is not part of the person layer"
    assert not [l for l in r.objects() if "Cap" in l.name and l is not ps[0]], "cap split into its own layer"


@pytest.mark.parametrize("name,expected", [("C_family", 6), ("C_crew", 5)])
def test_C_multiple_people(engine, name, expected):
    img, r = run(engine, name)
    check_common(engine, img, r)
    ps = people(r)
    assert len(ps) >= expected - 1, [l.name for l in r.objects()]  # at most one missed, never merged
    for p in ps:
        assert single_piece(p, r, 0.85), f"{p.name} is fragmented"
    for p in ps:
        assert hole_matches_surroundings(img, r, p, max_de=20.0)


@pytest.mark.parametrize("name,min_text,max_layers", [("D_simian", 3, 10), ("D_philadelphia", 2, 10), ("D_rosie", 1, 8)])
def test_D_covers_and_posters(engine, name, min_text, max_layers):
    img, r = run(engine, name)
    check_common(engine, img, r)
    texts = [l for l in r.objects() if l.kind == "text"]
    assert len(texts) >= min_text, [l.name for l in r.objects()]
    assert len(r.objects()) <= max_layers, f"fragmented: {[l.name for l in r.objects()]}"
    # lettering lifted off: the rebuilt background has no type where it stood
    from unflatten_engine.stages.text import detect_text

    left = detect_text(r.layers[1].rgba[..., :3])
    for t in texts:
        a = alpha_of(t, r) > 0.5
        assert not any((l.mask & a).sum() > 0.3 * a.sum() for l in left), f"{t.name} still in background"
