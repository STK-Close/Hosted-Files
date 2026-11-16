// Unflatten core: the pixel logic of the one-click separation, independent of
// Photoshop so it runs (and is tested) the same in the plugin and in Node.
//
// Photoshop supplies the masks (Select Subject, Mask All Objects) and the
// rebuilt background (Generative Fill or Content-Aware Fill); this module turns
// them into layers that recombine to the original image:
//   instances()   which masks become layers (scenery dropped, accessories merged)
//   stackOrder()  back to front
//   holeOf()      the area the background must be rebuilt in
//   checkFill()   is a rebuilt background plausible (catches invented objects)
//   buildLayers() exact colours and opacities for every layer
// Masks are Uint8Array (0..255), images Uint8Array RGB, all row-major w*h.
"use strict";

// ---------------------------------------------------------------- masks

const SQ2 = Math.SQRT2;

// Distance (in pixels, chamfer approximation) from every pixel to the nearest
// pixel where `inside(i)` holds; also the index of that nearest pixel.
function distanceTo(inside, w, h, withIndex) {
  const n = w * h;
  const d = new Float32Array(n);
  const idx = withIndex ? new Int32Array(n) : null;
  for (let i = 0; i < n; i++) {
    if (inside(i)) { d[i] = 0; if (idx) idx[i] = i; } else { d[i] = 1e9; if (idx) idx[i] = -1; }
  }
  const relax = (i, j, c) => { if (d[j] + c < d[i]) { d[i] = d[j] + c; if (idx) idx[i] = idx[j]; } };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (x > 0) relax(i, i - 1, 1);
      if (y > 0) {
        relax(i, i - w, 1);
        if (x > 0) relax(i, i - w - 1, SQ2);
        if (x < w - 1) relax(i, i - w + 1, SQ2);
      }
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (x < w - 1) relax(i, i + 1, 1);
      if (y < h - 1) {
        relax(i, i + w, 1);
        if (x < w - 1) relax(i, i + w + 1, SQ2);
        if (x > 0) relax(i, i + w - 1, SQ2);
      }
    }
  }
  return { d, idx };
}

const on = (m) => (i) => m[i] > 127;
function dilate(m, w, h, r) {
  if (r <= 0) return m.slice();
  const { d } = distanceTo(on(m), w, h);
  const o = new Uint8Array(w * h);
  for (let i = 0; i < o.length; i++) if (d[i] <= r) o[i] = 255;
  return o;
}
function erode(m, w, h, r) {
  if (r <= 0) return m.slice();
  const { d } = distanceTo((i) => !(m[i] > 127), w, h);
  const o = new Uint8Array(w * h);
  for (let i = 0; i < o.length; i++) if (d[i] > r) o[i] = 255;
  return o;
}
function count(m) { let c = 0; for (let i = 0; i < m.length; i++) if (m[i] > 127) c++; return c; }
function union(a, b) { const o = a.slice(); for (let i = 0; i < o.length; i++) if (b[i] > o[i]) o[i] = b[i]; return o; }
function bboxOf(m, w, h) {
  let x0 = w, y0 = h, x1 = 0, y1 = 0;
  for (let i = 0; i < w * h; i++) if (m[i] > 127) {
    const x = i % w, y = (i / w) | 0;
    if (x < x0) x0 = x; if (x >= x1) x1 = x + 1; if (y < y0) y0 = y; if (y >= y1) y1 = y + 1;
  }
  return x1 ? [x0, y0, x1, y1] : null;
}

// Connected pieces of a mask (8-connected), largest first.
function pieces(m, w, h) {
  const lab = new Int32Array(w * h), out = [];
  const stack = new Int32Array(w * h);
  for (let s = 0; s < w * h; s++) {
    if (!(m[s] > 127) || lab[s]) continue;
    const id = out.length + 1, px = [];
    let top = 0; stack[top++] = s; lab[s] = id;
    while (top) {
      const i = stack[--top]; px.push(i);
      const x = i % w, y = (i / w) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const j = yy * w + xx;
        if (m[j] > 127 && !lab[j]) { lab[j] = id; stack[top++] = j; }
      }
    }
    const mask = new Uint8Array(w * h);
    for (const i of px) mask[i] = 255;
    out.push({ mask, area: px.length });
  }
  return out.sort((a, b) => b.area - a.area);
}

// ---------------------------------------------------------------- which masks become layers

