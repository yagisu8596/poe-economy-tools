/**
 * Collector core: fetch poe.ninja exchange overviews for the tracked leagues,
 * normalize them, hand them to a store. No I/O of its own — fetch, storage and
 * the clock are injected so this runs the same in tests and in the Edge Function.
 *
 * poe.ninja rules followed here (https://poe.ninja/docs/api):
 *  - one backend fetches for everyone; never per-user traffic
 *  - conditional requests (ETag / If-None-Match), no cache-busting
 *  - descriptive User-Agent with a contact
 *  - modest volume: sequential requests, a pause between them, and a
 *    per-(league, category) minimum interval so repeated triggers are no-ops
 */
import {
  normalizeExchangeOverview,
  DataIntegrityError,
  type DivineContext,
  type NormalizedItem,
  type RawExchangeOverview,
} from "./normalize.ts";
import type { AlertEvent } from "./alerts.ts";

export const NINJA_BASE = "https://poe.ninja/poe1/api/economy";

/** PoE 1 exchange categories per https://poe.ninja/docs/api (2026-11-04). Currency must stay first. */
export const EXCHANGE_CATEGORIES = [
  "Currency",
  "Fragment",
  "Scarab",
  "Essence",
  "Fossil",
  "Resonator",
  "Oil",
  "DeliriumOrb",
  "DivinationCard",
  "Omen",
  "Tattoo",
  "Runegraft",
  "Astrolabe",
  "Artifact",
  "EnshroudingCrystal",
  "DjinnCoin",
  "Ducat",
  "AllflameEmber",
] as const;

export type LeagueKind = "challenge" | "challenge_hc" | "standard" | "hardcore";
export interface League {
  id: string;
  name: string;
  kind: LeagueKind;
}

/** fast = current challenge softcore (default view); slow = the other three. */
export type Tier = "fast" | "slow";
export const TIER_KINDS: Record<Tier, LeagueKind[]> = {
  fast: ["challenge"],
  slow: ["challenge_hc", "standard", "hardcore"],
};
/** A (league, category) is skipped if it was attempted more recently than this. */
// fast runs every 15 min (poe.ninja refreshes PoE1 about every 15 min); slow runs hourly.
export const MIN_INTERVAL_MS: Record<Tier, number> = { fast: 12 * 60_000, slow: 50 * 60_000 };

export interface FetchResult {
  status: number;
  etag: string | null;
  body: unknown;
}

export interface CategoryState {
  etag: string | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  divineChaos: number | null;
  divineChange7d: number | null;
}

export type RunStatus = "ok" | "not_modified" | "empty" | "error" | "rejected";

export interface Store {
  upsertLeagues(leagues: League[], seenAt: string): Promise<void>;
  getState(leagueId: string, category: string): Promise<CategoryState | null>;
  setState(leagueId: string, category: string, state: CategoryState): Promise<void>;
  ingest(leagueId: string, category: string, capturedAt: string, items: IngestItem[]): Promise<number>;
  recordRun(run: {
    leagueId: string;
    category: string;
    startedAt: string;
    status: RunStatus;
    divineChaos: number | null;
    itemCount: number | null;
    warnings: string[];
    error: string | null;
  }): Promise<void>;
}

export interface IngestItem {
  ninja_id: string;
  name: string;
  icon_url: string | null;
  chaos_value: number | null;
  divine_value: number | null;
  volume_chaos: number | null;
  change7d_chaos: number | null;
  change7d_divine: number | null;
  confidence: 0 | 1 | 2;
  trend_pair: string | null;
}

/** Optional alert hooks: evaluated after each stored snapshot, delivered once per run. */
export interface AlertHooks {
  evaluate(leagueId: string, category: string, at: string): Promise<AlertEvent[]>;
  deliver(events: AlertEvent[]): Promise<void>;
}

export interface CollectorDeps {
  fetchJson(url: string, etag: string | null): Promise<FetchResult>;
  store: Store;
  now(): Date;
  sleep(ms: number): Promise<void>;
  alerts?: AlertHooks;
}

export interface CollectOptions {
  tier: Tier;
  categories?: readonly string[];
  /** Stop starting new requests after this long; the next run picks up the rest. */
  budgetMs?: number;
  /** Pause between upstream requests. */
  gapMs?: number;
}

export interface CollectSummary {
  tier: Tier;
  leagues: string[];
  results: { leagueId: string; category: string; status: RunStatus | "skipped"; items?: number; note?: string }[];
  stoppedEarly: boolean;
  alerts: { fired: number; errors: string[] };
}

/**
 * Map poe.ninja's league list to our league kinds. The first entry is the current
 * challenge league; its hardcore twin is "Hardcore <name>". Anything else (events,
 * private leagues) is ignored.
 */
