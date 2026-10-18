"""Compare Photoshop's native results (from the Unflatten Probe) with the engine.

  python tools/compare_probe.py "<Unflatten Probe Results folder>" [-o out_dir]

Everything is compared on identical input: the same test images the probe
bundles, the same hole Photoshop filled, the same known-truth scenes. Writes
comparison.md plus side-by-side images.

Subjects (the two priorities: complete, logically grouped subjects):
  * people the image contains vs pieces in Photoshop's Select Subject vs
    person layers from the engine (separating people)
  * whether the detected cap lies inside the person (grouping)
  * agreement between Photoshop's subject mask and the engine's subjects
Backgrounds (no holes, no ghosts), on Photoshop's own hole:
  * anyone still detectable where a subject was removed
  * seam: how visible the hole's outline is (1.0 = invisible)
  * match: colour difference between the fill and its surroundings (ΔE)
  * detail: fine texture inside the fill relative to its surroundings (1.0 = same, low = blurred)
  * known-truth scenes: PSNR against the real background
"""
import argparse
import glob
import json
import os
import subprocess
import sys

import numpy as np
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE_DIR = os.path.dirname(HERE)
sys.path.insert(0, ENGINE_DIR)
PROBE_DIR = os.path.join(os.path.dirname(ENGINE_DIR), "probe")

from unflatten_engine.compose import layer_to_canvas, psnr, to_float  # noqa: E402
from unflatten_engine.pipeline import Engine  # noqa: E402
from unflatten_engine.stages.regions import dilate, to_lab  # noqa: E402


def unrle(path, n):
    b = np.fromfile(path, np.uint8).reshape(-1, 5)
    vals = b[:, 0]
    runs = b[:, 1].astype(np.int64) | (b[:, 2].astype(np.int64) << 8) | (b[:, 3].astype(np.int64) << 16) | (b[:, 4].astype(np.int64) << 24)
    out = np.repeat(vals, runs)
    assert out.size == n, f"{path}: {out.size} != {n}"
    return out


def load_original(image_id):
    for p in (os.path.join(PROBE_DIR, "testimages", image_id + ".jpg"),
              os.path.join(ENGINE_DIR, "tests", "data", "real", image_id + ".img")):
        if os.path.exists(p):
            return np.array(Image.open(p).convert("RGB"))
    raise FileNotFoundError(image_id)


def seam(rgb, hole):
    rgb = rgb.astype(np.int32)
    dx = np.abs(np.diff(rgb, axis=1)).sum(-1)
    dy = np.abs(np.diff(rgb, axis=0)).sum(-1)
    bx = hole[:, 1:] != hole[:, :-1]
    by = hole[1:] != hole[:-1]
    border = np.concatenate([dx[bx], dy[by]])
    base = np.concatenate([dx[~bx], dy[~by]])
    return float(border.mean() / max(base.mean(), 1e-3)) if border.size else None


