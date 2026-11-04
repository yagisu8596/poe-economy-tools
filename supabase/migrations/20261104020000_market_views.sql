-- PoE Economy Tools — read functions for the Market page (v0.4.0)
-- Both are read-only over public market data and callable with the publishable key.

-- One row per item of a league: current price + intraday changes from our own
-- snapshots (NULL until enough history exists — never guessed) + the source's
-- 7-day trend.
create or replace function public.market_overview(p_league_id text, p_now timestamptz default now())
returns table (
  item_id         int,
  ninja_id        text,
  name            text,
  category        text,
  icon_url        text,
  chaos_value     real,
  divine_value    real,
  volume_chaos    real,
  confidence      smallint,
  updated_at      timestamptz,
  change_1h       real,
  change_6h       real,
  change_24h      real,
  change7d_chaos  real,
  change7d_divine real
)
language sql
stable
set search_path = public
as $$
  select i.id, i.ninja_id, i.name, i.category, i.icon_url,
         lp.chaos_value, lp.divine_value, lp.volume_chaos, lp.confidence, lp.updated_at,
         h1.change_pct, h6.change_pct, h24.change_pct,
         lp.change7d_chaos, lp.change7d_divine
  from latest_prices lp
  join items i on i.id = lp.item_id
  left join price_change_window(p_league_id, interval '1 hour', p_now)   h1  on h1.item_id  = lp.item_id
  left join price_change_window(p_league_id, interval '6 hours', p_now)  h6  on h6.item_id  = lp.item_id
  left join price_change_window(p_league_id, interval '24 hours', p_now) h24 on h24.item_id = lp.item_id
  where lp.league_id = p_league_id;
$$;

-- Price line for one item over the last p_hours, at the finest resolution we
-- still keep for each stretch of time: daily for old data, hourly for the last
-- week, raw (15-min) points for the most recent hours.
create or replace function public.price_history(
  p_league_id text,
  p_item_id   int,
  p_hours     int,
  p_now       timestamptz default now()
)
returns table (ts timestamptz, chaos_value real, divine_value real, volume_chaos real)
language sql
stable
set search_path = public
as $$
  with pts as (
    select resolution, pp.ts, pp.chaos_value, pp.divine_value, pp.volume_chaos
    from price_points pp
    where pp.league_id = p_league_id and pp.item_id = p_item_id
      and pp.ts >= p_now - make_interval(hours => p_hours)
      and pp.chaos_value is not null
  ),
  edge as (
    select
      (select min(ts) from pts where resolution = 1) as hourly_start,
      (select max(ts) + interval '1 hour' from pts where resolution = 1) as hourly_end,
      (select max(ts) + interval '1 day' from pts where resolution = 2) as daily_end
  )
  select p.ts, p.chaos_value, p.divine_value, p.volume_chaos
  from pts p, edge e
  where case
          -- short ranges: raw points only
          when p_hours <= 48 then p.resolution = 0
          -- hourly rows wherever we still have them (last ~7 days)
          when p.resolution = 1 then true
          -- daily rows only for the time before hourly coverage begins
          when p.resolution = 2 then p.ts < coalesce(e.hourly_start, 'infinity')
          -- raw rows only for what no rollup covers yet
          else p.ts >= coalesce(e.hourly_end, e.daily_end, '-infinity')
        end
  order by p.ts;
$$;

grant execute on function public.market_overview(text, timestamptz) to anon, authenticated, service_role;
grant execute on function public.price_history(text, int, int, timestamptz) to anon, authenticated, service_role;
