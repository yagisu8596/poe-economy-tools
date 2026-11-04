#!/usr/bin/env bash
# Runs every test/sql/*_test.sql in its own throwaway database (never a real project).
# Usage: PGHOST=... PGPORT=... PGUSER=postgres test/sql/run.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
ITEMS=$(node --experimental-strip-types test/sql/fixture-items.ts)
for f in test/sql/*_test.sql; do
  DB="poe_test_$$_$(basename "$f" .sql)"
  createdb "$DB"
  echo "== $f"
  if ! psql -X -q -d "$DB" -v items="$ITEMS" -f "$f"; then
    dropdb --if-exists "$DB"; exit 1
  fi
  dropdb --if-exists "$DB"
done
