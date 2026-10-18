// Unflatten Probe: measures, inside a real Photoshop, which native operations a
// plugin can drive automatically, how fast they are and how good their results
// are, so the Unflatten architecture is chosen from measurements.
//
// One button runs everything that is safe. The probe opens its own bundled test
// images (and builds test scenes with a known true background), never touches
// the user's documents, closes what it opened, and writes its results to a
// folder on the Desktop after every single test, so even an interrupted run
// leaves usable data. The WebAssembly test is separate and never runs on its own.
const ps = require("photoshop");
const { app, core, action, imaging, constants } = ps;
const uxp = require("uxp");

const PROBE_VERSION = "0.3.0";
const ENGINE = "http://127.0.0.1:7865"; // optional; only used if a developer runs it
const NO_DIALOG = { dialogOptions: "dontDisplay" };
const RESULTS_NAME = "Unflatten Probe Results";

const report = { probe: PROBE_VERSION, started: new Date().toISOString(), environment: null,
                 resultsFolder: null, recorded: [], images: [], accuracy: [], wasm: null, notes: [] };
let resultsFolder = null;
let busy = false;

const $ = (id) => document.getElementById(id);
function log(line) {
  const el = $("log");
  el.textContent += line + "\n";
  el.scrollTop = el.scrollHeight;
}
function status(text) { $("status").textContent = text; }

// ---------------------------------------------------------------- utilities

function summary(d) {
  if (!d) return "";
  const s = JSON.stringify(d);
  return s.length > 140 ? s.slice(0, 137) + "…" : s;
}

async function timed(name, fn) {
  const t = Date.now();
  const entry = { name, ok: false, ms: 0 };
  try {
    const detail = await fn();
    entry.ok = !(detail && detail.ok === false);
    entry.detail = detail;
  } catch (e) {
    entry.error = String((e && e.message) || e);
  }
  entry.ms = Date.now() - t;
  log(`${entry.ok ? "✓" : "✗"} ${name}  ${(entry.ms / 1000).toFixed(1)} s  ${entry.error || summary(entry.detail)}`);
  return entry;
}

function modal(name, fn) {
  return core.executeAsModal(fn, { commandName: `Unflatten Probe: ${name}` });
}

async function batch(desc) {
  return action.batchPlay([desc], {});
}

async function tryDescriptors(candidates) {
  const errors = [];
  for (const c of candidates) {
    try {
      const res = await batch({ ...c.desc, _options: NO_DIALOG });
      const err = res && res[0] && res[0]._obj === "error" ? res[0].message || "error" : null;
      if (!err) return { used: c.label };
      errors.push(`${c.label}: ${err}`);
    } catch (e) {
      errors.push(`${c.label}: ${(e && e.message) || e}`);
    }
  }
  throw new Error(errors.join(" | ") || "no candidates");
}

function recordedFor(events) {
  return report.recorded.filter((r) => events.includes(r.event)).map((r, i) => {
    const d = JSON.parse(JSON.stringify(r.descriptor || {}));
    delete d._isCommand;
    d._obj = d._obj || r.event;
    return { label: `recorded ${r.event} #${i + 1}`, desc: d };
  });
}

// Recorded descriptors (optional step) first, then the commonly scripted forms.
const SELECT_SUBJECT = () => [...recordedFor(["autoCutout"]),
  { label: "autoCutout", desc: { _obj: "autoCutout", sampleAllLayers: false } }];
const CONTENT_AWARE = () => [...recordedFor(["fill"]),
  { label: "fill contentAware + colour adaptation", desc: { _obj: "fill", using: { _enum: "fillContents", _value: "contentAware" },
    contentAwareColorAdaptationFill: true, opacity: { _unit: "percentUnit", _value: 100 }, mode: { _enum: "blendMode", _value: "normal" } } },
  { label: "fill contentAware", desc: { _obj: "fill", using: { _enum: "fillContents", _value: "contentAware" } } }];
const REMOVE_BACKGROUND = () => [...recordedFor(["removeBackground"]),
  { label: "removeBackground", desc: { _obj: "removeBackground" } }];
// Mask All Objects has no published command name, and a wrong guess makes
// Photoshop show a "not currently available" alert that stops the run, so it
// is only replayed once it has been recorded.
// Photoshop 27.1 reports Layer › Mask All Objects as "autoMaskGenerate". Only
// these names are replayed: a recording also catches general notices such as
// "invokeCommand" (a menu click), and replaying one of those raises the alert.
const MASK_ALL_EVENTS = ["autoMaskGenerate", "autoMaskAllObjects", "maskAllObjects", "objectFinderMaskAll"];
const MASK_ALL_OBJECTS = () => {
  const out = [];
  for (const c of recordedFor(MASK_ALL_EVENTS)) {
    // first without references to the document it was recorded on, so it acts
    // on the probe's own document; then exactly as recorded
    const bare = JSON.parse(JSON.stringify(c.desc));
    for (const k of ["_target", "documentID", "layerID", "documentId", "layerId"]) delete bare[k];
    if (JSON.stringify(bare) !== JSON.stringify(c.desc)) out.push({ label: `${c.label} (no target)`, desc: bare });
    out.push(c);
  }
  // as recorded in Photoshop 27.1, so no recording is needed there
  out.push({ label: "autoMaskGenerate (recorded in 27.1)", desc: { _obj: "autoMaskGenerate", sampleAllLayers: false, hardEdge: true } });
  return out;
};

// ---------------------------------------------------------------- pixels and masks

function profileOf(doc) { try { return doc.colorProfileName; } catch (e) { return null; } }

