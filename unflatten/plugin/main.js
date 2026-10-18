// Unflatten panel: one button. Reads the active document's pixels, sends them
// to the local engine, and builds the returned layers in the same document as
// a single undoable step. All processing happens on this computer.
const { app, core, imaging, action, constants } = require("photoshop");

const ENGINE = "http://127.0.0.1:7865";
const ORIGINAL_NAME = "Original (flattened)";

const goButton = document.getElementById("go");
const busy = document.getElementById("busy");
const bar = document.getElementById("bar");
const statusLine = document.getElementById("status");

function show(message, progress) {
  statusLine.textContent = message || "";
  if (progress === undefined) {
    busy.classList.add("hidden");
  } else {
    busy.classList.remove("hidden");
    bar.value = Math.round(progress * 100);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function engineReady() {
  try {
    const r = await fetch(`${ENGINE}/health`);
    return r.ok;
  } catch (e) {
    return false;
  }
}

async function readComposite(doc) {
  return core.executeAsModal(async () => {
    const got = await imaging.getPixels({ documentID: doc.id, componentSize: 8 });
    const img = got.imageData;
    const data = await img.getData({ chunky: true });
    const out = { width: img.width, height: img.height, components: img.components, data: new Uint8Array(data) };
    img.dispose();
    return out;
  }, { commandName: "Unflatten: read image" });
}

async function runJob(pixels) {
  const post = await fetch(`${ENGINE}/jobs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Width": String(pixels.width),
      "X-Height": String(pixels.height),
      "X-Components": String(pixels.components),
    },
    body: pixels.data.buffer,
  });
  if (!post.ok) throw new Error((await post.json()).error || `engine refused the image (${post.status})`);
  const { id } = await post.json();

  for (;;) {
    await sleep(300);
    const st = await (await fetch(`${ENGINE}/jobs/${id}`)).json();
    if (st.state === "error") throw new Error(st.error);
    show(`${st.stage}…`, 0.1 + 0.75 * st.progress);
    if (st.state === "done") break;
  }
  const buf = await (await fetch(`${ENGINE}/jobs/${id}/result`)).arrayBuffer();
  fetch(`${ENGINE}/jobs/${id}`, { method: "DELETE" }).catch(() => {});
  return parseResult(buf);
}

function parseResult(buf) {
  const head = new Uint8Array(buf, 0, 4);
  if (String.fromCharCode(...head) !== "UNFL") throw new Error("unexpected engine response");
  const len = new DataView(buf).getUint32(4, true);
  const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, len)));
  meta.payload = buf.slice(8 + len);
  return meta;
}

// Keep the user's existing layers, hidden, as the untouched original.
async function preserveOriginal(doc) {
  const bg = doc.backgroundLayer;
  if (bg) {
    await action.batchPlay([{
      _obj: "set",
      _target: [{ _ref: "layer", _property: "background" }],
      to: { _obj: "layer", name: ORIGINAL_NAME, opacity: { _unit: "percentUnit", _value: 100 },
            mode: { _enum: "blendMode", _value: "normal" } },
    }], {});
  }
  let original;
  if (doc.layers.length === 1) {
    original = doc.layers[0];
  } else {
    original = await doc.groupLayers(doc.layers.slice());
  }
  original.name = ORIGINAL_NAME;
  original.visible = false;
  return original;
}

async function buildLayers(doc, result, ctx) {
  const suspension = await ctx.hostControl.suspendHistory({ documentID: doc.id, name: "Unflatten" });
  let below = await preserveOriginal(doc);
  const layers = result.layers.filter((l) => l.kind !== "original");
  let profile;
  try { profile = doc.colorProfileName || undefined; } catch (e) { profile = undefined; }

  for (let i = 0; i < layers.length; i++) {
    const l = layers[i];
    ctx.reportProgress({ value: 0.85 + 0.15 * (i / layers.length), commandName: `Creating “${l.name}”` });
    const layer = doc.createPixelLayer
      ? await doc.createPixelLayer({ name: l.name })
      : await doc.createLayer({ name: l.name });
    await layer.move(below, constants.ElementPlacement.PLACEBEFORE);

    const pixels = new Uint8Array(result.payload, l.offset, l.length);
    const options = { width: l.width, height: l.height, components: 4, chunky: true, colorSpace: "RGB" };
    if (profile) options.colorProfile = profile; // same profile in and out: no colour conversion
    const imageData = await imaging.createImageDataFromBuffer(pixels, options);
    await imaging.putPixels({ documentID: doc.id, layerID: layer.id, imageData,
                              targetBounds: { left: l.left, top: l.top }, commandName: l.name });
    imageData.dispose();
    layer.visible = l.visible;
    below = layer;
  }
  await ctx.hostControl.resumeHistory(suspension, true);
}

async function unflatten() {
  const doc = app.activeDocument;
  if (!doc) return show("Open an image first.");
  if (doc.mode !== constants.DocumentMode.RGB) return show("Unflatten works on RGB documents (Image ▸ Mode ▸ RGB Color).");
  if (doc.bitsPerChannel !== constants.BitsPerChannelType.EIGHT) {
    return show("Unflatten works on 8-bit documents (Image ▸ Mode ▸ 8 Bits/Channel).");
  }

  goButton.disabled = true;
  try {
    show("Starting…", 0.02);
    if (!(await engineReady())) {
      return show("The Unflatten engine isn't running on this computer.");
    }
    show("Reading image…", 0.05);
    const pixels = await readComposite(doc);
    const result = await runJob(pixels);
    show("Creating layers…", 0.88);
    await core.executeAsModal((ctx) => buildLayers(doc, result, ctx), { commandName: "Unflatten" });
    const n = result.layers.filter((l) => l.kind === "object" || l.kind === "text").length;
    show(`${n} layer${n === 1 ? "" : "s"} separated.`);
  } catch (e) {
    console.error(e);
    show(`Something went wrong: ${e.message || e}`);
  } finally {
    goButton.disabled = false;
  }
}

goButton.addEventListener("click", unflatten);
