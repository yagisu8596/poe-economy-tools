// League history importer for poe.ninja's public data dumps (https://poe.ninja/poe1/data,
// CC BY-SA). Runs in a browser tab on poe.ninja (same origin, so the zip can be read)
// and sends compact daily series to Supabase through import_league_history(),
// which only accepts a short-lived token from app_config.
//
// The pure part (buildHistory) is unit-tested in test/league-history.test.ts.

/** Exchange-style item types kept from the dumps' items CSV (types we track live). */
export const KEEP_TYPES = new Set([
  "Scarab", "Essence", "Fossil", "Resonator", "Oil", "DeliriumOrb", "DivinationCard", "Omen",
  "Tattoo", "Runegraft", "Artifact", "AllflameEmber", "DjinnCoin", "Astrolabe", "EnshroudingCrystal", "Ducat",
]);

/** Patch versions of past challenge leagues (dump name → version). */
export const VERSIONS = {
  Mirage: "3.28", Keepers: "3.27", Mercenaries: "3.26", Settlers: "3.25",
  Necropolis: "3.24", Affliction: "3.23", Ancestor: "3.22", Crucible: "3.21",
};

const DAY = 86400000;
const dayNumber = (date, start) => Math.round((Date.parse(date + "T00:00:00Z") - Date.parse(start + "T00:00:00Z")) / DAY) + 1;

/**
 * Picks the softcore challenge league among the dump's files: the biggest
 * "<League>.currency.csv" that is not a permanent, hardcore, ruthless or private league.
 */
export function pickLeagues(fileNames) {
  const cur = fileNames
    .filter((f) => f.name.endsWith(".currency.csv"))
    .map((f) => ({ ...f, league: f.name.slice(0, -".currency.csv".length) }))
    .filter((f) => !["Standard", "Hardcore"].includes(f.league) && !/^(Hardcore|HC|Ruthless|SSF)\b/i.test(f.league) && !/\(PL\d+\)/.test(f.league));
  cur.sort((a, b) => b.usize - a.usize);
  const sc = cur[0]?.league ?? null;
  if (!sc) return null;
  const has = (n) => fileNames.some((f) => f.name === n);
  const hc = has(`Hardcore ${sc}.currency.csv`) ? `Hardcore ${sc}` : null;
  return { sc, hc };
}

/**
 * Builds one row per item with a daily chaos price array (index 0 = league day 1).
 * currencyLines / itemLines: CSV lines WITHOUT the header.
 *   currency: League;Date;Get;Pay;Value;Confidence   (kept: Pay = Chaos Orb)
 *   items:    League;Date;Id;Type;Name;BaseType;Variant;Links;Value;Confidence (kept: KEEP_TYPES, no variant/links)
 * Low-confidence values become null.
 */
export function buildHistory({ league, kind, version, currencyLines, itemLines }) {
  const series = new Map(); // name -> { category, byDate: Map(date -> value) }
  let start = null;
  const put = (name, category, date, value, conf) => {
    if (!start || date < start) start = date;
    let s = series.get(name);
    if (!s) series.set(name, (s = { category, byDate: new Map() }));
    const v = Number(value);
    s.byDate.set(date, conf === "Low" || !Number.isFinite(v) || v <= 0 ? null : v);
  };
  const dates = new Set();
  for (const line of currencyLines) {
    const c = line.split(";");
    if (c.length < 6 || c[0] !== league) continue;
    dates.add(c[1]);
    if (c[3] !== "Chaos Orb") continue;
    put(c[2], "Currency", c[1], c[4], c[5]);
  }
  for (const line of itemLines) {
    const c = line.split(";");
    if (c.length < 10 || c[0] !== league || !KEEP_TYPES.has(c[3]) || c[6] || c[7]) continue;
    dates.add(c[1]);
    put(c[4], c[3], c[1], c[8], c[9]);
  }
  for (const d of dates) if (!start || d < start) start = d;
  if (!start) return { startedOn: null, rows: [] };
  const last = [...dates].sort().at(-1);
  const days = dayNumber(last, start);
  // Chaos Orb is the unit itself.
  series.set("Chaos Orb", { category: "Currency", byDate: new Map([...dates].map((d) => [d, 1])) });
  const rows = [];
  for (const [name, s] of series) {
    const prices = new Array(days).fill(null);
    for (const [d, v] of s.byDate) prices[dayNumber(d, start) - 1] = v == null ? null : +v.toPrecision(6);
    if (prices.every((v) => v == null)) continue;
    rows.push({ league, kind, version: version ?? null, started_on: start, item_name: name, category: s.category, prices });
  }
  rows.sort((a, b) => a.item_name.localeCompare(b.item_name));
  return { startedOn: start, days, rows };
}

