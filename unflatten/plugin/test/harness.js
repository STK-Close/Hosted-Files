// Runs the real panel script (../main.js with ../core.js) in Node against a
// simulated Photoshop that replays real Photoshop 27.11 results: Select
// Subject and Mask All Objects masks and Generative Fill backgrounds recorded
// by the Unflatten Probe (test/fixtures). Checks the whole one-click flow:
// layers made and named, original kept hidden, visible layers recombining to
// the original, the fill check and its fallbacks, and that a failure leaves
// the document untouched (one Undo step, rolled back).
//   node test/harness.js
// It verifies the plugin's own logic and its use of the API; Photoshop's real
// behaviour comes from the recorded fixtures.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const zlib = require("zlib");

const PLUGIN = path.join(__dirname, "..");
const FIX = path.join(__dirname, "fixtures");

function fixture(id) {
  const d = path.join(FIX, id), meta = JSON.parse(fs.readFileSync(path.join(d, "meta.json")));
  const rd = (f) => new Uint8Array(zlib.gunzipSync(fs.readFileSync(path.join(d, f))));
  const objects = [];
  for (let k = 0; k < meta.objects; k++) objects.push(rd(`object${k}.u8.gz`));
  return { w: meta.width, h: meta.height, rgb: rd("rgb.u8.gz"), subject: rd("subject.u8.gz"), objects, generative: rd("generative.u8.gz") };
}

// ---------------------------------------------------------------- simulated Photoshop

