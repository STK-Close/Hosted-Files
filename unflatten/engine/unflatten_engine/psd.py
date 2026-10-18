"""Minimal layered PSD writer (8-bit RGB, raw channels).

Lets the engine produce a real Photoshop document from the command line, for
testing without the plugin and as a fallback export path.
"""
import struct

import numpy as np

from .compose import flatten, to_u8


def _pascal(name, pad=4):
    raw = name.encode("mac_roman", "replace")[:255]
    data = bytes([len(raw)]) + raw
    data += b"\0" * ((-len(data)) % pad)
    return data


def _unicode_name(name):
    body = struct.pack(">I", len(name)) + name.encode("utf-16-be")
    body += b"\0" * ((-len(body)) % 4)
    return b"8BIMluni" + struct.pack(">I", len(body)) + body


def write_psd(path, result):
    w, h = result.width, result.height
    layers = [l for l in result.layers if l.rgba.size]
    records, channel_data = [], []
    for layer in layers:
        lh, lw = layer.rgba.shape[:2]
        top, left = layer.top, layer.left
        chans = []
        for cid, idx in ((-1, 3), (0, 0), (1, 1), (2, 2)):
            plane = np.ascontiguousarray(layer.rgba[..., idx]).tobytes()
            chans.append((cid, struct.pack(">H", 0) + plane))
        rec = struct.pack(">iiiiH", top, left, top + lh, left + lw, len(chans))
        for cid, data in chans:
            rec += struct.pack(">hI", cid, len(data))
        flags = 0x08 | (0x02 if not layer.visible else 0)  # bit 1 set = hidden
        rec += b"8BIMnorm" + struct.pack(">BBBB", 255, 0, flags, 0)
        extra = struct.pack(">I", 0) + struct.pack(">I", 0) + _pascal(layer.name) + _unicode_name(layer.name)
        rec += struct.pack(">I", len(extra)) + extra
        records.append(rec)
        channel_data.append(b"".join(d for _, d in chans))

    info = struct.pack(">h", len(layers)) + b"".join(records) + b"".join(channel_data)
    if len(info) % 2:
        info += b"\0"
    layer_info = struct.pack(">I", len(info)) + info
    lmi = layer_info + struct.pack(">I", 0)

    comp = to_u8(flatten(result.layers, w, h))
    with open(path, "wb") as f:
        f.write(b"8BPS" + struct.pack(">H6xHIIHH", 1, 3, h, w, 8, 3))
        f.write(struct.pack(">I", 0))  # colour mode data
        f.write(struct.pack(">I", 0))  # image resources
        f.write(struct.pack(">I", len(lmi)) + lmi)
        f.write(struct.pack(">H", 0))
        for c in range(3):
            f.write(np.ascontiguousarray(comp[..., c]).tobytes())