// Mask All Objects also returns scenery (the steps behind a seated man, a wall,
// the floor): an object that spans most of the frame both ways, touches three
// edges and lies mostly outside Select Subject is background, not something to
// lift out. Flags at the sides of a group photo touch three edges too but are
// narrow, and stay objects. (Measured on the acceptance images.)
function backgroundLike(m, subject, w, h) {
  let top = false, bottom = false, left = false, right = false, n = 0, inside = 0;
  for (let i = 0; i < w * h; i++) {
    if (!(m[i] > 127)) continue;
    n++; if (subject && subject[i] > 127) inside++;
    const x = i % w, y = (i / w) | 0;
    if (y === 0) top = true; if (y === h - 1) bottom = true; if (x === 0) left = true; if (x === w - 1) right = true;
  }
  const b = bboxOf(m, w, h);
  const spans = b && b[2] - b[0] >= 0.8 * w && b[3] - b[1] >= 0.8 * h;
  return spans && top + bottom + left + right >= 3 && inside < 0.5 * n;
}

// The layers to make: Mask All Objects' objects when it found any, otherwise
// the separate pieces of Select Subject. Small objects that sit on a larger one
// (a cap, glasses, a badge) join it, so a person keeps what they wear.
function instances(subject, objects, w, h) {
  const n = w * h;
  let list = (objects || [])
    .filter((m) => count(m) >= 0.0005 * n && count(m) < 0.85 * n && !backgroundLike(m, subject, w, h))
    .map((m) => ({ mask: m, area: count(m) }));
  if (!list.length && subject) {
    list = pieces(subject, w, h).filter((p) => p.area >= 0.005 * n);
  }
  list.sort((a, b) => b.area - a.area);
  const merged = [];
  for (const it of list) {
    const host = merged.find((big) => it.area < 0.15 * big.area && sharesEdge(it.mask, big.mask, w, h));
    if (host) { host.mask = union(host.mask, it.mask); host.area = count(host.mask); host.parts++; }
    else merged.push({ mask: it.mask, area: it.area, parts: 1 });
  }
  return merged;
}

// Do two masks touch: most of the small one's outline within 3px of the big one,
// or the small one lies inside the big one's outline box near its top (a hat).
function sharesEdge(small, big, w, h) {
  const near = dilate(big, w, h, 3);
  let edge = 0, touching = 0;
  const grown = dilate(small, w, h, 1);
  for (let i = 0; i < w * h; i++) {
    if (grown[i] > 127 && !(small[i] > 127)) { edge++; if (near[i] > 127) touching++; }
  }
  return edge > 0 && touching / edge >= 0.25;
}

// Back to front: what reaches lower in the frame stands in front (people in a
// group photo, a table in front of those seated); larger first on ties.
function stackOrder(list, w, h) {
  const bottomOf = (m) => { const b = bboxOf(m, w, h); return b ? b[3] : 0; };
  return list.map((it, k) => ({ k, bottom: bottomOf(it.mask), area: it.area }))
    .sort((a, b) => (a.bottom - b.bottom) || (b.area - a.area)).map((x) => list[x.k]);
}

// ---------------------------------------------------------------- background

function holeOf(list, w, h) {
  let u = new Uint8Array(w * h);
  for (const it of list) u = union(u, it.mask);
  return dilate(u, w, h, holeMargin(w, h));
}
function holeMargin(w, h) { return Math.max(4, Math.round(0.008 * Math.max(w, h))); }

function toLab(r, g, b) {
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const R = lin(r), G = lin(g), B = lin(b);
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const X = f((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047);
  const Y = f(0.2126 * R + 0.7152 * G + 0.0722 * B);
  const Z = f((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883);
  return [116 * Y - 16, 500 * (X - Y), 200 * (Y - Z)];
}

// A rebuilt background is checked against its surroundings: mean colour of the
// fill vs a ring around it (ΔE), and fine texture inside vs the ring (1 = same).
// Generative Fill on flat artwork can invent an object; on the Rosie poster
// that read ΔE 20.4 and texture 1.31, against at most 8.9 and 1.06 on photos.
const FILL_LIMITS = { deltaE: 12, detail: 1.2 };
function checkFill(rgb, w, h, hole) {
  const ring = dilate(hole, w, h, 25), inner4 = dilate(hole, w, h, 4);
  const inner = erode(hole, w, h, 6);
  const sum = (sel) => {
    let n = 0, L = 0, A = 0, B = 0;
    for (let i = 0; i < w * h; i += 2) if (sel(i)) {
      const lab = toLab(rgb[3 * i], rgb[3 * i + 1], rgb[3 * i + 2]); L += lab[0]; A += lab[1]; B += lab[2]; n++;
    }
    return n ? [L / n, A / n, B / n] : null;
  };
  const isRing = (i) => ring[i] > 127 && !(inner4[i] > 127);
  const a = sum((i) => hole[i] > 127), b = sum(isRing);
  const deltaE = a && b ? Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) : 0;
  // high-frequency energy: |grey - 2x down-up sampled grey|
  const g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = (rgb[3 * i] + rgb[3 * i + 1] + rgb[3 * i + 2]) / 3;
  const hw = w >> 1, hh = h >> 1, small = new Float32Array(hw * hh);
  for (let y = 0; y < hh; y++) for (let x = 0; x < hw; x++) {
    const i = 2 * y * w + 2 * x;
    small[y * hw + x] = (g[i] + g[i + 1] + g[i + w] + g[i + w + 1]) / 4;
  }
  let hi = 0, nIn = 0, hr = 0, nRing = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    const v = Math.abs(g[i] - small[Math.min(hh - 1, y >> 1) * hw + Math.min(hw - 1, x >> 1)]);
    if (inner[i] > 127) { hi += v; nIn++; } else if (isRing(i)) { hr += v; nRing++; }
  }
  const detail = nIn && nRing ? (hi / nIn) / Math.max(hr / nRing, 1e-3) : 1;
  return { ok: deltaE <= FILL_LIMITS.deltaE && detail <= FILL_LIMITS.detail,
           deltaE: +deltaE.toFixed(1), detail: +detail.toFixed(2) };
}

