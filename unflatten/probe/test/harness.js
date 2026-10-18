// Runs the real probe.js in Node against a simulated Photoshop and file system,
// end to end: one click on "Run safe tests", the bundled images opened, every
// check run, results written to a Desktop folder. This verifies the probe's own
// logic and output format (which tools/compare_probe.py reads). It says nothing
// about how real Photoshop behaves; the simulated Select Subject is an ellipse
// and the simulated fill copies the nearest pixel on the left.
//
//   node harness.js <decoded-images-dir> <fake-home-dir>
// <decoded-images-dir> holds <id>.rgb + <id>.json ({width, height}) for each test image.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const [decodedDir, home] = process.argv.slice(2);
const PROBE = path.join(__dirname, "..");
fs.mkdirSync(path.join(home, "Desktop"), { recursive: true });
const dataDir = path.join(home, "plugin-data");
fs.mkdirSync(dataDir, { recursive: true });

// ---- simulated UXP file system
function fileEntry(p) {
  return {
    isFile: true, name: path.basename(p), nativePath: p,
    async read(opts) {
      const b = fs.readFileSync(p);
      return opts && opts.format === "binary" ? b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) : b.toString("utf8");
    },
    async write(data) { fs.writeFileSync(p, typeof data === "string" ? data : Buffer.from(data)); },
  };
}
function folderEntry(p) {
  return {
    isFolder: true, name: path.basename(p), nativePath: p,
    async getEntry(name) {
      const q = path.join(p, name);
      if (!fs.existsSync(q)) throw new Error(`no entry ${name}`);
      return fs.statSync(q).isDirectory() ? folderEntry(q) : fileEntry(q);
    },
    async createFolder(name) { const q = path.join(p, name); fs.mkdirSync(q, { recursive: true }); return folderEntry(q); },
    async createFile(name) { return fileEntry(path.join(p, name)); },
  };
}
const localFileSystem = {
  async getPluginFolder() { return folderEntry(PROBE); },
  async getDataFolder() { return folderEntry(dataDir); },
  async getEntryWithUrl(url) { return folderEntry(url.replace(/^file:/, "")); },
  async getFolder() { return null; },
};

// ---- simulated Photoshop
let nextId = 1;
const docs = [];
function ellipse(w, h) {
  const m = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++)
    if (((x - w / 2) / (w * 0.22)) ** 2 + ((y - h * 0.55) / (h * 0.38)) ** 2 < 1) m[y * w + x] = 255;
  return m;
}
// Colour setups seen in Photoshop 27.1 on the bundled images. The imaging API
// rejects RGB buffers whose profile it does not know ("Unknown color profile").
const OPENED_AS = {
  B_cap_red: { profile: "c2" }, C_crew: { profile: "c2" }, C_family: { profile: "None", mode: "grayscaleMode" },
  D_simian: { profile: "None" }, D_philadelphia: { profile: "None" }, D_rosie: { profile: "None" },
  B_cap_black: { profile: "Adobe RGB (1998)" },
};
const KNOWN_PROFILES = new Set(["sRGB IEC61966-2.1", "Adobe RGB (1998)", "Gray Gamma 2.2"]);
function makeDoc(title, w, h, rgb) {
  const as = OPENED_AS[title] || {};
  const doc = { id: nextId++, title, width: w, height: h, mode: as.mode || "RGBColorMode", bitsPerChannel: "bitDepth8",
                colorProfileName: as.profile || "sRGB IEC61966-2.1", layers: [], selection: null, active: null, closed: false };
  doc.changeMode = async (to) => { if (to !== "RGB") throw new Error("mode"); doc.mode = "RGBColorMode"; doc.colorProfileName = "sRGB IEC61966-2.1"; };
  const base = { id: nextId++, name: "Background", rgba: new Uint8Array(w * h * 4), mask: null };
  for (let i = 0; i < w * h; i++) { base.rgba.set(rgb ? rgb.subarray(3 * i, 3 * i + 3) : [255, 255, 255], 4 * i); base.rgba[4 * i + 3] = 255; }
  doc.layers.push(base);
  doc.createPixelLayer = async ({ name }) => { const l = { id: nextId++, name, rgba: new Uint8Array(w * h * 4), mask: null }; doc.layers.push(l); return l; };
  doc.createTextLayer = async ({ name }) => { const l = { id: nextId++, name, kind: "text" }; doc.layers.push(l); return l; };
  doc.closeWithoutSaving = () => { doc.closed = true; };
  docs.push(doc);
  return doc;
}
function composite(doc) {
  const { width: w, height: h } = doc, out = new Uint8Array(w * h * 3);
  for (const l of doc.layers) {
    if (!l.rgba) continue;
    for (let i = 0; i < w * h; i++) {
      const a = (l.rgba[4 * i + 3] / 255) * (l.mask ? l.mask[i] / 255 : 1);
      for (let c = 0; c < 3; c++) out[3 * i + c] = Math.round(l.rgba[4 * i + c] * a + out[3 * i + c] * (1 - a));
    }
  }
  return out;
}
const current = () => docs.filter((d) => !d.closed).slice(-1)[0];
const docById = (id) => docs.find((d) => d.id === id);
const layerById = (doc, id, ls = doc.layers) => {
  for (const l of ls) { if (l.id === id) return l; const inner = l.layers && layerById(doc, id, l.layers); if (inner) return inner; }
  return undefined;
};
const imageData = (data, w, h, comps, colorSpace) => ({ width: w, height: h, components: comps, colorSpace,
  getData: async () => data, dispose() {} });
