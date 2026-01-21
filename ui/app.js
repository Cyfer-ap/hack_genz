// ---------- CONFIG ----------
const API_BASE = "http://127.0.0.1:8000";
const POLL_MS = 5000;

// OSM tile layer (actual base map)
const OSM_TILES = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";

// ---------- STATE ----------
let simMode = false;
let map, markersLayer, baseTileLayer;

// ---------- HELPERS ----------
function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }

function log(msg) {
  const el = document.getElementById("log");
  const ts = new Date().toLocaleTimeString();
  el.innerHTML = `[${ts}] ${msg}\n` + el.innerHTML;
}

function setConn(mode) {
  const dot = document.getElementById("connDot");
  const text = document.getElementById("connText");

  if (mode === "ONLINE") {
    dot.className = "dot green";
    text.textContent = "ONLINE (Local API)";
  } else if (mode === "SIM") {
    dot.className = "dot yellow";
    text.textContent = "SIM MODE (Offline)";
  } else {
    dot.className = "dot red";
    text.textContent = "OFFLINE (Fallback)";
  }
}

function setMetric(id, value) {
  document.getElementById(id).textContent = value;
}

function riskLabel(alertFlag, maxRisk) {
  if (!alertFlag) return "NO ALERT";
  return `ALERT ✅ (${maxRisk.toFixed(2)})`;
}

function colorForRisk(r) {
  if (r >= 0.80) return "#ff4d4f";
  if (r >= 0.60) return "#ffb020";
  if (r >= 0.40) return "#ffd166";
  return "#26d07c";
}

// ---------- SERVICE WORKER ----------
async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    log("Service Worker not supported (offline tile cache disabled)");
    return;
  }

  try {
    const reg = await navigator.serviceWorker.register("./sw.js");
    log("Service Worker registered ✅ (offline cache enabled)");
  } catch (e) {
    log("Service Worker registration failed ❌");
  }
}

// ---------- MAP ----------
function addLegend() {
  const legend = L.control({ position: "bottomleft" });
  legend.onAdd = function () {
    const div = L.DomUtil.create("div", "legend");
    div.innerHTML = `
      <div class="legendTitle">Risk Level</div>
      <div><span class="swatch" style="background:#ff4d4f"></span> High (≥0.80)</div>
      <div><span class="swatch" style="background:#ffb020"></span> Med-High (0.60–0.79)</div>
      <div><span class="swatch" style="background:#ffd166"></span> Watch (0.40–0.59)</div>
      <div><span class="swatch" style="background:#26d07c"></span> Low (&lt;0.40)</div>
    `;
    return div;
  };
  legend.addTo(map);
}

function addBaseTiles() {
  // Actual map tiles (OSM)
  baseTileLayer = L.tileLayer(OSM_TILES, {
    maxZoom: 18,
    crossOrigin: true,
    attribution: "&copy; OpenStreetMap contributors"
  });

  // If tiles fail (offline, blocked), we keep the map background + markers
  baseTileLayer.on("tileerror", () => {
    // Do not spam logs: only note once
    if (!window.__tileErrorLogged) {
      window.__tileErrorLogged = true;
      log("Map tiles failed to load (offline/blocked). Markers still work ✅");
    }
  });

  baseTileLayer.addTo(map);
}

function initMap() {
  map = L.map("map", { zoomControl: true }).setView([31.10, 77.17], 10);

  // Add actual map tiles
  addBaseTiles();

  // Marker layer always works (offline-safe)
  markersLayer = L.layerGroup().addTo(map);

  addLegend();
}

function updateMarkers(hotspots) {
  markersLayer.clearLayers();

  hotspots.forEach(h => {
    if (h.lat == null || h.lon == null) return;

    const col = colorForRisk(h.risk);

    const m = L.circleMarker([h.lat, h.lon], {
      radius: clamp(h.risk * 18, 6, 16),
      weight: 2,
      color: col,
      fillColor: col,
      fillOpacity: 0.65
    });

    m.bindPopup(`<b>${h.name}</b><br/>Risk: ${h.risk.toFixed(2)}`);
    m.addTo(markersLayer);
  });
}

// ---------- TABLE ----------
function updateTable(hotspots) {
  const body = document.getElementById("hotspotBody");
  body.innerHTML = "";

  hotspots.slice(0, 10).forEach((h, idx) => {
    const tr = document.createElement("tr");
    tr.style.cursor = "pointer";

    tr.innerHTML = `
      <td>${idx + 1}</td>
      <td>${h.name || ("Cell-" + idx)}</td>
      <td><b>${(h.risk ?? 0).toFixed(2)}</b></td>
      <td>${h.lat ?? "—"}</td>
      <td>${h.lon ?? "—"}</td>
    `;

    tr.addEventListener("click", () => {
      if (h.lat != null && h.lon != null) {
        map.setView([h.lat, h.lon], 13);
      }
    });

    body.appendChild(tr);
  });

  if (hotspots.length === 0) {
    body.innerHTML = `<tr><td colspan="5" class="muted">No hotspots returned</td></tr>`;
  }
}

// ---------- SMS ----------
function buildSMS(areaName, maxRisk) {
  let msg = `ALERT: Landslide risk HIGH (${maxRisk.toFixed(2)}) in ${areaName} next 6h. Avoid slopes/roads. Evacuate to safe shelter. Helpline 112.`;
  return msg.slice(0, 160);
}

