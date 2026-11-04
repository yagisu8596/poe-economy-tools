import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatPrice, formatChange, formatVolume, timeAgo, selectRows, movers, categories, categoryLabel, freshnessState, itemHash, findByHash, toggleWatch, displayPrice, chartUnit, compareRows, compareLabel, toDivineSeries, leagueChartModel, nearestValue,
  defaultLeague, chartModel, niceTicks, newestUpdate,
} from "../web/lib.js";

const row = (o: Record<string, unknown>) => ({
  item_id: 1, name: "X", category: "Currency", chaos_value: 1, divine_value: 0.0025, volume_chaos: 100,
  confidence: 2, updated_at: "2026-11-04T02:32:00Z", change_1h: null, change_6h: null, change_24h: null,
  change7d_chaos: null, ...o,
});

test("price follows the divine/chaos display rule; missing is a dash", () => {
  assert.deepEqual(formatPrice(440.2, 1), { main: "1.00 div", alt: "440 c" });
  assert.deepEqual(formatPrice(543427, 1234.6), { main: "1,235 div", alt: "543,427 c" });
  assert.deepEqual(formatPrice(16.25, 0.0369), { main: "16.3 c", alt: "0.037 div" });
  assert.equal(formatPrice(0.002771, 0.0000063).main, "0.0028 c");
  assert.deepEqual(formatPrice(null, null), { main: "—", alt: null });
});

test("changes are signed with a real minus and missing is a dash, not 0%", () => {
  assert.deepEqual(formatChange(5), { text: "+5.0%", dir: "up" });
  assert.deepEqual(formatChange(-4.25), { text: "−4.3%", dir: "down" });
  assert.deepEqual(formatChange(222.5), { text: "+223%", dir: "up" });
  assert.deepEqual(formatChange(0.01), { text: "0.0%", dir: "flat" });
  assert.deepEqual(formatChange(null), { text: "—", dir: "none" });
});

test("volume and time formatting", () => {
  assert.equal(formatVolume(294938), "295k c");
  assert.equal(formatVolume(1670577), "1.7M c");
  assert.equal(formatVolume(null), "—");
  const now = Date.parse("2026-11-04T03:00:00Z");
  assert.equal(timeAgo("2026-11-04T02:53:00Z", now), "7 min ago");
  assert.equal(timeAgo("2026-11-04T00:30:00Z", now), "2 h ago");
  assert.equal(timeAgo(null, now), "never");
});

test("rows without a value sort last instead of counting as zero", () => {
  const rows = [
    row({ name: "A", change_1h: 3 }), row({ name: "B", change_1h: null }),
    row({ name: "C", change_1h: -8 }), row({ name: "D", change_1h: 12 }),
  ];
  const s = selectRows(rows, { sort: "change", windowField: "change_1h", category: "all" });
  assert.deepEqual(s.map((r) => r.name), ["D", "A", "C", "B"]);
});

test("filters: category, search, thin markets hidden", () => {
  const rows = [
    row({ name: "Divine Orb", confidence: 2 }), row({ name: "Orb of Intention", confidence: 0 }),
    row({ name: "Ambush Scarab", category: "Scarab", confidence: 1 }),
  ];
  assert.deepEqual(selectRows(rows, { category: "all", minConfidence: 1 }).map((r) => r.name).sort(), ["Ambush Scarab", "Divine Orb"]);
  assert.deepEqual(selectRows(rows, { category: "Scarab" }).map((r) => r.name), ["Ambush Scarab"]);
  assert.deepEqual(selectRows(rows, { category: "all", query: "orb" }).map((r) => r.name).sort(), ["Divine Orb", "Orb of Intention"]);
});

