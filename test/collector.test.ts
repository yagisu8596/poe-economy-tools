import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  collect,
  classifyLeagues,
  NINJA_BASE,
  type CategoryState,
  type CollectorDeps,
  type FetchResult,
  type IngestItem,
  type League,
  type Store,
} from "../supabase/functions/_shared/collector.ts";

const load = (f: string) => JSON.parse(readFileSync(new URL(`../fixtures/${f}`, import.meta.url), "utf8"));
const CURRENCY = load("allflame-currency-2026-11-04.json");
const SCARAB = load("allflame-scarab-2026-11-04.json");
const LEAGUES = [
  { id: "Allflame", name: "Allflame" },
  { id: "Hardcore Allflame", name: "Hardcore Allflame" },
  { id: "Standard", name: "Standard" },
  { id: "Hardcore", name: "Hardcore" },
];

// ------------------------------------------------------------- fakes
class MemoryStore implements Store {
  leagues: League[] = [];
  state = new Map<string, CategoryState>();
  ingested: { leagueId: string; category: string; items: IngestItem[] }[] = [];
  runs: { leagueId: string; category: string; status: string; error: string | null; warnings: string[] }[] = [];
  async upsertLeagues(l: League[]) { this.leagues = l; }
  async getState(lg: string, c: string) { return this.state.get(`${lg}|${c}`) ?? null; }
  async setState(lg: string, c: string, s: CategoryState) { this.state.set(`${lg}|${c}`, { ...s }); }
  async ingest(leagueId: string, category: string, _at: string, items: IngestItem[]) {
    this.ingested.push({ leagueId, category, items });
    return items.length;
  }
  async recordRun(r: { leagueId: string; category: string; status: string; error: string | null; warnings: string[] }) {
    this.runs.push(r);
  }
}

type Responder = (etag: string | null) => FetchResult;
function fakeNinja(routes: Record<string, Responder>) {
  const calls: string[] = [];
  const fetchJson = async (url: string, etag: string | null): Promise<FetchResult> => {
    calls.push(url);
    const key = url === `${NINJA_BASE}/leagues` ? "leagues" : new URL(url).searchParams.get("league") + "|" + new URL(url).searchParams.get("type");
    const r = routes[key];
    if (!r) return { status: 404, etag: null, body: null };
    return r(etag);
  };
  return { fetchJson, calls };
}
const ok = (body: unknown, tag: string): Responder => (etag) =>
  etag === tag ? { status: 304, etag: tag, body: null } : { status: 200, etag: tag, body: structuredClone(body) };

function deps(store: Store, fetchJson: CollectorDeps["fetchJson"], clock: { t: number }, sleeps: number[] = []): CollectorDeps {
  return { store, fetchJson, now: () => new Date(clock.t), sleep: async (ms) => { sleeps.push(ms); } };
}
const T0 = Date.parse("2026-11-04T01:07:00Z");
const exchangeCalls = (calls: string[]) => calls.filter((c) => c.includes("/exchange/"));

// ------------------------------------------------------------- leagues
test("classifyLeagues maps poe.ninja's list to our four kinds", () => {
  assert.deepEqual(classifyLeagues(LEAGUES).map((l) => [l.id, l.kind]), [
    ["Allflame", "challenge"],
    ["Hardcore Allflame", "challenge_hc"],
    ["Standard", "standard"],
    ["Hardcore", "hardcore"],
  ]);
});

test("classifyLeagues follows a new league automatically and ignores events", () => {
  const next = [{ id: "NewLeague" }, { id: "Hardcore NewLeague" }, { id: "Standard" }, { id: "Hardcore" }, { id: "Some Event" }];
  assert.deepEqual(classifyLeagues(next).map((l) => l.kind), ["challenge", "challenge_hc", "standard", "hardcore"]);
  assert.deepEqual(classifyLeagues([{ id: "Standard" }, { id: "Hardcore" }]).map((l) => l.kind), ["standard", "hardcore"]);
  assert.deepEqual(classifyLeagues(null), []);
});

