// PoE Economy Tools — Market page (vanilla JS, no build step).
import {
  WINDOWS, RANGES, CONFIDENCE, formatPrice, formatChange, formatVolume, timeAgo, newestUpdate,
  selectRows, movers, categories, categoryLabel, defaultLeague, leagueLabel, chartModel, formatTick,
  freshnessState, itemHash, findByHash, toggleWatch, displayPrice, chartUnit,
  compareRows, toDivineSeries, leagueChartModel, nearestValue,
} from "./lib.js";

const REFRESH_MS = 5 * 60 * 1000;
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const store = {
  get(k, d) { try { const v = localStorage.getItem("pet." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("pet." + k, JSON.stringify(v)); } catch { /* private mode */ } },
};

export function startApp(source) {
  const state = {
    leagues: [], league: null, rows: [], loading: true, error: null,
    window: store.get("window", "1h"),
    category: store.get("category", "all"),
    query: "",
    hideThin: store.get("hideThin", true),
    sort: store.get("sort", "volume"),
    selected: null, range: store.get("range", "24h"), history: null, historyError: null,
    watch: [].concat(store.get("watch", [])).filter(Number.isInteger),
    cmpDay: null, cmpUnit: store.get("cmpUnit", "chaos"), cmp: null, cmpSeries: null, cmpError: null,
  };
  const win = () => WINDOWS.find((w) => w.key === state.window) || WINDOWS[0];
  const watching = (id) => state.watch.includes(id);
  // The watchlist is a pseudo-category: filter rows first, then treat it as "all".
  const view = () => state.category === "watch"
    ? { rows: state.rows.filter((r) => watching(r.item_id)), category: "all" }
    : { rows: state.rows, category: state.category };

  // ------------------------------------------------------------- loading
  async function loadLeagues() {
    state.leagues = await source.leagues();
    const saved = store.get("league", null);
    state.league = state.leagues.some((l) => l.id === saved) ? saved : defaultLeague(state.leagues);
  }
  async function loadOverview(quiet = false) {
    if (!state.league) return;
    if (!quiet) { state.loading = true; render(); }
    try {
      state.rows = await source.overview(state.league);
      state.error = null;
    } catch (e) {
      state.error = `Could not load prices (${e.message}). Retrying in a few minutes.`;
    }
    state.loading = false;
    render();
    if (state.selected) {
      const fresh = state.rows.find((r) => r.item_id === state.selected.item_id);
      if (fresh) { state.selected = fresh; loadHistory(); loadCompare(); }
    }
  }
  const seriesCache = new Map();
  async function seriesFor(itemId) {
    const k = `${state.league}|${itemId}`;
    if (!seriesCache.has(k)) seriesCache.set(k, source.series ? source.series(state.league, itemId) : Promise.resolve([]));
    try { return await seriesCache.get(k); } catch (e) { seriesCache.delete(k); throw e; }
  }
  async function loadCompare() {
    const item = state.selected;
    if (!item || !source.compare) return;
    state.cmp = null; state.cmpError = null; renderCompare();
    try {
      const divine = state.rows.find((r) => r.ninja_id === "divine");
      const [rows, series, divSeries] = await Promise.all([
        source.compare(state.league, item.item_id, state.cmpDay),
        seriesFor(item.item_id),
        divine && divine.item_id !== item.item_id ? seriesFor(divine.item_id) : Promise.resolve(null),
      ]);
      if (state.selected?.item_id !== item.item_id) return;
      state.cmp = rows; state.cmpSeries = { series, divSeries, isDivine: item.ninja_id === "divine" };
      renderCompare();
    } catch (e) {
      state.cmpError = `Could not load past leagues (${e.message}).`; renderCompare();
    }
  }

  async function loadHistory() {
    const item = state.selected;
    if (!item) return;
    const range = RANGES.find((r) => r.key === state.range) || RANGES[0];
    state.history = null; state.historyError = null; renderDetail();
    try {
      const pts = await source.history(state.league, item.item_id, range.hours);
      if (state.selected?.item_id === item.item_id) { state.history = pts; renderDetail(); }
    } catch (e) {
      state.historyError = `Could not load the chart (${e.message}).`; renderDetail();
    }
  }

  // ------------------------------------------------------------- rendering
  function render() {
    renderHeader();
    renderControls();
    renderMovers();
    renderTable();
  }

  function renderHeader() {
    const sel = $("#league");
    if (sel.options.length !== state.leagues.length) {
      sel.innerHTML = state.leagues.map((l) => `<option value="${esc(l.id)}">${esc(leagueLabel(l))}</option>`).join("");
    }
    if (state.league) sel.value = state.league;
    const newest = newestUpdate(state.rows);
    const ageMin = newest ? (Date.now() - Date.parse(newest)) / 60000 : Infinity;
    const badge = $("#freshness");
    badge.dataset.state = freshnessState(ageMin);
    const snap = source.mode === "snapshot" ? " · preview snapshot" : "";
    badge.querySelector("span").textContent = state.loading && !state.rows.length
      ? "Loading prices…"
      : newest ? `Prices updated ${timeAgo(newest)}${snap}` : "No prices yet";
    badge.title = "Prices come from poe.ninja, which publishes new exchange prices about once an hour. We check every 15 minutes. This is not a live feed.";
  }

  function renderControls() {
    for (const b of document.querySelectorAll("[data-window]")) b.setAttribute("aria-pressed", String(b.dataset.window === state.window));
    const cats = categories(state.rows);
    const sel = $("#category");
    const want = `<option value="all">All categories (${state.rows.length})</option>` +
      `<option value="watch">★ Watchlist (${state.rows.filter((r) => watching(r.item_id)).length})</option>` +
      cats.map((c) => `<option value="${esc(c.name)}">${esc(categoryLabel(c.name))} (${c.count})</option>`).join("");
    if (sel.dataset.sig !== want) { sel.innerHTML = want; sel.dataset.sig = want; }
    sel.value = state.category === "watch" || cats.some((c) => c.name === state.category) ? state.category : "all";
    $("#hide-thin").checked = state.hideThin;
    $("#error").hidden = !state.error;
    $("#error").textContent = state.error || "";
  }

  function moverItem(r, field) {
    const p = displayPrice(r), c = formatChange(r[field]);
    return `<li><button type="button" class="mover" data-item="${r.item_id}">
      ${icon(r)}<span class="mover-name">${esc(r.name)}</span>
      <span class="mover-price">${esc(p.main)}</span>
      <span class="chg" data-dir="${c.dir}">${esc(c.text)}</span></button></li>`;
  }

  function renderMovers() {
    const w = win();
    const v = view();
    const m = movers(v.rows, w.field, { minConfidence: state.hideThin ? 1 : 0, category: v.category });
    $("#movers-title").textContent = `Biggest moves · ${w.label}`;
    const note = $("#movers-note");
    if (state.loading && !state.rows.length) {
      note.textContent = "Loading…"; note.hidden = false;
      $("#risers").innerHTML = $("#fallers").innerHTML = "";
      return;
    }
    if (state.category === "watch" && !v.rows.length) {
      note.hidden = false;
      note.textContent = "Your watchlist is empty. Tap ☆ next to an item to add it.";
    } else if (!m.measured) {
      note.hidden = false;
      note.textContent = w.key === "7d"
        ? "No 7-day trend available for this selection."
        : `Collecting history. ${w.label} changes appear once we have ${w.label} of our own price snapshots for this league.`;
    } else {
      note.hidden = true;
    }
    $("#risers").innerHTML = m.up.map((r) => moverItem(r, w.field)).join("") || (m.measured ? `<li class="empty">Nothing rose.</li>` : "");
    $("#fallers").innerHTML = m.down.map((r) => moverItem(r, w.field)).join("") || (m.measured ? `<li class="empty">Nothing fell.</li>` : "");
  }

  function star(r) {
    const on = watching(r.item_id);
    return `<button type="button" class="star" data-star="${r.item_id}" aria-pressed="${on}"
      aria-label="${on ? "Remove" : "Add"} ${esc(r.name)} ${on ? "from" : "to"} watchlist" title="${on ? "Remove from" : "Add to"} watchlist">${on ? "★" : "☆"}</button>`;
  }

  function icon(r) {
    return r.icon_url
      ? `<img class="ico" src="${esc(r.icon_url)}" alt="" width="28" height="28" loading="lazy" referrerpolicy="no-referrer">`
      : `<span class="ico ico-blank" aria-hidden="true"></span>`;
  }

  function renderTable() {
    const w = win();
    $("#col-change").textContent = `Change ${w.label}`;
    for (const th of document.querySelectorAll("th[data-sort]")) th.setAttribute("aria-sort", th.dataset.sort === state.sort ? (state.sort === "name" ? "ascending" : "descending") : "none");
    const v = view();
    const rows = selectRows(v.rows, {
      query: state.query, category: v.category, minConfidence: state.hideThin ? 1 : 0,
      sort: state.sort, windowField: w.field,
    });
    $("#count").textContent = state.loading && !state.rows.length ? "" :
      `${rows.length} item${rows.length === 1 ? "" : "s"}${state.hideThin ? " · thin markets hidden" : ""}`;
    $("#tbody").innerHTML = rows.map((r) => {
      const p = displayPrice(r), c = formatChange(r[w.field]);
      const conf = CONFIDENCE[r.confidence ?? 0];
      return `<tr data-item="${r.item_id}" tabindex="0" ${state.selected?.item_id === r.item_id ? 'aria-selected="true"' : ""}>
        <td class="c-item"><div class="c-item-in">${star(r)}${icon(r)}<span><span class="nm">${esc(r.name)}</span><span class="cat">${esc(categoryLabel(r.category))}</span></span></div></td>
        <td class="c-num"><span class="pmain">${esc(p.main)}</span>${p.alt ? `<span class="palt">${esc(p.alt)}</span>` : ""}</td>
        <td class="c-num"><span class="chg" data-dir="${c.dir}">${esc(c.text)}</span></td>
        <td class="c-num c-vol">${esc(formatVolume(r.volume_chaos))}</td>
        <td class="c-conf"><span class="pill" data-level="${conf}">${conf}</span></td>
      </tr>`;
    }).join("") || `<tr><td colspan="5" class="empty">${state.loading ? "Loading prices…"
      : state.category === "watch" && !v.rows.length ? "Your watchlist is empty. Tap ☆ next to an item to add it."
      : "No items match."}</td></tr>`;
  }

  function renderDetail() {
    const panel = $("#detail");
    const r = state.selected;
    panel.hidden = !r;
    document.body.classList.toggle("detail-open", !!r);
    if (!r) return;
    const p = displayPrice(r);
    $("#d-icon").innerHTML = icon(r);
    $("#d-name").textContent = r.name;
    $("#d-cat").textContent = `${categoryLabel(r.category)} · ${CONFIDENCE[r.confidence ?? 0]} confidence · traded ${formatVolume(r.volume_chaos)}`;
    $("#d-price").textContent = p.main;
    $("#d-alt").textContent = p.alt || "";
    $("#d-updated").textContent = r.updated_at ? `Price last changed ${timeAgo(r.updated_at)}` : "";
    const ws = $("#d-watch");
    ws.setAttribute("aria-pressed", String(watching(r.item_id)));
    ws.textContent = watching(r.item_id) ? "★ Watching" : "☆ Watch";
    for (const b of document.querySelectorAll("[data-range]")) b.setAttribute("aria-pressed", String(b.dataset.range === state.range));
    $("#d-windows").innerHTML = WINDOWS.map((w) => {
      const c = formatChange(r[w.field]);
      return `<div><dt>${w.label}</dt><dd class="chg" data-dir="${c.dir}">${esc(c.text)}</dd></div>`;
    }).join("");
    drawChart();
    renderCompare();
  }

  const fmtUnit = (v, unit) => {
    if (v == null || !Number.isFinite(v)) return "—";
    const m = formatPrice(v, null).main;            // "97.9 c"
    return unit === "divine" ? m.replace(/ c$/, " div") : m;
  };

  function renderCompare() {
    const r = state.selected;
    if (!r) return;
    // Divine Orb is always 1 div: compare it in chaos only.
    const unit = r.ninja_id === "divine" ? "chaos" : state.cmpUnit;
    $(".cmp").dataset.divine = String(r.ninja_id === "divine");
    for (const b of document.querySelectorAll("[data-cmp-unit]")) b.setAttribute("aria-pressed", String(b.dataset.cmpUnit === unit));
    const body = $("#cmp-body"), note = $("#cmp-note"), box = $("#cmp-chart");
    if (state.cmpError) { body.innerHTML = ""; box.innerHTML = ""; note.textContent = state.cmpError; return; }
    if (!state.cmp) { body.innerHTML = `<tr><td colspan="3" class="empty">Loading…</td></tr>`; box.innerHTML = ""; note.textContent = ""; return; }
    // poe.ninja has gaps (days with only low-confidence prices): fall back to the nearest day within ±3.
    const s0 = state.cmpSeries;
    const filled = state.cmp.map((x) => {
      if (x.is_current || (unit === "divine" ? x.divine_value : x.chaos_value) != null || !s0) return x;
      const p = s0.series?.find((q) => q.league === x.league)?.prices;
      const pv = unit === "divine" ? (p && toDivineSeries(p, s0.divSeries?.find((q) => q.league === x.league)?.prices, s0.isDivine)) : p;
      const near = nearestValue(pv, x.day);
      if (!near) return x;
      return { ...x, chaos_value: unit === "chaos" ? near.value : x.chaos_value, divine_value: unit === "divine" ? near.value : x.divine_value, nearDay: near.day };
    });
    const rows = compareRows(filled, unit);
    const cur = rows.find((x) => x.is_current);
    const day = cur?.day ?? state.cmpDay ?? 1;
    const input = $("#cmp-day");
    if (document.activeElement !== input) input.value = String(day);
    $("#cmp-today").disabled = state.cmpDay == null;
    const past = rows.filter((x) => !x.is_current);
    if (!past.length) {
      body.innerHTML = `<tr><td colspan="3" class="empty">${source.mode === "snapshot"
        ? "This item's past-league data is not included in the preview. The live site has it for 94% of items."
        : "No past-league data for this item. It is probably new in this league; it becomes comparable once the league's data is archived."}</td></tr>`;
    } else {
      body.innerHTML = rows.map((x) => {
        const c = formatChange(x.vsNow);
        const beyond = !x.is_current && x.value == null && x.league_days != null && day > x.league_days;
        return `<tr${x.is_current ? ' class="cur"' : ""}>
          <td>${esc(x.label)}</td>
          <td class="c-num">${x.value == null ? `<span class="muted" title="${beyond ? "That league was shorter" : "No reliable price around that day"}">${beyond ? "league over" : "—"}</span>`
            : esc(fmtUnit(x.value, unit)) + (x.nearDay ? ` <span class="muted near" title="No reliable price on day ${day}; nearest day shown">day ${x.nearDay}</span>` : "")}</td>
          <td class="c-num">${x.is_current ? "" : `<span class="chg" data-dir="${c.dir}">${esc(c.text)}</span>`}</td></tr>`;
      }).join("");
    }
    // overlay chart: this league + the three most recent past leagues
    const s = state.cmpSeries;
    const conv = (p) => unit === "divine" ? toDivineSeries(p.prices, s.divSeries?.find((d) => d.league === p.league)?.prices, s.isDivine) : p.prices;
    const list = (s?.series ?? []).slice(0, 4).map((p, i) => ({ key: p.is_current ? "cur" : `p${i}`, label: p.is_current ? `${p.league} (this league)` : `${p.league}${p.version ? ` (${p.version})` : ""}`, prices: conv(p), current: p.is_current }));
    const width = Math.max(280, box.clientWidth || 380), height = 200;
    const m = list.length > 1 ? leagueChartModel(list, { width, height, day }) : null;
    if (!m) { box.innerHTML = ""; }
    else {
      box.innerHTML = `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" aria-label="${esc(r.name)} price by league day">
        ${m.ticks.map((t) => `<line x1="56" x2="${width - 12}" y1="${t.y.toFixed(1)}" y2="${t.y.toFixed(1)}" class="grid"/><text x="50" y="${(t.y + 4).toFixed(1)}" class="tick" text-anchor="end">${esc(formatTick(t.v))}</text>`).join("")}
        ${m.xTicks.map((t) => `<text x="${t.x.toFixed(1)}" y="${height - 6}" class="tick" text-anchor="middle">${t.d}</text>`).join("")}
        ${m.marker ? `<line x1="${m.marker.x.toFixed(1)}" x2="${m.marker.x.toFixed(1)}" y1="12" y2="${height - 24}" class="day-mark"/>` : ""}
        ${m.lines.slice().reverse().map((l) => `<path d="${l.path}" class="lg-line lg-${l.key}"/>`).join("")}
        ${m.lines.filter((l) => l.current && l.end).map((l) => `<circle cx="${l.end.x.toFixed(1)}" cy="${l.end.y.toFixed(1)}" r="4" class="lg-dot"/>`).join("")}
      </svg>
      <ul class="lg-legend">${m.lines.map((l) => `<li><span class="sw lg-${l.key}"></span>${esc(l.label)}</li>`).join("")}</ul>`;
    }
    note.textContent = `Day ${day} = ${day === 1 ? "launch day" : `${day - 1} days after launch`}. ${unit === "divine" ? "Divine values use each league's Divine Orb price that day." : "Chaos values; Divine Orb prices differed a lot between leagues, so also check Divine."}`;
  }

  function drawChart() {
    const box = $("#chart");
    const note = $("#chart-note");
    if (state.historyError) { box.innerHTML = ""; note.textContent = state.historyError; return; }
    if (!state.history) { box.innerHTML = `<div class="chart-loading">Loading chart…</div>`; note.textContent = ""; return; }
    const width = Math.max(280, box.clientWidth || 560), height = 220;
    const unit = chartUnit(state.selected);
    const m = chartModel(state.history, { width, height, unit });
    const range = RANGES.find((x) => x.key === state.range);
    if (!m) {
      box.innerHTML = `<div class="chart-loading">Not enough history yet for a ${range.label} chart.</div>`;
      note.textContent = "We store a snapshot each time poe.ninja publishes new prices (about once an hour); the line fills in as they accumulate.";
      return;
    }
    const c = formatChange(m.change);
    const suffix = unit === "divine" ? " div" : " c";
    box.innerHTML = `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" aria-label="${esc(state.selected.name)} price, last ${range.label}">
      ${m.ticks.map((t) => `<line x1="56" x2="${width - 12}" y1="${t.y.toFixed(1)}" y2="${t.y.toFixed(1)}" class="grid"/><text x="50" y="${(t.y + 4).toFixed(1)}" class="tick" text-anchor="end">${esc(formatTick(t.v))}</text>`).join("")}
      <path d="${m.area}" class="area" data-dir="${c.dir}"/>
      <path d="${m.line}" class="line" data-dir="${c.dir}"/>
      <circle cx="${m.lastX.toFixed(1)}" cy="${m.lastY.toFixed(1)}" r="4" class="dot" data-dir="${c.dir}"/>
      <text x="56" y="${height - 6}" class="tick">${esc(fmtDate(m.t0))}</text>
      <text x="${width - 12}" y="${height - 6}" class="tick" text-anchor="end">${esc(fmtDate(m.t1))}</text>
    </svg>`;
    note.innerHTML = `<span class="chg" data-dir="${c.dir}">${esc(c.text)}</span> over the last ${esc(range.label)} · from ${esc(formatTick(m.first))}${suffix} to ${esc(formatTick(m.last))}${suffix} · ${m.count} points`;
  }

  function fmtDate(t) {
    const d = new Date(t);
    return d.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  }

  // ------------------------------------------------------------- events
  $("#league").addEventListener("change", (e) => {
    state.league = e.target.value; store.set("league", state.league); state.cmpDay = null;
    state.selected = null; renderDetail(); loadOverview();
  });
  for (const b of document.querySelectorAll("[data-window]")) {
    b.addEventListener("click", () => {
      state.window = b.dataset.window; store.set("window", state.window);
      if (state.sort !== "change" && state.sort !== "volume") state.sort = "change";
      render();
    });
  }
  $("#category").addEventListener("change", (e) => { state.category = e.target.value; store.set("category", state.category); render(); });
  $("#search").addEventListener("input", (e) => { state.query = e.target.value; renderTable(); });
  $("#hide-thin").addEventListener("change", (e) => { state.hideThin = e.target.checked; store.set("hideThin", state.hideThin); render(); });
  for (const th of document.querySelectorAll("th[data-sort]")) {
    const activate = () => { state.sort = th.dataset.sort; store.set("sort", state.sort); renderTable(); };
    th.addEventListener("click", activate);
    th.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activate(); } });
  }
  const setHash = (h) => {
    try { history.replaceState(null, "", h || location.pathname + location.search); } catch { /* sandboxed */ }
  };
  const openItem = (id, { scroll = true } = {}) => {
    const r = state.rows.find((x) => x.item_id === Number(id));
    if (!r) return;
    const changed = state.selected?.item_id !== r.item_id;
    state.selected = r;
    if (changed) { state.cmp = null; state.cmpSeries = null; }
    renderDetail(); renderTable(); loadHistory(); if (changed) loadCompare();
    setHash(itemHash(r));
    if (scroll && window.matchMedia("(max-width: 900px)").matches) $("#detail").scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const closeItem = () => { state.selected = null; renderDetail(); renderTable(); setHash(""); };
  const toggleStar = (id) => {
    state.watch = toggleWatch(state.watch, Number(id)); store.set("watch", state.watch);
    render(); if (state.selected) renderDetail();
  };
  const openFromHash = () => {
    const r = findByHash(state.rows, location.hash);
    if (r && state.selected?.item_id !== r.item_id) openItem(r.item_id, { scroll: false });
  };
  let toastTimer;
  const toast = (msg) => {
    const t = $("#toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2200);
  };
  async function copyText(text, done) {
    try { await navigator.clipboard.writeText(text); toast(done); return; } catch { /* fall back below */ }
    const ta = document.createElement("textarea");
    ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    let ok = false; try { ok = document.execCommand("copy"); } catch { ok = false; }
    ta.remove();
    toast(ok ? done : `Copy blocked here. Text: ${text}`);
  }
  document.addEventListener("click", (e) => {
    const s = e.target.closest("[data-star]");
    if (s) { e.stopPropagation(); toggleStar(s.dataset.star); return; }
    const t = e.target.closest("[data-item]");
    if (t) openItem(t.dataset.item);
  });
  $("#tbody").addEventListener("keydown", (e) => {
    const tr = e.target.closest("tr[data-item]");
    if (tr && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openItem(tr.dataset.item); }
  });
  for (const b of document.querySelectorAll("[data-range]")) {
    b.addEventListener("click", () => { state.range = b.dataset.range; store.set("range", state.range); renderDetail(); loadHistory(); });
  }
  $("#d-close").addEventListener("click", closeItem);
  const setCmpDay = (d) => {
    const cur = (state.cmp || []).find((x) => x.is_current);
    const today = cur?.league_days ?? null;
    let n = Math.round(Number(d));
    if (!Number.isFinite(n) || n < 1) n = 1;
    if (n > 400) n = 400;
    state.cmpDay = today != null && n === today ? null : n;
    loadCompare();
  };
  $("#cmp-prev").addEventListener("click", () => setCmpDay(Number($("#cmp-day").value) - 1));
  $("#cmp-next").addEventListener("click", () => setCmpDay(Number($("#cmp-day").value) + 1));
  $("#cmp-today").addEventListener("click", () => { state.cmpDay = null; loadCompare(); });
  $("#cmp-day").addEventListener("change", (e) => setCmpDay(e.target.value));
  for (const b of document.querySelectorAll("[data-cmp-unit]")) {
    b.addEventListener("click", () => { state.cmpUnit = b.dataset.cmpUnit; store.set("cmpUnit", state.cmpUnit); renderCompare(); });
  }
  $("#d-watch").addEventListener("click", () => { if (state.selected) toggleStar(state.selected.item_id); });
  // In-game Currency Exchange and trade searches are by name, so copying it saves typing.
  $("#d-copy").addEventListener("click", () => { if (state.selected) copyText(state.selected.name, `Copied “${state.selected.name}”`); });
  $("#d-link").addEventListener("click", () => {
    if (state.selected) copyText(location.href.split("#")[0] + itemHash(state.selected), "Link copied");
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.selected && !e.target.closest?.("input, select, textarea")) closeItem();
  });
  window.addEventListener("hashchange", openFromHash);
  window.addEventListener("resize", () => { if (state.selected && state.history) drawChart(); if (state.selected && state.cmp) renderCompare(); });

  // ------------------------------------------------------------- start
  (async () => {
    render();
    try {
      await loadLeagues();
      await loadOverview();
      openFromHash();
    } catch (e) {
      state.loading = false;
      state.error = `Could not reach the price database (${e.message}).`;
      render();
    }
    setInterval(() => { if (document.visibilityState === "visible") loadOverview(true); }, REFRESH_MS);
    document.addEventListener("visibilitychange", () => {
      const newest = newestUpdate(state.rows);
      if (document.visibilityState === "visible" && newest && Date.now() - Date.parse(newest) > 16 * 60000) loadOverview(true);
    });
    setInterval(renderHeader, 30000);
  })();
}
