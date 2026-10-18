#!/bin/sh
# Assembles probe/wasm for the WebAssembly test (not kept in git: ~175 MB):
#   ONNX Runtime Web 1.17.3 (MIT): the single-script build plus its .wasm files,
#     with one line added so UXP's require() can load it
#   the engine's SAM 2.1 models (Apache-2.0), merged into single .onnx files
# Needs npm, python3 with the onnx package, and engine/models/sam2.
set -e
HERE=$(cd "$(dirname "$0")/.." && pwd)
SAM="$HERE/../engine/models/sam2"
TMP=$(mktemp -d)
(cd "$TMP" && npm pack -q onnxruntime-web@1.17.3 >/dev/null && tar xzf onnxruntime-web-1.17.3.tgz)
DIST="$TMP/package/dist"
mkdir -p "$HERE/wasm"
cp "$DIST/ort-wasm-simd.wasm" "$DIST/ort-wasm.wasm" "$HERE/wasm/"
{
  cat "$DIST/ort.wasm.min.js"
  printf '\n// added for the probe: expose the global as a CommonJS module for UXP require()\n'
  printf 'if (typeof module !== "undefined" && module.exports) module.exports = ort;\n'
} > "$HERE/wasm/ort.js"
python3 - "$SAM" "$HERE/wasm" <<'PY'
import sys, onnx
src, out = sys.argv[1:]
for name in ("vision_encoder", "prompt_encoder_mask_decoder"):
    onnx.save(onnx.load(f"{src}/{name}.onnx"), f"{out}/sam2_{name}.onnx")
PY
cat > "$HERE/wasm/NOTICE.txt" <<'TXT'
ort.js, ort-wasm*.wasm: ONNX Runtime Web 1.17.3, Copyright (c) Microsoft Corporation, MIT License.
sam2_*.onnx: SAM 2.1 (hiera-tiny), Meta Platforms, Apache License 2.0; ONNX export as used by the Unflatten engine.
TXT
rm -rf "$TMP"
ls -la "$HERE/wasm"