// ------------------------------------------------------------- collection
test("fast tier collects Currency first, then other categories with the Divine reference", async () => {
  const store = new MemoryStore();
  const ninja = fakeNinja({ leagues: ok(LEAGUES, "L1"), "Allflame|Currency": ok(CURRENCY, "c1"), "Allflame|Scarab": ok(SCARAB, "s1") });
  const sleeps: number[] = [];
  const sum = await collect(deps(store, ninja.fetchJson, { t: T0 }, sleeps), { tier: "fast", categories: ["Currency", "Scarab"] });

  assert.deepEqual(sum.leagues, ["Allflame"]);
  assert.deepEqual(exchangeCalls(ninja.calls).map((c) => new URL(c).searchParams.get("type")), ["Currency", "Scarab"]);
  assert.deepEqual(sum.results.map((r) => r.status), ["ok", "ok"]);
  assert.equal(sleeps.length, 1, "pauses between upstream requests");

  const st = await store.getState("Allflame", "Currency");
  assert.equal(st!.divineChaos, 401.8);
  assert.equal(st!.divineChange7d, 17.25);
  assert.equal(st!.etag, "c1");

  const scarab = store.ingested.find((i) => i.category === "Scarab")!.items.find((i) => i.ninja_id === "ambush-scarab")!;
  assert.equal(scarab.chaos_value, 2.93);
  assert.equal(scarab.change7d_chaos, -33.64);
  // Divine trend borrowed from Currency: (1 - 0.3364) / 1.1725 - 1
  assert.ok(Math.abs(scarab.change7d_divine! - ((0.6636 / 1.1725 - 1) * 100)) < 1e-6);
  assert.equal(scarab.icon_url, "https://poe.ninja/gen/image/ambush.png");
  assert.equal(scarab.trend_pair, "chaos");
});

test("a repeated trigger within the interval does not hit poe.ninja again", async () => {
  const store = new MemoryStore();
  const ninja = fakeNinja({ leagues: ok(LEAGUES, "L1"), "Allflame|Currency": ok(CURRENCY, "c1") });
  const clock = { t: T0 };
  await collect(deps(store, ninja.fetchJson, clock), { tier: "fast", categories: ["Currency"] });
  clock.t += 5 * 60_000;
  const sum = await collect(deps(store, ninja.fetchJson, clock), { tier: "fast", categories: ["Currency"] });
  assert.equal(exchangeCalls(ninja.calls).length, 1);
  assert.equal(sum.results[0].status, "skipped");
});

test("the fast tier fetches again on the next 15-minute run", async () => {
  const store = new MemoryStore();
  const changed = structuredClone(CURRENCY);
  let call = 0;
  const ninja = fakeNinja({
    leagues: ok(LEAGUES, "L1"),
    "Allflame|Currency": (etag) => (++call === 1 ? ok(CURRENCY, "c1")(etag) : ok(changed, "c2")(etag)),
  });
  const clock = { t: T0 };
  await collect(deps(store, ninja.fetchJson, clock), { tier: "fast", categories: ["Currency"] });
  clock.t += 15 * 60_000;
  const sum = await collect(deps(store, ninja.fetchJson, clock), { tier: "fast", categories: ["Currency"] });
  assert.equal(sum.results[0].status, "ok");
  assert.equal(store.ingested.length, 2);
});

test("the slow tier is not refetched within the hour", async () => {
  const store = new MemoryStore();
  const ninja = fakeNinja({ leagues: ok(LEAGUES, "L1"), "Standard|Currency": ok(CURRENCY, "c1") });
  const clock = { t: T0 };
  await collect(deps(store, ninja.fetchJson, clock), { tier: "slow", categories: ["Currency"] });
  clock.t += 30 * 60_000;
  const sum = await collect(deps(store, ninja.fetchJson, clock), { tier: "slow", categories: ["Currency"] });
  assert.equal(sum.results.find((r) => r.leagueId === "Standard")!.status, "skipped");
});

test("unchanged data (ETag 304) is recorded as not_modified and not re-stored", async () => {
  const store = new MemoryStore();
  const ninja = fakeNinja({ leagues: ok(LEAGUES, "L1"), "Allflame|Currency": ok(CURRENCY, "c1") });
  const clock = { t: T0 };
  await collect(deps(store, ninja.fetchJson, clock), { tier: "fast", categories: ["Currency"] });
  clock.t += 30 * 60_000;
  const sum = await collect(deps(store, ninja.fetchJson, clock), { tier: "fast", categories: ["Currency"] });
  assert.equal(sum.results[0].status, "not_modified");
  assert.equal(store.ingested.length, 1);
});

test("inverted Divine data is rejected: nothing stored, ETag not remembered", async () => {
  const bad = structuredClone(CURRENCY);
  bad.lines.find((l: { id: string }) => l.id === "divine").primaryValue = 0.002489;
  bad.core.rates.divine = 1 / 0.002489;
  const store = new MemoryStore();
  const ninja = fakeNinja({ leagues: ok(LEAGUES, "L1"), "Allflame|Currency": ok(bad, "bad1"), "Allflame|Scarab": ok(SCARAB, "s1") });
  const sum = await collect(deps(store, ninja.fetchJson, { t: T0 }), { tier: "fast", categories: ["Currency", "Scarab"] });
  assert.equal(sum.results[0].status, "rejected");
  assert.equal(store.ingested.length, 0);
  assert.equal((await store.getState("Allflame", "Currency"))!.etag, null);
  // Without a Divine reference the other categories wait instead of guessing.
  assert.equal(sum.results[1].status, "skipped");
  assert.equal(exchangeCalls(ninja.calls).length, 1);
});

