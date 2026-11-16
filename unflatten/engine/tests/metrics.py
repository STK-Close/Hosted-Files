"""Measurements behind the acceptance tests."""
import numpy as np

from unflatten_engine.compose import flatten, layer_to_canvas, psnr, to_float


def match_layers(scene, result):
    """Map each ground-truth object to the extracted layer that best covers it
    (IoU of visible alpha > 0.5)."""
    out = {}
    layers = result.objects()
    for label, _, _ in scene.objects:
        gt = scene.visible_alpha(label) > 0.5
        full = next(a for l, _, a in scene.objects if l == label) > 0.5
        best, best_iou = None, 0.0
        for layer in layers:
            _, a = layer_to_canvas(layer, scene.w, scene.h)
            m = a > 0.5
            # a layer may legitimately include its occluded (completed) part
            iou = max((g & m).sum() / max((g | m).sum(), 1) for g in (gt, full))
            if iou > best_iou:
                best, best_iou = layer, iou
        out[label] = (best, best_iou)
    return out


def reconstruction_psnr(scene, result):
    return psnr(flatten(result.layers, scene.w, scene.h), to_float(scene.image()))


def halo_psnr(scene, label, layer, backdrop=(1.0, 0.0, 1.0)):
    """Object composited on magenta, extracted vs ground truth, around the object.
    Background fringes and missing edges both show up here."""
    from unflatten_engine.stages.regions import dilate

    gt_rgb = next(rgb for l, rgb, _ in scene.objects if l == label)
    gt_a = scene.visible_alpha(label)
    mag = np.broadcast_to(np.float32(backdrop), gt_rgb.shape)
    want = gt_rgb * gt_a[..., None] + mag * (1 - gt_a[..., None])
    rgb, a = layer_to_canvas(layer, scene.w, scene.h)
    got = rgb * a[..., None] + mag * (1 - a[..., None])
    near = dilate(gt_a > 0.02, 3)
    vis = near & ~dilate(occluded_by_others(scene, label), 2)
    return psnr(got, want, vis)


def occluded_by_others(scene, label):
    above, seen = np.zeros((scene.h, scene.w), bool), False
    for l, _, a in scene.objects:
        if seen:
            above |= a > 0.02
        seen |= l == label
    return above


def stray_alpha(scene, label, layer):
    """Fraction of a layer's opacity that lies away from its object (fragments)."""
    from unflatten_engine.stages.regions import dilate

    _, a = layer_to_canvas(layer, scene.w, scene.h)
    gt = next(al for l, _, al in scene.objects if l == label)
    far = ~dilate(gt > 0.01, 4)
    return float(a[far].sum() / max(a.sum(), 1e-6))


def hide_psnr(scene, result, label, layer):
    """Hide one layer: compare with the scene rendered without that object,
    inside the area the object covered."""
    from unflatten_engine.stages.regions import dilate

    got = flatten(result.layers, scene.w, scene.h, skip={layer.name})
    want = scene.composite(skip={label})
    gt = next(al for l, _, al in scene.objects if l == label)
    return psnr(got, want, dilate(gt > 0.02, 2))
