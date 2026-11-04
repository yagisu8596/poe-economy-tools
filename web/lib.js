// Pure helpers for the Market page (no DOM, no network) — unit-tested in test/web-lib.test.ts.
// All user-facing text is English.

export const WINDOWS = [
  { key: "1h", label: "1h", field: "change_1h" },
  { key: "6h", label: "6h", field: "change_6h" },
  { key: "24h", label: "24h", field: "change_24h" },
  { key: "7d", label: "7d", field: "change7d_chaos" },
];

export const RANGES = [
  { key: "24h", label: "24h", hours: 24 },
  { key: "7d", label: "7d", hours: 168 },
  { key: "30d", label: "30d", hours: 720 },
];

export const CONFIDENCE = ["low", "medium", "high"];

/** Same rule as the collector: >= 1 divine shows divines, otherwise chaos. null -> "—". */
export function formatPrice(chaos, divine) {
  if (chaos == null || !Number.isFinite(chaos)) return { main: "—", alt: null };
  const fmt = (n) =>
    n >= 100 ? Math.round(n).toLocaleString("en-US")
    : n >= 10 ? n.toFixed(1)
    : n >= 1 ? n.toFixed(2)
    : n >= 0.01 ? n.toFixed(3)
    : n.toPrecision(2);
  if (divine != null && divine >= 1) return { main: `${fmt(divine)} div`, alt: `${fmt(chaos)} c` };
  return { main: `${fmt(chaos)} c`, alt: divine != null ? `${fmt(divine)} div` : null };
}

/** Price as shown for one item. Divine Orb itself is always "1 div", so it is shown in chaos. */
export function displayPrice(row) {
  if (row?.ninja_id === "divine") return { main: formatPrice(row.chaos_value, null).main, alt: null };
  return formatPrice(row?.chaos_value, row?.divine_value);
}

/** Chart unit for one item: divines for items worth >= 1 div, chaos otherwise (and for Divine Orb). */
export function chartUnit(row) {
  return row?.ninja_id !== "divine" && (row?.divine_value ?? 0) >= 1 ? "divine" : "chaos";
}

export function formatChange(pct) {
  if (pct == null || !Number.isFinite(pct)) return { text: "—", dir: "none" };
  const abs = Math.abs(pct);
  const s = abs >= 100 ? Math.round(abs).toString() : abs.toFixed(1);
  if (pct > 0.05) return { text: `+${s}%`, dir: "up" };
  if (pct < -0.05) return { text: `−${s}%`, dir: "down" };
  return { text: "0.0%", dir: "flat" };
}

export function formatVolume(chaos) {
  if (chaos == null || !Number.isFinite(chaos)) return "—";
  if (chaos >= 1e6) return `${(chaos / 1e6).toFixed(1)}M c`;
  if (chaos >= 1e4) return `${Math.round(chaos / 1e3)}k c`;
  if (chaos >= 1e3) return `${(chaos / 1e3).toFixed(1)}k c`;
  return `${Math.round(chaos)} c`;
}