function downsample(rgb, w, h, tw) {
  const th = Math.round((h * tw) / w), out = new Uint8Array(tw * th * 4);
  for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
    const s = 3 * (Math.floor((y * h) / th) * w + Math.floor((x * w) / tw));
    out.set([rgb[s], rgb[s + 1], rgb[s + 2], 255], 4 * (y * tw + x));
  }
  return { data: out, w: tw, h: th };
}

const photoshop = {
  app: {
    version: "mock-26.1",
    async open(entry) {
      const id = path.basename(entry.nativePath).replace(/\.\w+$/, "");
      const meta = JSON.parse(fs.readFileSync(path.join(decodedDir, `${id}.json`)));
      return makeDoc(id, meta.width, meta.height, new Uint8Array(fs.readFileSync(path.join(decodedDir, `${id}.rgb`))));
    },
    async createDocument({ name, width: w, height: h }) { return makeDoc(name, w, h, null); },
  },
  constants: { ChangeMode: { RGB: "RGB" } },
  core: { executeAsModal: async (fn) => fn({ hostControl: {}, reportProgress() {} }) },
  action: {
    addNotificationListener: async () => {}, removeNotificationListener: async () => {},
    async batchPlay([d]) {
      const doc = current();
      switch (d._obj) {
        case "autoCutout": doc.selection = ellipse(doc.width, doc.height); return [{}];
        case "set": doc.selection = null; return [{}];
        case "select": doc.active = layerById(doc, d._target[0]._id); return [{}];
        case "removeBackground": doc.active.mask = ellipse(doc.width, doc.height); return [{}];
        case "fill": {
          if (!doc.selection) return [{ _obj: "error", message: "no selection" }];
          const { width: w, height: h } = doc, px = doc.active.rgba;
          for (let y = 0; y < h; y++) { let last = null;
            for (let x = 0; x < w; x++) { const i = y * w + x;
              if (doc.selection[i] > 127 && last !== null) px.set(px.subarray(4 * last, 4 * last + 4), 4 * i);
              else if (doc.selection[i] <= 127 && px[4 * i + 3] > 0) last = i; } }
          return [{}];
        }
        case "autoMaskGenerate": {
          // Mask All Objects: one masked layer per object, in a group
          const group = { id: nextId++, name: "Objects", layers: [] };
          for (let k = 0; k < 2; k++) {
            const m = ellipse(doc.width, doc.height).map((v, i) => ((i % doc.width) < doc.width / 2) === (k === 0) ? v : 0);
            group.layers.push({ id: nextId++, name: `Background Object ${k + 1}`, rgba: null, mask: m });
          }
          doc.layers.push(group);
          return [{}];
        }
        case "invokeCommand": throw new Error('The command "<unknown>" is not currently available.');
        default: return [{ _obj: "error", message: `unknown command ${d._obj}` }];
      }
    },
  },
  imaging: {
    async getPixels({ documentID, layerID, targetSize }) {
      const doc = docById(documentID), w = doc.width, h = doc.height;
      if (layerID) return { imageData: imageData(layerById(doc, layerID).rgba, w, h, 4, "RGB"), sourceBounds: { left: 0, top: 0 } };
      const c = composite(doc);
      if (targetSize) { const s = downsample(c, w, h, targetSize.width); return { imageData: imageData(s.data, s.w, s.h, 4, "RGB"), sourceBounds: { left: 0, top: 0 } }; }
      const rgba = new Uint8Array(w * h * 4);
      for (let i = 0; i < w * h; i++) { rgba.set(c.subarray(3 * i, 3 * i + 3), 4 * i); rgba[4 * i + 3] = 255; }
      return { imageData: imageData(rgba, w, h, 4, "RGB"), sourceBounds: { left: 0, top: 0 } };
    },
    async getSelection({ documentID }) {
      const doc = docById(documentID);
      if (!doc.selection) throw new Error("no selection");
      return { imageData: imageData(doc.selection, doc.width, doc.height, 1, "Grayscale"), sourceBounds: { left: 0, top: 0 } };
    },
    async getLayerMask({ documentID, layerID }) {
      const doc = docById(documentID), l = layerById(doc, layerID);
      if (!l.mask) throw new Error("layer has no mask");
      return { imageData: imageData(l.mask, doc.width, doc.height, 1, "Grayscale"), sourceBounds: { left: 0, top: 0 } };
    },
    async createImageDataFromBuffer(buf, o) {
      if (buf.length !== o.width * o.height * o.components) throw new Error("buffer size mismatch");
      if (o.colorSpace === "RGB" && !KNOWN_PROFILES.has(o.colorProfile)) throw new Error("Photoshop Error. Code: -26120. Message: Unknown color profile null");
      return { ...o, buf: new Uint8Array(buf), dispose() {} };
    },
    async putPixels({ documentID, layerID, imageData: d }) {
      const doc = docById(documentID);
      if (!doc.mode.startsWith("RGB") || d.colorProfile !== doc.colorProfileName) throw new Error("putPixels: document is not RGB with this profile"); layerById(docById(documentID), layerID).rgba.set(d.buf); },
    async putSelection({ documentID, imageData: d }) { docById(documentID).selection = d.buf; },
  },
};

