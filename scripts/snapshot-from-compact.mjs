// Expands a compact snapshot (captured in the browser from the live database
// with the public key) into dist/snapshot.json for build-preview.mjs.
// Input dist/snapshot.compact.json:
//   { takenAt, league, leagues:[{id,name,kind,is_active}], rows:[[...FIELDS]], hist:{ "<itemId>": [[ts,chaos,divine]] } }
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIELDS = ["item_id", "ninja_id", "name", "category", "chaos_value", "divine_value", "volume_chaos", "confidence",
  "updated_at", "change_1h", "change_6h", "change_24h", "change7d_chaos", "change7d_divine"];
const c = JSON.parse(readFileSync(join(root, "dist/snapshot.compact.json"), "utf8"));
const rows = c.rows.map((a) => {
  const o = Object.fromEntries(FIELDS.map((f, i) => [f, a[i]]));
  o.icon_url = null;
  return o;
});
const history = {};
for (const [id, pts] of Object.entries(c.hist ?? {})) {
  history[`${c.league}|${id}`] = pts.map(([ts, chaos_value, divine_value]) => ({ ts, chaos_value, divine_value }));
}
// Optional league-day series (dist/series.compact.json): { "<itemId>": [[league, version, started_on, is_current, prices[]]] }
const series = {};
try {
  const sc = JSON.parse(readFileSync(join(root, "dist/series.compact.json"), "utf8"));
  for (const [id, list] of Object.entries(sc)) {
    series[`${c.league}|${id}`] = list.map(([league, version, started_on, is_current, prices]) => ({ league, version, started_on, is_current, prices }));
  }
  // Extra items in a compact encoding: [["C", days, lastValue], [league, "v1,v2,,v4…"], …]
  try {
    const extra = JSON.parse(readFileSync(join(root, "dist/series.extra.json"), "utf8"));
    const meta = Object.fromEntries((series[`${c.league}|${Object.keys(sc)[0]}`] ?? []).map((x) => [x.league, x]));
    for (const [id, list] of Object.entries(extra)) {
      series[`${c.league}|${id}`] = list.map((e) => {
        if (e[0] === "C") {
          const prices = new Array(e[1]).fill(null); prices[e[1] - 1] = e[2];
          return { league: c.league, version: null, started_on: meta[c.league]?.started_on ?? null, is_current: true, prices };
        }
        const prices = e[1].split(",").map((v) => (v === "" ? null : Number(v)));
        return { league: e[0], version: meta[e[0]]?.version ?? null, started_on: meta[e[0]]?.started_on ?? null, is_current: false, prices };
      });
    }
  } catch { /* optional */ }
  const div = rows.find((r) => r.ninja_id === "divine");
  if (div && series[`${c.league}|${div.item_id}`]) series[`${c.league}|divine`] = series[`${c.league}|${div.item_id}`];
} catch { /* no series: the comparison section shows "no data" */ }
const out = { takenAt: c.takenAt, leagues: c.leagues, overview: { [c.league]: rows }, history, series };
writeFileSync(join(root, "dist/snapshot.json"), JSON.stringify(out));
console.log(`dist/snapshot.json: ${rows.length} rows, ${Object.keys(history).length} histories, ${Object.keys(series).length} league series`);