export function classifyLeagues(list: unknown): League[] {
  if (!Array.isArray(list) || list.length === 0) return [];
  const entries = list
    .filter((l): l is { id: string; name?: string } => !!l && typeof (l as { id?: unknown }).id === "string")
    .map((l) => ({ id: l.id, name: typeof l.name === "string" ? l.name : l.id }));
  if (entries.length === 0) return [];
  const out: League[] = [];
  const first = entries[0];
  const isPermanent = (id: string) => id === "Standard" || id === "Hardcore";
  if (!isPermanent(first.id)) out.push({ ...first, kind: "challenge" });
  for (const e of entries) {
    if (e.id === "Standard") out.push({ ...e, kind: "standard" });
    else if (e.id === "Hardcore") out.push({ ...e, kind: "hardcore" });
    else if (!isPermanent(first.id) && e.id === `Hardcore ${first.id}`) out.push({ ...e, kind: "challenge_hc" });
  }
  return out;
}

const CONFIDENCE_CODE = { low: 0, medium: 1, high: 2 } as const;

export function toIngestItems(items: NormalizedItem[], icons: Map<string, string | null>): IngestItem[] {
  return items.map((i) => ({
    ninja_id: i.id,
    name: i.name,
    icon_url: icons.get(i.id) ?? null,
    chaos_value: i.chaosValue,
    divine_value: i.divineValue,
    volume_chaos: i.volumeChaos,
    change7d_chaos: i.change7dPctChaos,
    change7d_divine: i.change7dPctDivine,
    confidence: CONFIDENCE_CODE[i.confidence],
    trend_pair: i.trendPair,
  }));
}

/** poe.ninja serves item images as relative paths under /gen/image/… */
export function iconMap(raw: RawExchangeOverview & { items?: { id: string; image?: string }[] }): Map<string, string | null> {
  const m = new Map<string, string | null>();
  for (const it of raw.items ?? []) {
    const img = (it as { image?: string }).image;
    m.set(it.id, typeof img === "string" && img.startsWith("/") ? `https://poe.ninja${img}` : null);
  }
  return m;
}

