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

function setStatus(msg) { el.status.textContent = msg; }

function addLog(msg) {
  const line = document.createElement("div");
  line.textContent = msg;
  el.log.prepend(line);
  while (el.log.childNodes.length > 200) el.log.removeChild(el.log.lastChild);
}

function clearLog() { el.log.innerHTML = ""; }

function toNumber(v) {
  // "12,900원" 같은 케이스까지 대비
  const s = String(v).replace(/[^\d.-]/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

function toISODateTimeKoreanDot(v) {
  // "2025. 12. 27. 14:45" -> { date:"2025-12-27", datetime:"2025-12-27 14:45" }
  const s = String(v).trim();

  // 숫자들만 뽑기 (YYYY, MM, DD, HH, mm)
  const nums = s.match(/\d+/g);
  if (!nums || nums.length < 3) return null;

  const yyyy = nums[0]?.padStart(4, "0");
  const mm   = nums[1]?.padStart(2, "0");
  const dd   = nums[2]?.padStart(2, "0");
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

function resetSim() {
  stopPlay();
  state.dayIndex = 0;
  state.totals = { spend: 0, count: 0 };
  state.itemCount = new Map();
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

    // 로그는 너무 길면 잘라서
    const shortName = p.item.length > 36 ? p.item.slice(0, 36) + "…" : p.item;
    addLog(`${p.datetime} — ${shortName} — ${p.price.toLocaleString()}`);
  }

  state.dayIndex += 1;
  renderStats();
  draw();
  setStatus(`day ${state.dayIndex}/${state.days.length}`);
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

function escapeHtml(s) {
  return String(s)
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

function draw() {
  const W = el.canvas.width, H = el.canvas.height;
  ctx.clearRect(0, 0, W, H);

  // axis
  const margin = 46;
  ctx.globalAlpha = 1;
  ctx.beginPath();
  ctx.moveTo(margin, H - margin);
  ctx.lineTo(W - margin, H - margin);
  ctx.stroke();

  const shownDays = state.days.slice(0, state.dayIndex);
  if (shownDays.length === 0) return;

  // max price among shown for scaling
  let maxP = 0;
  for (const d of shownDays) {
    for (const p of (state.byDay.get(d) ?? [])) maxP = Math.max(maxP, p.price);
  }
  maxP = Math.max(maxP, 1);

  const xStep = (W - margin * 2) / Math.max(state.days.length - 1, 1);

  // dots
  for (let i = 0; i < shownDays.length; i++) {
    const d = shownDays[i];
    const x = margin + i * xStep;
    const list = state.byDay.get(d) ?? [];

    for (const p of list) {
      const y = (H - margin) - (p.price / maxP) * (H - margin * 2);
      const r = Math.max(2, Math.min(12, (p.price / maxP) * 12));

      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // label (current day)
  const currentDay = state.days[Math.min(state.dayIndex, state.days.length - 1)] ?? "";
  ctx.fillText(`current: ${currentDay}`, margin, 20);
}

function stopPlay() {
  state.playing = false;
  if (state.timer) { clearInterval(state.timer); state.timer = null; }
  el.play.textContent = "Play";
}

function togglePlay() {
  if (state.playing) { stopPlay(); return; }
  state.playing = true;
  el.play.textContent = "Pause";
  state.timer = setInterval(stepOneDay, 250);
}

function enableControls(enabled) {
  el.next.disabled = !enabled;
  el.play.disabled = !enabled;
  el.reset.disabled = !enabled;
}

el.load.addEventListener("click", () => {
  const file = el.file.files?.[0];
  if (!file) { setStatus("Choose a CSV/TSV file"); return; }

  setStatus("parsing...");

  const parseWith = (delimiter) => new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      delimiter, // "," or "\t"
      transformHeader: (h) => {
        // BOM 제거 + 앞뒤 공백 제거 + 소문자
        return String(h).replace(/^\uFEFF/, "").trim().toLowerCase();
      },
      complete: (res) => resolve(res),
      error: (err) => reject(err),
    });
  });

  (async () => {
    try {
      // 1차: 쉼표 CSV로 시도
      let res = await parseWith(",");

      // 헤더가 1개뿐이면(=구분자 틀렸을 확률 높음) 탭으로 재시도
      const fields = res.meta?.fields ?? [];
      if (fields.length <= 1) {
        res = await parseWith("\t");
      }

      const normalized = [];
      for (const row of res.data) {
        const r = normalizeRow(row);
        if (r) normalized.push(r);
      }

      if (normalized.length === 0) {
        // 디버깅용: 실제로 어떤 헤더로 들어왔는지 상태창에 보여줌
        setStatus(`No valid rows. Detected headers: ${(res.meta?.fields ?? []).join(", ")}`);
        enableControls(false);
        return;
      }

      normalized.sort((a,b) => (a.datetime < b.datetime ? -1 : 1));
      state.purchases = normalized;
      buildIndex(normalized);
      resetSim();
      enableControls(true);
      setStatus(`Loaded ${normalized.length} rows`);
    } catch (e) {
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
