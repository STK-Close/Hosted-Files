// Unflatten Probe: verifies, inside a real Photoshop, which native operations a
// plugin can drive automatically, how fast they are, and how good the results
// are, before the Unflatten pipeline is moved onto them.
//
// Every check runs on a duplicate or on a test document the probe creates, and
// records {ok, ms, detail, error}. Nothing here touches the user's documents.
const ps = require("photoshop");
const { app, core, action, imaging, constants } = ps;
const uxp = require("uxp");

const ENGINE = "http://127.0.0.1:7865";
const report = { probe: "0.1.0", started: new Date().toISOString(), environment: null, recorded: [],
                 checks: [], accuracy: [], wasm: null };
const resultDocs = [];
const logEl = document.getElementById("log");

function log(line) {
  logEl.textContent += line + "\n";
  logEl.scrollTop = logEl.scrollHeight;
}

const NO_DIALOG = { dialogOptions: "dontDisplay" };

// ---------------------------------------------------------------- utilities

async function timed(name, fn) {
  const t = Date.now();
  const entry = { name, ok: false, ms: 0 };
  try {
    const detail = await fn();
    entry.ok = detail && detail.ok === false ? false : true;
    entry.detail = detail;
  } catch (e) {
    entry.error = String((e && e.message) || e);
  }
  entry.ms = Date.now() - t;
  log(`${entry.ok ? "✓" : "✗"} ${name}  ${entry.ms} ms  ${entry.error || summary(entry.detail)}`);
  return entry;
}

function summary(d) {
  if (!d) return "";
  const s = JSON.stringify(d);
  return s.length > 160 ? s.slice(0, 157) + "…" : s;
}

function modal(name, fn) {
  return core.executeAsModal(fn, { commandName: `Unflatten Probe: ${name}` });
}

async function batch(desc) {
  return action.batchPlay([desc], {});
}

// Try descriptors in order (recorded ones first); report which one worked.
async function tryDescriptors(candidates) {
  const errors = [];
  for (const c of candidates) {
    try {
      const res = await batch({ ...c.desc, _options: NO_DIALOG });
      const err = res && res[0] && res[0]._obj === "error" ? res[0].message || "error" : null;
      if (!err) return { used: c.label, result: res && res[0] };
      errors.push(`${c.label}: ${err}`);
    } catch (e) {
      errors.push(`${c.label}: ${(e && e.message) || e}`);
    }
  }
  throw new Error(errors.join(" | ") || "no candidates");
}

function recordedFor(objNames) {
  return report.recorded
    .filter((r) => objNames.includes(r.event))
    .map((r, i) => ({ label: `recorded ${r.event} #${i + 1}`, desc: stripForReplay(r.descriptor, r.event) }));
}

function stripForReplay(desc, event) {
  const d = JSON.parse(JSON.stringify(desc || {}));
  delete d._isCommand;
  d._obj = d._obj || event;
  return d;
}

async function compositeRGB(docId, w, h) {
  const got = await imaging.getPixels({ documentID: docId, componentSize: 8, applyAlpha: true });
  const data = await got.imageData.getData({ chunky: true });
  const comps = got.imageData.components;
  const out = new Uint8Array(w * h * 3);
  const b = got.sourceBounds;
  const gw = got.imageData.width;
  for (let y = 0; y < got.imageData.height; y++) {
    for (let x = 0; x < gw; x++) {
      const s = (y * gw + x) * comps, d = ((y + b.top) * w + (x + b.left)) * 3;
      out[d] = data[s]; out[d + 1] = data[s + 1]; out[d + 2] = data[s + 2];
    }
  }
  got.imageData.dispose();
  return out;
}

// Current selection as a full-canvas Uint8Array (0..255), or null if none.
async function selectionMask(docId, w, h) {
  let got;
  try {
    got = await imaging.getSelection({ documentID: docId });
  } catch (e) {
    return null;
  }
  if (!got || !got.imageData) return null;
  const data = await got.imageData.getData({ chunky: true });
  const comps = got.imageData.components || 1;
  const b = got.sourceBounds || { left: 0, top: 0 };
  const sw = got.imageData.width, sh = got.imageData.height;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const yy = y + b.top, xx = x + b.left;
      if (yy >= 0 && yy < h && xx >= 0 && xx < w) out[yy * w + xx] = data[(y * sw + x) * comps];
    }
  }
  const info = { colorSpace: got.imageData.colorSpace, components: comps, bounds: b };
  got.imageData.dispose();
  return { mask: out, info };
}

