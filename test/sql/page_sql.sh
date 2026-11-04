#!/usr/bin/env bash
# Runs the SQL the setup page generates (exported by test/setup-page.test.ts into
# dist/page-sql/) against a throwaway Postgres with fake pg_cron / pg_net.
# Usage: PGHOST=... PGPORT=... PGUSER=postgres test/sql/page_sql.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
D=dist/page-sql
run() { psql -X -q -v ON_ERROR_STOP=1 -d "$1" -f "$2"; }
fakes() {
  psql -X -q -v ON_ERROR_STOP=1 -d "$1" <<'SQL'
do $$ begin
  if not exists (select from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;
create schema net;
create table net._http_response (id bigserial, status_code int, content text, created timestamptz default now());
create function net.http_post(url text, headers jsonb, body jsonb, timeout_milliseconds int) returns bigint language sql as $f$ select 1::bigint $f$;
create schema cron;
create table cron.job (jobname text primary key, schedule text, command text);
create function cron.schedule(name text, sched text, cmd text) returns bigint language sql as $f$
  insert into cron.job values (name, sched, cmd) on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command returning 1::bigint $f$;
SQL
}
strip_ext() { sed '/create extension/d' "$1" > "$1.noext"; echo "$1.noext"; }

# A) fresh install: step 2 (both migrations) + step 4
DB=page_fresh_$$; createdb $DB; fakes $DB
run $DB $D/step2.sql
run $DB "$(strip_ext $D/schedule.sql)"
echo "fresh install jobs: $(psql -X -tAq -d $DB -c "select string_agg(jobname, ',' order by jobname) from cron.job")"
dropdb $DB

# B) existing v0.2 install upgraded with U2
DB=page_upgrade_$$; createdb $DB; fakes $DB
run $DB supabase/migrations/20261104000000_market_data.sql
run $DB "$(strip_ext $D/schedule.sql)"
run $DB $D/u2-migration.sql
run $DB $D/u2-migration.sql   # twice: must be idempotent
run $DB $D/u3-migration.sql
run $DB $D/u3-migration.sql
run $DB $D/u4-migration.sql
run $DB $D/u4-migration.sql
run $DB $D/webhook.sql
run $DB $D/webhook.sql
run $DB $D/discord-test.sql
psql -X -q -d $DB -c "insert into items (ninja_id, category, name) values ('divine','Currency','Divine Orb'), ('hunters-exalted-orb','Currency','Hunter''s Exalted Orb')"
run $DB $D/alarm-test.sql
run $DB $D/alarm-scarab.sql
run $DB $D/alarm-apostrophe.sql
if psql -X -q -v ON_ERROR_STOP=1 -d $DB -f $D/alarm-typo.sql 2>/tmp/typo.err; then echo "FAIL: typo alarm was accepted"; exit 1; fi
grep -q "Eşya bulunamadı" /tmp/typo.err && echo "typo rejected with: $(grep -o 'Eşya bulunamadı[^.]*' /tmp/typo.err)"
run $DB $D/alarm-list.sql > /dev/null
echo "alerts: $(psql -X -tAq -d $DB -c "select string_agg(label || ' [' || coalesce(item_id::text,'all') || case when confirm_next then ',confirm' else '' end || ']', ' | ' order by id) from alerts")"
echo "market fn: $(psql -X -tAq -d $DB -c "select count(*) from market_overview('none')")"
echo "history fn: $(psql -X -tAq -d $DB -c "select count(*) from league_day_compare('none', 1)")"
echo "webhook rows: $(psql -X -tAq -d $DB -c "select count(*) from app_config where key='discord_webhook_url'")"
echo "jobs: $(psql -X -tAq -d $DB -c "select string_agg(jobname, ',' order by jobname) from cron.job")"
dropdb $DB
echo "PAGE SQL OK"
