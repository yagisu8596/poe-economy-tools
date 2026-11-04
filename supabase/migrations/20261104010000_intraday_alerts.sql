-- PoE Economy Tools — intraday changes and alerts (v0.3.0)
--
-- price_change_window(): change of every item in a league over a window
--   (15 min, 1 h, 6 h, 24 h, …) from our own snapshots. The "then" price is the
--   newest point at or before now − window, and only if it is not much older
--   than that; otherwise the change is NULL (never guessed from stale data).
--
-- Alerts: one row per rule. A rule targets one item, or every item of a
-- category (item_id NULL) — "tell me about any Scarab that rises 15% in 1 h".
-- It follows a league KIND (current challenge, Standard, …) so it keeps working
-- when a new league starts. State is kept per (alert, item).
--   above / below : price crosses a level (chaos or divine); fires once, re-arms
--                   when the price goes back across.
--   rise / drop   : % change over window_minutes reaches threshold; then waits
--                   cooldown_minutes before firing again for that item.
-- Thin markets are skipped below min_confidence (0 low, 1 medium, 2 high).

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
  select lp.item_id, lp.chaos_value, lp.divine_value, past.chaos_value, past.ts,
         case when past.chaos_value > 0 and lp.chaos_value is not null
              then ((lp.chaos_value / past.chaos_value) - 1) * 100 end::real,
         lp.volume_chaos, lp.confidence, lp.updated_at
  from latest_prices lp
  left join lateral (
    select pp.chaos_value, pp.ts
    from price_points pp
    where pp.league_id = lp.league_id
      and pp.item_id = lp.item_id
      and pp.resolution in (0, 1)
      and pp.chaos_value is not null
      and pp.ts <= p_now - p_window
      -- the comparison point may be at most 25% of the window (min 20 min) older than asked
      and pp.ts >= p_now - p_window - greatest(interval '20 minutes', p_window / 4)
    order by pp.ts desc, pp.resolution asc
    limit 1
  ) past on true
  where lp.league_id = p_league_id;
$$;

-- ---------------------------------------------------------------- alert rules
create table if not exists public.alerts (
  id               bigserial primary key,
  label            text,
  league_kind      text not null default 'challenge'
                   check (league_kind in ('challenge', 'challenge_hc', 'standard', 'hardcore')),
  category         text not null,                  -- poe.ninja type, e.g. 'Currency', 'Scarab'
  item_id          int references public.items (id) on delete cascade,  -- NULL = every item in category
  kind             text not null check (kind in ('above', 'below', 'rise', 'drop')),
  threshold        real not null check (threshold > 0),
  unit             text check (unit in ('chaos', 'divine')),             -- for above/below
  window_minutes   int check (window_minutes in (15, 30, 60, 180, 360, 720, 1440)),  -- for rise/drop
  min_confidence   smallint not null default 1 check (min_confidence in (0, 1, 2)),
  cooldown_minutes int not null default 60 check (cooldown_minutes >= 15),
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  check ((kind in ('above', 'below') and unit is not null and window_minutes is null)
      or (kind in ('rise', 'drop') and window_minutes is not null and unit is null))
);

create table if not exists public.alert_item_state (
  alert_id      bigint not null references public.alerts (id) on delete cascade,
  item_id       int    not null references public.items (id) on delete cascade,
  armed         boolean not null default true,
  last_fired_at timestamptz,
  primary key (alert_id, item_id)
);

create table if not exists public.alert_events (
  id           bigserial primary key,
  alert_id     bigint not null references public.alerts (id) on delete cascade,
  item_id      int    not null references public.items (id) on delete cascade,
  item_name    text,                          -- copied at fire time so the message is self-contained
  alert_label  text,
  league_id    text   not null,
  fired_at     timestamptz not null,
  kind         text not null,
  threshold    real not null,
  unit         text,
  window_minutes int,
  now_chaos    real,
  now_divine   real,
  change_pct   real,
  volume_chaos real,
  confidence   smallint,
  delivered_at timestamptz,
  error        text
);
create index if not exists alert_events_fired_idx on public.alert_events (fired_at desc);

-- ---------------------------------------------------------------- evaluation
-- Called by the collector right after it stored a (league, category) snapshot.
-- Returns the events that fired now (already recorded, not yet delivered).
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
          if not st.armed then
            update alert_item_state set armed = true where alert_id = a.id and item_id = r.iid;
          end if;
          continue;
        end if;
        continue when not st.armed;
        update alert_item_state set armed = false, last_fired_at = p_now
          where alert_id = a.id and item_id = r.iid;
      else
        continue when r.change_pct is null;
        v_cond := (a.kind = 'rise' and r.change_pct >= a.threshold)
               or (a.kind = 'drop' and r.change_pct <= -a.threshold);
        continue when not v_cond;
        continue when st.last_fired_at is not null
                  and p_now - st.last_fired_at < make_interval(mins => a.cooldown_minutes);
        update alert_item_state set last_fired_at = p_now
          where alert_id = a.id and item_id = r.iid;
      end if;

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

create or replace function public.mark_alert_delivery(p_ids bigint[], p_error text default null)
returns void
language sql
security definer
set search_path = public
as $$
  update alert_events
     set delivered_at = case when p_error is null then now() end,
         error = p_error
   where id = any(p_ids);
$$;

-- Keep two weeks of alert history.
create or replace function public.prune_alert_events(p_now timestamptz default now())
returns int
language sql
security definer
set search_path = public
as $$
  with d as (delete from alert_events where fired_at < p_now - interval '14 days' returning 1)
  select count(*)::int from d;
$$;

-- ---------------------------------------------------------------- security
-- Alert rules and events are private for now (single owner, no accounts yet).
alter table public.alerts           enable row level security;
alter table public.alert_item_state enable row level security;
alter table public.alert_events     enable row level security;

revoke all on function public.evaluate_alerts(text, text, timestamptz, int) from public, anon, authenticated;
revoke all on function public.mark_alert_delivery(bigint[], text) from public, anon, authenticated;
revoke all on function public.prune_alert_events(timestamptz) from public, anon, authenticated;
grant execute on function public.evaluate_alerts(text, text, timestamptz, int) to service_role;
grant execute on function public.mark_alert_delivery(bigint[], text) to service_role;
grant execute on function public.prune_alert_events(timestamptz) to service_role;
-- price_change_window is read-only over public data: anyone may call it.
grant execute on function public.price_change_window(text, interval, timestamptz) to anon, authenticated, service_role;
