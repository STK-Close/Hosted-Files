"""Model-backed stages. Skipped when the ONNX models are not downloaded."""
import os

import numpy as np
import pytest

from synth import SCENES
from unflatten_engine.pipeline import DEFAULT_MODELS, Engine

need = pytest.mark.skipif(not os.path.exists(os.path.join(DEFAULT_MODELS, "sam2", "vision_encoder.onnx")),
                          reason="run download_models.py first")


@need
def test_sam_path_is_exact_and_finds_objects():
    scene = SCENES["shapes"]()
    r = Engine(segmenter="sam2").run(scene.image())
    assert r.stats["segmenter"] in ("sam2", "subjects")
    assert r.stats["reconstruction_psnr"] >= 45
    assert len(r.objects()) >= 2


@need
def test_lama_fills_textured_hole():
    from unflatten_engine.compose import psnr, to_float
    from unflatten_engine.stages.inpaint import LamaInpainter

    scene = SCENES["badge"]()
    bg = np.clip(np.rint(scene.background * 255), 0, 255).astype(np.uint8)
    mask = np.zeros(bg.shape[:2], bool)
    mask[150:250, 150:250] = True
    out = LamaInpainter.load(DEFAULT_MODELS)(bg, mask)
    assert np.array_equal(out[~mask], bg[~mask])  # untouched outside the hole
    assert psnr(to_float(out), to_float(bg), mask) > 28
