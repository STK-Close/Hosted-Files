"""Local HTTP service for the Photoshop panel. Binds to 127.0.0.1 only.

  GET    /health                 engine status and installed capabilities
  POST   /jobs                   raw 8-bit chunky pixels; headers X-Width, X-Height, X-Components
  GET    /jobs/<id>              {"state", "stage", "progress", "error"}
  GET    /jobs/<id>/result       binary: b"UNFL" + uint32 json_len + json + raw RGBA layer data
  DELETE /jobs/<id>

Pixels travel uncompressed and unencoded, in the document's own colour space,
so values round-trip exactly. Nothing leaves the machine.
"""
import argparse
import json
import queue
import struct
import threading
import traceback
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

from . import __version__
from .pipeline import Engine

MAX_PIXELS = 120_000_000


class Jobs:
    def __init__(self, engine):
        self.engine = engine
        self.jobs = {}
        self.lock = threading.Lock()
        self.queue = queue.Queue()
        threading.Thread(target=self._worker, daemon=True).start()

    def submit(self, image):
        jid = uuid.uuid4().hex[:12]
        with self.lock:
            self.jobs[jid] = {"state": "queued", "stage": "Waiting", "progress": 0.0, "error": None, "result": None}
        self.queue.put((jid, image))
        return jid

    def _worker(self):
        while True:
            jid, image = self.queue.get()
            job = self.jobs.get(jid)
            if job is None:
                continue
            job["state"] = "running"

            def progress(stage, frac, job=job):
                job["stage"], job["progress"] = stage, frac

            try:
                job["result"] = encode_result(self.engine.run(image, progress))
                job["state"], job["progress"], job["stage"] = "done", 1.0, "Done"
            except Exception as e:  # report to the panel, keep serving
                traceback.print_exc()
                job["state"], job["error"] = "error", f"{type(e).__name__}: {e}"


def encode_result(result):
    meta, blobs, offset = [], [], 0
    for layer in result.layers:
        data = np.ascontiguousarray(layer.rgba).tobytes()
        h, w = layer.rgba.shape[:2]
        meta.append({"name": layer.name, "kind": layer.kind, "visible": layer.visible,
                     "left": layer.left, "top": layer.top, "width": w, "height": h,
                     "offset": offset, "length": len(data)})
        blobs.append(data)
        offset += len(data)
    head = json.dumps({"width": result.width, "height": result.height, "stats": result.stats,
                       "layers": meta}).encode()
    return b"UNFL" + struct.pack("<I", len(head)) + head + b"".join(blobs)


def make_handler(jobs):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):
            pass

        def _send(self, code, body, ctype="application/json"):
            if not isinstance(body, (bytes, bytearray)):
                body = json.dumps(body).encode()
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(body)

        def do_OPTIONS(self):
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Width, X-Height, X-Components")
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_GET(self):
            parts = self.path.strip("/").split("/")
            if parts == ["health"]:
                return self._send(200, {"ok": True, "version": __version__, **jobs.engine.capabilities()})
            if len(parts) >= 2 and parts[0] == "jobs" and parts[1] in jobs.jobs:
                job = jobs.jobs[parts[1]]
                if len(parts) == 3 and parts[2] == "result":
                    if job["state"] != "done":
                        return self._send(409, {"error": "not ready"})
                    return self._send(200, job["result"], "application/octet-stream")
                return self._send(200, {k: job[k] for k in ("state", "stage", "progress", "error")})
            self._send(404, {"error": "not found"})

        def do_POST(self):
            if self.path.strip("/") != "jobs":
                return self._send(404, {"error": "not found"})
            try:
                w, h = int(self.headers["X-Width"]), int(self.headers["X-Height"])
                c = int(self.headers.get("X-Components", "4"))
                n = int(self.headers["Content-Length"])
            except (TypeError, ValueError):
                return self._send(400, {"error": "X-Width, X-Height and Content-Length are required"})
            if c not in (3, 4) or w * h > MAX_PIXELS or n != w * h * c:
                return self._send(400, {"error": f"expected {w}x{h}x{c} bytes of 8-bit pixels, got {n}"})
            buf = bytearray(n)
            view, got = memoryview(buf), 0
            while got < n:
                k = self.rfile.readinto(view[got:])
                if not k:
                    return self._send(400, {"error": "truncated upload"})
                got += k
            image = np.frombuffer(buf, np.uint8).reshape(h, w, c)
            self._send(202, {"id": jobs.submit(image)})

        def do_DELETE(self):
            parts = self.path.strip("/").split("/")
            if len(parts) == 2 and parts[0] == "jobs":
                jobs.jobs.pop(parts[1], None)
            self._send(200, {"ok": True})

    return Handler


def serve(host="127.0.0.1", port=7865, **engine_kw):
    engine = Engine(**engine_kw)
    httpd = ThreadingHTTPServer((host, port), make_handler(Jobs(engine)))
    print(f"Unflatten engine {__version__} on http://{host}:{port}  {engine.capabilities()}")
    httpd.serve_forever()


def main():
    ap = argparse.ArgumentParser(description="Unflatten local engine")
    ap.add_argument("--port", type=int, default=7865)
    ap.add_argument("--segmenter", default="auto", choices=["auto", "classical", "sam2"])
    a = ap.parse_args()
    serve(port=a.port, segmenter=a.segmenter)


if __name__ == "__main__":
    main()