// Writing pixels needs an 8-bit RGB document whose colour profile Photoshop's
// imaging API knows. Images in the wild are often grayscale, untagged ("None")
// or carry an embedded profile with an odd name ("c2"); the first run failed on
// those. Assigning a profile keeps every pixel value, so it is used for those;
// grayscale is tagged Gray Gamma 2.2 (sRGB's tone curve) before going to RGB so
// the values change as little as possible. Returns what was done.
async function normalize(doc) {
  const done = [];
  if (!String(doc.mode).toLowerCase().includes("rgb")) {
    if (String(doc.mode).toLowerCase().includes("gray")) {
      await assignProfile(doc, "Gray Gamma 2.2").then(() => done.push("tagged Gray Gamma 2.2"), () => {});
    }
    await doc.changeMode(constants.ChangeMode.RGB);
    done.push("converted to RGB");
  }
  if (String(doc.bitsPerChannel) !== "bitDepth8" && constants.BitsPerChannelType) {
    try { doc.bitsPerChannel = constants.BitsPerChannelType.EIGHT; done.push("converted to 8 bit"); } catch (e) { /* keep */ }
  }
  const was = profileOf(doc);
  if (!(await profileUsable(was))) {
    await assignProfile(doc, "sRGB IEC61966-2.1");
    done.push(`assigned sRGB in place of ${was}`);
  }
  return done;
}

async function profileUsable(name) {
  if (!name || name === "None") return false;
  try {
    const img = await imaging.createImageDataFromBuffer(new Uint8Array(4),
      { width: 1, height: 1, components: 4, chunky: true, colorSpace: "RGB", colorProfile: name });
    img.dispose();
    return true;
  } catch (e) { return false; }
}

async function assignProfile(doc, name) {
  try { doc.colorProfileName = name; if (profileOf(doc) === name) return; } catch (e) { /* use the command */ }
  await batch({ _obj: "assignProfile", _target: [{ _ref: "document", _enum: "ordinal", _value: "targetEnum" }],
    profile: name, _options: NO_DIALOG });
}

async function compositeRGB(docId, w, h) {
  const got = await imaging.getPixels({ documentID: docId, componentSize: 8, applyAlpha: true });
  const out = await toCanvasRGB(got, w, h);
  return out;
}

