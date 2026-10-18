// Unflatten panel: one button. Separates the active image into named layers
// with transparent backgrounds over a rebuilt background, keeps the original as
// a hidden layer, and does it all as one Undo step. Photoshop does the pixel
// work (Select Subject, Mask All Objects, Generative Fill or Content-Aware
// Fill); core.js turns the results into layers that recombine to the original.
const { app, core: ps, action, imaging, constants } = require("photoshop");
const uxp = require("uxp");
const U = require("./core.js");

const NO_DIALOG = { dialogOptions: "dontDisplay" };
const ORIGINAL_NAME = "Original (flattened)";
const BACKGROUND_NAME = "Background (rebuilt)";

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- panel

function show(message, progress) {
  $("status").textContent = message || "";
  if (progress === undefined) $("busy").classList.add("hidden");
  else { $("busy").classList.remove("hidden"); $("bar").value = Math.round(progress * 100); }
}

function generativeWanted() {
  try { return $("generative").checked !== false; } catch (e) { return true; }
}
function rememberChoice() {
  try { localStorage.setItem("unflatten.generative", generativeWanted() ? "1" : "0"); } catch (e) { /* per session */ }
}
function restoreChoice() {
  try { if (localStorage.getItem("unflatten.generative") === "0") $("generative").checked = false; } catch (e) { /* default on */ }
}

// ---------------------------------------------------------------- Photoshop helpers

async function batch(desc) {
  return action.batchPlay([{ ...desc, _options: NO_DIALOG }], {});
}
async function tryDescriptors(candidates) {
  const errors = [];
  for (const d of candidates) {
    try {
      const res = await batch(d);
      if (!(res && res[0] && res[0]._obj === "error")) return d;
      errors.push(res[0].message || "error");
    } catch (e) { errors.push((e && e.message) || String(e)); }
  }
  throw new Error(errors.join(" | "));
}

const SELECT_SUBJECT = [{ _obj: "autoCutout", sampleAllLayers: false }];
// Layer › Mask All Objects, as Photoshop 27 records it
const MASK_ALL_OBJECTS = [{ _obj: "autoMaskGenerate", sampleAllLayers: false, hardEdge: true }];
const CONTENT_AWARE = [
  { _obj: "fill", using: { _enum: "fillContents", _value: "contentAware" }, contentAwareColorAdaptationFill: true,
    opacity: { _unit: "percentUnit", _value: 100 }, mode: { _enum: "blendMode", _value: "normal" } },
  { _obj: "fill", using: { _enum: "fillContents", _value: "contentAware" } },
];
// Edit › Generative Fill with an empty prompt, as Photoshop 27.11 records it. It
// runs only with its document and layer references (without them Photoshop
// answers "not currently available"), so they are set to the current ones.
function generativeFill(doc, layer) {
  return {
    _obj: "syntheticFill",
    _target: [{ _ref: "document", _enum: "ordinal", _value: "targetEnum" }],
    documentID: doc.id, layerID: layer.id,
    prompt: "", serviceID: "clio",
    workflowType: { _enum: "genWorkflow", _value: "in_painting" },
    serviceOptionsList: { clio: { _obj: "clio", gi_PROMPT: "", gi_MODE: "ginp", gi_SEED: -1, gi_NUM_STEPS: -1,
      gi_GUIDANCE: 6, gi_SIMILARITY: 0, gi_CROP: false, gi_DILATE: false, gi_CONTENT_PRESERVE: 0,
      gi_ENABLE_PROMPT_FILTER: true, dualCrop: true } },
    serviceVersion: "clio3",
    workflow_to_active_service_identifier_map: { gen_harmonize: "gen_harmonize", generativeUpscale: "clio_f16_async",
      instruct_edit: "clio3", text_to_image: "clio3", generate_similar: "clio3", out_painting: "me_md",
      prompt_to_edit: "firefly_image_5", generate_background: "clio3", in_painting: "me_md" },
  };
}

function profileOf(doc) { try { return doc.colorProfileName; } catch (e) { return null; } }
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
  await batch({ _obj: "assignProfile", _target: [{ _ref: "document", _enum: "ordinal", _value: "targetEnum" }], profile: name });
}
// Writing pixels needs an 8-bit RGB document with a profile the imaging API
// knows; grayscale, untagged and oddly tagged images are common (6 of the 8
// test images). Assigning keeps pixel values; grayscale goes through Gray Gamma 2.2.
async function normalize(doc) {
  const mode = String(doc.mode).toLowerCase();
  if (!mode.includes("rgb")) {
    if (mode.includes("gray")) await assignProfile(doc, "Gray Gamma 2.2").catch(() => {});
    await doc.changeMode(constants.ChangeMode.RGB);
  }
  if (String(doc.bitsPerChannel) !== "bitDepth8" && constants.BitsPerChannelType) {
    doc.bitsPerChannel = constants.BitsPerChannelType.EIGHT;
  }
  if (!(await profileUsable(profileOf(doc)))) await assignProfile(doc, "sRGB IEC61966-2.1");
}

