// Runs the real panel script (../main.js) in Node against a running engine,
// with a recording stand-in for Photoshop's UXP API. Verifies what the panel
// would do to a document and recomposites the layers it would create.
//
//   node harness.js <raw-rgb-file> <width> <height> [expected-min-layers]
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const [rawPath, W, H, minLayers = "1"] = process.argv.slice(2);
const width = +W, height = +H;
const rgb = new Uint8Array(fs.readFileSync(rawPath));
const log = [];
let nextId = 100;

function makeLayer(name, extra = {}) {
  return { id: nextId++, name, visible: true, pixels: null, bounds: null, ...extra,
           async move(rel, where) { log.push(["move", this.name, rel.name, where]); } };
}

const original = makeLayer("Background", { isBackgroundLayer: true });
const doc = {
  id: 1, width, height, mode: "RGBColorMode", bitsPerChannel: 8, colorProfileName: "sRGB IEC61966-2.1",
  layers: [original], created: [],
  get backgroundLayer() { return this.layers.find((l) => l.isBackgroundLayer) || null; },
  async createPixelLayer({ name }) { const l = makeLayer(name); this.created.push(l); return l; },
  async groupLayers(ls) { const g = makeLayer("Group"); this.layers = [g]; return g; },
};

const photoshop = {
  app: { activeDocument: doc },
  constants: { DocumentMode: { RGB: "RGBColorMode" }, BitsPerChannelType: { EIGHT: 8 },
               ElementPlacement: { PLACEBEFORE: "placeBefore" } },
  action: { async batchPlay(cmds) { log.push(["batchPlay", cmds[0]._obj]); original.isBackgroundLayer = false; } },
  core: {
    async executeAsModal(fn, opts) {
      log.push(["modal", opts.commandName]);
      const ctx = {
        hostControl: {
          async suspendHistory(o) { log.push(["suspend", o.name]); return 7; },
          async resumeHistory(id, commit) { log.push(["resume", id, commit]); },
        },
        reportProgress() {},
      };
      return fn(ctx);
    },
  },
  imaging: {
    async getPixels({ componentSize }) {
      if (componentSize !== 8) throw new Error("expected 8-bit read");
      return { imageData: { width, height, components: 3, async getData() { return rgb; }, dispose() {} } };
    },
    async createImageDataFromBuffer(buf, o) {
      if (buf.length !== o.width * o.height * o.components) throw new Error("buffer size mismatch");
      log.push(["imageData", o.colorProfile]);
      return { buf: new Uint8Array(buf), ...o, dispose() {} };
    },
    async putPixels({ layerID, imageData, targetBounds }) {
      const l = doc.created.find((x) => x.id === layerID);
      l.pixels = imageData; l.bounds = targetBounds;
    },
  },
};

let clickHandler;
const el = () => ({ classList: { add() {}, remove() {} }, textContent: "", value: 0, disabled: false,
                    addEventListener(_, fn) { clickHandler = fn; } });
const elements = { go: el(), busy: el(), bar: el(), status: el() };
const sandbox = {
  require: (m) => (m === "photoshop" ? photoshop : require(m)),
  document: { getElementById: (id) => elements[id] },
  fetch, TextDecoder, setTimeout, console, Uint8Array, DataView, JSON, String, Math, Error,
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8"), sandbox);

(async () => {
  await clickHandler();
  const status = elements.status.textContent;
  const fail = (m) => { console.error("FAIL:", m, "\nstatus:", status, "\nlog:", log); process.exit(1); };
  if (!/separated/.test(status)) fail("panel did not finish");
  if (original.name !== "Original (flattened)" || original.visible) fail("original not preserved hidden");
  const names = doc.created.map((l) => l.name);
  if (names[0] !== "Background") fail("reconstructed background must be the bottom new layer");
  if (doc.created.length - 1 < +minLayers) fail(`expected >= ${minLayers} object layers, got ${names}`);
  if (new Set(names).size !== names.length) fail("duplicate names");
  if (!log.some((e) => e[0] === "suspend") || !log.some((e) => e[0] === "resume" && e[2] === true)) fail("not one undo step");
  if (!log.filter((e) => e[0] === "imageData").every((e) => e[1] === doc.colorProfileName)) fail("colour profile not passed through");

  // Recomposite what Photoshop would show and compare with the input.
  const out = new Float64Array(width * height * 3);
  for (const l of doc.created) {
    if (!l.visible) continue;
    const { buf, width: lw, height: lh } = l.pixels, { left, top } = l.bounds;
    for (let y = 0; y < lh; y++) for (let x = 0; x < lw; x++) {
      const s = (y * lw + x) * 4, a = buf[s + 3] / 255, d = ((y + top) * width + (x + left)) * 3;
      for (let c = 0; c < 3; c++) out[d + c] = buf[s + c] * a + out[d + c] * (1 - a);
    }
  }
  let se = 0;
  for (let i = 0; i < out.length; i++) se += ((out[i] - rgb[i]) / 255) ** 2;
  const psnr = 10 * Math.log10(1 / (se / out.length));
  console.log(JSON.stringify({ status, layers: names, recompositePSNR: +psnr.toFixed(2) }));
  if (psnr < 45) fail("recomposite does not match original");
})().catch((e) => { console.error(e); process.exit(1); });
