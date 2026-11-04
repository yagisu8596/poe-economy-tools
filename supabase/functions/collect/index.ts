/**
 * Supabase Edge Function: collect
 *
 * Triggered by pg_cron (see supabase/setup/schedule.sql):
 *   POST /functions/v1/collect?tier=fast   every 15 min  (current challenge softcore)
 *   POST /functions/v1/collect?tier=slow   hourly        (challenge HC, Standard, Hardcore)
 *   POST /functions/v1/collect?mode=discord-test           (sends one test message to Discord)
 *
 * After each stored (league, category) snapshot the alert rules are evaluated in
 * the database (evaluate_alerts); everything that fired is sent to the Discord
 * webhook in app_config ('discord_webhook_url') once per run.
 *
 * Auth: deployed with verify_jwt = false and protected by a token kept in the
 * private table app_config (key 'collector_token'); the cron job sends it in
 * the x-collector-token header. The per-category minimum interval in the
 * collector is a second line of defence against repeated calls.
 */
import { createClient } from "npm:@supabase/supabase-js@2";
import { collect, type AlertHooks, type CategoryState, type Store, type Tier } from "../_shared/collector.ts";
import { buildPayloads, sendDiscord, testPayload, type AlertEvent, type PostJson } from "../_shared/alerts.ts";

const VERSION = "0.3.0";

Deno.serve(async (req) => {
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });

  const config = await loadConfig(supabase);
  const token = req.headers.get("x-collector-token");
  if (!config.collector_token || token !== config.collector_token) {
    return new Response("Forbidden", { status: 403 });
  }

  const params = new URL(req.url).searchParams;
  const tier: Tier = params.get("tier") === "slow" ? "slow" : "fast";
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  const postJson: PostJson = async (url, body) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    await res.body?.cancel();
    const retry = Number(res.headers.get("retry-after"));
    return { status: res.status, retryAfterMs: Number.isFinite(retry) && retry > 0 ? retry * 1000 : null };
  };

  if (params.get("mode") === "discord-test") {
    const hook = config.discord_webhook_url;
    if (!hook) return Response.json({ ok: false, error: "No Discord webhook saved yet" }, { status: 400 });
    const error = await sendDiscord(postJson, sleep, hook, testPayload(new Date().toISOString()));
    return Response.json({ ok: !error, error }, { status: error ? 502 : 200 });
  }

  const alerts: AlertHooks = {
    async evaluate(leagueId, category, at) {
      const { data, error } = await supabase.rpc("evaluate_alerts", {
        p_league_id: leagueId,
        p_category: category,
        p_now: at,
      });
      if (error) throw error;
      return (data ?? []) as AlertEvent[];
    },
    async deliver(events) {
      const hook = config.discord_webhook_url;
      for (const { payload, ids } of buildPayloads(events)) {
        const error = hook ? await sendDiscord(postJson, sleep, hook, payload) : "No Discord webhook saved yet";
        await supabase.rpc("mark_alert_delivery", { p_ids: ids, p_error: error });
      }
    },
  };
  const userAgent = `poe-economy-tools/${VERSION} (contact: ${config.ninja_contact ?? "not set"})`;

  const fetchJson = async (url: string, etag: string | null) => {
    const headers: Record<string, string> = { "User-Agent": userAgent, Accept: "application/json" };
    if (etag) headers["If-None-Match"] = etag;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
    const body = res.status === 200 ? await res.json() : (await res.body?.cancel(), null);
    return { status: res.status, etag: res.headers.get("etag"), body };
  };

  const store: Store = {
    async upsertLeagues(leagues, seenAt) {
      const { error } = await supabase.from("leagues").upsert(
        leagues.map((l) => ({ id: l.id, name: l.name, kind: l.kind, last_seen_at: seenAt, is_active: true })),
        { onConflict: "id" },
      );
      if (error) throw error;
      const ids = leagues.map((l) => `"${l.id.replaceAll('"', '\\"')}"`).join(",");
      const { error: e2 } = await supabase.from("leagues").update({ is_active: false }).not("id", "in", `(${ids})`);
      if (e2) throw e2;
    },
    async getState(leagueId, category) {
      const { data, error } = await supabase
        .from("collection_state")
        .select("etag,last_attempt_at,last_success_at,divine_chaos,divine_change7d")
        .eq("league_id", leagueId)
        .eq("category", category)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      return {
        etag: data.etag,
        lastAttemptAt: data.last_attempt_at,
        lastSuccessAt: data.last_success_at,
        divineChaos: data.divine_chaos,
        divineChange7d: data.divine_change7d,
      } satisfies CategoryState;
    },
    async setState(leagueId, category, s) {
      const { error } = await supabase.from("collection_state").upsert(
        {
          league_id: leagueId,
          category,
          etag: s.etag,
          last_attempt_at: s.lastAttemptAt,
          last_success_at: s.lastSuccessAt,
          divine_chaos: s.divineChaos,
          divine_change7d: s.divineChange7d,
        },
        { onConflict: "league_id,category" },
      );
      if (error) throw error;
    },
    async ingest(leagueId, category, capturedAt, items) {
      const { data, error } = await supabase.rpc("ingest_snapshot", {
        p_league_id: leagueId,
        p_category: category,
        p_captured_at: capturedAt,
        p_items: items,
      });
      if (error) throw error;
      return data as number;
    },
    async recordRun(r) {
      const { error } = await supabase.from("collection_runs").insert({
        league_id: r.leagueId,
        category: r.category,
        started_at: r.startedAt,
        status: r.status,
        divine_chaos: r.divineChaos,
        item_count: r.itemCount,
        warnings: r.warnings.length ? r.warnings : null,
        error: r.error,
      });
      if (error) throw error;
    },
  };

  try {
    const summary = await collect(
      { fetchJson, store, now: () => new Date(), sleep, alerts },
      { tier, budgetMs: 100_000 },
    );
    return Response.json(summary);
  } catch (e) {
    console.error(e);
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
});

async function loadConfig(supabase: ReturnType<typeof createClient>) {
  const { data } = await supabase.from("app_config").select("key,value").in("key", ["collector_token", "ninja_contact", "discord_webhook_url"]);
  const out: Record<string, string> = {};
  for (const row of data ?? []) out[row.key as string] = row.value as string;
  return out as { collector_token?: string; ninja_contact?: string; discord_webhook_url?: string };
}
