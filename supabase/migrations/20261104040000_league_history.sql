-- PoE Economy Tools — v0.6.0: compare an item's price on the same league day
-- across leagues ("Divine Orb on day 3: Mirage 97.9 c, Keepers …, this league …").
--
-- Past leagues come from poe.ninja's public data dumps (https://poe.ninja/poe1/data,
-- licensed CC BY-SA): one price per item per day. We keep only Currency Exchange
-- style items (currency, fragments, scarabs, essences, …) of the challenge
-- leagues (softcore and hardcore), one row per (league, item) with a daily array:
--   prices[1] = league day 1 (launch day, UTC date), prices[2] = day 2, …
--   NULL = no reliable price that day (poe.ninja marked it Low confidence).
-- The current league is compared with our own snapshots.
--
-- Safe to run more than once.

-- ---------------------------------------------------------------- league start
alter table public.leagues add column if not exists started_on date;
-- Curse of the Allflame (3.29) launched on 2026-07-24. Later leagues default to
-- the day our collector first saw them (it sees a new league on launch day).
update public.leagues set started_on = date '2026-07-24'
 where id in ('Allflame', 'Hardcore Allflame') and started_on is null;

create or replace function public.league_start(p_league_id text)
returns date
language sql
stable
set search_path = public
as $$
  select coalesce(started_on, (first_seen_at at time zone 'UTC')::date) from leagues where id = p_league_id;
$$;

-- ---------------------------------------------------------------- history
create table if not exists public.league_history (
  league      text not null,                 -- 'Mirage', 'Hardcore Mirage'
  kind        text not null check (kind in ('challenge', 'challenge_hc')),
  version     text,                          -- '3.28' when known
  started_on  date not null,
  item_name   text not null,
  category    text not null,
  prices      real[] not null,               -- chaos per unit by league day (1-based)
  imported_at timestamptz not null default now(),
  primary key (league, item_name)
);
create index if not exists league_history_item_idx on public.league_history (lower(item_name), kind);

alter table public.league_history enable row level security;
drop policy if exists "public read" on public.league_history;
create policy "public read" on public.league_history for select to anon, authenticated using (true);

-- Imports are written by a one-off, time-limited token (app_config keys
-- history_import_token / history_import_expires). Nothing else may write.
create or replace function public.import_league_history(p_token text, p_rows jsonb)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare n int;
begin
  if p_token is null or length(p_token) < 32
     or p_token is distinct from (select value from app_config where key = 'history_import_token')
     or coalesce((select value from app_config where key = 'history_import_expires')::timestamptz, '-infinity') < now() then
    raise exception 'history import not allowed' using errcode = '42501';
  end if;
  insert into league_history (league, kind, version, started_on, item_name, category, prices, imported_at)
  select x.league, x.kind, x.version, x.started_on, x.item_name, x.category, x.prices, now()
  from jsonb_to_recordset(p_rows) as x(league text, kind text, version text, started_on date,
                                       item_name text, category text, prices real[])
  where x.league is not null and x.item_name is not null and x.prices is not null
  on conflict (league, item_name) do update
    set kind = excluded.kind, version = excluded.version, started_on = excluded.started_on,
        category = excluded.category, prices = excluded.prices, imported_at = excluded.imported_at;
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke all on function public.import_league_history(text, jsonb) from public;
grant execute on function public.import_league_history(text, jsonb) to anon, authenticated, service_role;