function maskStats(mask, w, h) {
  let on = 0, x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x] > 127) {
        on++;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  return { coverage: +(on / (w * h)).toFixed(4), bbox: on ? [x0, y0, x1 + 1, y1 + 1] : null,
           components: components(mask, w, h) };
}

// Connected pieces (on a ≤256 px copy): Select Subject on a group photo returns one
// selection; how many separate pieces it has says whether people can be told apart.
function components(mask, w, h) {
  const s = Math.max(1, Math.ceil(Math.max(w, h) / 256));
  const sw = Math.ceil(w / s), sh = Math.ceil(h / s);
  const m = new Uint8Array(sw * sh);
  for (let y = 0; y < h; y += s) for (let x = 0; x < w; x += s) if (mask[y * w + x] > 127) m[(y / s | 0) * sw + (x / s | 0)] = 1;
  const seen = new Uint8Array(sw * sh);
  const sizes = [];
  for (let i = 0; i < m.length; i++) {
    if (!m[i] || seen[i]) continue;
    let n = 0;
    const stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const p = stack.pop();
      n++;
      const px = p % sw, py = (p / sw) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const qx = px + dx, qy = py + dy;
        if (qx < 0 || qy < 0 || qx >= sw || qy >= sh) continue;
        const q = qy * sw + qx;
        if (m[q] && !seen[q]) { seen[q] = 1; stack.push(q); }
      }
    }
    sizes.push(n);
  }
  sizes.sort((a, b) => b - a);
  const total = sizes.reduce((a, b) => a + b, 0) || 1;
  return { count: sizes.length, significant: sizes.filter((n) => n > 0.02 * total).length };
}

function dilateMask(mask, w, h, r) {
  // separable max filter
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let k = -r; k <= r && !v; k++) { const xx = x + k; if (xx >= 0 && xx < w && mask[y * w + xx] > 127) v = 255; }
      tmp[y * w + x] = v;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let k = -r; k <= r && !v; k++) { const yy = y + k; if (yy >= 0 && yy < h && tmp[yy * w + x]) v = 255; }
      out[y * w + x] = v;
    }
  }
  return out;
}

async function newLayerWithPixels(doc, name, rgb, w, h) {
  const layer = doc.createPixelLayer ? await doc.createPixelLayer({ name }) : await doc.createLayer({ name });
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    rgba[4 * i] = rgb[3 * i]; rgba[4 * i + 1] = rgb[3 * i + 1]; rgba[4 * i + 2] = rgb[3 * i + 2]; rgba[4 * i + 3] = 255;
  }
  const opts = { width: w, height: h, components: 4, chunky: true, colorSpace: "RGB" };
  try { if (doc.colorProfileName) opts.colorProfile = doc.colorProfileName; } catch (e) { /* untagged */ }
  const img = await imaging.createImageDataFromBuffer(rgba, opts);
  await imaging.putPixels({ documentID: doc.id, layerID: layer.id, imageData: img });
  img.dispose();
  return layer;
}

async function putMaskOnLayer(doc, layer, mask, w, h) {
  const img = await imaging.createImageDataFromBuffer(mask, {
    width: w, height: h, components: 1, chunky: false, colorSpace: "Grayscale", colorProfile: "Gray Gamma 2.2" });
  await imaging.putLayerMask({ documentID: doc.id, layerID: layer.id, imageData: img });
  img.dispose();
}

async function setSelection(doc, mask, w, h) {
  const img = await imaging.createImageDataFromBuffer(mask, {
    width: w, height: h, components: 1, chunky: false, colorSpace: "Grayscale", colorProfile: "Gray Gamma 2.2" });
  await imaging.putSelection({ documentID: doc.id, imageData: img });
  img.dispose();
}

async function selectLayer(layer) {
  await batch({ _obj: "select", _target: [{ _ref: "layer", _id: layer.id }], makeVisible: false, _options: NO_DIALOG });
}

