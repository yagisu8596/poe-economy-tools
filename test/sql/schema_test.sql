-- Schema tests. Run with test/sql/run.sh against a throwaway Postgres.
-- Expects psql variable :items (JSON produced from the real Allflame fixture).
\set ON_ERROR_STOP on

-- Emulate Supabase roles and default grants.
do $$ begin
  if not exists (select from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;

\ir ../../supabase/migrations/20261104000000_market_data.sql
-- Idempotent: running the migration twice must not fail.
\ir ../../supabase/migrations/20261104000000_market_data.sql

insert into leagues (id, name, kind) values ('Allflame', 'Allflame', 'challenge');

-- ---------------------------------------------------------------- ingest
create temp table _r as select ingest_snapshot('Allflame', 'Currency', '2026-11-04T01:07:00Z', :'items'::jsonb) as n;
do $$ declare n int; begin select _r.n into n from _r; assert n = 9, format('ingested %s', n); end $$;

do $$
declare n int; d real; c real;
begin
  select count(*) into n from items where category = 'Currency';
  assert n = 9, format('items %s', n);
  select chaos_value into d from latest_prices lp join items i on i.id = lp.item_id where i.ninja_id = 'divine';
  assert d = 401.8::real, format('divine %s', d);
  -- 1 chaos is a tiny fraction of a divine
  select divine_value into c from latest_prices lp join items i on i.id = lp.item_id where i.ninja_id = 'chaos';
  assert c < 0.01, format('chaos in divine %s', c);
  select count(*) into n from price_points where resolution = 0;
  assert n = 9, format('raw points %s', n);
end $$;

-- An unpriced item: kept in latest_prices as NULL, never written as 0, not in history.
select ingest_snapshot('Allflame', 'Currency', '2026-11-04T01:37:00Z',
  '[{"ninja_id":"annul","name":"Orb of Annulment","icon_url":null,"chaos_value":null,"divine_value":null,"volume_chaos":null,"change7d_chaos":null,"change7d_divine":null,"confidence":0,"trend_pair":"divine"}]'::jsonb);
do $$
declare v real; n int; icon text;
begin
  select chaos_value into v from latest_prices lp join items i on i.id = lp.item_id where i.ninja_id = 'annul';
  assert v is null, 'unpriced must be NULL';
  select count(*) into n from price_points pp join items i on i.id = pp.item_id
   where i.ninja_id = 'annul' and pp.ts = '2026-11-04T01:37:00Z';
  assert n = 0, 'unpriced must not enter history';
  select count(*) into n from price_points where chaos_value = 0;
  assert n = 0, 'no zero prices';
  -- a later snapshot without an icon must not erase the stored icon
  select icon_url into icon from items where ninja_id = 'annul';
  assert icon is not null, 'icon kept';
end $$;

-- Re-ingesting the same moment does not duplicate history.
select ingest_snapshot('Allflame', 'Currency', '2026-11-04T01:07:00Z', :'items'::jsonb);
do $$ declare n int; begin
  select count(*) into n from price_points where ts = '2026-11-04T01:07:00Z';
  assert n = 9, format('dup check %s', n);
end $$;

-- ---------------------------------------------------------------- security
set role anon;
do $$ declare n int; begin
  select count(*) into n from latest_prices;
  assert n = 9, 'anon reads public prices';
  select count(*) into n from collection_state;
  assert n = 0, 'collection_state hidden';
end $$;
do $$ begin
  begin
    insert into app_config values ('collector_token', 'stolen');
    raise exception 'anon was able to write app_config';
  exception when insufficient_privilege then null;  -- RLS blocked it, as intended
  end;
  begin
    insert into price_points (league_id, item_id, resolution, ts, chaos_value) values ('Allflame', 1, 0, now(), 1);
    raise exception 'anon was able to write price_points';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- ---------------------------------------------------------------- compaction
-- Synthetic raw history for one item: every 30 min for 3 days, price rising 1c per point.
truncate price_points;
insert into price_points (league_id, item_id, resolution, ts, chaos_value, divine_value, volume_chaos, confidence)
select 'Allflame', (select id from items where ninja_id = 'alt'), 0,
       timestamptz '2026-11-01T00:00:00Z' + make_interval(mins => 30 * g), 100 + g, (100 + g) / 400.0, 1000, 2
from generate_series(0, 143) g;   -- 2026-11-01 00:00 .. 2026-11-03 23:30

-- Hourly pass at 2026-11-04 00:10: all completed hours rolled up; raw older than 2 days removed.
select compact_price_points('2026-11-04T00:10:00Z', false);
do $$
declare n int; v real;
begin
  select count(*) into n from price_points where resolution = 1;
  assert n = 72, format('hourly rows %s', n);
  -- hour 00:00 of Nov 1 = avg(100, 101)
  select chaos_value into v from price_points where resolution = 1 and ts = '2026-11-01T00:00:00Z';
  assert v = 100.5, format('hourly avg %s', v);
  select count(*) into n from price_points where resolution = 0 and ts < '2026-11-02T00:10:00Z';
  assert n = 0, 'raw older than 2 days deleted';
  -- cutoff 2026-11-02 00:10 → kept: Nov 2 00:30 .. Nov 3 23:30 = 95 points
  select count(*) into n from price_points where resolution = 0;
  assert n = 95, format('raw kept %s', n);
  select count(*) into n from price_points where resolution = 2;
  assert n = 0, 'no daily rows from the hourly pass';
end $$;

-- Running it again changes nothing (idempotent).
select compact_price_points('2026-11-04T00:10:00Z', false);
do $$ declare n int; begin
  select count(*) into n from price_points where resolution = 1;
  assert n = 72, format('hourly rows after rerun %s', n);
end $$;

-- Nightly pass: completed days become daily averages.
select compact_price_points('2026-11-04T00:41:00Z', true);
do $$
declare n int; v real;
begin
  select count(*) into n from price_points where resolution = 2;
  assert n = 3, format('daily rows %s', n);
  -- Nov 1: points 100..147 → avg 123.5
  select chaos_value into v from price_points where resolution = 2 and ts = '2026-11-01T00:00:00Z';
  assert v = 123.5, format('daily avg %s', v);
end $$;

-- Ten days later, hourly rows past 7 days are gone but daily rows stay forever.
select compact_price_points('2026-11-14T00:41:00Z', true);
do $$ declare n int; begin
  select count(*) into n from price_points where resolution = 1;
  assert n = 0, format('old hourly rows %s', n);
  select count(*) into n from price_points where resolution = 2;
  assert n = 3, format('daily rows kept %s', n);
end $$;

\echo 'ALL SQL TESTS PASSED'

do $$ declare ok boolean; begin
  select has_function_privilege('anon', 'public.ingest_snapshot(text,text,timestamptz,jsonb)', 'execute') into ok;
  assert not ok, 'anon must not execute ingest_snapshot';
  select has_function_privilege('authenticated', 'public.compact_price_points(timestamptz,boolean)', 'execute') into ok;
  assert not ok, 'authenticated must not execute compact_price_points';
  select has_function_privilege('service_role', 'public.ingest_snapshot(text,text,timestamptz,jsonb)', 'execute') into ok;
  assert ok, 'service_role executes ingest_snapshot';
end $$;
