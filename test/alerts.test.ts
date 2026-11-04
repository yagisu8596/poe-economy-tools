import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildPayloads,
  formatEvent,
  sendDiscord,
  testPayload,
  windowLabel,
  DISCORD_WEBHOOK_RE,
  type AlertEvent,
  type PostJson,
} from "../supabase/functions/_shared/alerts.ts";
import { collect, NINJA_BASE, type CategoryState, type CollectorDeps, type FetchResult, type IngestItem, type League, type Store } from "../supabase/functions/_shared/collector.ts";

const ev = (over: Partial<AlertEvent> = {}): AlertEvent => ({
  id: 1, alert_id: 7, item_id: 3, item_name: "Divine Orb", alert_label: "divine +3% 1h", league_id: "Allflame",
  fired_at: "2026-11-05T12:00:00Z", kind: "rise", threshold: 3, unit: null, window_minutes: 60,
  now_chaos: 420, now_divine: 1, change_pct: 5, volume_chaos: 294938, confidence: 2, ...over,
});
const HOOK = "https://discord.com/api/webhooks/123456789/abc_DEF-ghi";

// ------------------------------------------------------------- formatting
test("rise/drop titles show the signed change and the window", () => {
  assert.equal(formatEvent(ev()).title, "📈 Divine Orb +5.0% in 1h");
  assert.equal(formatEvent(ev({ kind: "drop", change_pct: -4.25, window_minutes: 15 })).title, "📉 Divine Orb −4.3% in 15m");
  assert.equal(windowLabel(1440), "24h");
  assert.equal(windowLabel(360), "6h");
});

test("level alerts name the level and its unit", () => {
  assert.equal(formatEvent(ev({ kind: "above", threshold: 410, unit: "chaos", change_pct: null })).title, "🔔 Divine Orb rose above 410 c");
  assert.equal(formatEvent(ev({ kind: "below", threshold: 2, unit: "divine" })).title, "🔔 Divine Orb fell below 2 div");
});

test("the price follows the divine/chaos display rule and nothing is invented", () => {
  const scarab = formatEvent(ev({ item_name: "Ambush Scarab", now_chaos: 2.93, now_divine: 2.93 / 401.8, volume_chaos: null, confidence: null }));
  assert.match(scarab.description, /\*\*Now:\*\* 2\.93 c/);
  assert.match(scarab.description, /\*\*Traded:\*\* — · \*\*Confidence:\*\* —/);
  const mirror = formatEvent(ev({ now_chaos: 501173, now_divine: 501173 / 401.8 }));
  assert.match(mirror.description, /1,247 div \(501,173 c\)/);
  const unpriced = formatEvent(ev({ now_chaos: null, now_divine: null }));
  assert.match(unpriced.description, /\*\*Now:\*\* —/);
});

test("messages are English, colored by direction, and never ping anyone", () => {
  const [{ payload }] = buildPayloads([ev(), ev({ id: 2, kind: "drop", change_pct: -6 })]);
  assert.deepEqual(payload.allowed_mentions, { parse: [] });
  assert.equal(payload.embeds![0].color, 0x2f9e44);
  assert.equal(payload.embeds![1].color, 0xc92a2a);
  assert.match(payload.embeds![0].description, /Check the live rate in game/);
  assert.match(payload.embeds![0].footer.text, /not affiliated with Grinding Gear Games/);
});

test("more than 10 events are split into several messages", () => {
  const many = Array.from({ length: 23 }, (_, i) => ev({ id: i + 1 }));
  const parts = buildPayloads(many);
  assert.deepEqual(parts.map((p) => p.ids.length), [10, 10, 3]);
  assert.equal(parts[2].ids[2], 23);
});

// ------------------------------------------------------------- sending
test("webhook URL is validated before anything is sent", async () => {
  assert.ok(DISCORD_WEBHOOK_RE.test(HOOK));
  assert.ok(!DISCORD_WEBHOOK_RE.test("https://evil.example.com/api/webhooks/1/x"));
  let called = false;
  const post: PostJson = async () => { called = true; return { status: 204, retryAfterMs: null }; };
  const err = await sendDiscord(post, async () => {}, "https://example.com/hook", testPayload("2026-11-05T12:00:00Z"));
  assert.match(err!, /not valid/);
  assert.equal(called, false);
});