async function deselect(doc) {
  try { await batch({ _obj: "set", _target: [{ _ref: "channel", _property: "selection" }], to: { _enum: "ordinal", _value: "none" }, _options: NO_DIALOG }); } catch (e) { /* none */ }
}

async function layerPixelsRGB(doc, layer, w, h) {
  const got = await imaging.getPixels({ documentID: doc.id, layerID: layer.id, componentSize: 8 });
  const data = await got.imageData.getData({ chunky: true });
  const comps = got.imageData.components, b = got.sourceBounds, gw = got.imageData.width;
  const out = new Uint8Array(w * h * 3);
  for (let y = 0; y < got.imageData.height; y++) {
    for (let x = 0; x < gw; x++) {
      const s = (y * gw + x) * comps, d = ((y + b.top) * w + (x + b.left)) * 3;
      out[d] = data[s]; out[d + 1] = data[s + 1]; out[d + 2] = data[s + 2];
    }
  }
  got.imageData.dispose();
  return out;
}

function psnr(a, b, mask) {
  let se = 0, n = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] <= 127) continue;
    for (let c = 0; c < 3; c++) { const d = (a[3 * i + c] - b[3 * i + c]) / 255; se += d * d; }
    n += 3;
  }
  if (!n) return null;
  return se === 0 ? 99 : +(10 * Math.log10(n / se)).toFixed(2);
}

// How visible the hole's outline is: mean colour jump across the hole border,
// relative to the image's ordinary neighbour-to-neighbour variation.
function seamScore(rgb, mask, w, h) {
  let border = 0, nb = 0, base = 0, nbase = 0;
  for (let y = 1; y < h; y++) {
    for (let x = 1; x < w; x++) {
      const i = y * w + x;
      for (const j of [i - 1, i - w]) {
        let d = 0;
        for (let c = 0; c < 3; c++) d += Math.abs(rgb[3 * i + c] - rgb[3 * j + c]);
        if ((mask[i] > 127) !== (mask[j] > 127)) { border += d; nb++; } else { base += d; nbase++; }
      }
    }
  }
  return nb && nbase ? +((border / nb) / Math.max(base / nbase, 1e-3)).toFixed(3) : null;
}

async function engineAvailable() {
  try {
    const r = await fetch(`${ENGINE}/health`);
    return r.ok ? await r.json() : null;
  } catch (e) {
    return null;
  }
}

async function engineInpaint(rgb, mask, w, h) {
  const body = new Uint8Array(w * h * 4);
  body.set(rgb, 0);
  body.set(mask, w * h * 3);
  const r = await fetch(`${ENGINE}/inpaint`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream", "X-Width": String(w), "X-Height": String(h), "X-Components": "3" },
    body: body.buffer,
  });
  if (!r.ok) throw new Error(`engine ${r.status}`);
  return { rgb: new Uint8Array(await r.arrayBuffer()), used: r.headers.get("X-Inpainter") };
}

// Candidate descriptors. Recorded ones (from step 1) always go first; the rest are
// the commonly scripted forms and are reported as such.
const SELECT_SUBJECT = () => [...recordedFor(["autoCutout"]),
  { label: "autoCutout", desc: { _obj: "autoCutout", sampleAllLayers: false } }];
const CONTENT_AWARE = () => [...recordedFor(["fill"]),
  { label: "fill contentAware + colour adaptation", desc: { _obj: "fill", using: { _enum: "fillContents", _value: "contentAware" },
    contentAwareColorAdaptationFill: true, opacity: { _unit: "percentUnit", _value: 100 }, mode: { _enum: "blendMode", _value: "normal" } } },
  { label: "fill contentAware", desc: { _obj: "fill", using: { _enum: "fillContents", _value: "contentAware" } } }];
const REMOVE_BACKGROUND = () => [...recordedFor(["removeBackground"]),
  { label: "removeBackground", desc: { _obj: "removeBackground" } }];
const MASK_ALL_OBJECTS = () => [...recordedFor(["autoMaskAllObjects", "maskAllObjects", "objectFinderMaskAll"])];

// ---------------------------------------------------------------- 0. environment

