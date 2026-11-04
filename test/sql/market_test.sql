-- Market read functions. Run via test/sql/run.sh.
\set ON_ERROR_STOP on
do $$ begin
  if not exists (select from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
\ir ../../supabase/migrations/20261104000000_market_data.sql
\ir ../../supabase/migrations/20261104010000_intraday_alerts.sql
\ir ../../supabase/migrations/20261104020000_market_views.sql
\ir ../../supabase/migrations/20261104020000_market_views.sql
\ir ../../supabase/migrations/20261104030000_hourly_cadence.sql
\ir ../../supabase/migrations/20261104030000_hourly_cadence.sql

insert into leagues (id, name, kind) values ('Allflame', 'Allflame', 'challenge');
insert into items (ninja_id, category, name, icon_url) values ('divine', 'Currency', 'Divine Orb', 'https://poe.ninja/x.png'), ('alt', 'Currency', 'Orb of Alteration', null);

-- 3 days of raw points every 15 min for divine: 400 + 0.1 per step; alt only has a point now.
insert into price_points (league_id, item_id, resolution, ts, chaos_value, divine_value, volume_chaos, confidence)
select 'Allflame', (select id from items where ninja_id = 'divine'), 0,
       timestamptz '2026-11-02T12:00:00Z' + make_interval(mins => 15 * g), 400 + g * 0.1, 1, 1000, 2
from generate_series(0, 288) g;  -- .. 2026-11-05T12:00
insert into latest_prices (league_id, item_id, updated_at, chaos_value, divine_value, volume_chaos, confidence, change7d_chaos, change7d_divine)
select 'Allflame', id, '2026-11-05T12:00:00Z', 428.8, 1, 1000, 2, 17.25, 0 from items where ninja_id = 'divine';
insert into latest_prices (league_id, item_id, updated_at, chaos_value, divine_value, volume_chaos, confidence)
select 'Allflame', id, '2026-11-05T12:00:00Z', 0.11, 0.0003, 50, 0 from items where ninja_id = 'alt';
insert into price_points (league_id, item_id, resolution, ts, chaos_value)
select 'Allflame', id, 0, '2026-11-05T12:00:00Z', 0.11 from items where ninja_id = 'alt';

do $$
declare r record;
begin
  select * into r from market_overview('Allflame', '2026-11-05T12:00:00Z') where ninja_id = 'divine';
  -- 1h ago = step 284 -> 428.4 ; 428.8/428.4 - 1
  assert abs(r.change_1h - ((428.8 / 428.4 - 1) * 100)) < 0.001, format('1h %s', r.change_1h);
  assert abs(r.change_24h - ((428.8 / 419.2 - 1) * 100)) < 0.001, format('24h %s', r.change_24h);
  assert r.name = 'Divine Orb' and r.icon_url is not null and r.change7d_chaos = 17.25, 'metadata';
  select * into r from market_overview('Allflame', '2026-11-05T12:00:00Z') where ninja_id = 'alt';
  assert r.change_1h is null and r.change_24h is null, 'no history -> NULL changes';
  assert r.confidence = 0, 'confidence passed through';
end $$;

-- price_history: short range uses raw points
do $$ declare n int; begin
  select count(*) into n from price_history('Allflame', (select id from items where ninja_id = 'divine'), 24, '2026-11-05T12:00:00Z');
  assert n = 97, format('24h raw points %s', n);
end $$;

-- after compaction, a 7-day range mixes daily/hourly/raw without overlaps
select compact_price_points('2026-11-05T12:00:00Z', true);
do $$
declare n int; dup int; first_ts timestamptz; last_ts timestamptz;
begin
  select count(*), count(*) - count(distinct ts), min(ts), max(ts) into n, dup, first_ts, last_ts
  from price_history('Allflame', (select id from items where ninja_id = 'divine'), 168, '2026-11-05T12:00:00Z');
  assert dup = 0, format('duplicate timestamps %s', dup);
  assert last_ts = '2026-11-05T12:00:00Z', format('latest raw point kept: %s', last_ts);
  assert first_ts <= '2026-11-03T00:00:00Z', format('history reaches back: %s', first_ts);
  -- strictly increasing and no point from a finer resolution before a coarser one ends
  assert (select bool_and(ok) from (
            select ts > lag(ts) over (order by ts) as ok
            from price_history('Allflame', (select id from items where ninja_id = 'divine'), 168, '2026-11-05T12:00:00Z')
          ) s where ok is not null), 'ordered';
  -- hourly Nov 2 12:00..Nov 5 11:00 (72) + daily Nov 2 00:00 (before hourly starts) + raw 12:00
  assert n = 74, format('7d points %s', n);
end $$;

-- anon may call both
set role anon;
do $$ begin
  assert (select count(*) from market_overview('Allflame', '2026-11-05T12:00:00Z')) = 2, 'anon overview';
end $$;
reset role;
\echo 'ALL MARKET TESTS PASSED'