async function toCanvasRGB(got, w, h) {
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

async function toCanvasMask(got, w, h) {
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
  got.imageData.dispose();
  return out;
}

async function selectionMask(docId, w, h) {
  let got;
  try { got = await imaging.getSelection({ documentID: docId }); } catch (e) { return null; }
  if (!got || !got.imageData) return null;
  return toCanvasMask(got, w, h);
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
  return { coverage: +(on / (w * h)).toFixed(4), bbox: on ? [x0, y0, x1 + 1, y1 + 1] : null, pieces: pieces(mask, w, h) };
}

// Separate pieces in a selection: on a group photo, Select Subject returns one
// selection, and its pieces show whether people could be told apart from it.
function pieces(mask, w, h) {
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
  const total = sizes.reduce((a, b) => a + b, 0) || 1;
  return { count: sizes.length, significant: sizes.filter((n) => n > 0.02 * total).length };
}

function dilateMask(mask, w, h, r) {
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

async function newLayerWithPixels(doc, name, rgb, w, h, transparent) {
  const layer = doc.createPixelLayer ? await doc.createPixelLayer({ name }) : await doc.createLayer({ name });
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    rgba[4 * i] = rgb[3 * i]; rgba[4 * i + 1] = rgb[3 * i + 1]; rgba[4 * i + 2] = rgb[3 * i + 2];
    rgba[4 * i + 3] = transparent && transparent[i] > 127 ? 0 : 255;
  }
  const opts = { width: w, height: h, components: 4, chunky: true, colorSpace: "RGB" };
  try { if (doc.colorProfileName) opts.colorProfile = doc.colorProfileName; } catch (e) { /* untagged */ }
  const img = await imaging.createImageDataFromBuffer(rgba, opts);
  await imaging.putPixels({ documentID: doc.id, layerID: layer.id, imageData: img });
  img.dispose();
  return layer;
}

async function grayImage(mask, w, h) {
  return imaging.createImageDataFromBuffer(mask, {
    width: w, height: h, components: 1, chunky: false, colorSpace: "Grayscale", colorProfile: "Gray Gamma 2.2" });
}

async function setSelection(doc, mask, w, h) {
  const img = await grayImage(mask, w, h);
  await imaging.putSelection({ documentID: doc.id, imageData: img });
  img.dispose();
}

async function selectLayer(layer) {
  await batch({ _obj: "select", _target: [{ _ref: "layer", _id: layer.id }], makeVisible: false, _options: NO_DIALOG });
}

async function deselect() {
  try {
    await batch({ _obj: "set", _target: [{ _ref: "channel", _property: "selection" }],
                  to: { _enum: "ordinal", _value: "none" }, _options: NO_DIALOG });
  } catch (e) { /* nothing selected */ }
}

async function layerRGB(doc, layer, w, h) {
  return toCanvasRGB(await imaging.getPixels({ documentID: doc.id, layerID: layer.id, componentSize: 8 }), w, h);
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

// How visible a filled hole's outline is: colour jump across the hole border
// relative to ordinary neighbour-to-neighbour variation (≈ 1: invisible).
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

// ---------------------------------------------------------------- results on disk

// Compact files: masks run-length encoded, fills cropped to the filled area.
function rle(mask) {
  const out = [];
  let i = 0;
  while (i < mask.length) {
    const v = mask[i];
    let n = 1;
    while (i + n < mask.length && mask[i + n] === v && n < 0xffffffff) n++;
    out.push(v, n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255);
    i += n;
  }
  return new Uint8Array(out);
}

function cropRGB(rgb, w, bbox) {
  const [x0, y0, x1, y1] = bbox;
  const cw = x1 - x0, ch = y1 - y0;
  const out = new Uint8Array(cw * ch * 3);
  for (let y = 0; y < ch; y++) out.set(rgb.subarray(((y + y0) * w + x0) * 3, ((y + y0) * w + x1) * 3), y * cw * 3);
  return out;
}

async function openResultsFolder() {
  if (resultsFolder) return resultsFolder;
  const fs = uxp.storage.localFileSystem;
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const name = `${RESULTS_NAME} ${stamp}`;
  // 1. Desktop, where it is easy to find
  try {
    const os = require("os");
    const home = os.homedir();
    const sep = home.includes("\\") ? "\\" : "/";
    const desktopPath = `${home}${sep}Desktop`;
    const url = "file:" + (desktopPath.startsWith("/") ? "" : "/") + desktopPath.replace(/\\/g, "/");
    const desktop = await fs.getEntryWithUrl(url);
    resultsFolder = await desktop.createFolder(name);
  } catch (e) {
    report.notes.push(`Desktop not writable (${e.message})`);
    // 2. ask once where to put the results
    let picked = null;
    try { picked = await fs.getFolder(); } catch (e2) { /* cancelled */ }
    // 3. the plugin's own data folder (its path is shown in the panel)
    resultsFolder = await (picked || await fs.getDataFolder()).createFolder(name);
  }
  report.resultsFolder = resultsFolder.nativePath;
  return resultsFolder;
}

async function writeFile(name, bytes) {
  const folder = await openResultsFolder();
  const f = await folder.createFile(name, { overwrite: true });
  await f.write(bytes.buffer ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : bytes,
                { format: uxp.storage.formats.binary });
  return name;
}

async function saveReport() {
  report.updated = new Date().toISOString();
  const folder = await openResultsFolder();
  const f = await folder.createFile("unflatten-probe-report.json", { overwrite: true });
  await f.write(JSON.stringify(report, null, 2));
}

// ---------------------------------------------------------------- environment

function environment() {
  let os = null;
  try { const o = require("os"); os = `${o.platform()} ${o.release()} ${o.arch ? o.arch() : ""}`.trim(); } catch (e) { /* n/a */ }
  return {
    photoshop: app.version || (uxp.host && uxp.host.version) || null, uxp: uxp.versions && uxp.versions.uxp, os,
    api: {
      "imaging.getSelection": typeof imaging.getSelection, "imaging.putSelection": typeof imaging.putSelection,
      "imaging.getLayerMask": typeof imaging.getLayerMask, "imaging.putLayerMask": typeof imaging.putLayerMask,
      "app.open": typeof app.open, "app.createDocument": typeof app.createDocument,
      "action.addNotificationListener": typeof action.addNotificationListener,
      WebAssembly: typeof WebAssembly,
    },
  };
}

// ---------------------------------------------------------------- test images

async function loadManifest() {
  const fs = uxp.storage.localFileSystem;
  const plugin = await fs.getPluginFolder();
  const folder = await plugin.getEntry("testimages");
  const manifest = JSON.parse(await (await folder.getEntry("images.json")).read());
  return { folder, images: manifest.images };
}

async function imageEntry(folder, img) {
  if (img.file) return folder.getEntry(img.file);
  // not redistributed with the probe: fetched once, cached in the plugin's data folder
  const data = await uxp.storage.localFileSystem.getDataFolder();
  const name = `${img.id}.jpg`;
  try { return await data.getEntry(name); } catch (e) { /* not cached yet */ }
  const r = await fetch(img.url);
  if (!r.ok) throw new Error(`download ${r.status}`);
  const f = await data.createFile(name, { overwrite: true });
  await f.write(await r.arrayBuffer(), { format: uxp.storage.formats.binary });
  return f;
}

// ---------------------------------------------------------------- checks on one image

async function checkImage(entry, meta) {
  const row = { id: meta.id, case: meta.case, expected: { people: meta.people, cap: meta.cap }, checks: [] };
  report.images.push(row);
  let doc, w, h, rgb, subject = null;
  const objectMasks = [];

  row.checks.push(await timed(`${meta.id}: open`, () => modal("open", async () => {
    doc = await app.open(entry);
    w = doc.width; h = doc.height;
    const opened = { mode: String(doc.mode), bits: String(doc.bitsPerChannel), profile: profileOf(doc) };
    const normalized = await normalize(doc);
    rgb = await compositeRGB(doc.id, w, h);
    // thumbnail lets the comparison confirm it decoded the same pixels Photoshop saw
    const thumb = await imaging.getPixels({ documentID: doc.id, componentSize: 8, applyAlpha: true, targetSize: { width: 256 } });
    const t = thumb.imageData;
    const tw = t.width, th = t.height, tc = t.components;
    const tdata = await t.getData({ chunky: true });
    const trgb = new Uint8Array(tw * th * 3);
    for (let i = 0; i < tw * th; i++) trgb.set(tdata.subarray(i * tc, i * tc + 3), i * 3);
    t.dispose();
    await writeFile(`${meta.id}_thumb_${tw}x${th}.rgb`, trgb);
    return { width: w, height: h, ...opened, normalized, profileNow: profileOf(doc) };
  })));
  if (!doc) { await saveReport(); return; }
  row.size = [w, h];

  try {
    // Select Subject: does it run unattended, how long, does it keep accessories,
    // does it separate people?
    row.checks.push(await timed(`${meta.id}: Select Subject`, () => modal("select subject", async () => {
      await deselect();
      const used = await tryDescriptors(SELECT_SUBJECT());
      const m = await selectionMask(doc.id, w, h);
      if (!m) return { ok: false, used: used.used, note: "ran, but produced no selection" };
      subject = m;
      await writeFile(`${meta.id}_select_subject.rle`, rle(m));
      return { used: used.used, ...maskStats(m, w, h) };
    })));
    await saveReport();

    // Remove Background quick action: a different model than Select Subject?
    row.checks.push(await timed(`${meta.id}: Remove Background`, () => modal("remove background", async () => {
      await deselect();
      const layer = await newLayerWithPixels(doc, "Probe · Remove Background", rgb, w, h);
      await selectLayer(layer);
      const used = await tryDescriptors(REMOVE_BACKGROUND());
      const m = await toCanvasMask(await imaging.getLayerMask({ documentID: doc.id, layerID: layer.id }), w, h);
      await writeFile(`${meta.id}_remove_background.rle`, rle(m));
      return { used: used.used, ...maskStats(m, w, h) };
    })));
    await saveReport();

    // Mask All Objects: per-object masks would tell people apart natively
    row.checks.push(await timed(`${meta.id}: Mask All Objects`, () => modal("mask all objects", async () => {
      const candidates = MASK_ALL_OBJECTS();
      await deselect();
      const before = new Set();
      const walk = (ls, f) => ls.forEach((l) => { f(l); if (l.layers) walk(l.layers, f); });
      walk(doc.layers, (l) => before.add(l.id));
      const used = await tryDescriptors(candidates);
      const created = [];
      walk(doc.layers, (l) => { if (!before.has(l.id)) created.push(l); });
      const masks = [];
      for (const l of created.slice(0, 40)) {
        try {
          const m = await toCanvasMask(await imaging.getLayerMask({ documentID: doc.id, layerID: l.id }), w, h);
          const file = await writeFile(`${meta.id}_object_${masks.length}.rle`, rle(m));
          objectMasks.push(m);
          masks.push({ name: l.name, file, ...maskStats(m, w, h) });
        } catch (e) { masks.push({ name: l.name, error: e.message }); }
      }
      return { used: used.used, created: created.length, objects: masks };
    })));
    await saveReport();

    // Content-Aware Fill behind the subject: unattended? anything outside changed?
    row.checks.push(await timed(`${meta.id}: Content-Aware Fill behind subject`, () => modal("content-aware fill", async () => {
      if (!subject) return { ok: false, note: "skipped: needs Select Subject" };
      const hole = dilateMask(subject, w, h, Math.max(4, Math.round(0.008 * Math.max(w, h))));
      // Photoshop 27.1 stops with "not enough source pixels" (an alert, even with
      // dialogs off) when the hole is nearly the whole image; measured at 97%.
      const holeCoverage = maskStats(hole, w, h).coverage;
      if (holeCoverage > 0.85) return { ok: false, note: `skipped: hole covers ${Math.round(holeCoverage * 100)}% of the image` };
      const layer = await newLayerWithPixels(doc, "Probe · Content-Aware Fill", rgb, w, h);
      await selectLayer(layer);
      await setSelection(doc, hole, w, h);
      const used = await tryDescriptors(CONTENT_AWARE());
      await deselect();
      const out = await layerRGB(doc, layer, w, h);
      let changedIn = 0, changedOut = 0, nIn = 0;
      let x0 = w, y0 = h, x1 = 0, y1 = 0;
      for (let i = 0; i < w * h; i++) {
        const diff = out[3 * i] !== rgb[3 * i] || out[3 * i + 1] !== rgb[3 * i + 1] || out[3 * i + 2] !== rgb[3 * i + 2];
        if (hole[i] > 127) {
          nIn++; if (diff) changedIn++;
          const x = i % w, y = (i / w) | 0;
          if (x < x0) x0 = x; if (x >= x1) x1 = x + 1; if (y < y0) y0 = y; if (y >= y1) y1 = y + 1;
        } else if (diff) changedOut++;
      }
      const bbox = nIn ? [x0, y0, x1, y1] : [0, 0, w, h];
      await writeFile(`${meta.id}_caf_hole.rle`, rle(hole));
      const file = await writeFile(`${meta.id}_caf_${bbox.join("_")}.rgb`, cropRGB(out, w, bbox));
      return { used: used.used, file, bbox, holeCoverage: +(nIn / (w * h)).toFixed(3),
               changedInsideHole: +(changedIn / Math.max(nIn, 1)).toFixed(3), changedOutsideHole: changedOut,
               seam: seamScore(out, hole, w, h) };
    })));
    await saveReport();

    // Large holes: the same background rebuilt with different fill strategies
    if (subject) {
      row.fills = await fillStrategies(doc, rgb, w, h, subject, objectMasks, meta.id);
      await saveReport();
    }

    // Editable text layer: priority 2, does the API work at all
    if (meta.id === report.images[0].id) {
      row.checks.push(await timed(`${meta.id}: create editable text layer`, () => modal("text layer", async () => {
        if (!doc.createTextLayer) return { ok: false, note: "Document.createTextLayer missing" };
        const t = await doc.createTextLayer({ name: "Probe · Text", contents: "Unflatten", fontSize: 24, position: { x: 20, y: 40 } });
        return { created: !!t, kind: String(t && t.kind) };
      })));
    }
  } finally {
    await modal("close", async () => { try { await doc.closeWithoutSaving(); } catch (e) { /* already closed */ } });
    await saveReport();
  }
}

// ---------------------------------------------------------------- known-truth background scenes

function prng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

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
      } else {
        const weave = 6 * Math.sin(x * 1.3) * Math.sin(y * 1.1);
        r = 205 + weave + 7 * n; g = 195 + weave + 7 * n; b = 175 + weave + 7 * n;
      }
      const i = 3 * (y * w + x);
      bg[i] = Math.max(0, Math.min(255, r)); bg[i + 1] = Math.max(0, Math.min(255, g)); bg[i + 2] = Math.max(0, Math.min(255, b));
    }
  }
  return bg;
}