function environment() {
  const doc = app.activeDocument;
  const env = {
    photoshop: app.version,
    uxp: uxp.versions && uxp.versions.uxp,
    os: (() => { try { return require("os").platform() + " " + require("os").release(); } catch (e) { return null; } })(),
    api: {
      "imaging.getPixels": typeof imaging.getPixels, "imaging.putPixels": typeof imaging.putPixels,
      "imaging.getSelection": typeof imaging.getSelection, "imaging.putSelection": typeof imaging.putSelection,
      "imaging.getLayerMask": typeof imaging.getLayerMask, "imaging.putLayerMask": typeof imaging.putLayerMask,
      "action.addNotificationListener": typeof action.addNotificationListener,
      "core.executeAsModal": typeof core.executeAsModal,
      "app.createDocument": typeof app.createDocument,
      WebAssembly: typeof WebAssembly,
    },
  };
  if (doc) {
    env.api["Document.createPixelLayer"] = typeof doc.createPixelLayer;
    env.api["Document.createTextLayer"] = typeof doc.createTextLayer;
    env.api["Document.groupLayers"] = typeof doc.groupLayers;
    env.api["Document.duplicate"] = typeof doc.duplicate;
    try {
      const sel = doc.selection;
      env.api["Document.selection"] = sel ? Object.getOwnPropertyNames(Object.getPrototypeOf(sel)).filter((k) => k !== "constructor").join(",") : "none";
    } catch (e) { env.api["Document.selection"] = "error: " + e.message; }
  }
  return env;
}

// ---------------------------------------------------------------- 1. recorder

let recording = false;
function onEvent(event, descriptor) {
  report.recorded.push({ event, descriptor });
  log(`● recorded ${event}: ${summary(descriptor)}`);
}
async function toggleRecord(btn) {
  if (!recording) {
    try {
      await action.addNotificationListener(["all"], onEvent);
    } catch (e) {
      await action.addNotificationListener(["autoCutout", "fill", "removeBackground", "make", "set", "select",
        "autoMaskAllObjects", "maskAllObjects", "contentAwareFill"], onEvent);
    }
    recording = true;
    btn.textContent = "Stop recording";
    log("Recording… run Select › Subject, Edit › Fill › Content-Aware, Layer › Mask All Objects, then Stop.");
  } else {
    try { await action.removeNotificationListener(["all"], onEvent); } catch (e) { /* listener list form */ }
    recording = false;
    btn.textContent = "Record";
    const kinds = [...new Set(report.recorded.map((r) => r.event))];
    log(`Stopped. Captured: ${kinds.join(", ") || "nothing"}`);
  }
}

// ---------------------------------------------------------------- 2. real image checks

