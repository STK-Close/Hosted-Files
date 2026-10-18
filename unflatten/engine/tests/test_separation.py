"""Acceptance tests for the separation engine on scenes with known layers.

Thresholds (dB PSNR on 0..1 images):
  reconstruction  >= 45   all visible layers recomposite to the original
  halo            >= 30   object over magenta matches ground truth (no fringes)
  hide            >= 28   hiding a layer reveals what was really behind it
  background      >= 32   reconstructed background under objects (smooth bgs)
"""
import re

import numpy as np
import pytest

from metrics import halo_psnr, hide_psnr, match_layers, reconstruction_psnr, stray_alpha
from synth import SCENES
from unflatten_engine import Engine
from unflatten_engine.compose import psnr, to_float


@pytest.fixture(scope="module")
def engine():
    return Engine(segmenter="classical")


@pytest.fixture(scope="module")
def results(engine):
    out = {}
    for name, make in SCENES.items():
        scene = make()
        out[name] = (scene, engine.run(scene.image()))
    return out


@pytest.mark.parametrize("name", list(SCENES))
def test_reconstruction_is_exact(results, name):
    scene, result = results[name]
    assert reconstruction_psnr(scene, result) >= 45


@pytest.mark.parametrize("name", list(SCENES))
def test_every_object_on_its_own_layer(results, name):
    scene, result = results[name]
    matches = match_layers(scene, result)
    for label, (layer, iou) in matches.items():
        assert layer is not None and iou >= 0.85, f"{label}: IoU {iou:.3f}"
    used = [m[0].name for m in matches.values()]
    assert len(set(used)) == len(used), "two objects merged into one layer"
    assert len(result.objects()) == len(scene.objects), [l.name for l in result.objects()]


@pytest.mark.parametrize("name", list(SCENES))
def test_transparent_clean_edges(results, name):
    scene, result = results[name]
    for label, (layer, _) in match_layers(scene, result).items():
        assert layer.rgba[..., 3].min() == 0, f"{layer.name} has no transparency"
        assert stray_alpha(scene, label, layer) < 0.005, f"{layer.name} has fragments"
        assert halo_psnr(scene, label, layer) >= 30, f"{layer.name} edge/halo"


@pytest.mark.parametrize("name", list(SCENES))
def test_hiding_a_layer_removes_it(results, name):
    scene, result = results[name]
    for label, (layer, _) in match_layers(scene, result).items():
        assert hide_psnr(scene, result, label, layer) >= 28, f"hiding {layer.name}"


@pytest.mark.parametrize("name", ["shapes", "shadow", "metallic"])
def test_background_reconstruction(results, name):
    scene, result = results[name]
    bg = next(l for l in result.layers if l.kind == "background")
    covered = np.zeros((scene.h, scene.w), bool)
    for _, _, a in scene.objects:
        covered |= a > 0.02
    assert psnr(to_float(bg.rgba[..., :3]), scene.background, covered) >= 32


@pytest.mark.parametrize("name", list(SCENES))
def test_document_structure(results, name):
    scene, result = results[name]
    names = [l.name for l in result.layers]
    assert len(set(names)) == len(names), "layer names must be unique"
    assert not any(re.fullmatch(r"Layer \d+", n) for n in names)
    original = result.layers[0]
    assert original.kind == "original" and not original.visible
    assert np.array_equal(original.rgba[..., :3], scene.image())
    bg = result.layers[1]
    assert bg.kind == "background" and bg.rgba.shape[:2] == (scene.h, scene.w)
    for layer in result.objects():
        b = layer.bounds
        assert 0 <= b["left"] < b["right"] <= scene.w and 0 <= b["top"] < b["bottom"] <= scene.h


def test_names_describe_content(results):
    assert [l.name for l in results["shapes"][1].objects()] == ["Red Circle", "Blue Square", "Green Triangle"]
    assert "Star" in results["shadow"][1].objects()[0].name
    assert [l.name for l in results["text"][1].objects()] == ["Title Text", "Text"]


def test_stacking_order(results):
    scene, result = results["shapes"]
    names = [l.name for l in result.objects()]
    assert names.index("Red Circle") < names.index("Blue Square")
    scene, result = results["badge"]
    kinds = [l.name for l in result.objects()]
    assert kinds[0] == "Gold Circle"


def test_occluded_shape_is_completed(results):
    scene, result = results["shapes"]
    circle = next(l for l in result.objects() if l.name == "Red Circle")
    assert circle.meta.get("completed")
    gt = scene.objects[0][2] > 0.5
    from unflatten_engine.compose import layer_to_canvas

    _, a = layer_to_canvas(circle, scene.w, scene.h)
    assert ((a > 0.5) & gt).sum() / gt.sum() > 0.97


def test_shadow_travels_with_object(results):
    scene, result = results["shadow"]
    star = result.objects()[0]
    a = star.rgba[..., 3]
    assert ((a > 10) & (a < 200)).sum() > 500, "soft shadow alpha missing"


def test_no_alpha_input_and_rgba_input(engine):
    scene = SCENES["shapes"]()
    rgba = np.dstack([scene.image(), np.full((scene.h, scene.w), 255, np.uint8)])
    r = engine.run(rgba)
    assert r.stats["reconstruction_psnr"] >= 45