function silhouette(w, h, scale, cxFrac = 0.5) {
  const m = new Uint8Array(w * h);
  const cx = w * cxFrac, hy = h * (0.5 - 0.28 * scale), hr = h * 0.09 * scale;
  const bx = w * 0.17 * scale, by = h * 0.3 * scale, bcy = h * (0.5 + 0.12 * scale);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let c = 0;
      for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
        const px = x + (sx + 0.5) / 4, py = y + (sy + 0.5) / 4;
        if ((px - cx) ** 2 + (py - hy) ** 2 < hr * hr || ((px - cx) / bx) ** 2 + ((py - bcy) / by) ** 2 < 1) c++;
      }
      m[y * w + x] = Math.round((c / 16) * 255);
    }
  }
  return m;
}

// [background, figure scale, figures across]; the last two are the large holes
const SCENES = [["blue wall", 1.0], ["brick wall", 1.0], ["paper", 1.0], ["brick wall", 2.1], ["brick wall", 0.85, 3]];

function buildScene(kind, scale, w, h, figures = 1) {
  const bg = makeScene(kind, w, h);
  const objects = [];
  for (let f = 0; f < figures; f++) objects.push(silhouette(w, h, scale, figures === 1 ? 0.5 : 0.2 + (0.6 * f) / (figures - 1)));
  const sil = new Uint8Array(w * h);
  for (const o of objects) for (let i = 0; i < w * h; i++) if (o[i] > sil[i]) sil[i] = o[i];
  const comp = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    const a = sil[i] / 255;
    comp[3 * i] = Math.round(25 * a + bg[3 * i] * (1 - a));
    comp[3 * i + 1] = Math.round(30 * a + bg[3 * i + 1] * (1 - a));
    comp[3 * i + 2] = Math.round(45 * a + bg[3 * i + 2] * (1 - a));
  }
  return { bg, comp, hole: dilateMask(sil, w, h, 5), objects };
}

