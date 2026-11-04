// Builds dist/supabase-setup.html: the copy-paste setup guide with the current
// migration, the single-file Edge Function and the schedule template embedded.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const mig1 = read("supabase/migrations/20261104000000_market_data.sql");
const mig2 = read("supabase/migrations/20261104010000_intraday_alerts.sql");
const mig3 = read("supabase/migrations/20261104020000_market_views.sql");
const mig4 = read("supabase/migrations/20261104030000_hourly_cadence.sql");
const mig5 = read("supabase/migrations/20261104040000_league_history.sql");
const collector = read("supabase/functions/_shared/collector.ts");
const cats = collector.match(/EXCHANGE_CATEGORIES = \[([\s\S]*?)\] as const/)[1].match(/"([A-Za-z]+)"/g).map((q) => q.slice(1, -1));
const blocks = {
  // Fresh installs get every migration in step 2; existing installs run U2a (alerts) and U3 (market + cadence).
  MIGRATION: [mig1, mig2, mig3, mig4, mig5].join("\n\n"),
  MIGRATION2: mig2,
  MIGRATION3: mig3 + "\n\n" + mig4,
  MIGRATION4: mig5,
  FUNCTION: read("dist/collect.single.ts"),
  SCHEDULE: read("supabase/setup/schedule.sql"),
};
// The update snippet reuses the collect-fast job from schedule.sql (single source of truth).
const fastJob = blocks.SCHEDULE.match(/select cron\.schedule\('collect-fast'[\s\S]*?\$job\$\);/);
if (!fastJob) throw new Error("collect-fast job not found in schedule.sql");
blocks.FAST_JOB = fastJob[0];
const pruneJob = blocks.SCHEDULE.match(/select cron\.schedule\('prune-alerts'[^\n]*/);
if (!pruneJob) throw new Error("prune-alerts job not found in schedule.sql");
blocks.PRUNE_JOB = "\n-- Eski alarm kayıtlarını her gece temizler.\n" + pruneJob[0];
for (const [k, v] of Object.entries(blocks)) {
  if (/<\/script/i.test(v)) throw new Error(`${k} contains </script and cannot be embedded`);
}
let html = read("scripts/setup-page.template.html");
for (const [k, v] of Object.entries(blocks)) html = html.replace(`{{${k}}}`, () => (k === "FAST_JOB" || k === "PRUNE_JOB" ? v : "\n" + v));
html = html.replace("__CATEGORIES_JSON__", () => JSON.stringify(cats));
if (/\{\{[A-Z_0-9]+\}\}|__CATEGORIES_JSON__/.test(html)) throw new Error("unfilled placeholder");
writeFileSync(join(root, "dist/supabase-setup.html"), html);
console.log(`dist/supabase-setup.html ${html.length} bytes`);
