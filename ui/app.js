// ---------- CONFIG ----------
const POLL_MS = 6000;             // refresh UI every 6s
const DATA_URL = "./data.json";   // local JSON now; later replace with backend endpoint

// OSM tile layer
const OSM_TILES = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";

// Local storage keys
const KEY_PAYLOAD = "lews_payload";
const KEY_ACK_AT = "lews_ack_at";
const KEY_MUTED = "lews_muted";

// ---------- STATE ----------
let map, markersLayer, baseTileLayer;
let lastPayload = null;
let alarmInterval = null;

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

function getMuted() {
  return localStorage.getItem(KEY_MUTED) === "1";
}

function setMuted(v) {
  localStorage.setItem(KEY_MUTED, v ? "1" : "0");
  updateAlarmText();
}

function getAckAt() {
  return localStorage.getItem(KEY_ACK_AT); // ISO string or null
}

function setAckNow() {
  const now = new Date().toISOString();
  localStorage.setItem(KEY_ACK_AT, now);
  updateAckText();
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
    updateMarkers([]);
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

// ---------- TIMELINE (chart + list) ----------
function drawTimelineChart(history) {
  const canvas = document.getElementById("timelineChart");
  if (!canvas) return;

  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;

  // Clear
  ctx.clearRect(0, 0, w, h);

  // Background grid
  ctx.globalAlpha = 1;
  ctx.fillStyle = "#0e1730";
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = "#223152";
  ctx.lineWidth = 1;
  for (let i = 1; i <= 4; i++) {
    const y = (h * i) / 5;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  if (!history || history.length < 2) {
    ctx.fillStyle = "#93a4c7";
    ctx.font = "12px monospace";
    ctx.fillText("No timeline data", 10, 20);
    return;
  }

  const pad = 10;
  const innerH = h - pad * 2;
  const innerW = w - pad * 2;

  const n = history.length;
  const xStep = innerW / (n - 1);

  // Line segments
  for (let i = 0; i < n - 1; i++) {
    const a = history[i];
    const b = history[i + 1];

    const ya = pad + (1 - clamp(Number(a.confidence ?? 0), 0, 1)) * innerH;
    const yb = pad + (1 - clamp(Number(b.confidence ?? 0), 0, 1)) * innerH;

    const xa = pad + i * xStep;
    const xb = pad + (i + 1) * xStep;

    const dec = String(b.decision || "NO").toUpperCase();
    ctx.strokeStyle = (dec === "YES") ? "#ff4d4f" : "#26d07c";
    ctx.lineWidth = 3;

    ctx.beginPath();
    ctx.moveTo(xa, ya);
    ctx.lineTo(xb, yb);
    ctx.stroke();
  }

  // Dots
  for (let i = 0; i < n; i++) {
    const p = history[i];
    const x = pad + i * xStep;
    const y = pad + (1 - clamp(Number(p.confidence ?? 0), 0, 1)) * innerH;
    const dec = String(p.decision || "NO").toUpperCase();

    ctx.fillStyle = (dec === "YES") ? "#ff4d4f" : "#26d07c";
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fill();
  }

  // Labels
  ctx.fillStyle = "#cfe0ff";
  ctx.font = "11px ui-monospace, Menlo, Consolas, monospace";
  ctx.fillText(history[0].t || "start", 10, h - 8);
  const last = history[history.length - 1].t || "now";
  ctx.fillText(last, w - 60, h - 8);
}

function setTimeline(payload) {
  const history = payload.history || [];
  drawTimelineChart(history);

  const list = document.getElementById("timelineList");
  if (!list) return;

  list.innerHTML = "";
  const tail = history.slice(-6).reverse();

  if (tail.length === 0) {
    list.innerHTML = `<div class="muted">No timeline points</div>`;
    return;
  }

  tail.forEach(p => {
    const dec = String(p.decision || "NO").toUpperCase();
    const row = document.createElement("div");
    row.className = `tRow ${dec === "YES" ? "tYes" : "tNo"}`;
    row.innerHTML = `
      <div class="tLeft">${p.t || "—"} → <b>${dec}</b></div>
      <div class="tRight">conf ${Number(p.confidence ?? 0).toFixed(2)}</div>
    `;
    list.appendChild(row);
  });
}

// ---------- ACK / ALARM ----------
function updateAckText() {
  const ackEl = document.getElementById("ackText");
  const ackAt = getAckAt();
  if (!ackEl) return;

  if (!ackAt) {
    ackEl.textContent = "NOT ACKED";
    ackEl.style.color = "#ffd6d6";
    return;
  }

  const d = new Date(ackAt);
  ackEl.textContent = `ACK @ ${d.toLocaleTimeString()}`;
  ackEl.style.color = "#c9ffe8";
}

function updateAlarmText() {
  const el = document.getElementById("alarmText");
  if (!el) return;

  const muted = getMuted();
  el.textContent = muted ? "MUTED" : "ARMED";
}

function shouldAlarm(payload) {
  if (!payload) return false;

  const decision = String(payload.decision || "NO").toUpperCase();
  if (decision !== "YES") return false;

  if (getMuted()) return false;
  if (getAckAt()) return false;

  return true;
}

function playBeepOnce() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();

    o.type = "square";
    o.frequency.value = 880;
    g.gain.value = 0.05;

    o.connect(g);
    g.connect(ctx.destination);

    o.start();
    setTimeout(() => {
      o.stop();
      ctx.close();
    }, 180);
  } catch {
    // No audio available -> ignore
  }
}