async function sceneTest(kind, scale, index, figures = 1) {
  const w = 900, h = 600;
  const label = `${kind}${figures > 1 ? `, ${figures} figures` : scale > 1.5 ? ", large hole" : ""}`;
  const { bg, comp, hole, objects } = buildScene(kind, scale, w, h, figures);
  let holeFrac = 0;
  for (let i = 0; i < w * h; i++) if (hole[i] > 127) holeFrac++;
  const row = { scene: label, index, hole: +(holeFrac / (w * h)).toFixed(3) };
  let doc;
  const run = await timed(`Content-Aware Fill, known background: ${label}`, () => modal("accuracy", async () => {
    doc = await app.createDocument({ name: `Unflatten Probe – ${label}`, width: w, height: h, resolution: 72,
      mode: (constants.NewDocumentMode && constants.NewDocumentMode.RGB) || "RGBColorMode",
      fill: (constants.DocumentFill && constants.DocumentFill.WHITE) || "white" });
    const layer = await newLayerWithPixels(doc, "Scene", comp, w, h);
    await selectLayer(layer);
    await setSelection(doc, hole, w, h);
    const used = await tryDescriptors(CONTENT_AWARE());
    await deselect();
    const out = await layerRGB(doc, layer, w, h);
    await writeFile(`scene${index}_caf.rgb`, out);
    return { used: used.used, psnr: psnr(out, bg, hole), seam: seamScore(out, hole, w, h) };
  }));
  if (doc && (figures > 1 || scale > 1.5)) row.fills = await fillStrategies(doc, comp, w, h, hole, objects, `scene${index}`, bg);
  if (doc) await modal("close", async () => { try { await doc.closeWithoutSaving(); } catch (e) { /* closed */ } });
  row.photoshop = run.ok ? { ms: run.ms, ...run.detail } : { error: run.error };

  // optional: a developer running the engine locally gets the same scene scored by it
  const engine = await engineAvailable();
  if (engine) {
    const en = await timed(`Engine, known background: ${label}`, async () => {
      const res = await engineInpaint(comp, hole, w, h);
      return { used: res.used, psnr: psnr(res.rgb, bg, hole), seam: seamScore(res.rgb, hole, w, h) };
    });
    row.engine = en.ok ? { ms: en.ms, ...en.detail } : { error: en.error };
  }
  report.accuracy.push(row);
  await saveReport();
}

async function engineAvailable() {
  try { const r = await fetch(`${ENGINE}/health`); return r.ok ? await r.json() : null; } catch (e) { return null; }
}

async function engineInpaint(rgb, mask, w, h) {
  const body = new Uint8Array(w * h * 4);
  body.set(rgb, 0);
  body.set(mask, w * h * 3);
  const r = await fetch(`${ENGINE}/inpaint`, { method: "POST",
    headers: { "Content-Type": "application/octet-stream", "X-Width": String(w), "X-Height": String(h), "X-Components": "3" },
    body: body.buffer });
  if (!r.ok) throw new Error(`engine ${r.status}`);
  return { rgb: new Uint8Array(await r.arrayBuffer()), used: r.headers.get("X-Inpainter") };
}


// ---------------------------------------------------------------- large holes: fill strategies

// Content-Aware Fill on one big hole clones recognisable pieces (flags, the
// pattern of the people removed). These strategies rebuild the same hole in
// different ways; each runs on its own layer and is saved for comparison.
//   all at once              the whole hole in one fill (what run 1 measured)
//   all at once, cleared     the hole's pixels deleted first, so nothing of the
//                            removed subjects can be sampled
//   one object at a time     cleared; each object's area filled separately,
//                            smallest first, then whatever is left
//   rings from the edge      cleared; filled in bands from the hole's edge
//                            inward, so each fill only continues what is next to it
const STRATEGIES = ["all at once", "all at once, cleared", "one object at a time", "rings from the edge"];

function andNot(a, b) { const o = new Uint8Array(a.length); for (let i = 0; i < a.length; i++) o[i] = a[i] > 127 && !(b[i] > 127) ? 255 : 0; return o; }
function and(a, b) { const o = new Uint8Array(a.length); for (let i = 0; i < a.length; i++) o[i] = a[i] > 127 && b[i] > 127 ? 255 : 0; return o; }
function orInto(a, b) { for (let i = 0; i < a.length; i++) if (b[i] > 127) a[i] = 255; return a; }
function count(m) { let n = 0; for (let i = 0; i < m.length; i++) if (m[i] > 127) n++; return n; }
function invert(m) { const o = new Uint8Array(m.length); for (let i = 0; i < m.length; i++) o[i] = m[i] > 127 ? 0 : 255; return o; }

