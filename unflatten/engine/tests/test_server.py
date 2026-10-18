"""The panel's wire protocol, end to end over a real socket."""
import json
import struct
import threading
import time
import urllib.request
from http.server import ThreadingHTTPServer

import numpy as np
import pytest

from synth import SCENES
from unflatten_engine.pipeline import Engine
from unflatten_engine.server import Jobs, make_handler


@pytest.fixture(scope="module")
def base():
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(Jobs(Engine(segmenter="classical"))))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}"
    httpd.shutdown()


def get(url):
    with urllib.request.urlopen(url) as r:
        return r.read()


def test_round_trip(base):
    assert json.loads(get(base + "/health"))["ok"]
    scene = SCENES["shapes"]()
    img = np.dstack([scene.image(), np.full((scene.h, scene.w), 255, np.uint8)])
    req = urllib.request.Request(base + "/jobs", data=img.tobytes(), method="POST",
                                 headers={"X-Width": str(scene.w), "X-Height": str(scene.h), "X-Components": "4"})
    jid = json.loads(urllib.request.urlopen(req).read())["id"]
    for _ in range(200):
        st = json.loads(get(f"{base}/jobs/{jid}"))
        if st["state"] in ("done", "error"):
            break
        time.sleep(0.05)
    assert st["state"] == "done", st
    blob = get(f"{base}/jobs/{jid}/result")
    assert blob[:4] == b"UNFL"
    n = struct.unpack("<I", blob[4:8])[0]
    meta = json.loads(blob[8:8 + n])
    payload = blob[8 + n:]
    assert meta["width"] == scene.w and meta["height"] == scene.h
    names = [l["name"] for l in meta["layers"]]
    assert names[:2] == ["Original (flattened)", "Background"] and "Red Circle" in names
    for l in meta["layers"]:
        assert l["length"] == l["width"] * l["height"] * 4
    orig = meta["layers"][0]
    px = np.frombuffer(payload[orig["offset"]:orig["offset"] + orig["length"]], np.uint8)
    assert np.array_equal(px.reshape(scene.h, scene.w, 4)[..., :3], scene.image())


def test_rejects_bad_upload(base):
    req = urllib.request.Request(base + "/jobs", data=b"\0" * 10, method="POST",
                                 headers={"X-Width": "4", "X-Height": "4", "X-Components": "4"})
    with pytest.raises(urllib.error.HTTPError) as e:
        urllib.request.urlopen(req)
    assert e.value.code == 400