test("a category whose Divine rate is far from Currency's is rejected", async () => {
  const off = structuredClone(SCARAB);
  off.core.rates.divine = 1 / 900; // 900c vs 401.8c
  const store = new MemoryStore();
  const ninja = fakeNinja({ leagues: ok(LEAGUES, "L1"), "Allflame|Currency": ok(CURRENCY, "c1"), "Allflame|Scarab": ok(off, "s1") });
  const sum = await collect(deps(store, ninja.fetchJson, { t: T0 }), { tier: "fast", categories: ["Currency", "Scarab"] });
  assert.deepEqual(sum.results.map((r) => r.status), ["ok", "rejected"]);
});

test("a category missing in this league is recorded as empty, not as an error", async () => {
  const store = new MemoryStore();
  const ninja = fakeNinja({ leagues: ok(LEAGUES, "L1"), "Allflame|Currency": ok(CURRENCY, "c1") });
  const sum = await collect(deps(store, ninja.fetchJson, { t: T0 }), { tier: "fast", categories: ["Currency", "AllflameEmber"] });
  assert.deepEqual(sum.results.map((r) => r.status), ["ok", "empty"]);
});

test("HTTP 429 stops the whole run immediately", async () => {
  const store = new MemoryStore();
  const ninja = fakeNinja({
    leagues: ok(LEAGUES, "L1"),
    "Allflame|Currency": ok(CURRENCY, "c1"),
    "Allflame|Scarab": () => ({ status: 429, etag: null, body: null }),
    "Allflame|Essence": ok(SCARAB, "e1"),
  });
  const sum = await collect(deps(store, ninja.fetchJson, { t: T0 }), { tier: "fast", categories: ["Currency", "Scarab", "Essence"] });
  assert.equal(sum.stoppedEarly, true);
  assert.equal(exchangeCalls(ninja.calls).length, 2);
});

test("network errors are recorded and the run continues", async () => {
  const store = new MemoryStore();
  const ninja = fakeNinja({
    leagues: ok(LEAGUES, "L1"),
    "Allflame|Currency": ok(CURRENCY, "c1"),
    "Allflame|Scarab": () => { throw new Error("timeout"); },
    "Allflame|Essence": ok(SCARAB, "e1"),
  });
  const sum = await collect(deps(store, ninja.fetchJson, { t: T0 }), { tier: "fast", categories: ["Currency", "Scarab", "Essence"] });
  assert.deepEqual(sum.results.map((r) => r.status), ["ok", "error", "ok"]);
  assert.equal(store.runs.find((r) => r.category === "Scarab")!.error, "timeout");
});

test("the time budget stops a run cleanly; the next run continues where it left off", async () => {
  const store = new MemoryStore();
  const ninja = fakeNinja({ leagues: ok(LEAGUES, "L1"), "Allflame|Currency": ok(CURRENCY, "c1"), "Allflame|Scarab": ok(SCARAB, "s1") });
  const clock = { t: T0 };
  const slowDeps: CollectorDeps = { ...deps(store, ninja.fetchJson, clock), sleep: async () => { clock.t += 200_000; } };
  const first = await collect(slowDeps, { tier: "fast", categories: ["Currency", "Scarab"], budgetMs: 100_000 });
  assert.equal(first.stoppedEarly, true);
  assert.deepEqual(first.results.map((r) => r.category), ["Currency"]);
  // Scarab had not been claimed, so the next run (still within Currency's interval) does it.
  clock.t += 60_000;
  const second = await collect(deps(store, ninja.fetchJson, clock), { tier: "fast", categories: ["Currency", "Scarab"] });
  assert.deepEqual(second.results.map((r) => r.status), ["skipped", "ok"]);
});

test("slow tier covers challenge hardcore, Standard and Hardcore only", async () => {
  const store = new MemoryStore();
  const ninja = fakeNinja({ leagues: ok(LEAGUES, "L1") });
  const sum = await collect(deps(store, ninja.fetchJson, { t: T0 }), { tier: "slow", categories: ["Currency"] });
  assert.deepEqual(sum.leagues, ["Hardcore Allflame", "Standard", "Hardcore"]);
  assert.equal(store.leagues.length, 4, "all leagues are still recorded");
});