// The hole all strategies share: everything Select Subject and Mask All Objects
// found, slightly enlarged so no rim of the subjects is left behind.
function strategyHole(subject, objects, w, h) {
  const u = subject.slice();
  for (const m of objects) if (count(m) < 0.85 * w * h) orInto(u, m);
  return dilateMask(u, w, h, Math.max(4, Math.round(0.008 * Math.max(w, h))));
}

// The fills a strategy makes, in order: a list of selection masks.
function strategySteps(name, hole, objects, w, h) {
  if (name.startsWith("all at once")) return [hole];
  const steps = [];
  let remaining = hole.slice();
  if (name === "one object at a time") {
    const r = Math.max(4, Math.round(0.008 * Math.max(w, h)));
    const parts = objects.map((m) => and(dilateMask(m, w, h, r), hole)).filter((m) => count(m) > 0.002 * w * h)
      .sort((a, b) => count(a) - count(b));
    for (const p of parts) {
      const step = and(p, remaining);
      if (count(step) > 0.0005 * w * h) { steps.push(step); remaining = andNot(remaining, step); }
    }
  } else {
    const band = Math.max(12, Math.round(0.04 * Math.min(w, h)));
    for (let k = 0; k < 10 && count(remaining) > 0; k++) {
      const ring = and(remaining, dilateMask(invert(remaining), w, h, band));
      if (!count(ring)) break;
      steps.push(ring);
      remaining = andNot(remaining, ring);
    }
  }
  if (count(remaining) > 0) steps.push(remaining);
  return steps;
}

// A layer holding the image with the hole's pixels transparent (written
// directly, documented API): transparent pixels are not used as fill source.
async function newLayerWithHole(doc, name, rgb, w, h, clear) {
  if (!clear) return newLayerWithPixels(doc, name, rgb, w, h);
  return newLayerWithPixels(doc, name, rgb, w, h, clear);
}

async function runStrategy(doc, rgb, w, h, hole, objects, name) {
  const steps = strategySteps(name, hole, objects, w, h);
  const layer = await newLayerWithHole(doc, `Probe · ${name}`, rgb, w, h, name === "all at once" ? null : hole);
  await selectLayer(layer);
  let used = null;
  for (const step of steps) {
    await setSelection(doc, step, w, h);
    used = (await tryDescriptors(CONTENT_AWARE())).used;
    await deselect();
  }
  const got = await imaging.getPixels({ documentID: doc.id, layerID: layer.id, componentSize: 8 });
  const comps = got.imageData.components;
  const alpha = comps === 4 ? await toCanvasAlpha(got, w, h) : null;
  const out = alpha ? alpha.rgb : await toCanvasRGB(got, w, h);
  let unfilled = 0;
  if (alpha) for (let i = 0; i < w * h; i++) if (hole[i] > 127 && alpha.a[i] < 250) unfilled++;
  try { await layer.delete(); } catch (e) { /* leave it; the document is closed unsaved */ }
  return { used, fills: steps.length, out, unfilled: +(unfilled / Math.max(count(hole), 1)).toFixed(4) };
}

async function toCanvasAlpha(got, w, h) {
  const data = await got.imageData.getData({ chunky: true });
  const b = got.sourceBounds || { left: 0, top: 0 }, gw = got.imageData.width;
  const rgb = new Uint8Array(w * h * 3), a = new Uint8Array(w * h);
  for (let y = 0; y < got.imageData.height; y++) {
    for (let x = 0; x < gw; x++) {
      const s = (y * gw + x) * 4, d = (y + b.top) * w + (x + b.left);
      if (d < 0 || d >= w * h) continue;
      rgb[3 * d] = data[s]; rgb[3 * d + 1] = data[s + 1]; rgb[3 * d + 2] = data[s + 2]; a[d] = data[s + 3];
    }
  }
  got.imageData.dispose();
  return { rgb, a };
}

async function fillStrategies(doc, rgb, w, h, subject, objects, id, truth) {
  const hole = strategyHole(subject, objects, w, h);
  const coverage = count(hole) / (w * h);
  const rows = [];
  if (coverage > 0.85) return [{ note: `skipped: hole covers ${Math.round(coverage * 100)}% of the image` }];
  let x0 = w, y0 = h, x1 = 0, y1 = 0;
  for (let i = 0; i < w * h; i++) if (hole[i] > 127) {
    const x = i % w, y = (i / w) | 0;
    if (x < x0) x0 = x; if (x >= x1) x1 = x + 1; if (y < y0) y0 = y; if (y >= y1) y1 = y + 1;
  }
  const bbox = [x0, y0, x1, y1];
  await writeFile(`${id}_fill_hole.rle`, rle(hole));
  for (let k = 0; k < STRATEGIES.length; k++) {
    const name = STRATEGIES[k];
    const r = await timed(`${id}: fill strategy "${name}"`, () => modal(`fill: ${name}`, async () => {
      const res = await runStrategy(doc, rgb, w, h, hole, objects, name);
      const file = await writeFile(`${id}_fill${k}_${bbox.join("_")}.rgb`, cropRGB(res.out, w, bbox));
      const scored = { used: res.used, fills: res.fills, unfilled: res.unfilled, file, bbox,
                       holeCoverage: +coverage.toFixed(3), seam: seamScore(res.out, hole, w, h) };
      if (truth) scored.psnr = psnr(res.out, truth, hole);
      return scored;
    }));
    rows.push({ strategy: name, ok: r.ok, ms: r.ms, ...(r.ok ? r.detail : { error: r.error }) });
    await saveReport();
  }
  return rows;
}

// ---------------------------------------------------------------- the one button

