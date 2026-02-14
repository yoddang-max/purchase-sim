const el = {
  file: document.getElementById("csvFile"),
  load: document.getElementById("btnLoad"),
  next: document.getElementById("btnNext"),
  play: document.getElementById("btnPlay"),
  reset: document.getElementById("btnReset"),
  status: document.getElementById("status"),
  stats: document.getElementById("stats"),
  log: document.getElementById("log"),
  canvas: document.getElementById("viz"),
  tooltip: document.getElementById("tooltip"),
};

const ctx = el.canvas.getContext("2d");

let state = {
  purchases: [],        // normalized {date, datetime, item, price}
  byDay: new Map(),     // date -> purchases[]
  days: [],             // sorted unique YYYY-MM-DD
  dayIndex: 0,

  totals: { spend: 0, count: 0 },
  itemCount: new Map(), // item -> count

  playing: false,
  timer: null,
};

// View transform for zoom/pan (world -> screen): screen = world*scale + offset
const view = {
  scale: 1,
  offsetX: 0,
  offsetY: 0,
  isDragging: false,
  dragStartX: 0,
  dragStartY: 0,
  dragOffsetX: 0,
  dragOffsetY: 0,
};

// points cache for hover hit-test
let drawnPoints = []; // {sx, sy, r, purchase}

function setStatus(msg) { el.status.textContent = msg; }

function addLog(msg) {
  const line = document.createElement("div");
  line.textContent = msg;
  el.log.prepend(line);
  while (el.log.childNodes.length > 200) el.log.removeChild(el.log.lastChild);
}

function clearLog() { el.log.innerHTML = ""; }

function enableControls(enabled) {
  el.next.disabled = !enabled;
  el.play.disabled = !enabled;
  el.reset.disabled = !enabled;
}