/** "just now", "7 min ago", "2 h ago", "3 d ago". */
export function timeAgo(iso, now = Date.now()) {
  if (!iso) return "never";
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

/** Freshness of the whole dataset: newest update across rows. */
export function newestUpdate(rows) {
  let best = null;
  for (const r of rows) if (r.updated_at && (!best || r.updated_at > best)) best = r.updated_at;
  return best;
}

/**
 * Filter + sort the overview.
 * opts: { query, category ("all" or a name), minConfidence (0..2), sort: "volume"|"price"|"name"|"change", windowField }
 * Rows without a value for the sort field always go last (never treated as 0).
 */
export function selectRows(rows, opts) {
  const q = (opts.query || "").trim().toLowerCase();
  const out = rows.filter((r) =>
    (opts.category === "all" || !opts.category || r.category === opts.category) &&
    (r.confidence ?? 0) >= (opts.minConfidence ?? 0) &&
    (!q || r.name.toLowerCase().includes(q)));
  const key = {
    volume: (r) => r.volume_chaos,
    price: (r) => r.chaos_value,
    name: (r) => r.name,
    change: (r) => r[opts.windowField],
  }[opts.sort || "volume"];
  const dir = opts.sort === "name" ? 1 : -1;
  return out.sort((a, b) => {
    const va = key(a), vb = key(b);
    const na = va == null || (typeof va === "number" && !Number.isFinite(va));
    const nb = vb == null || (typeof vb === "number" && !Number.isFinite(vb));
    if (na !== nb) return na ? 1 : -1;
    if (na && nb) return a.name.localeCompare(b.name);
    if (typeof va === "string") return dir * va.localeCompare(vb);
    return dir * (va - vb) || a.name.localeCompare(b.name);
  });
}

/** Biggest risers and fallers for a window; only rows that have a value and enough confidence. */
export function movers(rows, field, { minConfidence = 1, limit = 5, category = "all" } = {}) {
  const ok = rows.filter((r) =>
    r[field] != null && Number.isFinite(r[field]) &&
    (r.confidence ?? 0) >= minConfidence &&
    (category === "all" || r.category === category));
  const up = ok.filter((r) => r[field] > 0).sort((a, b) => b[field] - a[field]).slice(0, limit);
  const down = ok.filter((r) => r[field] < 0).sort((a, b) => a[field] - b[field]).slice(0, limit);
  return { up, down, measured: ok.length };
}

/**
 * Freshness of the newest price. poe.ninja publishes new exchange prices roughly once an hour
 * (measured 2026-11-04); we check every 15 minutes, so up to ~75 min is normal.
 */
export function freshnessState(ageMin) {
  if (!(ageMin >= 0)) return "old";
  return ageMin < 80 ? "fresh" : ageMin < 180 ? "stale" : "old";
}

/** Shareable item links: "#item-<poe.ninja id>" (ASCII letters, digits, hyphens only). */
export function itemHash(row) {
  const id = String(row?.ninja_id ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return id ? `#item-${id}` : "";
}
export function findByHash(rows, hash) {
  const m = /^#item-([a-z0-9-]+)$/.exec(String(hash || ""));
  if (!m) return null;
  return rows.find((r) => itemHash(r) === `#item-${m[1]}`) ?? null;
}

/** Watchlist: a list of item ids kept per browser. Returns a new array. */
export function toggleWatch(list, id) {
  const ids = Array.isArray(list) ? list.filter((x) => Number.isInteger(x)) : [];
  return ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
}

/** poe.ninja type ids are CamelCase ("DivinationCard"); show them as words. */
export function categoryLabel(name) {
  return String(name ?? "").replace(/([a-z])([A-Z])/g, "$1 $2");
}

export function categories(rows) {
  const counts = new Map();
  for (const r of rows) counts.set(r.category, (counts.get(r.category) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
}

/** Default league = current challenge softcore; falls back to the first active league. */
export function defaultLeague(leagues) {
  const active = leagues.filter((l) => l.is_active !== false);
  return (active.find((l) => l.kind === "challenge") || active[0] || null)?.id ?? null;
}

export function leagueLabel(l) {
  const kind = { challenge: "current league", challenge_hc: "current league, hardcore", standard: "permanent", hardcore: "permanent, hardcore" }[l.kind];
  return kind ? `${l.name} (${kind})` : l.name;
}

/**
 * Chart geometry for a simple price line. Returns SVG path + scale info, or null if < 2 points.
 * points: [{ ts, chaos_value }] ascending. unit: "chaos" | "divine".
 */
export function chartModel(points, { width, height, pad = { l: 56, r: 12, t: 12, b: 24 }, unit = "chaos" }) {
  const pts = points
    .map((p) => ({ t: Date.parse(p.ts), v: unit === "divine" ? p.divine_value : p.chaos_value }))
    .filter((p) => Number.isFinite(p.t) && p.v != null && Number.isFinite(p.v));
  if (pts.length < 2) return null;
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
  let lo = Math.min(...pts.map((p) => p.v)), hi = Math.max(...pts.map((p) => p.v));
  if (hi === lo) { const d = Math.abs(hi) * 0.01 || 1; lo -= d; hi += d; }
  const span = hi - lo; lo -= span * 0.08; hi += span * 0.08;
  const W = width - pad.l - pad.r, H = height - pad.t - pad.b;
  const X = (t) => pad.l + ((t - t0) / Math.max(1, t1 - t0)) * W;
  const Y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * H;
  const line = pts.map((p, i) => `${i ? "L" : "M"}${X(p.t).toFixed(1)} ${Y(p.v).toFixed(1)}`).join("");
  const area = `${line}L${X(t1).toFixed(1)} ${(pad.t + H).toFixed(1)}L${X(t0).toFixed(1)} ${(pad.t + H).toFixed(1)}Z`;
  const ticks = niceTicks(lo, hi, 4).map((v) => ({ v, y: Y(v) }));
  const first = pts[0].v, last = pts[pts.length - 1].v;
  return {
    line, area, ticks,
    change: first ? ((last / first) - 1) * 100 : null,
    first, last, t0, t1,
    lastX: X(t1), lastY: Y(last),
    count: pts.length,
  };
}

export function niceTicks(lo, hi, count) {
  const raw = (hi - lo) / count;
  if (!(raw > 0)) return [lo];
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => raw <= s) ?? 10 * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toPrecision(12));
  return out;
}

export function formatTick(v) {
  const a = Math.abs(v);
  if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e4) return `${Math.round(v / 1e3)}k`;
  if (a >= 100) return Math.round(v).toLocaleString("en-US");
  if (a >= 1) return v.toFixed(a >= 10 ? 1 : 2);
  return v.toPrecision(2);
}

// ------------------------------------------------------------------ league comparison
/** "Mirage (3.28)" / "Allflame (this league)". */
export function compareLabel(r) {
  if (r.is_current) return `${r.league} (this league)`;
  return r.version ? `${r.league} (${r.version})` : r.league;
}

/**
 * Rows from league_day_compare → display rows with the value in the chosen unit and
 * how this league compares with each past league on the same day (null when unknown).
 */
export function compareRows(rows, unit = "chaos") {
  const pick = (r) => (unit === "divine" ? r.divine_value : r.chaos_value);
  const cur = rows.find((r) => r.is_current);
  const now = cur ? pick(cur) : null;
  return rows.map((r) => {
    const v = pick(r);
    return {
      ...r, label: compareLabel(r), value: v,
      vsNow: r.is_current || now == null || v == null || v <= 0 ? null : ((now / v) - 1) * 100,
    };
  });
}

/** Divide a chaos series by the same league's Divine Orb series, day by day. */
export function toDivineSeries(prices, divinePrices, isDivine = false) {
  return prices.map((v, i) => {
    if (v == null) return null;
    if (isDivine) return 1;
    const d = divinePrices?.[i];
    return d > 0 ? v / d : null;
  });
}

/**
 * Overlay chart by league day. series: [{ key, label, prices: (number|null)[], current }]
 * (prices[0] = day 1). Returns paths per series on one shared scale, or null.
 */
export function leagueChartModel(series, { width, height, day = null, maxDay = null, pad = { l: 56, r: 12, t: 12, b: 24 } }) {
  const usable = series.filter((s) => s.prices.some((v) => v != null && Number.isFinite(v)));
  if (!usable.length) return null;
  const longest = Math.max(...usable.map((s) => s.prices.length));
  const last = Math.max(2, Math.min(maxDay ?? longest, longest));
  const vals = usable.flatMap((s) => s.prices.slice(0, last).filter((v) => v != null && Number.isFinite(v)));
  if (!vals.length) return null;
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (hi === lo) { const d = Math.abs(hi) * 0.01 || 1; lo -= d; hi += d; }
  const span = hi - lo; lo = Math.max(0, lo - span * 0.06); hi += span * 0.06;
  const W = width - pad.l - pad.r, H = height - pad.t - pad.b;
  const X = (d) => pad.l + ((d - 1) / Math.max(1, last - 1)) * W;
  const Y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * H;
  const lines = usable.map((s) => {
    let path = "", pen = false, end = null;
    s.prices.slice(0, last).forEach((v, i) => {
      if (v == null || !Number.isFinite(v)) { pen = false; return; }
      path += `${pen ? "L" : "M"}${X(i + 1).toFixed(1)} ${Y(v).toFixed(1)}`;
      pen = true; end = { x: X(i + 1), y: Y(v) };
    });
    return { key: s.key, label: s.label, current: !!s.current, path, end };
  });
  const xTicks = niceTicks(1, last, 5).filter((d) => d >= 1 && Number.isInteger(d)).map((d) => ({ d, x: X(d) }));
  return {
    lines, ticks: niceTicks(lo, hi, 4).map((v) => ({ v, y: Y(v) })), xTicks, last,
    marker: day && day >= 1 && day <= last ? { x: X(day), day } : null,
  };
}

/** Value on league day `day` (1-based), or the nearest day within ±maxGap that has one. */
export function nearestValue(prices, day, maxGap = 3) {
  if (!Array.isArray(prices) || !(day >= 1)) return null;
  for (let g = 0; g <= maxGap; g++) {
    for (const d of g ? [day - g, day + g] : [day]) {
      const v = prices[d - 1];
      if (d >= 1 && v != null && Number.isFinite(v)) return { value: v, day: d };
    }
  }
  return null;
}

/**
 * poe.ninja's generated image URLs (/gen/image/<base64 JSON>/…) do not load on other sites.
 * They wrap GGG's CDN path ({"f":"2DItems/…"}), so point straight at web.poecdn.com.
 */
export function iconUrl(url) {
  const m = /\/gen\/image\/([A-Za-z0-9_-]+)\//.exec(String(url || ""));
  if (!m) return url || null;
  try {
    const b64 = m[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = JSON.parse(typeof atob === "function" ? atob(b64 + "===".slice((b64.length + 3) % 4)) : Buffer.from(b64, "base64").toString("utf8"));
    const f = json.find?.((x) => x && typeof x === "object" && typeof x.f === "string")?.f;
    if (f && /^[\w/.-]+$/.test(f)) return `https://web.poecdn.com/image/Art/${f}.png?scale=1`;
  } catch { /* keep the original */ }
  return url;
}
