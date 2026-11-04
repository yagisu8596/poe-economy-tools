-- Intraday change + alert engine tests. Run via test/sql/run.sh on a throwaway Postgres.
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
\ir ../../supabase/migrations/20261104010000_intraday_alerts.sql
\ir ../../supabase/migrations/20261104030000_hourly_cadence.sql
\ir ../../supabase/migrations/20261104030000_hourly_cadence.sql

insert into leagues (id, name, kind) values ('Allflame', 'Allflame', 'challenge'), ('Standard', 'Standard', 'standard');
insert into items (ninja_id, category, name) values
  ('divine', 'Currency', 'Divine Orb'),
  ('scarab-a', 'Scarab', 'Scarab A'),
  ('scarab-b', 'Scarab', 'Scarab B'),
  ('scarab-c', 'Scarab', 'Scarab C');

-- helper: one collector snapshot = raw point + latest row (what ingest_snapshot does)
create function snap(p_ninja text, p_ts timestamptz, p_chaos real, p_conf smallint default 2, p_league text default 'Allflame')
returns void language sql as $$
  insert into price_points (league_id, item_id, resolution, ts, chaos_value, divine_value, volume_chaos, confidence)
  select p_league, id, 0, p_ts, p_chaos, p_chaos / 400, 10000, p_conf from items where ninja_id = p_ninja;
  insert into latest_prices (league_id, item_id, updated_at, chaos_value, divine_value, volume_chaos, confidence)
  select p_league, id, p_ts, p_chaos, p_chaos / 400, 10000, p_conf from items where ninja_id = p_ninja
  on conflict (league_id, item_id) do update set updated_at = excluded.updated_at, chaos_value = excluded.chaos_value,
    divine_value = excluded.divine_value, confidence = excluded.confidence;
$$;

-- Timeline (T = 12:00 UTC): divine 400 at 10:45 and 11:00, 420 at 12:00.
select snap('divine', '2026-11-05T10:45:00Z', 400);
select snap('divine', '2026-11-05T11:00:00Z', 400);
select snap('divine', '2026-11-05T12:00:00Z', 420);

-- ---------------------------------------------------------------- price_change_window
do $$ declare v real; t timestamptz; begin
  select change_pct, then_ts into v, t from price_change_window('Allflame', interval '1 hour', '2026-11-05T12:00:00Z')
   where item_id = (select id from items where ninja_id = 'divine');
  assert abs(v - 5) < 0.01, format('1h change %s', v);
  assert t = '2026-11-05T11:00:00Z', format('compared with %s', t);
  -- 6 h ago we have no data near enough: NULL, not a guess
  select change_pct into v from price_change_window('Allflame', interval '6 hours', '2026-11-05T12:00:00Z')
   where item_id = (select id from items where ninja_id = 'divine');
  assert v is null, format('6h change should be null, got %s', v);
  -- 30 min: nearest point at or before 11:30 is 11:00 = 30 min older than asked > 20 min tolerance -> NULL
  select change_pct into v from price_change_window('Allflame', interval '30 minutes', '2026-11-05T12:00:00Z')
   where item_id = (select id from items where ninja_id = 'divine');
  assert v is null, format('30m change should be null (stale), got %s', v);
end $$;

-- ---------------------------------------------------------------- alerts
insert into alerts (label, league_kind, category, item_id, kind, threshold, unit, window_minutes, min_confidence, cooldown_minutes)
select 'divine +3% 1h', 'challenge', 'Currency', id, 'rise', 3, null, 60, 1, 60 from items where ninja_id = 'divine';
insert into alerts (label, league_kind, category, item_id, kind, threshold, unit, window_minutes)
select 'divine above 410c', 'challenge', 'Currency', id, 'above', 410, 'chaos', null from items where ninja_id = 'divine';
insert into alerts (label, league_kind, category, item_id, kind, threshold, unit, window_minutes)
select 'divine on standard', 'standard', 'Currency', id, 'above', 1, 'chaos', null from items where ninja_id = 'divine';
insert into alerts (label, league_kind, category, item_id, kind, threshold, unit, window_minutes, is_active)
select 'inactive', 'challenge', 'Currency', id, 'above', 1, 'chaos', null, false from items where ninja_id = 'divine';

create temp table ev1 as select * from evaluate_alerts('Allflame', 'Currency', '2026-11-05T12:00:00Z');
do $$ declare n int; v real; begin
  select count(*) into n from ev1;
  assert n = 2, format('expected rise + above, got %s', n);
  select change_pct into v from ev1 where kind = 'rise';
  assert abs(v - 5) < 0.01, format('event change %s', v);
  assert (select count(*) from ev1 where kind = 'above' and now_chaos = 420) = 1, 'above event carries price';
  assert (select count(*) from ev1 where item_name = 'Divine Orb' and alert_label is not null) = 2, 'events carry names';
  assert (select count(*) from alert_events where delivered_at is null) = 2, 'events stored undelivered';
end $$;

-- 12:15: still +5%-ish and still above 410 -> nothing (cooldown / not re-armed)
select snap('divine', '2026-11-05T11:15:00Z', 400);
select snap('divine', '2026-11-05T12:15:00Z', 421);
do $$ declare n int; begin
  select count(*) into n from evaluate_alerts('Allflame', 'Currency', '2026-11-05T12:15:00Z');
  assert n = 0, format('cooldown/armed should block, got %s', n);
end $$;

