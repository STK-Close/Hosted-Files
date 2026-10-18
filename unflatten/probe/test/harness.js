// Runs probe.js in Node against a simulated Photoshop. This checks the probe's own
// logic (bookkeeping, masks, metrics, engine comparison, report) end to end; it
// cannot say anything about real Photoshop behaviour, which is what the probe is for.
//
//   node harness.js <raw-rgb> <width> <height>    (engine optional at 127.0.0.1:7865)
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const [rawPath, W, H] = process.argv.slice(2);
const width = +W, height = +H;
const source = new Uint8Array(fs.readFileSync(rawPath));
let nextId = 1;
const docs = [];

function ellipseMask(w, h) {
  const m = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++)
    if (((x - w / 2) / (w * 0.22)) ** 2 + ((y - h * 0.55) / (h * 0.38)) ** 2 < 1) m[y * w + x] = 255;
  return m;
}

function makeDoc(title, w, h, rgb) {
  const doc = { id: nextId++, title, width: w, height: h, mode: "RGBColorMode", bitsPerChannel: 8,
                colorProfileName: "sRGB IEC61966-2.1", layers: [], selection: null, active: null };
  const base = { id: nextId++, name: "Background", visible: true, rgba: new Uint8Array(w * h * 4), mask: null };
  for (let i = 0; i < w * h; i++) { base.rgba.set(rgb ? rgb.subarray(3 * i, 3 * i + 3) : [255, 255, 255], 4 * i); base.rgba[4 * i + 3] = 255; }
  doc.layers.push(base);
  doc.duplicate = async (t) => { const d = makeDoc(t, w, h, composite(doc)); return d; };
  doc.createPixelLayer = async ({ name }) => { const l = { id: nextId++, name, visible: true, rgba: new Uint8Array(w * h * 4), mask: null }; doc.layers.push(l); doc.active = l; return l; };
  doc.createTextLayer = async ({ name }) => { const l = { id: nextId++, name, visible: true, kind: "text" }; doc.layers.push(l); return l; };
  doc.saveAs = { psd: async () => {} };
  docs.push(doc);
  return doc;
}

function composite(doc) {
  const { width: w, height: h } = doc;
  const out = new Uint8Array(w * h * 3);
  for (const l of doc.layers) {
    if (!l.visible || !l.rgba) continue;
    for (let i = 0; i < w * h; i++) {
      const a = (l.rgba[4 * i + 3] / 255) * (l.mask ? l.mask[i] / 255 : 1);
      for (let c = 0; c < 3; c++) out[3 * i + c] = Math.round(l.rgba[4 * i + c] * a + out[3 * i + c] * (1 - a));
    }
  }
  return out;
}

const docById = (id) => docs.find((d) => d.id === id);
const layerById = (doc, id) => doc.layers.find((l) => l.id === id);
const imageData = (data, w, h, comps, colorSpace) => ({ width: w, height: h, components: comps, colorSpace,
  getData: async () => data, dispose() {} });