function toNumber(v) {
  // "12,900원" 같은 케이스 대비
  const s = String(v).replace(/[^\d.-]/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

function toISODateTimeKoreanDot(v) {
  // "2025. 12. 27. 14:45" -> { date:"2025-12-27", datetime:"2025-12-27 14:45" }
  const s = String(v).trim();
  const nums = s.match(/\d+/g);
  if (!nums || nums.length < 3) return null;

  const yyyy = (nums[0] ?? "").padStart(4, "0");
  const mm   = (nums[1] ?? "01").padStart(2, "0");
  const dd   = (nums[2] ?? "01").padStart(2, "0");
  const HH   = (nums[3] ?? "00").padStart(2, "0");
  const Min  = (nums[4] ?? "00").padStart(2, "0");

  const date = `${yyyy}-${mm}-${dd}`;
  const datetime = `${date} ${HH}:${Min}`;
  return { date, datetime };
}

function normalizeRow(row) {
  // transformHeader로 이미 lower-case + trim 됨
  const rawDate = row["order_date"];
  const rawItem = row["product_name"];
  const rawPrice = row["price"];

  if (!rawDate || !rawItem || rawPrice == null) return null;

  const dt = toISODateTimeKoreanDot(rawDate);
  if (!dt) return null;

  const item = String(rawItem).trim();
  const price = toNumber(rawPrice);

  if (!item || !Number.isFinite(price)) return null;

  return { date: dt.date, datetime: dt.datetime, item, price };
}

function buildIndex(purchases) {
  state.byDay = new Map();
  for (const p of purchases) {
    if (!state.byDay.has(p.date)) state.byDay.set(p.date, []);
    state.byDay.get(p.date).push(p);
  }
  state.days = Array.from(state.byDay.keys()).sort();
  state.dayIndex = 0;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

function renderStats() {
  const topItems = Array.from(state.itemCount.entries())
    .sort((a,b) => b[1] - a[1])
    .slice(0, 6);

  el.stats.innerHTML = `
    <div><b>Rows loaded:</b> ${state.purchases.length}</div>
    <div><b>Days:</b> ${state.days.length}</div>
    <div><b>Total count (played):</b> ${state.totals.count}</div>
    <div><b>Total spend (played):</b> ${Math.round(state.totals.spend).toLocaleString()}</div>
    <div style="margin-top:10px;"><b>Top items (played)</b></div>
    ${topItems.map(([k,v]) => `<div title="${escapeHtml(k)}">${escapeHtml(k.length>28 ? k.slice(0,28)+"…" : k)}: ${v}</div>`).join("")}
  `;
}

function stopPlay() {
  state.playing = false;
  if (state.timer) { clearInterval(state.timer); state.timer = null; }
  el.play.textContent = "Play";
}

function resetSim() {
  stopPlay();

  state.dayIndex = 0;
  state.totals = { spend: 0, count: 0 };
  state.itemCount = new Map();

  view.scale = 1;
  view.offsetX = 0;
  view.offsetY = 0;
  hideTooltip();

  clearLog();
  draw();
  renderStats();
  setStatus("reset");
}

function stepOneDay() {
  if (state.dayIndex >= state.days.length) {
    setStatus("done");
    stopPlay();
    return;
  }

  const day = state.days[state.dayIndex];
  const todays = state.byDay.get(day) ?? [];

  for (const p of todays) {
    state.totals.spend += p.price;
    state.totals.count += 1;
    state.itemCount.set(p.item, (state.itemCount.get(p.item) ?? 0) + 1);

    const shortName = p.item.length > 50 ? p.item.slice(0, 50) + "…" : p.item;
    addLog(`${p.datetime} — ${shortName} — ${p.price.toLocaleString()}`);
  }

  state.dayIndex += 1;
  renderStats();
  draw();
  setStatus(`day ${state.dayIndex}/${state.days.length}`);
}

function togglePlay() {
  if (state.playing) { stopPlay(); return; }
  state.playing = true;
  el.play.textContent = "Pause";
  state.timer = setInterval(stepOneDay, 250);
}

/* ===========================
   DRAW (axes labels + zoom/pan + points cache)
=========================== */
function draw() {
  const W = el.canvas.width, H = el.canvas.height;
  const margin = 56;

  // background
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);

  // axes frame
  ctx.strokeStyle = "#111";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(margin, H - margin);
  ctx.lineTo(W - margin, H - margin);
  ctx.lineTo(W - margin, margin);
  ctx.stroke();

  // axis labels
  ctx.fillStyle = "#111";
  ctx.font = "12px system-ui, -apple-system, sans-serif";
  ctx.fillText("X: Order date (time →)", margin, H - 18);

  ctx.save();
  ctx.translate(18, H / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText("Y: Price (relative to max shown)", 0, 0);
  ctx.restore();

  // current data range (played)
  const shownDays = state.days.slice(0, state.dayIndex);
  if (shownDays.length === 0) {
    ctx.fillStyle = "#555";
    ctx.fillText("Load a file, then press Next Day / Play.", margin, margin);
    drawnPoints = [];
    return;
  }

  // compute max price among shown for scaling
  let maxP = 0;
  for (const d of shownDays) {
    for (const p of (state.byDay.get(d) ?? [])) maxP = Math.max(maxP, p.price);
  }
  maxP = Math.max(maxP, 1);

  const plotW = (W - margin * 2);
  const plotH = (H - margin * 2);

  const xStep = plotW / Math.max(state.days.length - 1, 1);

  function worldToScreen(wx, wy) {
    // base plot origin at (margin, H-margin)
    const baseX = margin + wx;
    const baseY = (H - margin) - wy;

    const ox = margin, oy = H - margin;
    const sx = (baseX - ox) * view.scale + ox + view.offsetX;
    const sy = (baseY - oy) * view.scale + oy + view.offsetY;
    return { sx, sy };
  }

  // top info
  ctx.fillStyle = "#555";
  ctx.font = "11px system-ui, -apple-system, sans-serif";
  ctx.fillText(`Max price (shown): ${Math.round(maxP).toLocaleString()}`, margin, margin - 18);
  ctx.fillText(`Zoom: ${(view.scale * 100).toFixed(0)}% (wheel)  |  Pan: drag`, margin, margin - 2);

  // draw points
  drawnPoints = [];
  ctx.fillStyle = "#111";

  for (let i = 0; i < shownDays.length; i++) {
    const d = shownDays[i];
    const wx = i * xStep;
    const list = state.byDay.get(d) ?? [];

    for (const p of list) {
      const wy = (p.price / maxP) * plotH; // 0..plotH

      const rWorld = Math.max(2, Math.min(12, (p.price / maxP) * 12));
      const { sx, sy } = worldToScreen(wx, wy);
      const r = rWorld * view.scale;

      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fill();

      drawnPoints.push({ sx, sy, r, purchase: p });
    }
  }
}

/* ===========================
   TOOLTIP + INTERACTION
=========================== */
function hideTooltip() {
  el.tooltip.style.display = "none";
}

function showTooltip(x, y, p) {
  el.tooltip.style.display = "block";
  el.tooltip.style.left = `${x + 12}px`;
  el.tooltip.style.top = `${y + 12}px`;
  el.tooltip.textContent = `${p.datetime} — ${p.item} — ${p.price.toLocaleString()}`;
}

function findPointUnderMouse(mx, my) {
  let best = null;
  let bestDist = Infinity;

  for (const pt of drawnPoints) {
    const dx = mx - pt.sx;
    const dy = my - pt.sy;
    const dist = Math.hypot(dx, dy);
    const hitR = Math.max(pt.r, 6);
    if (dist <= hitR && dist < bestDist) {
      best = pt;
      bestDist = dist;
    }
  }
  return best;
}

// Hover tooltip + drag pan
el.canvas.addEventListener("mousemove", (e) => {
  const rect = el.canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;

  if (view.isDragging) {
    view.offsetX = view.dragOffsetX + (e.clientX - view.dragStartX);
    view.offsetY = view.dragOffsetY + (e.clientY - view.dragStartY);
    hideTooltip();
    draw();
    return;
  }

  const hit = findPointUnderMouse(mx, my);
  if (hit) showTooltip(e.clientX, e.clientY, hit.purchase);
  else hideTooltip();
});

el.canvas.addEventListener("mouseleave", () => {
  hideTooltip();
  view.isDragging = false;
});

// Pan by drag
el.canvas.addEventListener("mousedown", (e) => {
  view.isDragging = true;
  view.dragStartX = e.clientX;
  view.dragStartY = e.clientY;
  view.dragOffsetX = view.offsetX;
  view.dragOffsetY = view.offsetY;
});

window.addEventListener("mouseup", () => {
  view.isDragging = false;
});

// Zoom with wheel (zoom around mouse position)
el.canvas.addEventListener("wheel", (e) => {
  e.preventDefault();

  const rect = el.canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;

  const W = el.canvas.width, H = el.canvas.height;
  const margin = 56;

  // origin in screen space, including current offset
  const ox = margin + view.offsetX;
  const oy = (H - margin) + view.offsetY;

  const rx = mx - ox;
  const ry = my - oy;

  const zoomFactor = Math.exp(-e.deltaY * 0.001);
  const newScale = Math.min(6, Math.max(0.4, view.scale * zoomFactor));

  const scaleChange = newScale / view.scale;
  view.offsetX = view.offsetX + rx * (1 - scaleChange);
  view.offsetY = view.offsetY + ry * (1 - scaleChange);
  view.scale = newScale;

  hideTooltip();
  draw();
}, { passive: false });

/* ===========================
   LOAD (CSV/TSV auto) + CONTROLS
=========================== */
el.load.addEventListener("click", () => {
  const file = el.file.files?.[0];
  if (!file) { setStatus("Choose a CSV/TSV file"); return; }

  setStatus("parsing...");

  const parseWith = (delimiter) => new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      delimiter, // "," or "\t"
      transformHeader: (h) => String(h).replace(/^\uFEFF/, "").trim().toLowerCase(),
      complete: (res) => resolve(res),
      error: (err) => reject(err),
    });
  });

  (async () => {
    try {
      // Try CSV first, then TSV if headers look wrong
      let res = await parseWith(",");
      const fields = res.meta?.fields ?? [];
      if (fields.length <= 1) res = await parseWith("\t");

      const normalized = [];
      for (const row of res.data) {
        const r = normalizeRow(row);
        if (r) normalized.push(r);
      }

      if (normalized.length === 0) {
        setStatus(`No valid rows. Detected headers: ${(res.meta?.fields ?? []).join(", ")}`);
        enableControls(false);
        return;
      }

      // sort by datetime
      normalized.sort((a,b) => (a.datetime < b.datetime ? -1 : 1));

      state.purchases = normalized;
      buildIndex(normalized);
      resetSim();
      enableControls(true);
      setStatus(`Loaded ${normalized.length} rows`);
    } catch {
      setStatus("Parse error");
      enableControls(false);
    }
  })();
});

el.next.addEventListener("click", stepOneDay);
el.play.addEventListener("click", togglePlay);
el.reset.addEventListener("click", resetSim);

// initial
enableControls(false);
draw();
renderStats();
