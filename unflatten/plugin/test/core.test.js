// Unit tests for core.js on a synthetic scene where every answer is known:
// a textured background, two overlapping figures (the lower one in front), a
// small badge on one figure, and a scenery strip across the whole frame.
//   node test/core.test.js
const assert = require("assert");
const core = require("../core.js");

const w = 240, h = 160, n = w * h;
let seed = 7;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

const bg = new Uint8Array(n * 3);
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
  const i = 3 * (y * w + x), t = (rand() - 0.5) * 12;
  bg[i] = 90 + x / 4 + t; bg[i + 1] = 120 + y / 4 + t; bg[i + 2] = 160 + t;
}
// soft-edged disc coverage (4x supersampled)
function disc(cx, cy, r) {
  const m = new Float32Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let c = 0;
    for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
      if ((x + (sx + 0.5) / 4 - cx) ** 2 + (y + (sy + 0.5) / 4 - cy) ** 2 < r * r) c++;
    }
    m[y * w + x] = c / 16;
  }
  return m;
}
const back = disc(95, 70, 38), front = disc(140, 95, 40), badge = disc(140, 52, 7);
const colours = [[200, 60, 40], [40, 160, 70], [250, 230, 30]];
const rgb = bg.slice();
for (const [m, col] of [[back, colours[0]], [front, colours[1]], [badge, colours[2]]]) {
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) rgb[3 * i + c] = Math.round(col[c] * m[i] + rgb[3 * i + c] * (1 - m[i]));
}
const hard = (m) => { const o = new Uint8Array(n); for (let i = 0; i < n; i++) o[i] = m[i] >= 0.5 ? 255 : 0; return o; };
const soft = new Uint8Array(n);
for (let i = 0; i < n; i++) soft[i] = Math.round(255 * Math.max(back[i], front[i], badge[i]));
const scenery = new Uint8Array(n);
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (y > 0.1 * h) scenery[y * w + x] = 255; // floor-like
// as Mask All Objects returns them: the back figure is cut where the front one covers it
const backOnly = hard(back).map((v, i) => (front[i] >= 0.5 ? 0 : v));
const objects = [backOnly, hard(front), hard(badge), scenery];

// which masks become layers
const list = core.stackOrder(core.instances(soft, objects, w, h), w, h);
assert.strictEqual(list.length, 2, "two figures; badge merged into the front one; scenery dropped");
assert.strictEqual(list[1].parts, 2, "the front figure carries the badge");
assert.ok(core.bboxOf(list[1].mask, w, h)[3] > core.bboxOf(list[0].mask, w, h)[3], "lower figure is in front");

// exact recomposition with the true background as the rebuilt one
const hole = core.holeOf(list, w, h);
const rebuilt = rgb.slice();
for (let i = 0; i < n; i++) if (hole[i] > 127) for (let c = 0; c < 3; c++) rebuilt[3 * i + c] = bg[3 * i + c];
const built = core.buildLayers(rgb, rebuilt, w, h, list, soft);
const comp = core.composite(built.background, built.layers, w, h);
let maxErr = 0;
for (let i = 0; i < comp.length; i++) maxErr = Math.max(maxErr, Math.abs(comp[i] - rgb[i]));
assert.ok(maxErr <= 1, `layers recombine to the original (max error ${maxErr})`);

// the figures are clean: solid inside, their own colour, transparent outside
const at = (l, x, y) => [...l.rgba.slice(4 * (y * w + x), 4 * (y * w + x) + 4)];
assert.deepStrictEqual(at(built.layers[1], 140, 95), [40, 160, 70, 255]);
assert.deepStrictEqual(at(built.layers[0], 80, 70), [200, 60, 40, 255]);
assert.strictEqual(at(built.layers[0], 20, 20)[3], 0);
// no ghost: away from the figures the background keeps the true background
let ghost = 0;
for (let i = 0; i < n; i++) if (hole[i] > 127 && back[i] === 0 && front[i] === 0 && badge[i] === 0) {
  for (let c = 0; c < 3; c++) ghost = Math.max(ghost, Math.abs(built.background[3 * i + c] - bg[3 * i + c]));
}
assert.ok(ghost <= 1, `rebuilt background keeps no outline of the figures (max ${ghost})`);
// edge pixels: opacity follows the true coverage
let edgeErr = 0, edges = 0;
for (let i = 0; i < n; i++) if (front[i] > 0.1 && front[i] < 0.9 && back[i] === 0 && badge[i] === 0) {
  edgeErr += Math.abs(built.layers[1].rgba[4 * i + 3] / 255 - front[i]); edges++;
}
assert.ok(edgeErr / edges < 0.12, `edge opacity close to coverage (mean error ${(edgeErr / edges).toFixed(3)})`);
// underlap: the back figure continues under the front one near their meeting line
let underlap = 0;
for (let i = 0; i < n; i++) if (built.layers[1].rgba[4 * i + 3] === 255 && built.layers[0].rgba[4 * i + 3] === 255) underlap++;
assert.ok(underlap > 50, `back figure continues a little under the front one (${underlap} px)`);

// fill check: the true background passes, an invented object fails
assert.ok(core.checkFill(rebuilt, w, h, hole).ok, "true background passes the fill check");
const invented = rebuilt.slice();
for (let i = 0; i < n; i++) if (hole[i] > 127 && (i % w) % 12 < 6) invented.set([20, 120, 120], 3 * i);
assert.ok(!core.checkFill(invented, w, h, hole).ok, "an invented striped object fails the fill check");

// graphic vs photo
const poster = new Uint8Array(n * 3);
for (let i = 0; i < n; i++) poster.set((i % w) < w / 2 ? [250, 210, 20] : [20, 40, 90], 3 * i);
assert.ok(core.isGraphic(poster, w, h), "flat two-colour poster is a graphic");
assert.ok(!core.isGraphic(rgb, w, h), "textured scene is a photo");

// names until the naming add-on: left to right
assert.deepStrictEqual(core.layerNames(list, w, h), ["Subject 1", "Subject 2"]);

console.log(`CORE OK (recomposition max error ${maxErr}, edge opacity error ${(edgeErr / edges).toFixed(3)})`);