async function realChecks() {
  const src = app.activeDocument;
  if (!src) return log("Open an image first.");
  report.environment = environment();
  log(`Photoshop ${report.environment.photoshop}, UXP ${report.environment.uxp}`);
  const engine = await engineAvailable();
  log(engine ? `Engine reachable (${engine.inpainter}); will compare.` : "Engine not running; Photoshop-only checks.");

  let doc, w, h, rgb, subject = null;
  report.checks.push(await timed("duplicate document", () => modal("duplicate", async () => {
    doc = await src.duplicate(`Unflatten Probe – ${src.title || "image"}`);
    w = doc.width; h = doc.height;
    rgb = await compositeRGB(doc.id, w, h);
    resultDocs.push(doc);
    return { width: w, height: h, mode: String(doc.mode), bits: String(doc.bitsPerChannel) };
  })));
  if (!doc) return;

  // Select Subject: automatic? how long? does it separate people?
  report.checks.push(await timed("Select Subject (batchPlay autoCutout)", () => modal("select subject", async () => {
    await deselect(doc);
    const used = await tryDescriptors(SELECT_SUBJECT());
    const sel = await selectionMask(doc.id, w, h);
    if (!sel) return { ok: false, used: used.used, note: "no selection produced" };
    subject = sel.mask;
    const layer = await newLayerWithPixels(doc, "Probe · Select Subject", rgb, w, h);
    await putMaskOnLayer(doc, layer, subject, w, h);
    return { used: used.used, selection: sel.info, ...maskStats(subject, w, h) };
  })));

  // Remove Background quick action: same model as Select Subject or different?
  report.checks.push(await timed("Remove Background (batchPlay)", () => modal("remove background", async () => {
    await deselect(doc);
    const layer = await newLayerWithPixels(doc, "Probe · Remove Background", rgb, w, h);
    await selectLayer(layer);
    const used = await tryDescriptors(REMOVE_BACKGROUND());
    const m = await imaging.getLayerMask({ documentID: doc.id, layerID: layer.id });
    const data = await m.imageData.getData({ chunky: true });
    const full = new Uint8Array(w * h);
    const b = m.sourceBounds, mw = m.imageData.width;
    for (let y = 0; y < m.imageData.height; y++) for (let x = 0; x < mw; x++) full[(y + b.top) * w + x + b.left] = data[y * mw + x];
    m.imageData.dispose();
    return { used: used.used, ...maskStats(full, w, h) };
  })));

  // Mask All Objects: only with a recorded descriptor (no public form exists)
  report.checks.push(await timed("Mask All Objects (recorded descriptor)", () => modal("mask all objects", async () => {
    const cands = MASK_ALL_OBJECTS();
    if (!cands.length) return { ok: false, note: "not recorded: run Layer › Mask All Objects during step 1, then re-run" };
    await deselect(doc);
    const before = doc.layers.length;
    const used = await tryDescriptors(cands);
    const names = [];
    const walk = (ls) => ls.forEach((l) => { names.push(l.name); if (l.layers) walk(l.layers); });
    walk(doc.layers);
    return { used: used.used, topLevelLayersBefore: before, topLevelLayersAfter: doc.layers.length, names: names.slice(0, 40) };
  })));

  // Content-Aware Fill behind the subject: automatic, no dialog? how long?
  let hole = null;
  report.checks.push(await timed("Content-Aware Fill behind subject (batchPlay fill)", () => modal("content-aware fill", async () => {
    if (!subject) return { ok: false, note: "needs Select Subject" };
    hole = dilateMask(subject, w, h, Math.max(4, Math.round(0.008 * Math.max(w, h))));
    const layer = await newLayerWithPixels(doc, "Probe · Content-Aware Fill", rgb, w, h);
    await selectLayer(layer);
    await setSelection(doc, hole, w, h);
    const used = await tryDescriptors(CONTENT_AWARE());
    await deselect(doc);
    const out = await layerPixelsRGB(doc, layer, w, h);
    let changedIn = 0, changedOut = 0, nIn = 0;
    for (let i = 0; i < w * h; i++) {
      const diff = out[3 * i] !== rgb[3 * i] || out[3 * i + 1] !== rgb[3 * i + 1] || out[3 * i + 2] !== rgb[3 * i + 2];
      if (hole[i] > 127) { nIn++; if (diff) changedIn++; } else if (diff) changedOut++;
    }
    return { used: used.used, holeCoverage: +(nIn / (w * h)).toFixed(3), changedInsideHole: +(changedIn / Math.max(nIn, 1)).toFixed(3),
             changedOutsideHole: changedOut, seam: seamScore(out, hole, w, h) };
  })));

  // Same mask through the engine (LaMa), for a side-by-side look
  if (engine && hole) {
    let res;
    report.checks.push(await timed("Engine background on the same mask", async () => {
      res = await engineInpaint(rgb, hole, w, h);
      return { used: res.used, seam: seamScore(res.rgb, hole, w, h) };
    }));
    if (res) {
      await modal("engine layer", async () => {
        const layer = await newLayerWithPixels(doc, `Probe · Engine (${res.used})`, res.rgb, w, h);
        layer.visible = false;
      });
    }
  }

  // Text layer creation: second priority, check the API works at all
  report.checks.push(await timed("Create editable text layer (DOM)", () => modal("text layer", async () => {
    if (!doc.createTextLayer) return { ok: false, note: "Document.createTextLayer missing" };
    const t = await doc.createTextLayer({ name: "Probe · Text", contents: "Unflatten", fontSize: 24,
                                          position: { x: 20, y: 40 } });
    t.visible = false;
    return { created: !!t, kind: String(t.kind) };
  })));
  log("Done. Inspect the 'Unflatten Probe' document's layers, then Save (step 4).");
}

// ---------------------------------------------------------------- 3. accuracy (synthetic)

function prng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

