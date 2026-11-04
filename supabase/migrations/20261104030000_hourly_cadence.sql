-- PoE Economy Tools — v0.5.0: fit the intraday maths to poe.ninja's real cadence
--
-- Measured on 2026-11-04: poe.ninja publishes new exchange prices about once an
-- hour (not every 15 min), at varying minutes. Two consequences:
--
-- 1. price_change_window() used "the newest point at or before now − window, at
--    most 20 min older". With ~45–75 min gaps between real updates the 1 h
--    change was often NULL. It now picks the point CLOSEST to now − window
--    within a tolerance band on both sides:
--        tolerance = greatest(25 min, window / 4)
--        accepted age = [greatest(window − tolerance, window / 2), window + tolerance]
--    1 h → 35–85 min, 6 h → 4.5–7.5 h, 24 h → 18–30 h. Outside the band the
--    change stays NULL (never guessed). 15/30 min windows will mostly be NULL
--    until poe.ninja publishes more often; that is honest, not a bug.
--
-- 2. False spikes: thin items sometimes jump for one update and fall back
--    (Ancient Orb 15.85c → 6.01c in one update). New per-rule option
--    alerts.confirm_next: the rule fires only if its condition still holds on the
--    item's NEXT refreshed update (≈ 1 h later). Off by default.
--
-- Safe to run more than once.

-- ---------------------------------------------------------------- changes
create or replace function public.price_change_window(
  p_league_id text,
  p_window    interval,
  p_now       timestamptz default now()
)
returns table (
  item_id      int,
  now_chaos    real,
  now_divine   real,
  then_chaos   real,
  then_ts      timestamptz,
  change_pct   real,
  volume_chaos real,
  confidence   smallint,
  updated_at   timestamptz
)
language sql
stable
set search_path = public
as $$
  with band as (
    select p_now - p_window as target,
           greatest(interval '25 minutes', p_window / 4) as tol
  )
  select lp.item_id, lp.chaos_value, lp.divine_value, past.chaos_value, past.ts,
         case when past.chaos_value > 0 and lp.chaos_value is not null
              then ((lp.chaos_value / past.chaos_value) - 1) * 100 end::real,
         lp.volume_chaos, lp.confidence, lp.updated_at
  from latest_prices lp
  cross join band
  left join lateral (
    select pp.chaos_value, pp.ts
    from price_points pp
    where pp.league_id = lp.league_id
      and pp.item_id = lp.item_id
      and pp.resolution in (0, 1)
      and pp.chaos_value is not null
      and pp.ts >= band.target - band.tol
      and pp.ts <= least(band.target + band.tol, p_now - p_window / 2)
    order by abs(extract(epoch from (pp.ts - band.target))), pp.resolution asc, pp.ts desc
    limit 1
  ) past on true
  where lp.league_id = p_league_id;
$$;

-- ---------------------------------------------------------------- confirm option
alter table public.alerts           add column if not exists confirm_next boolean not null default false;
alter table public.alert_item_state add column if not exists pending_since timestamptz;

-- ---------------------------------------------------------------- evaluation
create or replace function public.evaluate_alerts(
  p_league_id text,
  p_category  text,
  p_now       timestamptz default now(),
  p_max_per_alert int default 10
)
returns setof public.alert_events
language plpgsql
security definer
set search_path = public
as $$
declare
  v_kind text;
  a      alerts%rowtype;
  r      record;
  v_cond boolean;
  v_val  real;
  v_fired int;
  st     alert_item_state%rowtype;
  ev     alert_events%rowtype;
begin
  select kind into v_kind from leagues where id = p_league_id;
  if v_kind is null then return; end if;

  for a in
    select * from alerts
    where is_active and league_kind = v_kind and category = p_category
    order by id
  loop
    v_fired := 0;
    for r in
      select c.*, i.id as iid, i.name as iname
      from price_change_window(
             p_league_id,
             make_interval(mins => coalesce(a.window_minutes, 15)),
             p_now) c                                    -- computed once per rule
      join items i on i.id = c.item_id
      where i.category = p_category
        and (a.item_id is null or i.id = a.item_id)
        and c.updated_at = p_now                        -- only items refreshed in this run
        and coalesce(c.confidence, 0) >= a.min_confidence
      order by c.volume_chaos desc nulls last
    loop
      insert into alert_item_state (alert_id, item_id) values (a.id, r.iid)
      on conflict do nothing;
      select * into st from alert_item_state where alert_id = a.id and item_id = r.iid for update;

      if a.kind in ('above', 'below') then
        v_val := case a.unit when 'chaos' then r.now_chaos else r.now_divine end;
        continue when v_val is null;
        v_cond := (a.kind = 'above' and v_val >= a.threshold)
               or (a.kind = 'below' and v_val <= a.threshold);
        if not v_cond then
          if not st.armed or st.pending_since is not null then
            update alert_item_state set armed = true, pending_since = null
             where alert_id = a.id and item_id = r.iid;
          end if;
          continue;
        end if;
        continue when not st.armed;
      else
        if r.change_pct is null then
          continue;                                     -- no comparison point: keep any pending state
        end if;
        v_cond := (a.kind = 'rise' and r.change_pct >= a.threshold)
               or (a.kind = 'drop' and r.change_pct <= -a.threshold);
        if not v_cond then
          if st.pending_since is not null then
            update alert_item_state set pending_since = null where alert_id = a.id and item_id = r.iid;
          end if;
          continue;
        end if;
        continue when st.last_fired_at is not null
                  and p_now - st.last_fired_at < make_interval(mins => a.cooldown_minutes);
      end if;

      -- Condition holds. With confirm_next the first sighting only arms a pending
      -- state; the next refreshed update (within 3 h) that still meets it fires.
      if a.confirm_next and (st.pending_since is null or p_now - st.pending_since > interval '3 hours') then
        update alert_item_state set pending_since = p_now where alert_id = a.id and item_id = r.iid;
        continue;
      end if;
      continue when a.confirm_next and st.pending_since >= p_now;  -- same run evaluated twice

      update alert_item_state
         set last_fired_at = p_now,
             pending_since = null,
             armed = case when a.kind in ('above', 'below') then false else armed end
       where alert_id = a.id and item_id = r.iid;

      insert into alert_events (alert_id, item_id, item_name, alert_label, league_id, fired_at, kind, threshold, unit,
                                window_minutes, now_chaos, now_divine, change_pct, volume_chaos, confidence)
      values (a.id, r.iid, r.iname, a.label, p_league_id, p_now, a.kind, a.threshold, a.unit,
              a.window_minutes, r.now_chaos, r.now_divine, r.change_pct, r.volume_chaos, r.confidence)
      returning * into ev;
      return next ev;

      v_fired := v_fired + 1;
      exit when v_fired >= p_max_per_alert;
    end loop;
  end loop;
end;
$$;

revoke all on function public.evaluate_alerts(text, text, timestamptz, int) from public, anon, authenticated;
grant execute on function public.evaluate_alerts(text, text, timestamptz, int) to service_role;
grant execute on function public.price_change_window(text, interval, timestamptz) to anon, authenticated, service_role;
