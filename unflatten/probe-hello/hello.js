// Smallest possible panel: no permissions, no buttons, nothing that touches
// documents. It only separates "Photoshop cannot load test plugins at all"
// from "something in the probe stops it loading".
try {
  const v = require("photoshop").app.version;
  document.getElementById("info").textContent = `It works. Photoshop ${v} loads test plugins correctly.`;
} catch (e) {
  document.getElementById("info").textContent = "Loaded, but: " + ((e && e.message) || e);
}