async function runSafeTests() {
  report.environment = environment();
  await openResultsFolder();
  log(`Photoshop ${report.environment.photoshop} · results: ${report.resultsFolder}`);
  await saveReport();

  const { folder, images } = await loadManifest();
  const total = images.length + SCENES.length;
  let step = 0;
  for (const meta of images) {
    status(`Testing image ${++step} of ${total}: ${meta.case}`);
    let entry;
    try {
      entry = await imageEntry(folder, meta);
    } catch (e) {
      log(`✗ ${meta.id}: could not load (${e.message}); skipped`);
      report.images.push({ id: meta.id, case: meta.case, skipped: e.message });
      await saveReport();
      continue;
    }
    await checkImage(entry, meta);
  }
  for (let i = 0; i < SCENES.length; i++) {
    status(`Testing background scene ${++step} of ${total}`);
    await sceneTest(SCENES[i][0], SCENES[i][1], i, SCENES[i][2] || 1);
  }
  report.finished = new Date().toISOString();
  await saveReport();
  status(`Finished. Send the folder “${RESULTS_NAME} …” from your ${report.resultsFolder.includes("Desktop") ? "Desktop" : "results location below"}.`);
  log(`\nAll safe tests finished.\nResults folder: ${report.resultsFolder}`);
}

// ---------------------------------------------------------------- optional: recording

let recording = false;
function onEvent(event, descriptor) {
  report.recorded.push({ event, descriptor });
  log(`● recorded ${event}`);
}
async function toggleRecord(btn) {
  if (!recording) {
    try { await action.addNotificationListener(["all"], onEvent); } catch (e) {
      await action.addNotificationListener(["autoCutout", "fill", "removeBackground", "maskAllObjects", "autoMaskAllObjects"], onEvent);
    }
    recording = true;
    btn.textContent = "Stop recording";
    log("Recording. Do the step(s) the report asked for by hand, then click Stop recording, then Run safe tests again.");
  } else {
    try { await action.removeNotificationListener(["all"], onEvent); } catch (e) { /* list form */ }
    recording = false;
    btn.textContent = "Record a command";
    await openResultsFolder();
    await saveReport();
    log(`Stopped. Captured: ${[...new Set(report.recorded.map((r) => r.event))].join(", ") || "nothing"}`);
  }
}

// ---------------------------------------------------------------- optional: WebAssembly (unsafe)

let wasmArmed = false;

// Decides how the plugin's own AI can ship with no separate application:
// WebAssembly inside the plugin, or a native (hybrid) add-on. Each step is
// written to the report before it runs, so if Photoshop closes, the report
// names the step that closed it. Runs only on two deliberate clicks.
const WASM_ADD = [0, 97, 115, 109, 1, 0, 0, 0, 1, 7, 1, 96, 2, 127, 127, 1, 127, 3, 2, 1, 0, 7, 7, 1, 3, 97, 100, 100, 0, 0,
  10, 9, 1, 7, 0, 32, 0, 32, 1, 106, 11]; // add(a, b)
const WASM_SIMD = [0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 127, 3, 2, 1, 0, 7, 5, 1, 1, 102, 0, 0, 10, 46, 1, 44, 0, 253, 12,
  2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 253, 12, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 253, 174, 1, 253, 27, 0, 11]; // 2+3 in a vector

async function pluginFile(name, binary) {
  const folder = await (await uxp.storage.localFileSystem.getPluginFolder()).getEntry("wasm");
  const f = await folder.getEntry(name);
  return binary ? f.read({ format: uxp.storage.formats.binary }) : f.read();
}

function stats(t) {
  const d = t.data; let sum = 0, sq = 0;
  for (let i = 0; i < d.length; i++) { sum += d[i]; sq += d[i] * d[i]; }
  const mean = sum / d.length;
  return { dims: t.dims, mean: +mean.toFixed(6), std: +Math.sqrt(Math.max(sq / d.length - mean * mean, 0)).toFixed(6),
           first: Array.from(d.slice(0, 4)).map((v) => +Number(v).toFixed(5)) };
}