function simulate(fx, opts) {
  const { w, h } = fx, n = w * h;
  let nextId = 1;
  const calls = [];
  const doc = { id: 100, width: w, height: h, mode: opts.mode || "RGBColorMode", bitsPerChannel: "bitDepth8",
    colorProfileName: opts.profile || "sRGB IEC61966-2.1", layers: [], selection: null, active: null };
  const mkLayer = (name, rgba, extra) => {
    const l = { id: nextId++, name, rgba, mask: null, visible: true, ...extra };
    l.delete = async () => { removeLayer(doc.layers, l); };
    return l;
  };
  function removeLayer(list, l) {
    const i = list.indexOf(l);
    if (i >= 0) { list.splice(i, 1); return true; }
    return list.some((x) => x.layers && removeLayer(x.layers, l));
  }
  const base = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) { base.set(fx.rgb.subarray(3 * i, 3 * i + 3), 4 * i); base[4 * i + 3] = 255; }
  // doc.layers is top first, as in Photoshop
  const bgLayer = mkLayer("Background", base, { isBackground: true });
  // as in Photoshop: a locked background layer cannot be renamed
  Object.defineProperty(bgLayer, "isBackgroundLayer", { get() { return this.isBackground; } });
  let bgName = "Background";
  Object.defineProperty(bgLayer, "name", { get() { return bgName; }, set(v) { if (this.isBackground && v !== bgName) throw new Error("locked"); bgName = v; } });
  doc.layers.push(bgLayer);
  doc.active = doc.layers[0];
  doc.createPixelLayer = async ({ name }) => {
    const l = mkLayer(name, new Uint8Array(n * 4));
    const i = Math.max(0, doc.layers.indexOf(doc.active));
    doc.layers.splice(i, 0, l); // above the active layer
    doc.active = l;
    return l;
  };
  doc.changeMode = async (to) => { if (to !== "RGB") throw new Error("mode"); doc.mode = "RGBColorMode"; };

  const all = () => { const out = []; const walk = (ls) => ls.forEach((l) => { out.push(l); if (l.layers) walk(l.layers); }); walk(doc.layers); return out; };
  const byId = (id) => all().find((l) => l.id === id);
  function composite() {
    const out = new Float32Array(n * 3);
    const paint = (ls) => {
      for (const l of ls.slice().reverse()) {
        if (!l.visible) continue;
        if (l.layers) { paint(l.layers); continue; }
        for (let i = 0; i < n; i++) {
          const a = (l.rgba[4 * i + 3] / 255) * (l.mask ? l.mask[i] / 255 : 1);
          if (a) for (let c = 0; c < 3; c++) out[3 * i + c] = l.rgba[4 * i + c] * a + out[3 * i + c] * (1 - a);
        }
      }
    };
    paint(doc.layers);
    const u = new Uint8Array(n * 3);
    for (let i = 0; i < n * 3; i++) u[i] = Math.round(out[i]);
    return u;
  }
  const imageData = (data, ww, hh, comps) => ({ width: ww, height: hh, components: comps, getData: async () => data, dispose() {} });
  let snapshot = null;
  const KNOWN = new Set(["sRGB IEC61966-2.1", "Adobe RGB (1998)", "Gray Gamma 2.2"]);

  const photoshop = {
    app: { get activeDocument() { return doc; } },
    constants: { ChangeMode: { RGB: "RGB" } },
    core: {
      async executeAsModal(fn) {
        return fn({
          reportProgress() {},
          hostControl: {
            async suspendHistory() { snapshot = JSON.stringify({ mode: doc.mode, profile: doc.colorProfileName, layers: all().map((l) => [l.id, l.name, l.visible]) }); snapshot = { state: snapshot, layers: doc.layers.slice(), store: all().map((l) => ({ l, name: l.name, visible: l.visible, bg: l.isBackground, rgba: l.rgba && l.rgba.slice() })), mode: doc.mode, profile: doc.colorProfileName }; return 1; },
            async resumeHistory(id, commit) {
              if (!commit) { // roll back everything since suspendHistory
                doc.layers.length = 0; doc.layers.push(...snapshot.layers);
                for (const s of snapshot.store) { s.l.isBackground = false; s.l.name = s.name; s.l.isBackground = s.bg; s.l.visible = s.visible; if (s.rgba) s.l.rgba = s.rgba; }
                doc.mode = snapshot.mode; doc.colorProfileName = snapshot.profile;
                calls.push("rolled back");
              } else calls.push("committed");
            },
          },
        });
      },
    },
    action: {
      async batchPlay([d]) {
        calls.push(d._obj);
        switch (d._obj) {
          case "select": doc.active = byId(d._target[0]._id); return [{}];
          case "set":
            if (d._target[0]._property === "background") { const b = doc.layers.find((l) => l.isBackground); if (b) { b.isBackground = false; } return [{}]; }
            doc.selection = null; return [{}];
          case "assignProfile": doc.colorProfileName = d.profile; return [{}];
          case "autoCutout": doc.selection = opts.subject ? opts.subject.slice() : fx.subject.slice(); return [{}];
          case "autoMaskGenerate": {
            const group = { id: nextId++, name: "Objects", layers: [], visible: true };
            for (const m of opts.objects || fx.objects) {
              const l = mkLayer(`${doc.active.name} Object`, doc.active.rgba.slice(), {});
              l.mask = m.slice();
              group.layers.push(l);
            }
            group.delete = async () => { removeLayer(doc.layers, group); };
            doc.layers.splice(doc.layers.indexOf(doc.active), 0, group);
            return [{}];
          }
          case "syntheticFill": {
            if (!d._target || d.documentID !== doc.id || d.layerID !== doc.active.id) throw new Error('The command "Generative Fill" is not currently available.');
            if (opts.generative === "throw") throw new Error("Generative Fill failed: no credits");
            if (!doc.selection) return [{ _obj: "error", message: "no selection" }];
            // a new layer above, holding the recorded fill (or an invented shape) inside the selection
            const l = await doc.createPixelLayer({ name: "Generative Fill" });
            for (let i = 0; i < n; i++) if (doc.selection[i] > 127) {
              const inv = opts.generative === "invent" && (i % w) % 10 < 5;
              l.rgba.set(inv ? [10, 120, 120] : fx.generative.subarray(3 * i, 3 * i + 3), 4 * i); l.rgba[4 * i + 3] = 255;
            }
            return [{}];
          }
          case "fill": {
            if (!doc.selection) return [{ _obj: "error", message: "no selection" }];
            const px = doc.active.rgba; // Content-Aware stand-in: nearest unselected pixel on the left
            for (let y = 0; y < h; y++) { let last = null;
              for (let x = 0; x < w; x++) { const i = y * w + x;
                if (doc.selection[i] > 127 && last !== null) px.set(px.subarray(4 * last, 4 * last + 4), 4 * i);
                else if (doc.selection[i] <= 127) last = i; } }
            return [{}];
          }
          default: return [{ _obj: "error", message: `unknown command ${d._obj}` }];
        }
      },
    },
    imaging: {
      async getPixels() {
        const c = composite(), rgba = new Uint8Array(n * 4);
        for (let i = 0; i < n; i++) { rgba.set(c.subarray(3 * i, 3 * i + 3), 4 * i); rgba[4 * i + 3] = 255; }
        return { imageData: imageData(rgba, w, h, 4), sourceBounds: { left: 0, top: 0 } };
      },
      async getSelection() { if (!doc.selection) throw new Error("no selection"); return { imageData: imageData(doc.selection, w, h, 1), sourceBounds: { left: 0, top: 0 } }; },
      async getLayerMask({ layerID }) { const l = byId(layerID); if (!l || !l.mask) throw new Error("no mask"); return { imageData: imageData(l.mask, w, h, 1), sourceBounds: { left: 0, top: 0 } }; },
      async createImageDataFromBuffer(buf, o) {
        if (buf.length !== o.width * o.height * o.components) throw new Error("buffer size mismatch");
        if (o.colorSpace === "RGB" && !KNOWN.has(o.colorProfile)) throw new Error("Unknown color profile");
        return { ...o, buf: new Uint8Array(buf), dispose() {} };
      },
      async putPixels({ layerID, imageData: d }) {
        if (!doc.mode.startsWith("RGB")) throw new Error("putPixels: not an RGB document");
        byId(layerID).rgba.set(d.buf);
      },
      async putSelection({ imageData: d }) { doc.selection = d.buf; },
    },
  };
  return { photoshop, doc, calls, composite, all };
}

