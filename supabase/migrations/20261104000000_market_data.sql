-- PoE Economy Tools — market data schema
--
-- Public market data collected from poe.ninja. Everything here is readable by
-- anyone (it is public game-economy data); only the collector (service role,
-- which bypasses RLS) writes.
--
-- Retention (fits the Supabase free tier, 500 MB):
--   resolution 0 = raw collector points     kept 2 days
--   resolution 1 = hourly averages          kept 7 days
--   resolution 2 = daily averages           kept forever (per league)
-- Missing prices are stored as NULL and never as 0.

-- ---------------------------------------------------------------- leagues
create table if not exists public.leagues (
  id            text primary key,                 -- poe.ninja league id, e.g. 'Allflame'
  name          text not null,
  kind          text not null check (kind in ('challenge', 'challenge_hc', 'standard', 'hardcore')),
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  is_active     boolean not null default true
);

-- ---------------------------------------------------------------- items
create table if not exists public.items (
  id            serial primary key,
  ninja_id      text not null,                    -- poe.ninja line id, e.g. 'divine'
  category      text not null,                    -- poe.ninja type, e.g. 'Currency'
  name          text not null,
  icon_url      text,
  first_seen_at timestamptz not null default now(),
  unique (ninja_id, category)
);

-- ---------------------------------------------------------------- price history
create table if not exists public.price_points (
  league_id       text     not null references public.leagues (id) on delete cascade,
  item_id         int      not null references public.items (id) on delete cascade,
  resolution      smallint not null check (resolution in (0, 1, 2)),
  ts              timestamptz not null,
  chaos_value     real,                            -- price of one unit in chaos
  divine_value    real,
  volume_chaos    real,                            -- traded value in chaos (NULL = unknown)
  change7d_chaos  real,                            -- source 7-day trend, chaos terms
  change7d_divine real,                            -- same, divine terms
  confidence      smallint check (confidence in (0, 1, 2)),  -- 0 low, 1 medium, 2 high
  primary key (league_id, item_id, resolution, ts)
);

-- ---------------------------------------------------------------- latest snapshot
-- One row per (league, item): what the Market list and the Scanner read.
create table if not exists public.latest_prices (
  league_id       text not null references public.leagues (id) on delete cascade,
  item_id         int  not null references public.items (id) on delete cascade,
  updated_at      timestamptz not null,
  chaos_value     real,
  divine_value    real,
  volume_chaos    real,
  change7d_chaos  real,
  change7d_divine real,
  confidence      smallint,
  trend_pair      text,
  primary key (league_id, item_id)
);

-- ---------------------------------------------------------------- collector bookkeeping
create table if not exists public.collection_state (
  league_id          text not null,
  category           text not null,
  etag               text,
  last_attempt_at    timestamptz,
  last_success_at    timestamptz,
  divine_chaos       real,      -- only for category 'Currency': reference for other categories
  divine_change7d    real,
  primary key (league_id, category)
);

create table if not exists public.collection_runs (
  id           bigserial primary key,
  league_id    text not null,
  category     text not null,
  started_at   timestamptz not null default now(),
  status       text not null check (status in ('ok', 'not_modified', 'empty', 'error', 'rejected')),
  divine_chaos real,
  item_count   int,
  warnings     jsonb,
  error        text
);
create index if not exists collection_runs_started_idx on public.collection_runs (started_at desc);

-- Private settings read by the collector and the cron jobs (service role only).
-- Keys: collector_token, project_url, ninja_contact.
create table if not exists public.app_config (
  key   text primary key,
  value text not null
);

-- ---------------------------------------------------------------- ingest
-- Called by the collector with the already-normalized snapshot of one
-- (league, category). Upserts item metadata, appends raw price points and
-- refreshes latest_prices, all in one transaction.
create or replace function public.ingest_snapshot(
  p_league_id    text,
  p_category     text,
  p_captured_at  timestamptz,
  p_items        jsonb
) returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  create temporary table _src on commit drop as
  select *
  from jsonb_to_recordset(p_items) as x(
    ninja_id text, name text, icon_url text,
    chaos_value real, divine_value real, volume_chaos real,
    change7d_chaos real, change7d_divine real, confidence smallint, trend_pair text
  );

  insert into items (ninja_id, category, name, icon_url)
  select s.ninja_id, p_category, s.name, s.icon_url from _src s
  on conflict (ninja_id, category) do update
    set name = excluded.name,
        icon_url = coalesce(excluded.icon_url, items.icon_url)
    where items.name is distinct from excluded.name
       or (excluded.icon_url is not null and items.icon_url is distinct from excluded.icon_url);

  -- Raw history: only rows that actually have a price.
  insert into price_points (league_id, item_id, resolution, ts, chaos_value, divine_value,
                            volume_chaos, change7d_chaos, change7d_divine, confidence)
  select p_league_id, i.id, 0, p_captured_at, s.chaos_value, s.divine_value,
         s.volume_chaos, s.change7d_chaos, s.change7d_divine, s.confidence
  from _src s join items i on i.ninja_id = s.ninja_id and i.category = p_category
  where s.chaos_value is not null
  on conflict do nothing;

  -- Latest view keeps unpriced items too, so the UI can show "—".
  insert into latest_prices (league_id, item_id, updated_at, chaos_value, divine_value, volume_chaos,
                             change7d_chaos, change7d_divine, confidence, trend_pair)
  select p_league_id, i.id, p_captured_at, s.chaos_value, s.divine_value, s.volume_chaos,
         s.change7d_chaos, s.change7d_divine, s.confidence, s.trend_pair
  from _src s join items i on i.ninja_id = s.ninja_id and i.category = p_category
  on conflict (league_id, item_id) do update set
    updated_at = excluded.updated_at, chaos_value = excluded.chaos_value,
    divine_value = excluded.divine_value, volume_chaos = excluded.volume_chaos,
    change7d_chaos = excluded.change7d_chaos, change7d_divine = excluded.change7d_divine,
    confidence = excluded.confidence, trend_pair = excluded.trend_pair;

  select count(*) into v_count from _src;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------- compaction
