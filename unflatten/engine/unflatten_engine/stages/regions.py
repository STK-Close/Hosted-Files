"""Region bookkeeping shared by all segmenters."""
from dataclasses import dataclass, field

import cv2
import numpy as np


@dataclass
class Region:
    mask: np.ndarray  # bool (H, W): pixels this element owns in the flattened image
    kind: str = "object"  # "object" | "text" | "shadow"
    hard: np.ndarray = None  # subset of mask that is the solid body (alpha forced to 1)
    score: float = 1.0
    meta: dict = field(default_factory=dict)

    def __post_init__(self):
        if self.hard is None:
            self.hard = self.mask.copy()

    @property
    def area(self):
        return int(self.mask.sum())

    def bbox(self):
        ys, xs = np.nonzero(self.mask)
        return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def disk(r):
    return cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))


def dilate(mask, r):
    if r <= 0:
        return mask.copy()
    return cv2.dilate(mask.astype(np.uint8), disk(r)) > 0


def erode(mask, r):
    if r <= 0:
        return mask.copy()
    return cv2.erode(mask.astype(np.uint8), disk(r), borderType=cv2.BORDER_REPLICATE) > 0


def to_lab(rgb_u8):
    """CIE Lab with L in 0..100 and a/b roughly -128..127 (float32)."""
    return cv2.cvtColor(rgb_u8.astype(np.float32) / 255.0, cv2.COLOR_RGB2LAB)


def labels_from_regions(regions, shape):
    """Disjoint label map, 0 = background, i+1 = regions[i]. Later regions win overlaps."""
    lab = np.zeros(shape, np.int32)
    for i, r in enumerate(regions):
        lab[r.mask] = i + 1
    return lab


def extend_labels(labels, within):
    """Give every pixel in `within` the label of its nearest labelled pixel."""
    from scipy import ndimage

    if not (labels > 0).any():
        return labels
    _, (iy, ix) = ndimage.distance_transform_edt(labels == 0, return_indices=True)
    out = labels.copy()
    sel = within & (labels == 0)
    out[sel] = labels[iy[sel], ix[sel]]
    return out