test("movers ignore thin markets and missing values", () => {
  const rows = [
    row({ name: "Up", change_1h: 10, confidence: 2 }), row({ name: "Fake spike", change_1h: 300, confidence: 0 }),
    row({ name: "Down", change_1h: -6, confidence: 1 }), row({ name: "Unknown", change_1h: null }),
  ];
  const m = movers(rows, "change_1h");
  assert.deepEqual(m.up.map((r) => r.name), ["Up"]);
  assert.deepEqual(m.down.map((r) => r.name), ["Down"]);
  assert.equal(m.measured, 2);
});

test("category labels split CamelCase ids", () => {
  assert.equal(categoryLabel("DivinationCard"), "Divination Card");
  assert.equal(categoryLabel("AllflameEmber"), "Allflame Ember");
  assert.equal(categoryLabel("Currency"), "Currency");
});

test("categories by size, default league, newest update", () => {
  const rows = [row({ category: "Scarab" }), row({ category: "Scarab", updated_at: "2026-11-04T02:47:00Z" }), row({})];
  assert.deepEqual(categories(rows), [{ name: "Scarab", count: 2 }, { name: "Currency", count: 1 }]);
  assert.equal(newestUpdate(rows), "2026-11-04T02:47:00Z");
  assert.equal(defaultLeague([{ id: "Standard", kind: "standard" }, { id: "Allflame", kind: "challenge" }]), "Allflame");
  assert.equal(defaultLeague([{ id: "Old", kind: "challenge", is_active: false }, { id: "Standard", kind: "standard" }]), "Standard");
});

test("chart model: scaled to the box, change from first to last point", () => {
  const pts = [
    { ts: "2026-11-04T00:00:00Z", chaos_value: 400, divine_value: 1 },
    { ts: "2026-11-04T01:00:00Z", chaos_value: 420, divine_value: 1 },
    { ts: "2026-11-04T02:00:00Z", chaos_value: 440, divine_value: 1 },
  ];
  const m = chartModel(pts, { width: 600, height: 200 })!;
  assert.ok(Math.abs(m.change - 10) < 1e-9);
  assert.match(m.line, /^M56\.0 /);
  assert.ok(m.lastX === 588);
  for (const t of m.ticks) assert.ok(t.y >= 12 && t.y <= 176, `tick inside: ${t.y}`);
  assert.equal(chartModel(pts.slice(0, 1), { width: 600, height: 200 }), null, "one point is not a line");
  // flat series still draws
  assert.ok(chartModel([{ ts: "2026-11-04T00:00:00Z", chaos_value: 5 }, { ts: "2026-11-04T01:00:00Z", chaos_value: 5 }], { width: 300, height: 100 }));
});

test("nice ticks are round numbers inside the range", () => {
  assert.deepEqual(niceTicks(392, 448, 4), [400, 420, 440]);
  assert.deepEqual(niceTicks(0.1, 0.2, 4), [0.1, 0.125, 0.15, 0.175, 0.2]);
});

test("freshness follows poe.ninja's hourly publishing", () => {
  assert.equal(freshnessState(10), "fresh");
  assert.equal(freshnessState(70), "fresh");
  assert.equal(freshnessState(120), "stale");
  assert.equal(freshnessState(300), "old");
  assert.equal(freshnessState(NaN), "old");
});

test("item links round-trip and ignore anything else in the hash", () => {
  const rows = [{ item_id: 14, ninja_id: "divine" }, { item_id: 9, ninja_id: "Hunter's Exalted" }];
  assert.equal(itemHash(rows[0]), "#item-divine");
  assert.equal(itemHash(rows[1]), "#item-hunter-s-exalted");
  assert.equal(findByHash(rows, "#item-divine"), rows[0]);
  assert.equal(findByHash(rows, "#item-hunter-s-exalted"), rows[1]);
  assert.equal(findByHash(rows, "#item-missing"), null);
  assert.equal(findByHash(rows, "#settings"), null);
  assert.equal(findByHash(rows, ""), null);
});

test("watchlist toggles and drops junk", () => {
  assert.deepEqual(toggleWatch([], 3), [3]);
  assert.deepEqual(toggleWatch([3, 5], 3), [5]);
  assert.deepEqual(toggleWatch(["x", 2.5, 4], 7), [4, 7]);
  assert.deepEqual(toggleWatch(null, 1), [1]);
});

