// Writes the probe's known-truth scenes exactly as the probe builds them inside
// Photoshop (same code), so the engine can be scored on identical input.
//   node export_scenes.js <out-dir>
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const out = process.argv[2];
fs.mkdirSync(out, { recursive: true });
const stub = { addEventListener() {}, textContent: "" };
const sandbox = {
  require: (m) => (m === "photoshop" ? { app: {}, core: {}, action: {}, imaging: {}, constants: {} } : m === "uxp" ? { versions: {}, storage: {} } : require(m)),
  document: { getElementById: () => stub }, console, Date, JSON, Math, String, Uint8Array, Error, Set, Object, Promise,
  module: { exports: {} },
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "probe.js"), "utf8"), sandbox);
const { buildScene, SCENES } = sandbox.module.exports;
const w = 900, h = 600;
SCENES.forEach(([kind, scale], i) => {
  const { bg, comp, hole } = buildScene(kind, scale, w, h);
  fs.writeFileSync(path.join(out, `scene${i}_comp.rgb`), Buffer.from(comp));
  fs.writeFileSync(path.join(out, `scene${i}_truth.rgb`), Buffer.from(bg));
  fs.writeFileSync(path.join(out, `scene${i}_hole.u8`), Buffer.from(hole));
});
fs.writeFileSync(path.join(out, "scenes.json"), JSON.stringify({ width: w, height: h, scenes: SCENES }));
console.log(`wrote ${SCENES.length} scenes to ${out}`);