-- 12:30: price falls below 410 -> re-arms the 'above' rule, nothing fires
select snap('divine', '2026-11-05T11:30:00Z', 400);
select snap('divine', '2026-11-05T12:30:00Z', 405);
do $$ declare n int; begin
  select count(*) into n from evaluate_alerts('Allflame', 'Currency', '2026-11-05T12:30:00Z');
  assert n = 0, format('below level: no event, got %s', n);
  assert (select armed from alert_item_state s join alerts a on a.id = s.alert_id where a.label = 'divine above 410c'), 're-armed';
end $$;

-- 13:05: back above 410 and +3.75% vs 12:00(?) -> 'above' fires again; rise compares with 12:05 window (none) ...
-- Use 13:00 with a point at 12:00 (420): 430/420 = +2.4% -> no rise; above fires (re-armed).
select snap('divine', '2026-11-05T13:00:00Z', 430);
do $$ declare n int; begin
  select count(*) into n from evaluate_alerts('Allflame', 'Currency', '2026-11-05T13:00:00Z') where kind = 'above';
  assert n = 1, format('re-armed above should fire, got %s', n);
end $$;

-- 13:15: +7.9% vs 12:15 (421 -> 455) and > 60 min since last rise -> rise fires again
select snap('divine', '2026-11-05T13:15:00Z', 455);
do $$ declare n int; begin
  select count(*) into n from evaluate_alerts('Allflame', 'Currency', '2026-11-05T13:15:00Z') where kind = 'rise';
  assert n = 1, format('rise after cooldown should fire, got %s', n);
end $$;

-- ---------------------------------------------------------------- category-wide rule
insert into alerts (label, league_kind, category, item_id, kind, threshold, unit, window_minutes, min_confidence)
values ('any scarab +10% 1h', 'challenge', 'Scarab', null, 'rise', 10, null, 60, 1);
select snap('scarab-a', '2026-11-05T12:00:00Z', 10, 2::smallint);
select snap('scarab-b', '2026-11-05T12:00:00Z', 10, 0::smallint);
select snap('scarab-c', '2026-11-05T12:00:00Z', 10, 2::smallint);
select snap('scarab-a', '2026-11-05T13:00:00Z', 12, 2::smallint);   -- +20%, trusted
select snap('scarab-b', '2026-11-05T13:00:00Z', 13, 0::smallint);   -- +30%, thin market
select snap('scarab-c', '2026-11-05T13:00:00Z', 10.5, 2::smallint); -- +5%
do $$ declare n int; who text; begin
  select count(*), min(i.ninja_id) into n, who
  from evaluate_alerts('Allflame', 'Scarab', '2026-11-05T13:00:00Z') e join items i on i.id = e.item_id;
  assert n = 1 and who = 'scarab-a', format('category rule fired %s (%s)', n, who);
end $$;

-- Items not refreshed in this run are not evaluated: a fresh rule that WOULD fire on
-- scarab-a's last price (12c at 13:00) must stay silent at 13:07, when no new data came in.
insert into alerts (label, league_kind, category, item_id, kind, threshold, unit, window_minutes)
values ('any scarab above 11c', 'challenge', 'Scarab', null, 'above', 11, 'chaos', null);
do $$ declare n int; begin
  select count(*) into n from evaluate_alerts('Allflame', 'Scarab', '2026-11-05T13:07:00Z');
  assert n = 0, format('stale items evaluated: %s', n);
end $$;
-- ...and it fires once scarab-a is refreshed.
select snap('scarab-a', '2026-11-05T13:15:00Z', 12, 2::smallint);
do $$ declare n int; begin
  select count(*) into n from evaluate_alerts('Allflame', 'Scarab', '2026-11-05T13:15:00Z') where kind = 'above';
  assert n = 1, format('refreshed item should fire, got %s', n);
end $$;

-- Rules of another league kind never fire here; Standard rule fires on Standard
select snap('divine', '2026-11-05T13:00:00Z', 700, 2::smallint, 'Standard');
do $$ declare n int; begin
  select count(*) into n from evaluate_alerts('Standard', 'Currency', '2026-11-05T13:00:00Z');
  assert n = 1, format('standard rule fired %s', n);
end $$;

-- ---------------------------------------------------------------- delivery bookkeeping
select mark_alert_delivery(array(select id from alert_events where kind = 'rise'), null);
select mark_alert_delivery(array(select id from alert_events where kind = 'above' and league_id = 'Standard'), 'HTTP 404');
do $$ begin
  assert (select bool_and(delivered_at is not null) from alert_events where kind = 'rise'), 'rise delivered';
  assert (select error from alert_events where league_id = 'Standard') = 'HTTP 404', 'error kept';
  assert (select prune_alert_events('2026-12-01T00:00:00Z')) > 0, 'old events pruned';
end $$;

-- ---------------------------------------------------------------- security
do $$ declare ok boolean; begin
  assert not has_function_privilege('anon', 'public.evaluate_alerts(text,text,timestamptz,int)', 'execute'), 'anon cannot evaluate';
  assert not has_function_privilege('anon', 'public.mark_alert_delivery(bigint[],text)', 'execute'), 'anon cannot mark';
  assert has_function_privilege('anon', 'public.price_change_window(text,interval,timestamptz)', 'execute'), 'anon reads changes';
end $$;
set role anon;
do $$ begin
  assert (select count(*) from alerts) = 0, 'alerts private';
  assert (select count(*) from alert_events) = 0, 'events private';
end $$;
reset role;

\echo 'ALL ALERT TESTS PASSED'