async function readRGB(got, w, h) {
  const data = await got.imageData.getData({ chunky: true });
  const comps = got.imageData.components, b = got.sourceBounds || { left: 0, top: 0 }, gw = got.imageData.width;
  const out = new Uint8Array(w * h * 3);
  for (let y = 0; y < got.imageData.height; y++) {
    for (let x = 0; x < gw; x++) {
      const s = (y * gw + x) * comps, d = ((y + b.top) * w + (x + b.left)) * 3;
      if (d < 0 || d >= out.length) continue;
      out[d] = data[s]; out[d + 1] = data[s + 1]; out[d + 2] = data[s + 2];
    }
  }
  got.imageData.dispose();
  return out;
}
async function readMask(got, w, h) {
  const data = await got.imageData.getData({ chunky: true });
  const comps = got.imageData.components || 1, b = got.sourceBounds || { left: 0, top: 0 };
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
const composite = async (doc, w, h) => readRGB(await imaging.getPixels({ documentID: doc.id, componentSize: 8, applyAlpha: true }), w, h);
async function selectionMask(doc, w, h) {
  try {
    const got = await imaging.getSelection({ documentID: doc.id });
    return got && got.imageData ? readMask(got, w, h) : null;
  } catch (e) { return null; }
}

async function putLayer(doc, name, rgba, w, h) {
  const layer = await doc.createPixelLayer({ name });
  const opts = { width: w, height: h, components: 4, chunky: true, colorSpace: "RGB", colorProfile: profileOf(doc) };
  const img = await imaging.createImageDataFromBuffer(rgba, opts);
  await imaging.putPixels({ documentID: doc.id, layerID: layer.id, imageData: img });
  img.dispose();
  return layer;
}
function opaque(rgb, w, h) {
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    rgba[4 * i] = rgb[3 * i]; rgba[4 * i + 1] = rgb[3 * i + 1]; rgba[4 * i + 2] = rgb[3 * i + 2]; rgba[4 * i + 3] = 255;
  }
  return rgba;
}
async function select(layer) {
  await batch({ _obj: "select", _target: [{ _ref: "layer", _id: layer.id }], makeVisible: false });
}
async function deselect() {
  try { await batch({ _obj: "set", _target: [{ _ref: "channel", _property: "selection" }], to: { _enum: "ordinal", _value: "none" } }); } catch (e) { /* none */ }
}
async function setSelection(doc, mask, w, h) {
  const img = await imaging.createImageDataFromBuffer(mask, { width: w, height: h, components: 1, chunky: false,
    colorSpace: "Grayscale", colorProfile: "Gray Gamma 2.2" });
  await imaging.putSelection({ documentID: doc.id, imageData: img });
  img.dispose();
}
function allLayers(doc) {
  const out = [];
  const walk = (ls) => ls.forEach((l) => { out.push(l); if (l.layers) walk(l.layers); });
  walk(doc.layers);
  return out;
}
async function removeLayersSince(doc, before) {
  const added = allLayers(doc).filter((l) => !before.has(l.id));
  for (const l of added.reverse()) { try { await l.delete(); } catch (e) { /* already gone with its group */ } }
}

// ---------------------------------------------------------------- the steps

async function findSubjects(doc, rgb, w, h) {
  await deselect();
  await tryDescriptors(SELECT_SUBJECT);
  const soft = await selectionMask(doc, w, h);
  await deselect();
  // Mask All Objects on a scratch copy of the image, so the masks it adds are
  // easy to collect and remove again
  const before = new Set(allLayers(doc).map((l) => l.id));
  const scratch = await putLayer(doc, "Unflatten · objects", opaque(rgb, w, h), w, h);
  await select(scratch);
  const objects = [];
  try {
    await tryDescriptors(MASK_ALL_OBJECTS);
    for (const l of allLayers(doc)) {
      if (before.has(l.id) || l.id === scratch.id) continue;
      try { objects.push(await readMask(await imaging.getLayerMask({ documentID: doc.id, layerID: l.id }), w, h)); } catch (e) { /* a group */ }
    }
  } catch (e) { /* Select Subject alone still separates unconnected subjects */ }
  await removeLayersSince(doc, before);
  return { soft, objects };
}