test("429 waits as asked (capped) and retries once", async () => {
  const sleeps: number[] = [];
  let n = 0;
  const post: PostJson = async () => (++n === 1 ? { status: 429, retryAfterMs: 1200 } : { status: 204, retryAfterMs: null });
  assert.equal(await sendDiscord(post, async (ms) => { sleeps.push(ms); }, HOOK, testPayload("x")), null);
  assert.deepEqual(sleeps, [1200]);
});

test("a deleted webhook gives a clear error", async () => {
  const post: PostJson = async () => ({ status: 404, retryAfterMs: null });
  assert.match((await sendDiscord(post, async () => {}, HOOK, testPayload("x")))!, /deleted/);
});

// ------------------------------------------------------------- collector integration
const CURRENCY = JSON.parse(readFileSync(new URL("../fixtures/allflame-currency-2026-11-04.json", import.meta.url), "utf8"));
const LEAGUES = [{ id: "Allflame" }, { id: "Hardcore Allflame" }, { id: "Standard" }, { id: "Hardcore" }];
class MemoryStore implements Store {
  state = new Map<string, CategoryState>();
  async upsertLeagues(_l: League[]) {}
  async getState(lg: string, c: string) { return this.state.get(`${lg}|${c}`) ?? null; }
  async setState(lg: string, c: string, s: CategoryState) { this.state.set(`${lg}|${c}`, s); }
  async ingest(_l: string, _c: string, _a: string, items: IngestItem[]) { return items.length; }
  async recordRun() {}
}
function fetcher(routes: Record<string, () => FetchResult>) {
  return async (url: string): Promise<FetchResult> => {
    if (url === `${NINJA_BASE}/leagues`) return { status: 200, etag: "l", body: LEAGUES };
    const u = new URL(url);
    const r = routes[`${u.searchParams.get("league")}|${u.searchParams.get("type")}`];
    return r ? r() : { status: 404, etag: null, body: null };
  };
}
const T0 = Date.parse("2026-11-05T12:00:00Z");

test("alerts are evaluated after each stored category and delivered once per run", async () => {
  const evaluated: string[] = [];
  const delivered: AlertEvent[][] = [];
  const deps: CollectorDeps = {
    store: new MemoryStore(),
    fetchJson: fetcher({ "Allflame|Currency": () => ({ status: 200, etag: "c", body: structuredClone(CURRENCY) }) }),
    now: () => new Date(T0),
    sleep: async () => {},
    alerts: {
      evaluate: async (l, c, at) => { evaluated.push(`${l}/${c}@${at}`); return c === "Currency" ? [ev(), ev({ id: 2 })] : []; },
      deliver: async (events) => { delivered.push(events); },
    },
  };
  const sum = await collect(deps, { tier: "fast", categories: ["Currency", "Scarab"] });
  assert.deepEqual(evaluated, ["Allflame/Currency@2026-11-05T12:00:00.000Z"], "only stored categories are evaluated, with the ingest time");
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].length, 2);
  assert.equal(sum.alerts.fired, 2);
});

test("alert failures never stop price collection", async () => {
  const deps: CollectorDeps = {
    store: new MemoryStore(),
    fetchJson: fetcher({
      "Allflame|Currency": () => ({ status: 200, etag: "c", body: structuredClone(CURRENCY) }),
      "Allflame|Essence": () => ({ status: 200, etag: "e", body: structuredClone(CURRENCY) }),
    }),
    now: () => new Date(T0),
    sleep: async () => {},
    alerts: {
      evaluate: async () => { throw new Error("db down"); },
      deliver: async () => { throw new Error("never called"); },
    },
  };
  const sum = await collect(deps, { tier: "fast", categories: ["Currency", "Essence"] });
  assert.deepEqual(sum.results.map((r) => r.status), ["ok", "ok"]);
  assert.equal(sum.alerts.errors.length, 2);
});

test("events that fired before a 429 are still delivered", async () => {
  const delivered: AlertEvent[][] = [];
  const deps: CollectorDeps = {
    store: new MemoryStore(),
    fetchJson: fetcher({
      "Allflame|Currency": () => ({ status: 200, etag: "c", body: structuredClone(CURRENCY) }),
      "Allflame|Scarab": () => ({ status: 429, etag: null, body: null }),
    }),
    now: () => new Date(T0),
    sleep: async () => {},
    alerts: { evaluate: async () => [ev()], deliver: async (e) => { delivered.push(e); } },
  };
  const sum = await collect(deps, { tier: "fast", categories: ["Currency", "Scarab"] });
  assert.equal(sum.stoppedEarly, true);
  assert.equal(delivered.length, 1);
});