def match_and_detail(rgb, hole):
    lab = to_lab(rgb)
    ring = dilate(hole, 25) & ~dilate(hole, 4)
    de = float(np.sqrt(((lab[hole].mean(0) - lab[ring].mean(0)) ** 2).sum()))
    g = rgb.astype(np.float32).mean(-1)
    hf = np.abs(g - np.asarray(Image.fromarray(g.astype(np.uint8)).resize(
        (g.shape[1] // 2, g.shape[0] // 2), Image.BILINEAR).resize((g.shape[1], g.shape[0]), Image.BILINEAR), np.float32))
    inner = hole & ~dilate(~hole, 6)
    detail = float(hf[inner].mean() / max(hf[ring].mean(), 1e-3)) if inner.any() else None
    return de, detail


def leftovers(engine, rgb, hole):
    """People still detectable over the filled area (should be none)."""
    ys, xs = np.nonzero(hole)
    box = (xs.min(), ys.min(), xs.max() + 1, ys.max() + 1)
    found = []
    for d in engine.detector(rgb):
        if d.label != "Person" or d.score < 0.2:
            continue
        x0, y0, x1, y1 = d.box
        ix = max(0, min(x1, box[2]) - max(x0, box[0])) * max(0, min(y1, box[3]) - max(y0, box[1]))
        if ix > 0.5 * (x1 - x0) * (y1 - y0):
            found.append(round(d.score, 2))
    return found


def people_layers(result):
    return [l for l in result.objects() if l.meta.get("subject") == "Person"]


def union_alpha(layers, result):
    u = np.zeros((result.height, result.width), bool)
    for l in layers:
        u |= layer_to_canvas(l, result.width, result.height)[1] > 0.5
    return u


def tile(img, h=300):
    im = Image.fromarray(img)
    return im.resize((max(1, int(im.width * h / im.height)), h), Image.LANCZOS)


def strip(images, labels, h=300):
    tiles = [tile(i, h) for i in images]
    out = Image.new("RGB", (sum(t.width for t in tiles) + 8 * len(tiles), h + 18), "white")
    d = ImageDraw.Draw(out)
    x = 0
    for t, lab in zip(tiles, labels):
        out.paste(t, (x, 18))
        d.text((x + 2, 2), lab, fill="black")
        x += t.width + 8
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("results")
    ap.add_argument("-o", "--out", default=None)
    a = ap.parse_args()
    report = json.load(open(os.path.join(a.results, "unflatten-probe-report.json")))
    out = a.out or os.path.join(a.results, "comparison")
    os.makedirs(out, exist_ok=True)
    engine = Engine()
    md = ["# Photoshop vs engine\n",
          f"Photoshop {report['environment']['photoshop']} · UXP {report['environment'].get('uxp')} · "
          f"{report['environment'].get('os')} · probe {report['probe']}\n"]
    subj_rows, bg_rows, notes = [], [], []

    for img in report["images"]:
        if img.get("skipped"):
            notes.append(f"{img['id']}: skipped in Photoshop ({img['skipped']})")
            continue
        iid = img["id"]
        checks = {c["name"].split(": ", 1)[1]: c for c in img["checks"]}
        rgb = load_original(iid)
        h, w = rgb.shape[:2]
        if img.get("size") and tuple(img["size"]) != (w, h):
            notes.append(f"{iid}: Photoshop size {img['size']} differs from {w}x{h}; skipped")
            continue
        thumbs = glob.glob(os.path.join(a.results, f"{iid}_thumb_*.rgb"))
        if thumbs:
            tw, th = map(int, thumbs[0].rsplit("_", 1)[1][:-4].split("x"))
            # compare coarse averages: independent of how each side resamples
            t = np.fromfile(thumbs[0], np.uint8).reshape(th, tw, 3)
            size = (16, max(1, round(16 * th / tw)))
            theirs = np.asarray(Image.fromarray(t).resize(size, Image.BOX), np.float32)
            mine = np.asarray(Image.fromarray(rgb).resize(size, Image.BOX), np.float32)
            diff = float(np.abs(theirs - mine).mean())
            if diff > 6:
                notes.append(f"{iid}: Photoshop's pixels differ from the file's (colour management?): mean diff {diff:.1f}")

        result = engine.run(rgb)
        eng_people = people_layers(result)
        ss = checks.get("Select Subject", {})
        ps_mask = None
        if ss.get("ok"):
            ps_mask = unrle(os.path.join(a.results, f"{iid}_select_subject.rle"), w * h).reshape(h, w) > 127
        rb = checks.get("Remove Background", {})
        mao = checks.get("Mask All Objects", {})

        # ---- subjects
        row = {"image": iid, "people": img["expected"]["people"],
               "ps_select_subject": "failed" if not ss.get("ok") else f"{ss['detail']['pieces']['significant']} piece(s)",
               "ps_time": round(ss.get("ms", 0) / 1000, 1),
               "ps_mask_all_objects": (f"{mao['detail']['created']} object layers" if mao.get("ok") else "not available"),
               "engine_people": len(eng_people),
               "engine_layers": ", ".join(l.name for l in result.objects())}
        rb_mask = None
        if rb.get("ok"):
            rb_mask = unrle(os.path.join(a.results, f"{iid}_remove_background.rle"), w * h).reshape(h, w) > 127
        if eng_people:
            u = union_alpha(eng_people, result)
            for key, m in (("agreement_iou", ps_mask), ("rb_agreement_iou", rb_mask)):
                if m is not None:
                    row[key] = round(float((u & m).sum() / max((u | m).sum(), 1)), 3)
        if img["expected"]["cap"]:
            caps = [d for d in engine.detector(rgb) if d.label == "Baseball Cap" and d.score >= 0.22]
            if caps:
                x0, y0, x1, y1 = [int(v) for v in max(caps, key=lambda d: d.score).box]
                if ps_mask is not None:
                    row["cap_in_ps_subject"] = round(float(ps_mask[y0:y1, x0:x1].mean()), 2)
                if eng_people:
                    row["cap_in_engine_person"] = round(float(union_alpha(eng_people, result)[y0:y1, x0:x1].mean()), 2)
        subj_rows.append(row)

        # ---- background on Photoshop's own hole
        caf = checks.get("Content-Aware Fill behind subject", {})
        if not caf.get("ok"):
            bg_rows.append({"image": iid, "photoshop": caf.get("error") or (caf.get("detail") or {}).get("note", "not run")})
            continue
        hole = unrle(os.path.join(a.results, f"{iid}_caf_hole.rle"), w * h).reshape(h, w) > 127
        x0, y0, x1, y1 = caf["detail"]["bbox"]
        ps_bg = rgb.copy()
        ps_bg[y0:y1, x0:x1] = np.fromfile(os.path.join(a.results, caf["detail"]["file"]), np.uint8).reshape(y1 - y0, x1 - x0, 3)
        lama_bg, used = engine.inpainter(rgb, hole)
        brow = {"image": iid, "hole": caf["detail"]["holeCoverage"], "ps_time": round(caf["ms"] / 1000, 1),
                "ps_changed_outside": caf["detail"]["changedOutsideHole"]}
        for name, bg in (("photoshop", ps_bg), ("engine", lama_bg)):
            de, detail = match_and_detail(bg, hole)
            brow[name] = {"people_left": leftovers(engine, bg, hole), "seam": round(seam(bg, hole), 3),
                          "match_dE": round(de, 1), "detail": round(detail, 2) if detail is not None else None}
        bg_rows.append(brow)
        strip([rgb, ps_bg, lama_bg, result.layers[1].rgba[..., :3]],
              ["original", "Photoshop Content-Aware Fill", f"engine {used}, same hole", "engine, own subjects"]).save(
            os.path.join(out, f"{iid}_background.png"))
        if ps_mask is not None:
            vis_ps = (rgb * 0.35).astype(np.uint8)
            vis_ps[ps_mask] = rgb[ps_mask]
            u = union_alpha(result.objects(), result)
            vis_en = (rgb * 0.35).astype(np.uint8)
            vis_en[u] = rgb[u]
            strip([rgb, vis_ps, vis_en], ["original", "Photoshop Select Subject", "engine subjects (all layers)"]).save(
                os.path.join(out, f"{iid}_subjects.png"))
        print(iid, "done", flush=True)

    # ---- known-truth scenes
    scene_dir = os.path.join(out, "scenes")
    subprocess.run(["node", os.path.join(PROBE_DIR, "test", "export_scenes.js"), scene_dir], check=True)
    meta = json.load(open(os.path.join(scene_dir, "scenes.json")))
    sw, sh = meta["width"], meta["height"]
    scene_rows = []
    for row in report["accuracy"]:
        i = row["index"]
        comp = np.fromfile(os.path.join(scene_dir, f"scene{i}_comp.rgb"), np.uint8).reshape(sh, sw, 3)
        truth = np.fromfile(os.path.join(scene_dir, f"scene{i}_truth.rgb"), np.uint8).reshape(sh, sw, 3)
        hole = np.fromfile(os.path.join(scene_dir, f"scene{i}_hole.u8"), np.uint8).reshape(sh, sw) > 127
        lama, _ = engine.inpainter(comp, hole)
        ps_ok = isinstance(row.get("photoshop"), dict) and row["photoshop"].get("psnr") is not None
        ps_img = None
        f = os.path.join(a.results, f"scene{i}_caf.rgb")
        if os.path.exists(f):
            ps_img = np.fromfile(f, np.uint8).reshape(sh, sw, 3)
        scene_rows.append({"scene": row["scene"], "hole": row["hole"],
                           "ps_psnr": row["photoshop"].get("psnr") if ps_ok else None,
                           "ps_seam": row["photoshop"].get("seam") if ps_ok else None,
                           "ps_time": round(row["photoshop"].get("ms", 0) / 1000, 1) if ps_ok else None,
                           "engine_psnr": round(psnr(to_float(lama), to_float(truth), hole), 2),
                           "engine_seam": round(seam(lama, hole), 3)})
        if ps_img is not None:
            strip([comp, truth, ps_img, lama], ["scene", "true background", "Photoshop", "engine"], 220).save(
                os.path.join(out, f"scene{i}.png"))

    # ---- write up
    md.append("\n## Subjects\n")
    md.append("| Image | People | Photoshop Select Subject | s | Mask All Objects | Engine people | Agreement IoU (Select Subject / Remove Background) | Cap in subject (PS / engine) |")
    md.append("|---|---|---|---|---|---|---|---|")
    for r in subj_rows:
        cap = f"{r.get('cap_in_ps_subject', '–')} / {r.get('cap_in_engine_person', '–')}" if "cap_in_engine_person" in r or "cap_in_ps_subject" in r else "–"
        md.append(f"| {r['image']} | {r['people']} | {r['ps_select_subject']} | {r['ps_time']} | {r['ps_mask_all_objects']} | "
                  f"{r['engine_people']} | {r.get('agreement_iou', '–')} / {r.get('rb_agreement_iou', '–')} | {cap} |")
    md.append("\nEngine layers per image: " + "; ".join(f"**{r['image']}**: {r['engine_layers']}" for r in subj_rows))
    md.append("\n## Background on Photoshop's own hole\n")
    md.append("| Image | Hole | People left (PS / engine) | Seam (PS / engine) | Match ΔE (PS / engine) | Detail (PS / engine) | PS s | PS changed outside |")
    md.append("|---|---|---|---|---|---|---|---|")
    for r in bg_rows:
        if "photoshop" in r and isinstance(r["photoshop"], str):
            md.append(f"| {r['image']} | – | Photoshop failed: {r['photoshop']} | | | | | |")
            continue
        p, e = r["photoshop"], r["engine"]
        md.append(f"| {r['image']} | {r['hole']} | {len(p['people_left'])} / {len(e['people_left'])} | {p['seam']} / {e['seam']} | "
                  f"{p['match_dE']} / {e['match_dE']} | {p['detail']} / {e['detail']} | {r['ps_time']} | {r['ps_changed_outside']} |")
    md.append("\n## Known-truth scenes (PSNR vs the real background; higher is better)\n")
    md.append("| Scene | Hole | Photoshop dB | Engine dB | Seam PS / engine | PS s |")
    md.append("|---|---|---|---|---|---|")
    for r in scene_rows:
        md.append(f"| {r['scene']} | {r['hole']} | {r['ps_psnr']} | {r['engine_psnr']} | {r['ps_seam']} / {r['engine_seam']} | {r['ps_time']} |")
    if report.get("wasm"):
        md.append(f"\nWebAssembly: {json.dumps(report['wasm'])}")
    if report.get("recorded"):
        md.append(f"\nRecorded commands: {sorted(set(r['event'] for r in report['recorded']))}")
    if notes or report.get("notes"):
        md.append("\n## Notes\n" + "\n".join(f"- {n}" for n in notes + report.get("notes", [])))
    open(os.path.join(out, "comparison.md"), "w").write("\n".join(md) + "\n")
    json.dump({"subjects": subj_rows, "background": bg_rows, "scenes": scene_rows},
              open(os.path.join(out, "comparison.json"), "w"), indent=1, default=str)
    print(f"wrote {out}/comparison.md")


if __name__ == "__main__":
    main()