// Flat graphic design (posters, covers, logos) versus photograph: mostly flat
// colour and few distinct colours. Generative Fill is not used on graphics.
function isGraphic(rgb, w, h) {
  const sw = Math.min(256, w), sh = Math.max(1, Math.round((h * sw) / w));
  const small = new Uint8Array(sw * sh * 3);
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    const sx = Math.min(w - 1, Math.floor(((x + 0.5) * w) / sw)), sy = Math.min(h - 1, Math.floor(((y + 0.5) * h) / sh));
    for (let c = 0; c < 3; c++) small[3 * (y * sw + x) + c] = rgb[3 * (sy * w + sx) + c];
  }
  let flat = 0, total = 0;
  const colours = new Set();
  let prev = null;
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    const i = 3 * (y * sw + x);
    const lab = toLab(small[i], small[i + 1], small[i + 2]);
    if (x > 0) { total++; if (Math.abs(lab[0] - prev[0]) + Math.abs(lab[1] - prev[1]) + Math.abs(lab[2] - prev[2]) < 1.5) flat++; }
    prev = lab;
    colours.add((small[i] >> 4) * 256 + (small[i + 1] >> 4) * 16 + (small[i + 2] >> 4));
  }
  return flat / Math.max(total, 1) > 0.85 && colours.size < 200;
}

// ---------------------------------------------------------------- exact layers

// Least opacity a layer pixel needs so that a colour in 0..255 over `below`
// gives `target`: the subject's minimum share of that pixel.
function minAlpha(t, b) {
  let a = 0;
  for (let c = 0; c < 3; c++) {
    const v = t[c] > b[c] ? (t[c] - b[c]) / Math.max(255 - b[c], 1e-6) : t[c] < b[c] ? (b[c] - t[c]) / Math.max(b[c], 1e-6) : 0;
    if (v > a) a = v;
  }
  return Math.min(1, a);
}

