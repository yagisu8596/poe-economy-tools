-- v0.6.0: league history import + same-day comparison.
\set ON_ERROR_STOP on
do $$ begin
  if not exists (select from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
\ir ../../supabase/migrations/20261104000000_market_data.sql
\ir ../../supabase/migrations/20261104010000_intraday_alerts.sql
\ir ../../supabase/migrations/20261104020000_market_views.sql
\ir ../../supabase/migrations/20261104030000_hourly_cadence.sql
insert into leagues (id, name, kind, first_seen_at) values
  ('Allflame', 'Allflame', 'challenge', '2026-11-04T02:00:00Z'),
  ('Hardcore Allflame', 'Hardcore Allflame', 'challenge_hc', '2026-11-04T02:00:00Z'),
  ('Kalguur', 'Kalguur', 'challenge', '2026-11-13T20:00:00Z');
\ir ../../supabase/migrations/20261104040000_league_history.sql
\ir ../../supabase/migrations/20261104040000_league_history.sql
insert into items (ninja_id, category, name) values ('divine', 'Currency', 'Divine Orb'), ('scarab-x', 'Scarab', 'Scarab X');

do $$ begin
  assert league_start('Allflame') = '2026-07-24', 'Allflame start pinned';
  assert league_start('Hardcore Allflame') = '2026-07-24', 'HC Allflame start pinned';
  assert league_start('Kalguur') = '2026-11-13', 'new league starts the day we first saw it';
end $$;

-- ---------------------------------------------------------------- import guard
grant select on app_config to anon;  -- only to prove the function, not the table, enforces access
do $$ declare ok boolean := false; begin
  begin perform import_league_history('x', '[]'); exception when insufficient_privilege then ok := true; end;
  assert ok, 'no token configured -> refused';
end $$;
insert into app_config (key, value) values
  ('history_import_token', 'tok_0123456789abcdef0123456789abcdef'),
  ('history_import_expires', '2000-01-01T00:00:00Z');
do $$ declare ok boolean := false; begin
  begin perform import_league_history('tok_0123456789abcdef0123456789abcdef', '[]'); exception when insufficient_privilege then ok := true; end;
  assert ok, 'expired token -> refused';
end $$;
update app_config set value = (now() + interval '1 hour')::text where key = 'history_import_expires';
do $$ declare ok boolean := false; begin
  begin perform import_league_history('tok_wrong_wrong_wrong_wrong_wrong_wrong', '[]'); exception when insufficient_privilege then ok := true; end;
  assert ok, 'wrong token -> refused';
end $$;
revoke select on app_config from anon;

-- Mirage-like softcore + hardcore history; JSON arrays (with nulls) become real[]
set role anon;
select import_league_history('tok_0123456789abcdef0123456789abcdef', $j$[
  {"league":"Mirage","kind":"challenge","version":"3.28","started_on":"2026-03-06","item_name":"Divine Orb","category":"Currency","prices":[36.3,86.2,97.9,145]},
  {"league":"Mirage","kind":"challenge","version":"3.28","started_on":"2026-03-06","item_name":"Scarab X","category":"Scarab","prices":[null,20,19.58,29]},
  {"league":"Keepers","kind":"challenge","version":"3.27","started_on":"2025-10-31","item_name":"Divine Orb","category":"Currency","prices":[50,120,180]},
  {"league":"Keepers","kind":"challenge","version":"3.27","started_on":"2025-10-31","item_name":"Scarab X","category":"Scarab","prices":[10,9,18]},
  {"league":"Hardcore Mirage","kind":"challenge_hc","version":"3.28","started_on":"2026-03-06","item_name":"Divine Orb","category":"Currency","prices":[40,70,80]}
]$j$);
reset role;
do $$ begin
  assert (select count(*) from league_history) = 5, 'imported';
  assert (select prices[1] from league_history where league = 'Mirage' and item_name = 'Scarab X') is null, 'json null -> NULL';
  assert (select prices[3] from league_history where league = 'Mirage' and item_name = 'Scarab X') = 19.58::real, 'values kept';
end $$;
-- re-import replaces (upsert)
set role anon;
select import_league_history('tok_0123456789abcdef0123456789abcdef',
  '[{"league":"Keepers","kind":"challenge","version":"3.27","started_on":"2025-10-31","item_name":"Scarab X","category":"Scarab","prices":[10,9,18.5]}]');
reset role;
do $$ begin
  assert (select count(*) from league_history) = 5 and
         (select prices[3] from league_history where league = 'Keepers' and item_name = 'Scarab X') = 18.5::real, 'upsert';
end $$;
-- public can read history but never write it directly
set role anon;
do $$ declare ok boolean := false; begin
  assert (select count(*) from league_history) = 5, 'anon reads';
  begin insert into league_history (league, kind, started_on, item_name, category, prices) values ('x','challenge','2020-01-01','y','z','{1}');
  exception when insufficient_privilege then ok := true; end;
  assert ok, 'anon cannot insert';
end $$;
reset role;

-- ---------------------------------------------------------------- compare
-- Current league: Allflame day 3 = 2026-07-26. We have one snapshot that day and a live price "today".
insert into price_points (league_id, item_id, resolution, ts, chaos_value, divine_value)
select 'Allflame', id, 0, '2026-07-26T10:00:00Z', 30, 30.0/100 from items where ninja_id = 'scarab-x';
insert into price_points (league_id, item_id, resolution, ts, chaos_value, divine_value)
select 'Allflame', id, 0, '2026-07-26T20:00:00Z', 34, 34.0/100 from items where ninja_id = 'scarab-x';
insert into latest_prices (league_id, item_id, updated_at, chaos_value, divine_value)
select 'Allflame', id, '2026-11-04T04:17:00Z', 39.5, 0.0894 from items where ninja_id = 'scarab-x';

do $$ declare r record; n int; begin
  -- day 3 explicitly: past leagues + our own average for that day
  select count(*) into n from league_day_compare('Allflame', (select id from items where ninja_id='scarab-x'), 3, '2026-11-04T05:00:00Z');
  assert n = 3, format('current + 2 softcore leagues, got %s', n);   -- HC history excluded
  select * into r from league_day_compare('Allflame', (select id from items where ninja_id='scarab-x'), 3, '2026-11-04T05:00:00Z') where league = 'Mirage';
  assert r.chaos_value = 19.58::real and abs(r.divine_value - 19.58 / 97.9) < 1e-6 and r.version = '3.28' and r.league_days = 4, format('Mirage %s', r);
  select * into r from league_day_compare('Allflame', (select id from items where ninja_id='scarab-x'), 3, '2026-11-04T05:00:00Z') where is_current;
  assert r.chaos_value = 32 and abs(r.divine_value - 0.32) < 1e-6 and r.day = 3, format('current day 3 %s', r);
  -- default day = today: Allflame day 104 on 2026-11-04 -> live price; past leagues have no day 104 -> NULL
  select * into r from league_day_compare('Allflame', (select id from items where ninja_id='scarab-x'), null, '2026-11-04T05:00:00Z') where is_current;
  assert r.day = 104 and r.chaos_value = 39.5::real and r.league_days = 104, format('today %s', r);
  select * into r from league_day_compare('Allflame', (select id from items where ninja_id='scarab-x'), null, '2026-11-04T05:00:00Z') where league = 'Keepers';
  assert r.chaos_value is null, 'beyond the league -> NULL';
  -- Divine Orb compares in chaos, divine = 1
  select * into r from league_day_compare('Allflame', (select id from items where ninja_id='divine'), 2, '2026-11-04T05:00:00Z') where league = 'Mirage';
  assert r.chaos_value = 86.2::real and r.divine_value = 1, format('divine %s', r);
  -- hardcore league compares with hardcore history only
  select count(*) into n from league_day_compare('Hardcore Allflame', (select id from items where ninja_id='divine'), 2, '2026-11-04T05:00:00Z') where not is_current;
  assert n = 1, format('hc history rows %s', n);
end $$;

do $$ declare r record; begin
  select * into r from league_day_series('Allflame', (select id from items where ninja_id='scarab-x'), '2026-11-04T05:00:00Z') where is_current;
  assert cardinality(r.prices) = 104 and r.prices[3] = 32 and r.prices[1] is null, format('current series %s', cardinality(r.prices));
  assert (select count(*) from league_day_series('Allflame', (select id from items where ninja_id='scarab-x'), '2026-11-04T05:00:00Z')) = 3, 'series rows';
  assert has_function_privilege('anon', 'public.league_day_compare(text,int,int,timestamptz)', 'execute'), 'anon compares';
end $$;

\echo 'ALL HISTORY TESTS PASSED'
