"""Download the open-weight ONNX models Unflatten uses.

All models are permissively licensed and run locally on CPU (or GPU via
onnxruntime execution providers). Nothing is sent to the cloud.

  SAM 2.1 hiera-tiny  (Apache-2.0)  object/instance proposals
  LaMa                (Apache-2.0)  background reconstruction (inpainting)
  CLIP ViT-B/32       (MIT)         zero-shot layer naming

Usage: python download_models.py [--dest models]
"""
import argparse
import os
import sys
import urllib.request

HF = "https://huggingface.co/{repo}/resolve/main/{path}"

FILES = {
    "sam2": ("onnx-community/sam2.1-hiera-tiny-ONNX", [
        "onnx/vision_encoder.onnx", "onnx/vision_encoder.onnx_data",
        "onnx/prompt_encoder_mask_decoder.onnx", "onnx/prompt_encoder_mask_decoder.onnx_data",
    ]),
    "lama": ("Carve/LaMa-ONNX", ["lama_fp32.onnx"]),
    "clip": ("Xenova/clip-vit-base-patch32", [
        "onnx/vision_model.onnx", "onnx/text_model.onnx", "tokenizer.json",
    ]),
}


def remote_size(url):
    req = urllib.request.Request(url, method="HEAD")
    with urllib.request.urlopen(req) as r:
        return int(r.headers.get("Content-Length", 0))


def fetch(url, dest, retries=6):
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    size = remote_size(url)
    if os.path.exists(dest) and os.path.getsize(dest) == size:
        print(f"  ok      {dest}")
        return
    if os.path.exists(dest):
        os.replace(dest, dest + ".part")  # resume an earlier truncated download
    tmp = dest + ".part"
    print(f"  fetch   {url} ({size / 1e6:.0f} MB)")
    for _ in range(retries):
        have = os.path.getsize(tmp) if os.path.exists(tmp) else 0
        if have >= size:
            break
        req = urllib.request.Request(url, headers={"Range": f"bytes={have}-"})
        try:
            with urllib.request.urlopen(req) as r, open(tmp, "ab") as f:
                while chunk := r.read(1 << 20):
                    f.write(chunk)
        except OSError as e:
            print(f"  retry   {e}")
    if os.path.getsize(tmp) != size:
        raise SystemExit(f"download incomplete: {dest}")
    os.replace(tmp, dest)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dest", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "models"))
    ap.add_argument("only", nargs="*", help="subset of: " + ", ".join(FILES))
    a = ap.parse_args()
    for name, (repo, paths) in FILES.items():
        if a.only and name not in a.only:
            continue
        print(name)
        for p in paths:
            fetch(HF.format(repo=repo, path=p), os.path.join(a.dest, name, os.path.basename(p)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