-- ---------------------------------------------------------------- comparison
-- Price of one item on league day p_day (default: today's day of the current
-- league) in every past league of the same kind, plus the current league.
-- divine = chaos / that league's Divine Orb chaos price on the same day.
create or replace function public.league_day_compare(
  p_league_id text,
  p_item_id   int,
  p_day       int default null,
  p_now       timestamptz default now()
)
returns table (
  league      text,
  version     text,
  started_on  date,
  is_current  boolean,
  day         int,
  chaos_value real,
  divine_value real,
  league_days int
)
language sql
stable
set search_path = public
as $$
  with cur as (
    select l.id, l.kind, league_start(l.id) as s from leagues l where l.id = p_league_id
  ), d as (
    select coalesce(p_day, ((p_now at time zone 'UTC')::date - cur.s) + 1) as n from cur
  ), it as (
    select name from items where id = p_item_id
  ),
  past as (
    select h.league, h.version, h.started_on, false as is_current, d.n as day,
           h.prices[d.n] as chaos_value,
           case when lower(h.item_name) = 'divine orb' then case when h.prices[d.n] is not null then 1::real end
                else h.prices[d.n] / nullif(dv.prices[d.n], 0) end::real as divine_value,
           cardinality(h.prices) as league_days
    from league_history h
    cross join d cross join it cross join cur
    left join league_history dv on dv.league = h.league and lower(dv.item_name) = 'divine orb'
    where lower(h.item_name) = lower(it.name)
      and h.kind = (case when cur.kind = 'challenge_hc' then 'challenge_hc' else 'challenge' end)
  ),
  now_row as (
    -- current league: the live price when asking about today, else that day's average snapshot
    select cur.id as league, null::text as version, cur.s as started_on, true as is_current, d.n as day,
           case when p_day is null or d.n = ((p_now at time zone 'UTC')::date - cur.s) + 1
                then lp.chaos_value else dayavg.c end::real as chaos_value,
           case when p_day is null or d.n = ((p_now at time zone 'UTC')::date - cur.s) + 1
                then lp.divine_value else dayavg.dv end::real as divine_value,
           (((p_now at time zone 'UTC')::date - cur.s) + 1)::int as league_days
    from cur cross join d
    left join latest_prices lp on lp.league_id = cur.id and lp.item_id = p_item_id
    left join lateral (
      select avg(pp.chaos_value) as c, avg(pp.divine_value) as dv
      from price_points pp
      where pp.league_id = cur.id and pp.item_id = p_item_id
        and pp.ts >= (cur.s + (d.n - 1))::timestamp at time zone 'UTC'
        and pp.ts <  (cur.s + d.n)::timestamp at time zone 'UTC'
    ) dayavg on true
  )
  select * from now_row
  union all
  select * from past
  order by is_current desc, started_on desc;
$$;

-- Daily series for an overlay chart: one row per league with prices by league day.
-- The current league's series is built from our snapshots (daily averages).
create or replace function public.league_day_series(
  p_league_id text,
  p_item_id   int,
  p_now       timestamptz default now()
)
returns table (
  league     text,
  version    text,
  started_on date,
  is_current boolean,
  prices     real[]
)
language sql
stable
set search_path = public
as $$
  with cur as (
    select l.id, l.kind, league_start(l.id) as s from leagues l where l.id = p_league_id
  ), it as (
    select name from items where id = p_item_id
  ), days as (
    select g as n from cur, generate_series(1, greatest(1, ((p_now at time zone 'UTC')::date - cur.s) + 1)) g
  ), mine as (
    select days.n, avg(pp.chaos_value)::real as c
    from cur cross join days
    left join price_points pp
      on pp.league_id = cur.id and pp.item_id = p_item_id
     and pp.ts >= (cur.s + (days.n - 1))::timestamp at time zone 'UTC'
     and pp.ts <  (cur.s + days.n)::timestamp at time zone 'UTC'
    group by days.n
  )
  select cur.id, null::text, cur.s, true, (select array_agg(c order by n) from mine)
  from cur
  union all
  select h.league, h.version, h.started_on, false, h.prices
  from league_history h cross join it cross join cur
  where lower(h.item_name) = lower(it.name)
    and h.kind = (case when cur.kind = 'challenge_hc' then 'challenge_hc' else 'challenge' end)
  order by 4 desc, 3 desc;
$$;

grant execute on function public.league_start(text) to anon, authenticated, service_role;
grant execute on function public.league_day_compare(text, int, int, timestamptz) to anon, authenticated, service_role;
grant execute on function public.league_day_series(text, int, timestamptz) to anon, authenticated, service_role;