// Backgrounds with known truth, plus a foreground silhouette whose hole we fill.
function makeScene(kind, w, h) {
  const rnd = prng(kind.length * 7919 + 17);
  const bg = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r, g, b;
      const n = (rnd() - 0.5) * 2;
      if (kind === "blue wall") {
        const t = y / h;
        r = 30 + 20 * t + 4 * n; g = 100 + 25 * t + 4 * n; b = 140 + 20 * t + 4 * n;
      } else if (kind === "brick wall") {
        const row = Math.floor(y / 36), off = row % 2 ? 45 : 0;
        const mortar = y % 36 < 4 || (x + off) % 90 < 4;
        const tone = 0.85 + 0.15 * Math.sin(row * 12.9898 + Math.floor((x + off) / 90) * 78.233);
        r = mortar ? 200 : 170 * tone; g = mortar ? 195 : 90 * tone; b = mortar ? 185 : 70 * tone;
        r += 10 * n; g += 8 * n; b += 8 * n;
      } else { // textured paper / cloth
        const weave = 6 * Math.sin(x * 1.3) * Math.sin(y * 1.1);
        r = 205 + weave + 7 * n; g = 195 + weave + 7 * n; b = 175 + weave + 7 * n;
      }
      const i = 3 * (y * w + x);
      bg[i] = Math.max(0, Math.min(255, r)); bg[i + 1] = Math.max(0, Math.min(255, g)); bg[i + 2] = Math.max(0, Math.min(255, b));
    }
  }
  return bg;
}

function silhouette(w, h, scale) {
  // head + body, anti-aliased by 4x supersampling
  const m = new Uint8Array(w * h);
  const cx = w / 2, hy = h * (0.5 - 0.28 * scale), hr = h * 0.09 * scale;
  const bx = w * 0.17 * scale, by = h * 0.3 * scale, bcy = h * (0.5 + 0.12 * scale);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let c = 0;
      for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
        const px = x + (sx + 0.5) / 4, py = y + (sy + 0.5) / 4;
        const head = (px - cx) ** 2 + (py - hy) ** 2 < hr * hr;
        const body = ((px - cx) / bx) ** 2 + ((py - bcy) / by) ** 2 < 1;
        if (head || body) c++;
      }
      m[y * w + x] = Math.round((c / 16) * 255);
    }
  }
  return m;
}

async function accuracyTest() {
  report.environment = report.environment || environment();
  const engine = await engineAvailable();
  log(engine ? "Engine reachable; scoring both." : "Engine not running; scoring Photoshop only.");
  const w = 900, h = 600;
  const cases = [["blue wall", 1.0], ["brick wall", 1.0], ["paper", 1.0], ["brick wall", 2.1]];
  for (const [kind, scale] of cases) {
    const label = `${kind}${scale > 1.5 ? ", large hole" : ""}`;
    const bg = makeScene(kind, w, h);
    const sil = silhouette(w, h, scale);
    const comp = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) {
      const a = sil[i] / 255;
      comp[3 * i] = Math.round(25 * a + bg[3 * i] * (1 - a));
      comp[3 * i + 1] = Math.round(30 * a + bg[3 * i + 1] * (1 - a));
      comp[3 * i + 2] = Math.round(45 * a + bg[3 * i + 2] * (1 - a));
    }
    const hole = dilateMask(sil, w, h, 5);
    let holeFrac = 0;
    for (let i = 0; i < w * h; i++) if (hole[i] > 127) holeFrac++;
    holeFrac /= w * h;
    const row = { scene: label, hole: +holeFrac.toFixed(3) };

    let doc;
    const fillRun = await timed(`Content-Aware Fill · ${label}`, () => modal("accuracy", async () => {
      doc = await app.createDocument({ name: `Unflatten Probe – ${label}`, width: w, height: h, resolution: 72,
        mode: (constants.NewDocumentMode && constants.NewDocumentMode.RGB) || "RGBColorMode",
        fill: (constants.DocumentFill && constants.DocumentFill.WHITE) || "white" });
      resultDocs.push(doc);
      const truth = await newLayerWithPixels(doc, "Truth · background", bg, w, h);
      truth.visible = false;
      await newLayerWithPixels(doc, "Scene", comp, w, h);
      const layer = await newLayerWithPixels(doc, "Photoshop · Content-Aware Fill", comp, w, h);
      await selectLayer(layer);
      await setSelection(doc, hole, w, h);
      const used = await tryDescriptors(CONTENT_AWARE());
      await deselect(doc);
      const out = await layerPixelsRGB(doc, layer, w, h);
      return { used: used.used, psnr: psnr(out, bg, hole), seam: seamScore(out, hole, w, h) };
    }));
    row.photoshop = fillRun.ok ? { ms: fillRun.ms, ...fillRun.detail } : { error: fillRun.error };

    if (engine) {
      const en = await timed(`Engine · ${label}`, async () => {
        const res = await engineInpaint(comp, hole, w, h);
        if (doc) await modal("engine layer", async () => {
          const l = await newLayerWithPixels(doc, `Engine · ${res.used}`, res.rgb, w, h);
          l.visible = false;
        });
        return { used: res.used, psnr: psnr(res.rgb, bg, hole), seam: seamScore(res.rgb, hole, w, h) };
      });
      row.engine = en.ok ? { ms: en.ms, ...en.detail } : { error: en.error };
    }
    report.accuracy.push(row);
  }
  log("\nScene                      hole   Photoshop dB/seam/ms        Engine dB/seam/ms");
  for (const r of report.accuracy) {
    const p = r.photoshop && r.photoshop.psnr != null ? `${r.photoshop.psnr} / ${r.photoshop.seam} / ${r.photoshop.ms}` : "failed";
    const e = r.engine ? (r.engine.psnr != null ? `${r.engine.psnr} / ${r.engine.seam} / ${r.engine.ms}` : "failed") : "–";
    log(`${r.scene.padEnd(26)} ${String(r.hole).padEnd(6)} ${p.padEnd(27)} ${e}`);
  }
  log("Higher dB = closer to the true background. Seam ≈ 1 means the hole's outline is invisible.");
}