// ------------------------------------------------------------------ browser part
/* global fetch, DecompressionStream, TextDecoderStream, Blob */
export async function readZipIndex(buf) {
  const dv = new DataView(buf);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 70000); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("not a zip file");
  const n = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const files = [];
  for (let k = 0; k < n; k++) {
    const method = dv.getUint16(off + 10, true), csize = dv.getUint32(off + 20, true), usize = dv.getUint32(off + 24, true);
    const nl = dv.getUint16(off + 28, true), el = dv.getUint16(off + 30, true), cl = dv.getUint16(off + 32, true), lho = dv.getUint32(off + 42, true);
    files.push({ name: new TextDecoder().decode(new Uint8Array(buf, off + 46, nl)), method, csize, usize, lho });
    off += 46 + nl + el + cl;
  }
  return files;
}

/** Streams a zip entry line by line (skips the header) and keeps lines that pass `keep`. */
export async function zipLines(buf, f, keep) {
  const dv = new DataView(buf);
  const nl = dv.getUint16(f.lho + 26, true), el = dv.getUint16(f.lho + 28, true);
  const data = new Uint8Array(buf, f.lho + 30 + nl + el, f.csize);
  let stream = new Blob([data]).stream();
  if (f.method === 8) stream = stream.pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  const out = [];
  let rest = "", header = true;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const parts = (rest + value).split("\n");
    rest = parts.pop();
    for (let l of parts) {
      if (header) { header = false; continue; }
      l = l.replace(/\r$/, "");
      if (keep(l)) out.push(l);
    }
  }
  if (rest && keep(rest)) out.push(rest);
  return out;
}

/** Downloads one dump (in memory), builds softcore + hardcore rows, sends them in batches. */
export async function importDump(dump, { supabaseUrl, publishableKey, token, batch = 200, log = () => {} }) {
  const res = await fetch(`/poe1/api/data/dumps/dump?name=${encodeURIComponent(dump)}`);
  if (!res.ok) throw new Error(`${dump}: HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  const files = await readZipIndex(buf);
  const picked = pickLeagues(files);
  if (!picked) throw new Error(`${dump}: no challenge league found`);
  const summary = { dump, bytes: buf.byteLength, leagues: [] };
  for (const [league, kind] of [[picked.sc, "challenge"], [picked.hc, "challenge_hc"]]) {
    if (!league) continue;
    const cf = files.find((f) => f.name === `${league}.currency.csv`);
    const itf = files.find((f) => f.name === `${league}.items.csv`);
    const currencyLines = cf ? await zipLines(buf, cf, () => true) : [];
    const typeRe = new RegExp(`^[^;]*;[^;]*;[^;]*;(${[...KEEP_TYPES].join("|")});`);
    const itemLines = itf ? await zipLines(buf, itf, (l) => typeRe.test(l)) : [];
    const h = buildHistory({ league, kind, version: VERSIONS[dump] ?? null, currencyLines, itemLines });
    let sent = 0;
    for (let i = 0; i < h.rows.length; i += batch) {
      const r = await fetch(`${supabaseUrl}/rest/v1/rpc/import_league_history`, {
        method: "POST",
        headers: { apikey: publishableKey, "Content-Type": "application/json" },
        body: JSON.stringify({ p_token: token, p_rows: h.rows.slice(i, i + batch) }),
      });
      if (!r.ok) throw new Error(`${league}: import HTTP ${r.status} ${await r.text()}`);
      sent += await r.json();
    }
    summary.leagues.push({ league, kind, startedOn: h.startedOn, days: h.days, items: h.rows.length, sent });
    log(`${league}: ${sent} items, ${h.days} days from ${h.startedOn}`);
  }
  return summary;
}