// Builds every layer so that  background, then each layer over it (normal
// blending, back to front) gives back the original pixels exactly (to 8-bit
// rounding). Each pixel of the rebuilt area belongs to the front-most layer
// that claims it:
//   * the layer's solid body is opaque;
//   * its rim is a blend of its own colour and the background beneath, with the
//     opacity projected onto that blend, never below the least that fits;
//   * rim pixels that are not such a blend and look like background go back to
//     the background with their original value (otherwise their outline would
//     be drawn into the rebuilt background as a ghost);
//   * under a layer in front, the one behind continues a few pixels (underlap)
//     so moving the front layer reveals no hairline gap.
// `soft` is Select Subject's soft selection (0..255), used as the edge estimate.
function buildLayers(rgb, bg, w, h, ordered, soft) {
  const n = w * h;
  const margin = holeMargin(w, h);
  const background = bg.slice();
  // inside a mask the front-most mask wins; around them the nearest one
  const owner = new Int16Array(n).fill(-1);
  const best = new Float32Array(n).fill(Infinity);
  for (let k = 0; k < ordered.length; k++) {
    const { d } = distanceTo(on(ordered[k].mask), w, h);
    for (let i = 0; i < n; i++) if (d[i] <= margin && d[i] <= best[i]) { best[i] = d[i]; owner[i] = k; }
  }
  const layers = [];
  for (let k = 0; k < ordered.length; k++) {
    const it = ordered[k];
    const core = erode(it.mask, w, h, 1);
    const { idx: nearest } = distanceTo(on(core), w, h, true);
    const rgba = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
      if (owner[i] !== k) continue;
      const t = [rgb[3 * i], rgb[3 * i + 1], rgb[3 * i + 2]];
      const b = [bg[3 * i], bg[3 * i + 1], bg[3 * i + 2]];
      let a;
      if (core[i] > 127) a = 1;
      else {
        const amin = minAlpha(t, b);
        let ap = -1;
        const j = nearest[i];
        if (j >= 0) {
          // projection onto the line from the background to the body colour
          let num = 0, den = 0, res = 0;
          const kc = [rgb[3 * j], rgb[3 * j + 1], rgb[3 * j + 2]];
          for (let c = 0; c < 3; c++) { num += (t[c] - b[c]) * (kc[c] - b[c]); den += (kc[c] - b[c]) ** 2; }
          if (den > 64) {
            const p = Math.max(0, Math.min(1, num / den));
            for (let c = 0; c < 3; c++) res = Math.max(res, Math.abs(b[c] + p * (kc[c] - b[c]) - t[c]));
            if (res <= 10) ap = p;
          }
        }
        const s = soft ? soft[i] / 255 : (it.mask[i] > 127 ? 1 : 0);
        const inMask = it.mask[i] > 127;
        if (ap >= 0.08) a = Math.max(ap, amin);
        else if (inMask || s >= 0.5) a = Math.max(s, amin, inMask ? 0.5 : 0);
        else { a = 0; background.set(t, 3 * i); } // background-like: folds back, exact
      }
      if (a <= 0) continue;
      const a8 = Math.min(255, Math.ceil(a * 255 - 1e-6));
      const af = a8 / 255;
      rgba[4 * i + 3] = a8;
      for (let c = 0; c < 3; c++) {
        const f = (t[c] - (1 - af) * background[3 * i + c]) / af;
        rgba[4 * i + c] = Math.max(0, Math.min(255, Math.round(f)));
      }
    }
    layers.push({ rgba, index: k });
  }
  // underlap: under an opaque pixel of a layer in front, the layer behind
  // continues its nearest own colour for a few pixels
  const under = Math.max(2, Math.round(margin / 2));
  for (let k = 0; k < layers.length - 1; k++) {
    const own = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (layers[k].rgba[4 * i + 3] === 255) own[i] = 255;
    if (!count(own)) continue;
    const { d, idx } = distanceTo(on(own), w, h, true);
    for (let i = 0; i < n; i++) {
      if (d[i] === 0 || d[i] > under || idx[i] < 0) continue;
      let covered = false;
      for (let m = k + 1; m < layers.length && !covered; m++) if (layers[m].rgba[4 * i + 3] === 255) covered = true;
      if (!covered) continue;
      const j = idx[i];
      for (let c = 0; c < 3; c++) layers[k].rgba[4 * i + c] = layers[k].rgba[4 * j + c];
      layers[k].rgba[4 * i + 3] = 255;
    }
  }
  for (const l of layers) l.bbox = bboxOf(l.rgba.filter((_, q) => q % 4 === 3), w, h);
  return { background, layers };
}

// Composites background + layers (normal blending, 8-bit) for checking.
function composite(background, layers, w, h) {
  const out = new Float32Array(background.length);
  for (let i = 0; i < out.length; i++) out[i] = background[i];
  for (const l of layers) {
    for (let i = 0; i < w * h; i++) {
      const a = l.rgba[4 * i + 3] / 255;
      if (!a) continue;
      for (let c = 0; c < 3; c++) out[3 * i + c] = l.rgba[4 * i + c] * a + out[3 * i + c] * (1 - a);
    }
  }
  const u = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) u[i] = Math.max(0, Math.min(255, Math.round(out[i])));
  return u;
}

// Layer names until the naming add-on arrives: people-free, position-based.
function layerNames(ordered, w, h) {
  const named = ordered.map((it, k) => ({ k, x: (bboxOf(it.mask, w, h) || [0])[0] }))
    .sort((a, b) => a.x - b.x);
  const names = new Array(ordered.length);
  named.forEach((e, n) => { names[e.k] = ordered.length === 1 ? "Subject" : `Subject ${n + 1}`; });
  return names;
}

module.exports = { distanceTo, dilate, erode, count, union, bboxOf, pieces, backgroundLike, instances, stackOrder,
  holeOf, holeMargin, checkFill, FILL_LIMITS, isGraphic, minAlpha, buildLayers, composite, layerNames, toLab };
