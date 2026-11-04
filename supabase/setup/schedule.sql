-- One-time setup after the migration and the `collect` Edge Function deploy.
-- Replace __PROJECT_URL__ (e.g. https://abcd1234.supabase.co) and
-- __CONTACT__ (contact shown to poe.ninja in the User-Agent) before running.
-- Safe to run again: jobs with the same name are replaced.

create extension if not exists pg_cron;
create extension if not exists pg_net;

insert into public.app_config (key, value)
values ('collector_token', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
on conflict (key) do nothing;

insert into public.app_config (key, value) values
  ('project_url', '__PROJECT_URL__'),
  ('ninja_contact', '__CONTACT__')
on conflict (key) do update set value = excluded.value;

-- Minutes are offset from :00/:15/:30/:45 so we do not pile onto the busiest moments.
-- poe.ninja refreshes PoE 1 data about every 15 minutes; unchanged data costs a 304.
select cron.schedule('collect-fast', '2,17,32,47 * * * *', $job$
  select net.http_post(
    url     := (select value from public.app_config where key = 'project_url') || '/functions/v1/collect?tier=fast',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-collector-token', (select value from public.app_config where key = 'collector_token')),
    body    := '{}'::jsonb,
    timeout_milliseconds := 150000)
$job$);

select cron.schedule('collect-slow', '19 * * * *', $job$
  select net.http_post(
    url     := (select value from public.app_config where key = 'project_url') || '/functions/v1/collect?tier=slow',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-collector-token', (select value from public.app_config where key = 'collector_token')),
    body    := '{}'::jsonb,
    timeout_milliseconds := 150000)
$job$);

select cron.schedule('compact-hourly', '52 * * * *', $job$ select public.compact_price_points(now(), false) $job$);
select cron.schedule('compact-daily',  '41 0 * * *', $job$ select public.compact_price_points(now(), true)  $job$);
select cron.schedule('prune-alerts',   '45 0 * * *', $job$ select public.prune_alert_events() $job$);
