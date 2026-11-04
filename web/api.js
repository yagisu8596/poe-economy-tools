// Data sources for the Market page. The live site talks to Supabase with the
// publishable key (read-only public data, protected by RLS); previews use an
// embedded snapshot with the same shape.

export function supabaseSource({ url, key }) {
  const headers = { apikey: key, "Content-Type": "application/json", Accept: "application/json" };
  async function req(path, body) {
    const res = await fetch(url + path, {
      method: body ? "POST" : "GET",
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { msg = (await res.json()).message || msg; } catch { /* keep status */ }
      throw new Error(msg);
    }
    return res.json();
  }
  return {
    mode: "live",
    leagues: () => req("/rest/v1/leagues?select=id,name,kind,is_active&is_active=eq.true"),
    overview: (league) => req("/rest/v1/rpc/market_overview", { p_league_id: league }),
    history: (league, itemId, hours) =>
      req("/rest/v1/rpc/price_history", { p_league_id: league, p_item_id: itemId, p_hours: hours }),
    // Same league day in past leagues (day = null → today's day of the current league).
    compare: (league, itemId, day) =>
      req("/rest/v1/rpc/league_day_compare", { p_league_id: league, p_item_id: itemId, p_day: day ?? null }),
    series: (league, itemId) => req("/rest/v1/rpc/league_day_series", { p_league_id: league, p_item_id: itemId }),
  };
}

export function snapshotSource(snapshot) {
  const delay = (v) => new Promise((r) => setTimeout(() => r(structuredClone(v)), 120));
  return {
    mode: "snapshot",
    takenAt: snapshot.takenAt,
    leagues: () => delay(snapshot.leagues),
    overview: (league) => delay(snapshot.overview[league] ?? []),
    history: (league, itemId, hours) => {
      const pts = snapshot.history?.[`${league}|${itemId}`] ?? [];
      const end = pts.length ? Date.parse(pts[pts.length - 1].ts) : 0;
      return delay(pts.filter((p) => Date.parse(p.ts) >= end - hours * 3600e3));
    },
    series: (league, itemId) => delay(snapshot.series?.[`${league}|${itemId}`] ?? []),
    // Built from the stored series so the preview needs no extra data.
    compare: async (league, itemId, day) => {
      const series = snapshot.series?.[`${league}|${itemId}`] ?? [];
      const divine = snapshot.series?.[`${league}|divine`] ?? [];
      const cur = series.find((x) => x.is_current);
      const today = cur ? cur.prices.length : 1;
      const n = day ?? today;
      const live = (snapshot.overview[league] ?? []).find((r) => r.item_id === itemId);
      const isDiv = live?.ninja_id === "divine";
      return delay(series.map((x) => {
        const dv = divine.find((d) => d.league === x.league)?.prices?.[n - 1];
        const c = x.is_current && n === today ? live?.chaos_value ?? null : x.prices[n - 1] ?? null;
        const d = x.is_current && n === today ? live?.divine_value ?? null : c == null ? null : isDiv ? 1 : dv > 0 ? c / dv : null;
        return { league: x.league, version: x.version, started_on: x.started_on, is_current: x.is_current, day: n,
          chaos_value: c, divine_value: d, league_days: x.is_current ? today : x.prices.length };
      }));
    },
  };
}