// ---------------------------------------------------------------- one click

async function click(fx, opts) {
  const sim = simulate(fx, opts);
  const elements = {};
  const el = (id) => (elements[id] = elements[id] || { id, textContent: "", value: 0, disabled: false, checked: opts.checked !== false,
    classList: { add() {}, remove() {} }, addEventListener(type, fn) { this[type] = fn; } });
  const sandbox = {
    require: (m) => (m === "photoshop" ? sim.photoshop : m === "uxp" ? {} : m === "./core.js" ? require(path.join(PLUGIN, "core.js")) : require(m)),
    document: { getElementById: el }, console, Date, JSON, Math, Uint8Array, Float32Array, Int16Array, Int32Array, Set, Map,
    Object, Promise, Error, String, Array, Number, Infinity, localStorage: { getItem() { return null; }, setItem() {} },
    module: { exports: {} },
  };
  vm.runInNewContext(fs.readFileSync(path.join(PLUGIN, "main.js"), "utf8"), sandbox);
  const t = Date.now();
  await elements.go.click();
  return { ...sim, status: elements.status.textContent, ms: Date.now() - t };
}

function maxDiff(a, b) { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; }
const fail = (m) => { console.error("FAIL:", m); process.exit(1); };

(async () => {
  const family = fixture("C_family"), rosie = fixture("D_rosie");

  // 1. six people, grayscale untagged original, Generative Fill accepted
  let r = await click(family, { mode: "grayscaleMode", profile: "None" });
  console.log(`family: ${r.status} (${r.ms} ms)`);
  if (!/^Done: 6 layers, background by Generative Fill/.test(r.status)) fail(r.status);
  const names = r.doc.layers.map((l) => l.name);
  const expect = ["Subject 1", "Subject 2", "Subject 3", "Subject 4", "Subject 5", "Subject 6"];
  if (!expect.every((x) => names.includes(x))) fail(`layer names ${names}`);
  if (names[names.length - 1] !== "Original (flattened)" || r.doc.layers[r.doc.layers.length - 1].visible) fail("original not kept hidden at the bottom");
  if (names[names.length - 2] !== "Background (rebuilt)") fail(`background layer ${names}`);
  if (r.all().some((l) => l.name.startsWith("Unflatten ·") || l.name === "Generative Fill" || l.name === "Objects")) fail("scratch layers left behind");
  const err = maxDiff(r.composite(), family.rgb);
  if (err > 2) fail(`visible layers do not recombine to the original (max ${err})`);
  if (!r.calls.includes("committed") || r.calls.filter((c) => c === "syntheticFill").length !== 1) fail(`calls ${r.calls}`);
  console.log(`  layers recombine to the original: max difference ${err}`);

  // 2. the poster: Generative Fill invents a shape -> rejected twice -> Content-Aware Fill
  r = await click(rosie, { generative: "invent", profile: "None" });
  console.log(`poster, invented fill: ${r.status}`);
  if (!/background by Content-Aware Fill/.test(r.status)) fail(r.status);
  if (r.calls.filter((c) => c === "syntheticFill").length !== 2 || !r.calls.includes("fill")) fail(`calls ${r.calls}`);
  if (maxDiff(r.composite(), rosie.rgb) > 2) fail("poster layers do not recombine");

  // 3. Generative Fill unavailable (no credits, offline) -> Content-Aware Fill
  r = await click(family, { generative: "throw" });
  console.log(`no credits: ${r.status}`);
  if (!/^Done: 6 layers, background by Content-Aware Fill/.test(r.status)) fail(r.status);

  // 4. generative switched off -> never called
  r = await click(family, { checked: false });
  console.log(`switched off: ${r.status}`);
  if (r.calls.includes("syntheticFill") || !/Content-Aware Fill/.test(r.status)) fail(`calls ${r.calls}`);

  // 5. full-frame graphic: refused, document left exactly as it was (rolled back)
  const whole = new Uint8Array(family.w * family.h).fill(255);
  r = await click(family, { subject: whole, objects: [whole], mode: "grayscaleMode", profile: "None" });
  console.log(`full-frame: ${r.status}`);
  if (!/book cover/.test(r.status) || !r.calls.includes("rolled back")) fail(r.status);
  if (r.doc.layers.length !== 1 || r.doc.layers[0].name !== "Background" || !r.doc.layers[0].visible || r.doc.mode !== "grayscaleMode") fail("document changed after a refusal");

  console.log("PLUGIN HARNESS OK");
})().catch((e) => { console.error(e); process.exit(1); });
