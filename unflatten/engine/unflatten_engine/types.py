from dataclasses import dataclass, field

import numpy as np


@dataclass
class Layer:
    """One output layer. `rgba` is cropped to its bounds; (left, top) places it on the canvas."""

    name: str
    rgba: np.ndarray  # (h, w, 4) uint8, straight (non-premultiplied) alpha
    left: int = 0
    top: int = 0
    kind: str = "object"  # "object" | "background" | "original" | "text"
    visible: bool = True
    meta: dict = field(default_factory=dict)

    @property
    def bounds(self):
        h, w = self.rgba.shape[:2]
        return {"left": self.left, "top": self.top, "right": self.left + w, "bottom": self.top + h}


@dataclass
class Result:
    width: int
    height: int
    layers: list  # bottom -> top
    stats: dict = field(default_factory=dict)

    def objects(self):
        return [l for l in self.layers if l.kind in ("object", "text")]