export async function collect(deps: CollectorDeps, opts: CollectOptions): Promise<CollectSummary> {
  const summary: CollectSummary = {
    tier: opts.tier, leagues: [], results: [], stoppedEarly: false, alerts: { fired: 0, errors: [] },
  };
  const fired: AlertEvent[] = [];
  try {
    await collectPrices(deps, opts, summary, fired);
  } finally {
    // Whatever happened to the prices, deliver what already fired.
    if (fired.length && deps.alerts) {
      try {
        await deps.alerts.deliver(fired);
      } catch (e) {
        summary.alerts.errors.push(`deliver: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  return summary;
}

async function collectPrices(
  deps: CollectorDeps,
  opts: CollectOptions,
  summary: CollectSummary,
  fired: AlertEvent[],
): Promise<CollectSummary> {
  const { store } = deps;
  const startMs = deps.now().getTime();
  const budget = opts.budgetMs ?? 100_000;
  const gap = opts.gapMs ?? 400;
  const categories = opts.categories ?? EXCHANGE_CATEGORIES;

  // Leagues
  const leaguesRes = await deps.fetchJson(`${NINJA_BASE}/leagues`, null);
  if (leaguesRes.status !== 200) throw new Error(`poe.ninja leagues: HTTP ${leaguesRes.status}`);
  const all = classifyLeagues(leaguesRes.body);
  if (all.length === 0) throw new Error("poe.ninja returned no usable leagues");
  await store.upsertLeagues(all, deps.now().toISOString());
  const leagues = all.filter((l) => TIER_KINDS[opts.tier].includes(l.kind));
  summary.leagues = leagues.map((l) => l.id);

  let requests = 0;
  for (const league of leagues) {
    let context: DivineContext | null = null;

    for (const category of categories) {
      if (deps.now().getTime() - startMs > budget) {
        summary.stoppedEarly = true;
        return summary;
      }
      const state = (await store.getState(league.id, category)) ?? {
        etag: null, lastAttemptAt: null, lastSuccessAt: null, divineChaos: null, divineChange7d: null,
      };
      if (category === "Currency" && state.divineChaos) {
        context = { divinePriceChaos: state.divineChaos, divineChange7dPct: state.divineChange7d };
      }
      const nowIso = deps.now().toISOString();
      if (state.lastAttemptAt && deps.now().getTime() - Date.parse(state.lastAttemptAt) < MIN_INTERVAL_MS[opts.tier]) {
        summary.results.push({ leagueId: league.id, category, status: "skipped", note: "attempted recently" });
        continue;
      }
      if (category !== "Currency" && !context) {
        summary.results.push({ leagueId: league.id, category, status: "skipped", note: "no Divine reference yet" });
        continue;
      }

      // Claim before fetching, so overlapping triggers cannot double-request poe.ninja.
      await store.setState(league.id, category, { ...state, lastAttemptAt: nowIso });

      if (requests > 0) await deps.sleep(gap);
      if (deps.now().getTime() - startMs > budget) {
        await store.setState(league.id, category, state); // release the claim for the next run
        summary.stoppedEarly = true;
        return summary;
      }
      requests++;
      const url = `${NINJA_BASE}/exchange/current/overview?league=${encodeURIComponent(league.id)}&type=${encodeURIComponent(category)}`;
      const base = { leagueId: league.id, category, startedAt: nowIso };
      let res: FetchResult;
      try {
        res = await deps.fetchJson(url, state.etag);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await store.setState(league.id, category, { ...state, lastAttemptAt: nowIso });
        await store.recordRun({ ...base, status: "error", divineChaos: null, itemCount: null, warnings: [], error: msg });
        summary.results.push({ leagueId: league.id, category, status: "error", note: msg });
        continue;
      }

      if (res.status === 304) {
        await store.setState(league.id, category, { ...state, lastAttemptAt: nowIso });
        await store.recordRun({ ...base, status: "not_modified", divineChaos: null, itemCount: null, warnings: [], error: null });
        summary.results.push({ leagueId: league.id, category, status: "not_modified" });
        continue;
      }
      if (res.status === 404 || (res.status === 200 && !hasLines(res.body))) {
        // Category not offered in this league (e.g. a league mechanic that ended).
        await store.setState(league.id, category, { ...state, etag: res.etag, lastAttemptAt: nowIso });
        await store.recordRun({ ...base, status: "empty", divineChaos: null, itemCount: 0, warnings: [], error: null });
        summary.results.push({ leagueId: league.id, category, status: "empty" });
        continue;
      }
      if (res.status !== 200) {
        const msg = `HTTP ${res.status}`;
        await store.setState(league.id, category, { ...state, lastAttemptAt: nowIso });
        await store.recordRun({ ...base, status: "error", divineChaos: null, itemCount: null, warnings: [], error: msg });
        summary.results.push({ leagueId: league.id, category, status: "error", note: msg });
        if (res.status === 429) {
          summary.stoppedEarly = true; // back off entirely; try again next scheduled run
          return summary;
        }
        continue;
      }

      const raw = res.body as RawExchangeOverview;
      try {
        const snap = normalizeExchangeOverview(raw, {
          league: league.id,
          category,
          fetchedAt: nowIso,
          context: category === "Currency" ? undefined : context ?? undefined,
        });
        const count = await store.ingest(league.id, category, nowIso, toIngestItems(snap.items, iconMap(raw)));
        const next: CategoryState = { ...state, etag: res.etag, lastAttemptAt: nowIso, lastSuccessAt: nowIso };
        if (category === "Currency") {
          next.divineChaos = snap.divinePriceChaos;
          next.divineChange7d = snap.divineChange7dPct;
          context = { divinePriceChaos: snap.divinePriceChaos, divineChange7dPct: snap.divineChange7dPct };
        }
        await store.setState(league.id, category, next);
        await store.recordRun({ ...base, status: "ok", divineChaos: snap.divinePriceChaos, itemCount: count, warnings: snap.warnings, error: null });
        summary.results.push({ leagueId: league.id, category, status: "ok", items: count });
        if (deps.alerts) {
          // Alert problems must never stop price collection.
          try {
            const events = await deps.alerts.evaluate(league.id, category, nowIso);
            fired.push(...events);
            summary.alerts.fired += events.length;
          } catch (e) {
            summary.alerts.errors.push(`${league.id}/${category}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      } catch (e) {
        const rejected = e instanceof DataIntegrityError;
        const msg = e instanceof Error ? e.message : String(e);
        // Do not store the ETag of rejected data, so the next run re-checks it.
        await store.setState(league.id, category, { ...state, lastAttemptAt: nowIso });
        await store.recordRun({ ...base, status: rejected ? "rejected" : "error", divineChaos: null, itemCount: null, warnings: [], error: msg });
        summary.results.push({ leagueId: league.id, category, status: rejected ? "rejected" : "error", note: msg });
      }
    }
  }
  return summary;
}

function hasLines(body: unknown): boolean {
  return !!body && Array.isArray((body as { lines?: unknown }).lines) && (body as { lines: unknown[] }).lines.length > 0;
}