-- Rolls completed hours of raw points into hourly averages and completed days of
-- hourly points into daily averages, then deletes what is past retention.
-- Idempotent: safe to run as often as wanted.
create or replace function public.compact_price_points(
  p_now timestamptz default now(),
  p_include_daily boolean default true      -- hourly cron passes false; nightly cron true
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hourly int; v_daily int; v_del_raw int; v_del_hourly int; v_del_runs int;
begin
  insert into price_points (league_id, item_id, resolution, ts, chaos_value, divine_value,
                            volume_chaos, change7d_chaos, change7d_divine, confidence)
  select league_id, item_id, 1, date_trunc('hour', ts, 'UTC'),
         avg(chaos_value), avg(divine_value), avg(volume_chaos),
         avg(change7d_chaos), avg(change7d_divine), min(confidence)
  from price_points
  where resolution = 0 and ts < date_trunc('hour', p_now, 'UTC')
  group by league_id, item_id, date_trunc('hour', ts, 'UTC')
  on conflict (league_id, item_id, resolution, ts) do update set
    chaos_value = excluded.chaos_value, divine_value = excluded.divine_value,
    volume_chaos = excluded.volume_chaos, change7d_chaos = excluded.change7d_chaos,
    change7d_divine = excluded.change7d_divine, confidence = excluded.confidence;
  get diagnostics v_hourly = row_count;

  if not p_include_daily then
    delete from price_points where resolution = 0 and ts < p_now - interval '2 days';
    get diagnostics v_del_raw = row_count;
    return jsonb_build_object('hourly_upserted', v_hourly, 'raw_deleted', v_del_raw);
  end if;

  insert into price_points (league_id, item_id, resolution, ts, chaos_value, divine_value,
                            volume_chaos, change7d_chaos, change7d_divine, confidence)
  select league_id, item_id, 2, date_trunc('day', ts, 'UTC'),
         avg(chaos_value), avg(divine_value), avg(volume_chaos),
         avg(change7d_chaos), avg(change7d_divine), min(confidence)
  from price_points
  where resolution = 1 and ts < date_trunc('day', p_now, 'UTC')
  group by league_id, item_id, date_trunc('day', ts, 'UTC')
  on conflict (league_id, item_id, resolution, ts) do update set
    chaos_value = excluded.chaos_value, divine_value = excluded.divine_value,
    volume_chaos = excluded.volume_chaos, change7d_chaos = excluded.change7d_chaos,
    change7d_divine = excluded.change7d_divine, confidence = excluded.confidence;
  get diagnostics v_daily = row_count;

  -- Only delete raw rows whose hour has been rolled up (older than 2 days anyway).
  delete from price_points where resolution = 0 and ts < p_now - interval '2 days';
  get diagnostics v_del_raw = row_count;
  -- Only delete hourly rows whose day has been rolled up.
  delete from price_points where resolution = 1 and ts < least(p_now - interval '7 days', date_trunc('day', p_now, 'UTC'));
  get diagnostics v_del_hourly = row_count;
  delete from collection_runs where started_at < p_now - interval '14 days';
  get diagnostics v_del_runs = row_count;

  return jsonb_build_object('hourly_upserted', v_hourly, 'daily_upserted', v_daily,
                            'raw_deleted', v_del_raw, 'hourly_deleted', v_del_hourly,
                            'runs_deleted', v_del_runs);
end;
$$;

-- ---------------------------------------------------------------- security
alter table public.leagues          enable row level security;
alter table public.items            enable row level security;
alter table public.price_points     enable row level security;
alter table public.latest_prices    enable row level security;
alter table public.collection_runs  enable row level security;
alter table public.collection_state enable row level security;  -- no policies: private
alter table public.app_config       enable row level security;  -- no policies: private

drop policy if exists "public read" on public.leagues;
drop policy if exists "public read" on public.items;
drop policy if exists "public read" on public.price_points;
drop policy if exists "public read" on public.latest_prices;
drop policy if exists "public read" on public.collection_runs;
create policy "public read" on public.leagues         for select to anon, authenticated using (true);
create policy "public read" on public.items           for select to anon, authenticated using (true);
create policy "public read" on public.price_points    for select to anon, authenticated using (true);
create policy "public read" on public.latest_prices   for select to anon, authenticated using (true);
create policy "public read" on public.collection_runs for select to anon, authenticated using (true);

-- The write functions run as their owner; nobody but the service role may call them.
-- Supabase grants EXECUTE on new public functions to anon/authenticated by default,
-- so revoking from PUBLIC alone is not enough.
revoke all on function public.ingest_snapshot(text, text, timestamptz, jsonb) from public, anon, authenticated;
revoke all on function public.compact_price_points(timestamptz, boolean) from public, anon, authenticated;
grant execute on function public.ingest_snapshot(text, text, timestamptz, jsonb) to service_role;
grant execute on function public.compact_price_points(timestamptz, boolean) to service_role;
