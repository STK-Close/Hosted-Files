"""Would smaller (8-bit quantized) models be good enough to ship inside a plugin?

Builds a second model folder whose OWLv2, SAM 2.1 and CLIP-vision files are the
quantized variants, runs the full engine both ways on a folder of images and
compares what matters to the product: the same subjects found, the same masks,
the same names, and the time taken.

  python tools/quant_compare.py <image folder> <quantized model folder>
"""
import glob
import os
import sys
import time

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from unflatten_engine.compose import layer_to_canvas  # noqa: E402
from unflatten_engine.pipeline import DEFAULT_MODELS, Engine  # noqa: E402


def build_quant_dir(qsrc, out):
    links = {
        "owlv2/model.onnx": f"{qsrc}/owlv2_quantized.onnx",
        "sam2/vision_encoder.onnx": f"{qsrc}/sam_vision_encoder_quantized.onnx",
        "sam2/vision_encoder_quantized.onnx_data": f"{qsrc}/sam_vision_encoder_quantized.onnx_data",
        "sam2/prompt_encoder_mask_decoder.onnx": f"{qsrc}/sam_decoder_quantized.onnx",
        "sam2/prompt_encoder_mask_decoder_quantized.onnx_data": f"{qsrc}/sam_decoder_quantized.onnx_data",
        "clip/vision_model.onnx": f"{qsrc}/clip_vision_quantized.onnx",
        "clip/text_model.onnx": f"{DEFAULT_MODELS}/clip/text_model.onnx",
        "clip/tokenizer.json": f"{DEFAULT_MODELS}/clip/tokenizer.json",
        "owlv2/tokenizer.json": f"{DEFAULT_MODELS}/owlv2/tokenizer.json",
        "lama/lama_fp32.onnx": f"{DEFAULT_MODELS}/lama/lama_fp32.onnx",
    }
    for rel, src in links.items():
        dst = os.path.join(out, rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        if os.path.exists(src) and not os.path.lexists(dst):
            os.symlink(os.path.abspath(src), dst)
    return out


def subjects(result):
    out = {}
    for l in result.objects():
        a = layer_to_canvas(l, result.width, result.height)[1] > 0.5
        out[l.name] = a
    return out


def union(masks, shape):
    u = np.zeros(shape, bool)
    for m in masks:
        u |= m
    return u


def main(src, qsrc):
    qdir = build_quant_dir(qsrc, os.path.join(os.path.dirname(qsrc), "models_quantized"))
    full, small = Engine(models_dir=DEFAULT_MODELS), Engine(models_dir=qdir)
    rows = []
    for f in sorted(glob.glob(os.path.join(src, "*.jpg")) + glob.glob(os.path.join(src, "*.img"))):
        img = np.array(Image.open(f).convert("RGB"))
        t = time.time(); a = full.run(img); ta = time.time() - t
        t = time.time(); b = small.run(img); tb = time.time() - t
        sa, sb = subjects(a), subjects(b)
        people_a = [m for n, m in sa.items() if n.startswith("Person")]
        people_b = [m for n, m in sb.items() if n.startswith("Person")]
        ua, ub = union(sa.values(), img.shape[:2]), union(sb.values(), img.shape[:2])
        iou = (ua & ub).sum() / max((ua | ub).sum(), 1)
        rows.append((os.path.basename(f), len(people_a), len(people_b), round(float(iou), 3),
                     sorted(sa) == sorted(sb), round(ta, 1), round(tb, 1)))
        print(rows[-1], "\n   full:", sorted(sa), "\n   quant:", sorted(sb), flush=True)
    print("\nimage | people full/quant | element-mask IoU | same names | seconds full/quant")
    for r in rows:
        print(f"{r[0]} | {r[1]}/{r[2]} | {r[3]} | {r[4]} | {r[5]}/{r[6]}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