// ---------------------------------------------------------------- 4. save

async function save() {
  const fs = uxp.storage.localFileSystem;
  const folder = await fs.getFolder();
  if (!folder) return;
  report.finished = new Date().toISOString();
  const file = await folder.createFile("unflatten-probe-report.json", { overwrite: true });
  await file.write(JSON.stringify(report, null, 2));
  log(`Saved ${file.name}`);
  for (const doc of resultDocs) {
    await timed(`save ${doc.title}`, () => modal("save", async () => {
      const name = (doc.title || "probe").replace(/[^\w\- ]+/g, "_") + ".psd";
      const f = await folder.createFile(name, { overwrite: true });
      await doc.saveAs.psd(f, {}, true);
      return { file: name };
    }));
  }
}

// ---------------------------------------------------------------- 5. WebAssembly

async function wasmCheck() {
  // (module (func (export "add") (param i32 i32) (result i32) local.get 0 local.get 1 i32.add))
  const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 7, 1, 96, 2, 127, 127, 1, 127, 3, 2, 1, 0, 7, 7, 1, 3, 97, 100, 100, 0, 0,
    10, 9, 1, 7, 0, 32, 0, 32, 1, 106, 11]);
  report.wasm = await timed("WebAssembly instantiate + call", async () => {
    if (typeof WebAssembly === "undefined") return { ok: false, note: "WebAssembly not defined" };
    const { instance } = await WebAssembly.instantiate(bytes);
    const r = instance.exports.add(2, 3);
    return { ok: r === 5, result: r, simd: typeof WebAssembly.validate === "function" };
  });
}

// ---------------------------------------------------------------- wiring

function guard(fn) {
  return async (ev) => {
    const btn = ev && ev.target;
    if (btn) btn.disabled = true;
    try { await fn(btn); } catch (e) { log("✗ " + ((e && e.message) || e)); } finally { if (btn) btn.disabled = false; }
  };
}

document.getElementById("record").addEventListener("click", (ev) => toggleRecord(ev.target).catch((e) => log("✗ " + e.message)));
document.getElementById("real").addEventListener("click", guard(realChecks));
document.getElementById("synthetic").addEventListener("click", guard(accuracyTest));
document.getElementById("save").addEventListener("click", guard(save));
document.getElementById("wasm").addEventListener("click", guard(wasmCheck));

if (typeof module !== "undefined") {
  module.exports = { realChecks, accuracyTest, wasmCheck, toggleRecord, report, makeScene, silhouette, psnr, seamScore, maskStats };
}