function updateSMS(data) {
  const sms = buildSMS("Target Zone", data.max_risk);
  const box = document.getElementById("smsText");
  const count = document.getElementById("smsCount");
  if (box) box.value = sms;
  if (count) count.textContent = sms.length;
}

// ---------- CONTROLS ----------
function getSimConfig() {
  const rain = Number(document.getElementById("rainSlider")?.value ?? 70) / 100;
  const fail = Number(document.getElementById("failSlider")?.value ?? 40) / 100;
  const thr = Number(document.getElementById("thrSlider")?.value ?? 80) / 100;
  return { rain, fail, thr };
}

function syncControlLabels(){
  const rain = document.getElementById("rainSlider").value;
  const fail = document.getElementById("failSlider").value;
  const thr = document.getElementById("thrSlider").value;

  document.getElementById("rainVal").textContent = rain;
  document.getElementById("failVal").textContent = fail;
  document.getElementById("thrVal").textContent = (thr/100).toFixed(2);
}

// ---------- SIM DATA ----------
function generateSimData(cfg) {
  const baseLat = 31.10, baseLon = 77.17;

  let maxRisk = 0.20 + 0.80 * cfg.rain - 0.12 * cfg.fail;
  maxRisk = clamp(maxRisk, 0.05, 0.99);

  const hotspots = [];
  for (let i = 0; i < 10; i++) {
    const jitterLat = baseLat + (Math.random() - 0.5) * 0.25;
    const jitterLon = baseLon + (Math.random() - 0.5) * 0.25;

    const r = clamp(
      maxRisk - i * 0.03 + (Math.random() - 0.5) * 0.04,
      0.05, 0.99
    );

    hotspots.push({
      name: `Cell-${1000 + i}`,
      risk: r,
      lat: Number(jitterLat.toFixed(5)),
      lon: Number(jitterLon.toFixed(5))
    });
  }

  hotspots.sort((a, b) => b.risk - a.risk);

  return {
    max_risk: hotspots[0].risk,
    alert: hotspots[0].risk >= cfg.thr,
    hotspots
  };
}

// ---------- API (for later) ----------
async function fetchJSON(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.json();
}

async function loadFromAPI() {
  const [hotspotsRaw, alertRaw] = await Promise.all([
    fetchJSON(`${API_BASE}/hotspots`),
    fetchJSON(`${API_BASE}/check_alert`)
  ]);

  const hotspots = (hotspotsRaw || []).map(h => ({
    name: h.name || (h.cell_id != null ? `Cell-${h.cell_id}` : "Cell"),
    risk: Number(h.risk ?? 0),
    lat: h.lat ?? null,
    lon: h.lon ?? null
  }));

  return {
    max_risk: Number(alertRaw.max_risk ?? 0),
    alert: Boolean(alertRaw.alert),
    hotspots
  };
}

// ---------- CACHE ----------
function saveCache(data) {
  try {
    localStorage.setItem("last_payload", JSON.stringify(data));
  } catch {}
}

function loadCache() {
  try {
    const raw = localStorage.getItem("last_payload");
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ---------- MAIN REFRESH ----------
function applyData(data, modeText) {
  setMetric("apiBase", API_BASE);
  setMetric("lastUpdate", new Date().toLocaleString());
  setMetric("maxRisk", data.max_risk.toFixed(2));
  setMetric("alertFlag", riskLabel(data.alert, data.max_risk));

  updateSMS(data);
  updateTable(data.hotspots);
  updateMarkers(data.hotspots);

  saveCache(data);
  log(modeText);
}

async function refresh() {
  const cfg = getSimConfig();

  if (simMode) {
    setConn("SIM");
    const data = generateSimData(cfg);
    applyData(data, "SIM refresh OK ✅");
    return;
  }

  try {
    const data = await loadFromAPI();
    setConn("ONLINE");
    applyData(data, "API refresh OK ✅");
  } catch (e) {
    setConn("OFFLINE");
    log(`API failed -> fallback: ${e.message}`);

    const cached = loadCache();
    if (cached) {
      applyData(cached, "Loaded cached state ✅");
      return;
    }

    const data = generateSimData(cfg);
    applyData(data, "Fallback sim data used ✅");
  }
}

// ---------- BOOT ----------
window.addEventListener("load", async () => {
  await registerServiceWorker();
  initMap();

  ["rainSlider","failSlider","thrSlider"].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener("input", () => {
        syncControlLabels();
        refresh();
      });
    }
  });
  syncControlLabels();

  document.getElementById("btnRefresh").addEventListener("click", refresh);

  document.getElementById("btnSim").addEventListener("click", () => {
    simMode = !simMode;
    log(simMode ? "SIM MODE ON ✅" : "SIM MODE OFF ✅");
    refresh();
  });

  document.getElementById("btnCopySms").addEventListener("click", async () => {
    const txt = document.getElementById("smsText").value || "";
    try {
      await navigator.clipboard.writeText(txt);
      log("SMS copied to clipboard ✅");
    } catch {
      log("Clipboard blocked ❌ (copy manually)");
    }
  });

  const cached = loadCache();
  if (cached) {
    setConn("OFFLINE");
    applyData(cached, "Booted from cache ✅");
  } else {
    setConn("OFFLINE");
    log("No cache found. Booting fresh…");
  }

  refresh();
  setInterval(refresh, POLL_MS);
});