function startAlarm() {
  if (alarmInterval) return;
  log("ALARM ACTIVE 🔥 (YES decision not acknowledged)");

  // beep pattern
  alarmInterval = setInterval(() => {
    playBeepOnce();
    setTimeout(playBeepOnce, 250);
    setTimeout(playBeepOnce, 500);
  }, 2000);
}

function stopAlarm() {
  if (!alarmInterval) return;
  clearInterval(alarmInterval);
  alarmInterval = null;
  log("Alarm stopped ✅");
}

// ---------- CACHE ----------
function saveCache(payload) {
  try {
    localStorage.setItem(KEY_PAYLOAD, JSON.stringify(payload));
  } catch {}
}

function loadCache() {
  try {
    const raw = localStorage.getItem(KEY_PAYLOAD);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ---------- DATA ----------
async function fetchPayload() {
  const r = await fetch(DATA_URL, { cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.json();
}

// ---------- APPLY ----------
function applyPayload(payload, sourceMsg) {
  lastPayload = payload;

  setMetrics(payload);
  setBannerDecision(payload);
  setChips(payload);
  setFactors(payload);
  setTimeline(payload);
  setHotspots(payload);
  setSMS(payload);

  saveCache(payload);
  updateAckText();
  updateAlarmText();

  // Alarm logic
  if (shouldAlarm(payload)) startAlarm();
  else stopAlarm();

  log(sourceMsg);
}

// ---------- REPORT DOWNLOAD ----------
function downloadReport(payload) {
  const dec = String(payload.decision || "NO").toUpperCase();
  const lines = [];

  lines.push("SENTINEL-LEWS SITUATION REPORT");
  lines.push("--------------------------------");
  lines.push(`District: ${payload.district || "-"}`);
  lines.push(`Updated:  ${payload.updated_at_local || new Date().toLocaleString()}`);
  lines.push(`Decision: ${dec}`);
  lines.push(`Confidence: ${(Number(payload.confidence ?? 0)).toFixed(2)}`);
  lines.push(`Lead Time (h): ${payload.lead_time_hours ?? "-"}`);
  lines.push("");
  lines.push("Summary:");
  lines.push(payload.summary || "-");
  lines.push("");
  lines.push("Factors:");
  (payload.factors || []).forEach(f => {
    lines.push(`- ${f.name}: ${f.value} (${String(f.level || "LOW").toUpperCase()})`);
  });
  lines.push("");
  lines.push("Hotspots:");
  (payload.hotspots || []).forEach(h => {
    lines.push(`- ${h.name}: ${String(h.decision || "NO").toUpperCase()} (conf ${(Number(h.confidence ?? 0)).toFixed(2)}) @ ${h.lat},${h.lon}`);
  });
  lines.push("");
  lines.push("SMS:");
  lines.push(String(payload.sms || "").slice(0, 160));
  lines.push("");

  const text = lines.join("\n");
  const blob = new Blob([text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  a.href = url;
  a.download = `LEWS_Report_${stamp}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);

  log("Downloaded Situation Report ✅");
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
    if (cached) applyPayload(cached, "Loaded cached payload ✅ (offline)");
    else log("No cache available ❌");
  }
}

// ---------- BOOT ----------
window.addEventListener("load", async () => {
  await registerServiceWorker();
  initMap();

  // Buttons
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

  document.getElementById("btnAck").addEventListener("click", () => {
    if (!lastPayload) return;

    const dec = String(lastPayload.decision || "NO").toUpperCase();
    if (dec !== "YES") {
      log("ACK ignored (decision is NO)");
      return;
    }

    setAckNow();
    stopAlarm();
    log("ALERT ACKNOWLEDGED ✅");
  });

  document.getElementById("btnMute").addEventListener("click", () => {
    const muted = getMuted();
    setMuted(!muted);
    document.getElementById("btnMute").textContent = !muted ? "Unmute" : "Mute";

    // If unmuted and YES and not acked -> alarm should start again
    if (lastPayload && shouldAlarm(lastPayload)) startAlarm();
    else stopAlarm();

    log(!muted ? "Alarm muted ✅" : "Alarm unmuted ✅");
  });

  document.getElementById("btnReport").addEventListener("click", () => {
    const payload = lastPayload || loadCache();
    if (!payload) {
      log("No payload available for report ❌");
      return;
    }
    downloadReport(payload);
  });

  // Boot from cache if exists
  const cached = loadCache();
  if (cached) {
    setConn(false);
    applyPayload(cached, "Booted from cache ✅");
  } else {
    updateAckText();
    updateAlarmText();
    log("Booting fresh…");
  }

  // Init mute button label
  document.getElementById("btnMute").textContent = getMuted() ? "Unmute" : "Mute";

  refresh();
  setInterval(refresh, POLL_MS);
});