async function wasmCheck(btn) {
  if (!wasmArmed) {
    wasmArmed = true;
    btn.textContent = "Click again to run (may close Photoshop)";
    return;
  }
  wasmArmed = false;
  btn.textContent = "WebAssembly test";
  report.environment = report.environment || environment();
  await openResultsFolder();
  report.wasm = { photoshop: app.version || (uxp.host && uxp.host.version), steps: [], running: null };
  const step = async (name, fn) => {
    status(`WebAssembly test: ${name}`);
    report.wasm.running = name; // if Photoshop closes now, the report says where
    await saveReport();
    const r = await timed(`WebAssembly: ${name}`, fn);
    report.wasm.steps.push(r);
    report.wasm.running = null;
    await saveReport();
    return r;
  };

  const basic = await step("instantiate and call", async () => {
    if (typeof WebAssembly === "undefined") return { ok: false, note: "WebAssembly not defined" };
    const { instance } = await WebAssembly.instantiate(new Uint8Array(WASM_ADD));
    return { add: instance.exports.add(2, 3) };
  });
  if (!basic.ok) return finishWasm();

  let simd = false;
  await step("capabilities", async () => {
    let cores = null;
    try { cores = require("os").cpus().length; } catch (e) { try { cores = navigator.hardwareConcurrency; } catch (e2) { /* n/a */ } }
    simd = WebAssembly.validate(new Uint8Array(WASM_SIMD));
    let simdResult = null;
    if (simd) simdResult = (await WebAssembly.instantiate(new Uint8Array(WASM_SIMD))).instance.exports.f();
    return { simd, simdResult, sharedArrayBuffer: typeof SharedArrayBuffer, atomics: typeof Atomics,
             worker: typeof Worker, cores, instantiateStreaming: typeof WebAssembly.instantiateStreaming };
  });

  await step("memory up to 3.5 GB", async () => {
    let mem = new WebAssembly.Memory({ initial: 256, maximum: 65536 });
    const reached = [];
    for (const gb of [0.5, 1, 2, 3.5]) {
      report.wasm.running = `memory ${gb} GB`;
      await saveReport();
      try { mem.grow(Math.round((gb * 1024 * 1024 * 1024) / 65536) - mem.buffer.byteLength / 65536); reached.push(gb); } catch (e) { break; }
    }
    mem = null;
    return { reachedGB: reached.length ? reached[reached.length - 1] : 0 };
  });

  let ortLib = null;
  const loaded = await step("load ONNX Runtime Web", async () => {
    ortLib = require("./wasm/ort.js");
    return { version: ortLib.env && ortLib.env.versions ? ortLib.env.versions : "loaded" };
  });
  if (!loaded.ok) return finishWasm();

  // ONNX Runtime fetches its .wasm by URL; inside a plugin that file is served
  // from the plugin folder instead.
  const realFetch = globalThis.fetch;
  const fetchShim = async (url, opts) => {
    const m = String(url).match(/^plugin:\/wasm\/(.+)$/);
    if (!m) return realFetch(url, opts);
    const buf = await pluginFile(m[1], true);
    return { ok: true, status: 200, url: String(url), arrayBuffer: async () => buf };
  };
  let streaming = null;
  try { streaming = WebAssembly.instantiateStreaming; WebAssembly.instantiateStreaming = undefined; } catch (e) { /* read-only */ }
  globalThis.fetch = fetchShim;
  // ONNX Runtime only fetches its .wasm where it sees a browser-style window
  const addedWindow = typeof window === "undefined";
  if (addedWindow) globalThis.window = globalThis;
  try {
    const ort = ortLib;
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.simd = simd;
    ort.env.wasm.proxy = false;
    ort.env.wasm.wasmPaths = "plugin:/wasm/";

    let embeddings = null, encoder = null;
    await step("SAM 2.1 image encoder (the heavy model): load", async () => {
      const bytes = new Uint8Array(await pluginFile("sam2_vision_encoder.onnx", true));
      encoder = await ort.InferenceSession.create(bytes);
      return { modelMB: +(bytes.length / 1048576).toFixed(1) };
    });
    if (encoder) {
      await step("SAM 2.1 image encoder: run on a 1024 x 1024 image", async () => {
        const px = new ort.Tensor("float32", new Float32Array(3 * 1024 * 1024).fill(0.1), [1, 3, 1024, 1024]);
        const t = Date.now();
        embeddings = await encoder.run({ pixel_values: px });
        const ms = Date.now() - t;
        const out = {};
        for (const k of Object.keys(embeddings)) out[k] = stats(embeddings[k]);
        return { runMs: ms, outputs: out };
      });
    }
    await step("SAM 2.1 mask decoder: load and run", async () => {
      const dec = await ort.InferenceSession.create(new Uint8Array(await pluginFile("sam2_prompt_encoder_mask_decoder.onnx", true)));
      const zero = (dims) => new ort.Tensor("float32", new Float32Array(dims.reduce((a, b) => a * b, 1)), dims);
      const feeds = {
        "image_embeddings.0": embeddings ? embeddings["image_embeddings.0"] : zero([1, 32, 256, 256]),
        "image_embeddings.1": embeddings ? embeddings["image_embeddings.1"] : zero([1, 64, 128, 128]),
        "image_embeddings.2": embeddings ? embeddings["image_embeddings.2"] : zero([1, 256, 64, 64]),
        input_points: new ort.Tensor("float32", new Float32Array([512, 512]), [1, 1, 1, 2]),
        input_labels: new ort.Tensor("int64", new BigInt64Array([1n]), [1, 1, 1]),
        input_boxes: new ort.Tensor("float32", new Float32Array([300, 300, 700, 700]), [1, 1, 4]),
      };
      const t = Date.now();
      const d = await dec.run(feeds);
      return { runMs: Date.now() - t, iou: stats(d.iou_scores), masks: stats(d.pred_masks), fromEncoder: !!embeddings };
    });
  } finally {
    globalThis.fetch = realFetch;
    if (addedWindow) delete globalThis.window;
    try { if (streaming) WebAssembly.instantiateStreaming = streaming; } catch (e) { /* read-only */ }
  }
  return finishWasm();
}

async function finishWasm() {
  report.wasm.finished = new Date().toISOString();
  await saveReport();
  status("WebAssembly test finished. Send the newest results folder.");
  log(`\nWebAssembly test finished.\nResults folder: ${report.resultsFolder}`);
}

// ---------------------------------------------------------------- wiring

function guard(fn) {
  return async (ev) => {
    if (busy) return;
    const btn = ev && ev.target;
    busy = true;
    if (btn) btn.disabled = true;
    try { await fn(btn); } catch (e) {
      log("✗ " + ((e && e.message) || e));
      report.notes.push(String((e && e.message) || e));
      try { await saveReport(); } catch (e2) { /* nowhere to write */ }
    } finally { busy = false; if (btn) btn.disabled = false; }
  };
}

// Startup never throws: any problem is shown in the panel instead.
function wire() {
  $("run").addEventListener("click", guard(runSafeTests));
  $("record").addEventListener("click", (ev) => toggleRecord(ev.target).catch((e) => log("✗ " + e.message)));
  $("wasm").addEventListener("click", guard(wasmCheck));
  const v = (app && app.version) || (uxp.host && uxp.host.version) || "";
  if (v.startsWith("26.0")) $("wasmwarn").textContent = `You are on Photoshop ${v}, the version reported to crash here. Skip this test unless asked.`;
}
try { wire(); } catch (e) {
  try { status("Startup problem: " + ((e && e.message) || e)); } catch (e2) { /* no panel */ }
}

if (typeof module !== "undefined" && module) {
  module.exports = { runSafeTests, wasmCheck, toggleRecord, report, buildScene, SCENES, psnr, seamScore, maskStats, rle };
}
