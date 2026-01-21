// ---------- CONFIG ----------
const POLL_MS = 6000;      // refresh UI every 6s
const DATA_URL = "./data.json";  // local JSON now; later replace with backend endpoint

// OSM tile layer (actual base map)
const OSM_TILES = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";

// ---------- STATE ----------
let map, markersLayer, baseTileLayer;

// ---------- HELPERS ----------
function log(msg) {
  const el = document.getElementById("log");
  const ts = new Date().toLocaleTimeString();
  el.innerHTML = `[${ts}] ${msg}\n` + el.innerHTML;
}

function setConn(ok) {
  const dot = document.getElementById("connDot");
  const text = document.getElementById("connText");

  dot.className = "dot " + (ok ? "green" : "red");
  text.textContent = ok ? "LOCAL DATA OK" : "OFFLINE (CACHE)";
}

function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }

function decisionColor(decision) {
  return (String(decision).toUpperCase() === "YES") ? "#ff4d4f" : "#26d07c";
}

// ---------- SERVICE WORKER ----------
async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    log("Service Worker not supported (offline cache disabled)");
    return;
  }
  try {
    await navigator.serviceWorker.register("./sw.js");
    log("Service Worker registered ✅ (offline cache enabled)");
  } catch {
    log("Service Worker registration failed ❌");
  }
}

// ---------- MAP ----------
function addBaseTiles() {
  baseTileLayer = L.tileLayer(OSM_TILES, {
    maxZoom: 18,
    crossOrigin: true,
    attribution: "&copy; OpenStreetMap contributors"
  });

  baseTileLayer.on("tileerror", () => {
    if (!window.__tileErrorLogged) {
      window.__tileErrorLogged = true;
      log("Map tiles failed to load (offline/blocked). Markers still work ✅");
    }
  });

  baseTileLayer.addTo(map);
}

function initMap() {
  map = L.map("map", { zoomControl: true }).setView([31.10, 77.17], 10);
  addBaseTiles();
  markersLayer = L.layerGroup().addTo(map);
}

function updateMarkers(hotspots) {
  markersLayer.clearLayers();

  (hotspots || []).forEach(h => {
    if (h.lat == null || h.lon == null) return;

    const dec = String(h.decision || "NO").toUpperCase();
    const col = decisionColor(dec);

    const conf = Number(h.confidence ?? 0.5);
    const radius = clamp(6 + conf * 10, 7, 16);

    const marker = L.circleMarker([h.lat, h.lon], {
      radius: radius,
      weight: 2,
      color: col,
      fillColor: col,
      fillOpacity: 0.55
    });

    marker.bindPopup(
      `<b>${h.name}</b><br/>Decision: <b style="color:${col}">${dec}</b><br/>Confidence: ${conf.toFixed(2)}`
    );

    marker.addTo(markersLayer);
  });
}

// ---------- UI UPDATES ----------
function setBannerDecision(payload) {
  const banner = document.getElementById("decisionBanner");
  const decisionText = document.getElementById("decisionText");
  const confText = document.getElementById("confidenceText");
  const leadText = document.getElementById("leadTimeText");
  const districtName = document.getElementById("districtName");
  const summaryText = document.getElementById("summaryText");

  const district = payload.district || "—";
  const decision = String(payload.decision || "NO").toUpperCase();
  const confidence = Number(payload.confidence ?? 0);
  const lead = payload.lead_time_hours ?? 6;

  districtName.textContent = district;
  summaryText.textContent = payload.summary || "—";

  // banner styles
  banner.classList.remove("yes", "no", "neutral");
  decisionText.classList.remove("yes", "no");

  if (decision === "YES") {
    banner.classList.add("yes");
    decisionText.classList.add("yes");
  } else {
    banner.classList.add("no");
    decisionText.classList.add("no");
  }

  decisionText.textContent = decision;
  confText.textContent = confidence.toFixed(2);
  leadText.textContent = `${lead} hours`;
}