// The background inside `hole`: Generative Fill when wanted and the image is a
// photo, checked against its surroundings (one retry), else Content-Aware Fill.
async function rebuildBackground(doc, rgb, w, h, hole, wantGenerative, step) {
  const graphic = U.isGraphic(rgb, w, h);
  const attempts = wantGenerative && !graphic ? ["Generative Fill", "Generative Fill", "Content-Aware Fill"] : ["Content-Aware Fill"];
  const notes = [];
  for (const method of attempts) {
    step(method === "Content-Aware Fill" ? "Rebuilding background" : "Rebuilding background (Generative Fill)");
    const before = new Set(allLayers(doc).map((l) => l.id));
    let filled = null;
    try {
      const layer = await putLayer(doc, "Unflatten · background", opaque(rgb, w, h), w, h);
      await select(layer);
      await setSelection(doc, hole, w, h);
      if (method === "Generative Fill") await batch(generativeFill(doc, layer));
      else await tryDescriptors(CONTENT_AWARE);
      await deselect();
      filled = await composite(doc, w, h);
    } catch (e) {
      notes.push(`${method}: ${(e && e.message) || e}`);
    } finally {
      await deselect();
      await removeLayersSince(doc, before);
    }
    if (!filled) continue;
    const bg = rgb.slice();
    for (let i = 0; i < w * h; i++) if (hole[i] > 127) { bg[3 * i] = filled[3 * i]; bg[3 * i + 1] = filled[3 * i + 1]; bg[3 * i + 2] = filled[3 * i + 2]; }
    const check = U.checkFill(bg, w, h, hole);
    if (check.ok || method === "Content-Aware Fill") return { bg, method, check, graphic, notes };
    notes.push(`${method} result rejected (ΔE ${check.deltaE}, texture ${check.detail})`);
  }
  throw new Error(`could not rebuild the background (${notes.join("; ")})`);
}

async function run(doc, ctx) {
  const step = (label, frac) => { show(`${label}…`, frac); try { ctx.reportProgress({ value: frac, commandName: label }); } catch (e) { /* older hosts */ } };
  step("Reading image", 0.02);
  await normalize(doc);
  const w = doc.width, h = doc.height;
  const rgb = await composite(doc, w, h);
  const originals = Array.from(doc.layers);

  step("Finding subjects", 0.1);
  const { soft, objects } = await findSubjects(doc, rgb, w, h);
  const list = U.stackOrder(U.instances(soft, objects, w, h), w, h);
  if (!list.length) throw new Error("no subject found in this image");
  const hole = U.holeOf(list, w, h);
  if (U.count(hole) > 0.85 * w * h) {
    throw new Error("this looks like a book cover or full-frame graphic; that mode arrives with the next update");
  }

  const bgStep = (label) => step(label, 0.35);
  const { bg, method, check, notes } = await rebuildBackground(doc, rgb, w, h, hole, generativeWanted(), bgStep);

  step("Separating layers", 0.75);
  const built = U.buildLayers(rgb, bg, w, h, list, soft);
  const names = U.layerNames(list, w, h);

  step("Creating layers", 0.85);
  for (const l of originals) { try { l.visible = false; } catch (e) { /* locked */ } }
  if (originals.length === 1) {
    // a locked "Background" layer becomes a normal one first (Layer › New ›
    // Layer from Background, as Photoshop 27.11 records it), then is renamed
    try {
      if (originals[0].isBackgroundLayer) {
        await batch({ _obj: "set", _target: [{ _ref: "layer", _property: "background" }],
          to: { _obj: "layer", opacity: { _unit: "percentUnit", _value: 100 }, mode: { _enum: "blendMode", _value: "normal" } } });
      }
      originals[0].name = ORIGINAL_NAME;
      originals[0].visible = false;
    } catch (e) { /* keeps its name; still hidden */ }
  }
  await putLayer(doc, BACKGROUND_NAME, opaque(built.background, w, h), w, h);
  for (let k = 0; k < built.layers.length; k++) await putLayer(doc, names[k], built.layers[k].rgba, w, h);
  await deselect();
  return { layers: built.layers.length, method, check, notes };
}

async function unflatten() {
  const doc = app.activeDocument;
  if (!doc) { show("Open an image first."); return; }
  $("go").disabled = true;
  rememberChoice();
  try {
    const result = await ps.executeAsModal(async (ctx) => {
      const hc = ctx.hostControl;
      const suspension = await hc.suspendHistory({ documentID: doc.id, name: "Unflatten" });
      try {
        const r = await run(doc, ctx);
        await hc.resumeHistory(suspension, true);
        return r;
      } catch (e) {
        await hc.resumeHistory(suspension, false); // leaves the image exactly as it was
        throw e;
      }
    }, { commandName: "Unflatten" });
    const via = result.method === "Generative Fill" ? "background by Generative Fill" : "background by Content-Aware Fill";
    show(`Done: ${result.layers} layer${result.layers === 1 ? "" : "s"}, ${via}.`);
  } catch (e) {
    show(`Could not unflatten: ${(e && e.message) || e}`);
  } finally {
    $("go").disabled = false;
  }
}

try {
  restoreChoice();
  $("go").addEventListener("click", unflatten);
  $("generative").addEventListener("change", rememberChoice);
} catch (e) {
  try { show("Startup problem: " + ((e && e.message) || e)); } catch (e2) { /* no panel */ }
}

if (typeof module !== "undefined" && module) module.exports = { unflatten, run, rebuildBackground, findSubjects };