// the one image that is downloaded at run time comes from the decoded set instead
const realFetch = fetch;
async function fakeFetch(url, opts) {
  if (url.startsWith("https://images.unsplash.com")) {
    return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
  }
  return realFetch(url, opts);
}

const elements = {};
const el = (id) => (elements[id] = elements[id] || { id, textContent: "", scrollTop: 0, scrollHeight: 0, disabled: false,
  addEventListener(_, fn) { this.handler = fn; } });
const sandbox = {
  require: (m) => {
    if (m === "photoshop") return photoshop;
    if (m === "uxp") return { versions: { uxp: "mock" }, storage: { localFileSystem, formats: { binary: "binary", utf8: "utf8" } } };
    if (m === "os") return { homedir: () => home, platform: () => "mock", release: () => "0", arch: () => "x64", cpus: () => [1, 2, 3, 4] };
    // ONNX Runtime Web is a browser script: run it inside the sandbox, as UXP would
    if (m === "./wasm/ort.js") return vm.runInContext(fs.readFileSync(path.join(PROBE, "wasm", "ort.js"), "utf8") + "\n;ort", sandbox);
    return require(m);
  },
  document: { getElementById: el }, fetch: fakeFetch, console, Date, JSON, Math, String, Uint8Array, Error, Set,
  Object, Promise, WebAssembly, module: { exports: {} },
  setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, TextDecoder, TextEncoder, performance,
  navigator: { userAgent: "UXP mock" },
};
vm.runInNewContext(fs.readFileSync(path.join(PROBE, "probe.js"), "utf8"), sandbox);
const probe = sandbox.module.exports;