test("Divine Orb is priced and charted in chaos; expensive items in divines", () => {
  const divine = { ninja_id: "divine", chaos_value: 441.6, divine_value: 1 };
  const mist = { ninja_id: "reflecting-mist", chaos_value: 4247, divine_value: 9.617 };
  const deck = { ninja_id: "stacked-deck", chaos_value: 9.62, divine_value: 0.02178 };
  assert.deepEqual(displayPrice(divine), { main: "442 c", alt: null });
  assert.equal(displayPrice(mist).main, "9.62 div");
  assert.equal(chartUnit(divine), "chaos");
  assert.equal(chartUnit(mist), "divine");
  assert.equal(chartUnit(deck), "chaos");
});

test("same-day comparison: labels, units and how this league compares", () => {
  const rows = [
    { league: "Allflame", version: null, is_current: true, day: 3, chaos_value: 120, divine_value: 1 },
    { league: "Mirage", version: "3.28", is_current: false, day: 3, chaos_value: 97.9, divine_value: 1 },
    { league: "Keepers", version: "3.27", is_current: false, day: 3, chaos_value: null, divine_value: null },
  ];
  const c = compareRows(rows, "chaos");
  assert.equal(c[0].label, "Allflame (this league)");
  assert.equal(c[1].label, "Mirage (3.28)");
  assert.equal(c[0].vsNow, null);
  assert.ok(Math.abs(c[1].vsNow - ((120 / 97.9 - 1) * 100)) < 1e-9);
  assert.equal(c[2].vsNow, null, "no price that day");
  assert.equal(compareRows(rows, "divine")[1].vsNow, 0, "divine of Divine Orb is always 1");
  assert.equal(compareLabel({ league: "X", is_current: false }), "X");
});

test("divine series divides day by day and skips gaps", () => {
  assert.deepEqual(toDivineSeries([10, null, 30, 40], [100, 100, 0, 200]), [0.1, null, null, 0.2]);
  assert.deepEqual(toDivineSeries([36.3, 86.2], [36.3, 86.2], true), [1, 1]);
});

test("league overlay chart shares one scale and breaks lines at gaps", () => {
  const m = leagueChartModel([
    { key: "cur", label: "Now", prices: [10, 20, null, 40], current: true },
    { key: "old", label: "Old", prices: [5, 6, 7, 8, 9, 10] },
    { key: "empty", label: "None", prices: [null, null] },
  ], { width: 400, height: 200, day: 4 });
  assert.equal(m.lines.length, 2, "empty series dropped");
  assert.equal(m.last, 6);
  assert.equal((m.lines[0].path.match(/M/g) || []).length, 2, "gap starts a new segment");
  assert.ok(m.marker && m.marker.day === 4);
  assert.ok(m.lines[0].end && Math.abs(m.lines[0].end.x - (56 + (3 / 5) * 332)) < 0.01, "current line ends at its last value (day 4)");
  assert.ok(m.ticks.every((t) => t.y >= 12 && t.y <= 176), "ticks inside the plot");
  assert.equal(leagueChartModel([{ key: "x", prices: [null] }], { width: 400, height: 200 }), null);
});

test("nearest reliable day within ±3", () => {
  const p = [1, null, null, null, null, 6, null];
  assert.deepEqual(nearestValue(p, 1), { value: 1, day: 1 });
  assert.deepEqual(nearestValue(p, 4), { value: 6, day: 6 }, "closest day wins");
  assert.deepEqual(nearestValue([null, 2, null, 4], 3), { value: 2, day: 2 }, "ties prefer the earlier day");
  assert.deepEqual(nearestValue(p, 5), { value: 6, day: 6 });
  assert.equal(nearestValue([null, null, null, null, null, null, null, 8], 2), null, "too far");
  assert.equal(nearestValue(null, 3), null);
});