let active = null;
const photoshop = {
  app: { get activeDocument() { return active; }, version: "mock-26.0",
         createDocument: async ({ name, width: w, height: h }) => makeDoc(name, w, h, null) },
  constants: {},
  core: { executeAsModal: async (fn) => fn({ hostControl: {}, reportProgress() {} }) },
  action: {
    addNotificationListener: async () => {}, removeNotificationListener: async () => {},
    async batchPlay([d]) {
      const doc = docs[docs.length - 1];
      switch (d._obj) {
        case "autoCutout": doc.selection = ellipseMask(doc.width, doc.height); return [{}];
        case "set": doc.selection = null; return [{}];
        case "select": doc.active = layerById(doc, d._target[0]._id); return [{}];
        case "removeBackground": doc.active.mask = ellipseMask(doc.width, doc.height); return [{}];
        case "fill": {
          if (!doc.selection) return [{ _obj: "error", message: "no selection" }];
          const { width: w, height: h } = doc, px = doc.active.rgba;
          for (let y = 0; y < h; y++) { let last = null;
            for (let x = 0; x < w; x++) { const i = y * w + x;
              if (doc.selection[i] > 127 && last !== null) px.set(px.subarray(4 * last, 4 * last + 4), 4 * i); else if (doc.selection[i] <= 127) last = i; } }
          return [{}];
        }
        default: return [{ _obj: "error", message: `unknown command ${d._obj}` }];
      }
    },
  },
  imaging: {
    async getPixels({ documentID, layerID }) {
      const doc = docById(documentID), w = doc.width, h = doc.height;
      if (layerID) return { imageData: imageData(layerById(doc, layerID).rgba, w, h, 4, "RGB"), sourceBounds: { left: 0, top: 0 } };
      const c = composite(doc), rgba = new Uint8Array(w * h * 4);
      for (let i = 0; i < w * h; i++) { rgba.set(c.subarray(3 * i, 3 * i + 3), 4 * i); rgba[4 * i + 3] = 255; }
      return { imageData: imageData(rgba, w, h, 4, "RGB"), sourceBounds: { left: 0, top: 0 } };
    },
    async getSelection({ documentID }) {
      const doc = docById(documentID);
      if (!doc.selection) throw new Error("no selection");
      return { imageData: imageData(doc.selection, doc.width, doc.height, 1, "Grayscale"), sourceBounds: { left: 0, top: 0 } };
    },
    async getLayerMask({ documentID, layerID }) {
      const doc = docById(documentID);
      return { imageData: imageData(layerById(doc, layerID).mask, doc.width, doc.height, 1, "Grayscale"), sourceBounds: { left: 0, top: 0 } };
    },
    async createImageDataFromBuffer(buf, o) {
      if (buf.length !== o.width * o.height * o.components) throw new Error("buffer size mismatch");
      return { ...o, buf: new Uint8Array(buf), dispose() {} };
    },
    async putPixels({ documentID, layerID, imageData: d }) { layerById(docById(documentID), layerID).rgba.set(d.buf); },
    async putLayerMask({ documentID, layerID, imageData: d }) { layerById(docById(documentID), layerID).mask = d.buf; },
    async putSelection({ documentID, imageData: d }) { docById(documentID).selection = d.buf; },
  },
};

const elements = {};
const el = (id) => (elements[id] = elements[id] || { id, textContent: "", scrollTop: 0, scrollHeight: 0, disabled: false,
  addEventListener() {} });
const sandbox = {
  require: (m) => (m === "photoshop" ? photoshop : m === "uxp" ? { versions: { uxp: "mock" }, storage: {} } : require(m)),
  document: { getElementById: el }, fetch, console, Date, JSON, Math, String, Uint8Array, Error, Set, Object, Promise,
  WebAssembly, module: { exports: {} },
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "probe.js"), "utf8"), sandbox);
const probe = sandbox.module.exports;

(async () => {
  active = makeDoc("photo", width, height, source);
  await probe.realChecks();
  await probe.accuracyTest();
  await probe.wasmCheck();
  const r = probe.report;
  const fail = (m) => { console.error("FAIL:", m, "\n", elements.log.textContent); process.exit(1); };
  const need = ["duplicate document", "Select Subject (batchPlay autoCutout)", "Remove Background (batchPlay)",
                "Content-Aware Fill behind subject (batchPlay fill)", "Create editable text layer (DOM)"];
  for (const n of need) { const c = r.checks.find((x) => x.name === n); if (!c || !c.ok) fail(`${n}: ${c && (c.error || JSON.stringify(c.detail))}`); }
  const mao = r.checks.find((x) => x.name.startsWith("Mask All Objects"));
  if (!mao || mao.ok) fail("Mask All Objects must report 'not recorded' without a recording");
  if (r.accuracy.length !== 4 || r.accuracy.some((a) => !a.photoshop || a.photoshop.psnr == null)) fail("accuracy rows incomplete");
  if (!r.wasm || !r.wasm.ok) fail("wasm check");
  console.log(elements.log.textContent);
  console.log("HARNESS OK");
})().catch((e) => { console.error(e); process.exit(1); });
