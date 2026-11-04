-- v0.5.0: change windows that fit hourly poe.ninja updates + confirm_next alerts.
\set ON_ERROR_STOP on
do $$ begin
  if not exists (select from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;
grant usage on schema public to anon, authenticated, service_role;
\ir ../../supabase/migrations/20261104000000_market_data.sql
\ir ../../supabase/migrations/20261104010000_intraday_alerts.sql
\ir ../../supabase/migrations/20261104020000_market_views.sql
\ir ../../supabase/migrations/20261104030000_hourly_cadence.sql
\ir ../../supabase/migrations/20261104030000_hourly_cadence.sql

insert into leagues (id, name, kind) values ('Allflame', 'Allflame', 'challenge');
insert into items (ninja_id, category, name) values ('divine', 'Currency', 'Divine Orb'), ('ancient', 'Currency', 'Ancient Orb');

create function snap(p_ninja text, p_ts timestamptz, p_chaos real, p_conf smallint default 2)
returns void language sql as $$
  insert into price_points (league_id, item_id, resolution, ts, chaos_value, divine_value, volume_chaos, confidence)
  select 'Allflame', id, 0, p_ts, p_chaos, p_chaos / 440, 5000, p_conf from items where ninja_id = p_ninja;
  insert into latest_prices (league_id, item_id, updated_at, chaos_value, divine_value, volume_chaos, confidence)
  select 'Allflame', id, p_ts, p_chaos, p_chaos / 440, 5000, p_conf from items where ninja_id = p_ninja
  on conflict (league_id, item_id) do update set updated_at = excluded.updated_at, chaos_value = excluded.chaos_value,
    divine_value = excluded.divine_value, confidence = excluded.confidence;
$$;
create function chg(p_ninja text, p_window interval, p_now timestamptz, out pct real, out then_ts timestamptz)
language sql as $$
  select c.change_pct, c.then_ts from price_change_window('Allflame', p_window, p_now) c
  join items i on i.id = c.item_id where i.ninja_id = p_ninja;
$$;

-- The real 2026-11-04 pattern: updates at 02:04, 02:32, 03:17 (gaps 28 and 45 min).
select snap('divine', '2026-11-04T02:04:00Z', 440.2);
select snap('divine', '2026-11-04T02:32:00Z', 437.1);
select snap('divine', '2026-11-04T03:17:00Z', 441.6);

do $$ declare c record; begin
  -- 1h at 03:17: target 02:17; 02:04 (13 min off) beats 02:32 (15 min off)
  select * into c from chg('divine', interval '1 hour', '2026-11-04T03:17:00Z');
  assert c.then_ts = '2026-11-04T02:04:00Z', format('1h compared with %s', c.then_ts);
  assert abs(c.pct - ((441.6 / 440.2 - 1) * 100)) < 0.001, format('1h pct %s', c.pct);
  -- 45 min after an update with the previous one 45 min older: still a 1h change (35–85 min band)
  select * into c from chg('divine', interval '1 hour', '2026-11-04T03:17:00Z');
  assert c.pct is not null, '1h must not be NULL with a 45–73 min old point';
  -- 6h: nothing in 4.5–7.5 h -> NULL, never a guess
  select * into c from chg('divine', interval '6 hours', '2026-11-04T03:17:00Z');
  assert c.pct is null, format('6h should be NULL, got %s', c.pct);
  -- 15 min: the band is 7.5–40 min; 02:32 is 45 min old -> NULL
  select * into c from chg('divine', interval '15 minutes', '2026-11-04T03:17:00Z');
  assert c.pct is null, format('15m should be NULL, got %s', c.pct);
  -- a point newer than half the window never counts (1h at 02:50: 02:32 is only 18 min old; 02:04 is 46 min old)
  select * into c from chg('divine', interval '1 hour', '2026-11-04T02:50:00Z');
  assert c.then_ts = '2026-11-04T02:04:00Z', format('1h at 02:50 compared with %s', c.then_ts);
  -- too old: 1h at 03:40 with points 68 and 96 min old -> 68 min wins (inside 35–85)
  select * into c from chg('divine', interval '1 hour', '2026-11-04T03:40:00Z');
  assert c.then_ts = '2026-11-04T02:32:00Z', format('1h at 03:40 compared with %s', c.then_ts);
end $$;

-- market_overview now shows a 1h change for this pattern
do $$ declare v real; begin
  select change_1h into v from market_overview('Allflame', '2026-11-04T03:17:00Z') where ninja_id = 'divine';
  assert v is not null, 'overview 1h change present';
end $$;

-- ---------------------------------------------------------------- confirm_next
-- Ancient Orb: 15.85 -> 6.01 (-62%) for one update, then 7.31 (still -54% vs 1h before? no: vs 6.01 +21%).
select snap('ancient', '2026-11-04T02:04:00Z', 15.85);
select snap('ancient', '2026-11-04T03:04:00Z', 6.01);
insert into alerts (label, category, item_id, kind, threshold, window_minutes, min_confidence, cooldown_minutes, confirm_next)
select 'ancient -20% 1h confirmed', 'Currency', id, 'drop', 20, 60, 1, 60, true from items where ninja_id = 'ancient';
insert into alerts (label, category, item_id, kind, threshold, window_minutes, min_confidence, cooldown_minutes, confirm_next)
select 'ancient -20% 1h instant', 'Currency', id, 'drop', 20, 60, 1, 60, false from items where ninja_id = 'ancient';

do $$ declare n int; who text; begin
  select count(*), min(alert_label) into n, who from evaluate_alerts('Allflame', 'Currency', '2026-11-04T03:04:00Z');
  assert n = 1 and who = 'ancient -20% 1h instant', format('first sighting: %s %s', n, who);
  assert (select pending_since from alert_item_state s join alerts a on a.id = s.alert_id
          where a.label = 'ancient -20% 1h confirmed') = '2026-11-04T03:04:00Z', 'confirmed rule is pending';
  -- evaluating the same run again does not fire the pending rule
  select count(*) into n from evaluate_alerts('Allflame', 'Currency', '2026-11-04T03:04:00Z') where alert_label like '%confirmed';
  assert n = 0, format('same run twice fired %s', n);
end $$;

-- Next update bounces back (vs 1h before: 7.31/6.01 = +21.6%): spike not confirmed, pending cleared.
select snap('ancient', '2026-11-04T04:04:00Z', 7.31);
do $$ declare n int; begin
  select count(*) into n from evaluate_alerts('Allflame', 'Currency', '2026-11-04T04:04:00Z');
  assert n = 0, format('bounce fired %s', n);
  assert (select pending_since from alert_item_state s join alerts a on a.id = s.alert_id
          where a.label = 'ancient -20% 1h confirmed') is null, 'pending cleared after bounce';
end $$;

-- A real, lasting fall: -25% then another -25% on the next update -> confirmed rule fires on the second.
select snap('ancient', '2026-11-04T05:04:00Z', 5.40);
do $$ declare n int; begin
  select count(*) into n from evaluate_alerts('Allflame', 'Currency', '2026-11-04T05:04:00Z') where alert_label like '%confirmed';
  assert n = 0, format('first of two drops fired %s', n);
end $$;
select snap('ancient', '2026-11-04T06:04:00Z', 4.00);
do $$ declare n int; begin
  select count(*) into n from evaluate_alerts('Allflame', 'Currency', '2026-11-04T06:04:00Z') where alert_label like '%confirmed';
  assert n = 1, format('confirmed drop should fire, got %s', n);
  assert (select pending_since from alert_item_state s join alerts a on a.id = s.alert_id
          where a.label = 'ancient -20% 1h confirmed') is null, 'pending cleared after firing';
end $$;

-- above + confirm: fires on the second update above the level, re-arms below it.
insert into alerts (label, category, item_id, kind, threshold, unit, confirm_next)
select 'divine above 441c confirmed', 'Currency', id, 'above', 441, 'chaos', true from items where ninja_id = 'divine';
select snap('divine', '2026-11-04T04:17:00Z', 443);
do $$ declare n int; begin
  select count(*) into n from evaluate_alerts('Allflame', 'Currency', '2026-11-04T04:17:00Z') where kind = 'above';
  assert n = 0, format('above first sighting fired %s', n);
end $$;
select snap('divine', '2026-11-04T05:17:00Z', 444);
do $$ declare n int; begin
  select count(*) into n from evaluate_alerts('Allflame', 'Currency', '2026-11-04T05:17:00Z') where kind = 'above';
  assert n = 1, format('above confirmed should fire, got %s', n);
end $$;

-- old rules keep working: confirm_next defaults to false
do $$ begin
  assert (select column_default from information_schema.columns
          where table_name = 'alerts' and column_name = 'confirm_next') = 'false', 'default off';
  assert not has_function_privilege('anon', 'public.evaluate_alerts(text,text,timestamptz,int)', 'execute'), 'anon cannot evaluate';
end $$;

\echo 'ALL CADENCE TESTS PASSED'