function setChips(payload) {
  const row = document.getElementById("chipRow");
  row.innerHTML = "";

  (payload.factors || []).slice(0, 4).forEach(f => {
    const level = String(f.level || "LOW").toUpperCase();
    const chip = document.createElement("div");
    chip.className = "chip " + (level === "HIGH" ? "high" : level === "MEDIUM" ? "medium" : "low");
    chip.textContent = `${f.name}: ${f.value}`;
    row.appendChild(chip);
  });
}

function setFactors(payload) {
  const list = document.getElementById("factorList");
  list.innerHTML = "";

  const factors = payload.factors || [];
  if (factors.length === 0) {
    list.innerHTML = `<div class="muted">No factor info available</div>`;
    return;
  }

  factors.forEach(f => {
    const level = String(f.level || "LOW").toUpperCase();
    const badgeClass = level === "HIGH" ? "high" : level === "MEDIUM" ? "medium" : "low";

    const row = document.createElement("div");
    row.className = "factorRow";
    row.innerHTML = `
      <div class="factorLeft">
        <div class="factorName">${f.name}</div>
        <div class="factorValue">${f.value}</div>
      </div>
      <div class="badge ${badgeClass}">${level}</div>
    `;
    list.appendChild(row);
  });
}

function setHotspots(payload) {
  const body = document.getElementById("hotspotBody");
  body.innerHTML = "";

  const hotspots = payload.hotspots || [];
  if (hotspots.length === 0) {
    body.innerHTML = `<tr><td colspan="6" class="muted">No hotspots returned</td></tr>`;
    return;
  }

  hotspots.slice(0, 10).forEach((h, idx) => {
    const dec = String(h.decision || "NO").toUpperCase();
    const rowClass = dec === "YES" ? "rowYes" : "rowNo";

    const tr = document.createElement("tr");
    tr.className = rowClass;
    tr.style.cursor = "pointer";

    tr.innerHTML = `
      <td>${idx + 1}</td>
      <td><b>${h.name || "Unknown"}</b></td>
      <td><b>${dec}</b></td>
      <td>${Number(h.confidence ?? 0).toFixed(2)}</td>
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

  updateMarkers(hotspots);
}

function setSMS(payload) {
  const smsBox = document.getElementById("smsText");
  const smsCount = document.getElementById("smsCount");

  let sms = payload.sms || "";
  sms = String(sms).slice(0, 160);

  smsBox.value = sms;
  smsCount.textContent = sms.length;
}

function setMetrics(payload) {
  document.getElementById("lastUpdate").textContent =
    payload.updated_at_local || new Date().toLocaleString();
}

// ---------- CACHE ----------
function saveCache(payload) {
  try {
    localStorage.setItem("lews_payload", JSON.stringify(payload));
  } catch {}
}

function loadCache() {
  try {
    const raw = localStorage.getItem("lews_payload");
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ---------- DATA LOADER ----------
async function fetchPayload() {
  const r = await fetch(DATA_URL, { cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.json();
}

// ---------- APPLY ----------
function applyPayload(payload, sourceMsg) {
  setMetrics(payload);
  setBannerDecision(payload);
  setChips(payload);
  setFactors(payload);
  setHotspots(payload);
  setSMS(payload);

  saveCache(payload);
  log(sourceMsg);
}

// ---------- MAIN ----------
async function refresh() {
  try {
    const payload = await fetchPayload();
    setConn(true);
    applyPayload(payload, "Loaded ./data.json ✅");
  } catch (e) {
    setConn(false);

    const cached = loadCache();
    if (cached) {
      applyPayload(cached, "Loaded cached payload ✅ (offline)");
    } else {
      log("No cache available ❌");
    }
  }
}

window.addEventListener("load", async () => {
  await registerServiceWorker();
  initMap();

  document.getElementById("btnRefresh").addEventListener("click", refresh);

  document.getElementById("btnCopySms").addEventListener("click", async () => {
    const txt = document.getElementById("smsText").value || "";
    try {
      await navigator.clipboard.writeText(txt);
      log("SMS copied ✅");
    } catch {
      log("Clipboard blocked ❌ (copy manually)");
    }
  });

  const cached = loadCache();
  if (cached) {
    setConn(false);
    applyPayload(cached, "Booted from cache ✅");
  }

  refresh();
  setInterval(refresh, POLL_MS);
});