async function wasmOnly() {
  // HARNESS_WASM=1: the unsafe test only, with the real ONNX Runtime Web and
  // models from probe/wasm (built by tools/build_wasm_assets.sh)
  const r = probe.report;
  await elements.wasm.handler({ target: elements.wasm }); // first click only arms it
  if (r.wasm) { console.error("FAIL: WebAssembly ran on the first click"); process.exit(1); }
  await elements.wasm.handler({ target: elements.wasm });
  console.log(elements.log.textContent);
  const bad = r.wasm.steps.filter((x) => !x.ok);
  if (!r.wasm.finished || bad.length) { console.error("FAIL:", JSON.stringify(bad)); process.exit(1); }
  const saved = JSON.parse(fs.readFileSync(path.join(r.resultsFolder, "unflatten-probe-report.json"), "utf8"));
  if (!saved.wasm || saved.wasm.steps.length !== r.wasm.steps.length) { console.error("FAIL: WebAssembly steps not saved"); process.exit(1); }
  console.log("HARNESS WASM OK");
}

(async () => {
  if (process.env.HARNESS_WASM) return wasmOnly();
  await elements.run.handler({ target: elements.run });
  const r = probe.report;
  const fail = (m) => { console.error("FAIL:", m, "\n", elements.log.textContent); process.exit(1); };
  if (!r.finished) fail("suite did not finish");
  if (!r.resultsFolder || !r.resultsFolder.includes("Desktop")) fail(`results not on Desktop: ${r.resultsFolder}`);
  const files = fs.readdirSync(r.resultsFolder);
  if (!files.includes("unflatten-probe-report.json")) fail("report not written");
  const tested = r.images.filter((i) => !i.skipped);
  if (tested.length < 7) fail(`only ${tested.length} images tested`);
  for (const img of tested) {
    for (const name of ["open", "Select Subject", "Remove Background", "Content-Aware Fill behind subject"]) {
      const c = img.checks.find((x) => x.name.endsWith(name));
      if (!c || !c.ok) fail(`${img.id} ${name}: ${c && (c.error || JSON.stringify(c.detail))}`);
    }
    const mao = img.checks.find((x) => x.name.endsWith("Mask All Objects"));
    if (!mao || !mao.ok) fail(`${img.id} Mask All Objects with the built-in command: ${mao && (mao.error || JSON.stringify(mao.detail))}`);
  }
  for (const img of tested) {
    if (!files.some((f) => /^.+_thumb_\d+x\d+\.rgb$/.test(f) && f.startsWith(img.id + "_thumb_"))) fail(`${img.id}: thumbnail file missing or misnamed`);
  }
  if (docs.some((d) => !d.closed)) fail("probe left documents open");
  if (r.accuracy.length !== probe.SCENES.length) fail("scene tests missing");
  if (r.wasm) fail("WebAssembly must not run as part of the safe tests");
  if (fs.readdirSync(dataDir).length === 0 && !r.images.find((i) => i.id === "A_wall").skipped) fail("download cache unused");
  // second run after a recording like the one made in Photoshop 27.1
  r.recorded.push({ event: "invokeCommand", descriptor: { commandID: 1234, _isCommand: true } },
                  { event: "historyStateChanged", descriptor: { name: "Mask All Objects" } },
                  { event: "autoMaskGenerate", descriptor: { _isCommand: true, documentID: 1, _target: [{ _ref: "document", _id: 1 }] } });
  r.images.length = 0; r.accuracy.length = 0;
  await elements.run.handler({ target: elements.run });
  for (const img of r.images.filter((i) => !i.skipped)) {
    const mao = img.checks.find((x) => x.name.endsWith("Mask All Objects"));
    if (!mao || !mao.ok || mao.detail.created < 2) fail(`${img.id} Mask All Objects after recording: ${mao && (mao.error || JSON.stringify(mao.detail))}`);
  }
  console.log(elements.log.textContent);
  console.log(`results: ${files.length} files in ${r.resultsFolder}`);
  console.log("HARNESS OK");
})().catch((e) => { console.error(e); process.exit(1); });
