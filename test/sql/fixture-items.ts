// Prints the ingest payload the collector would send for the real Allflame Currency fixture.
import { readFileSync } from "node:fs";
import { normalizeExchangeOverview } from "../../supabase/functions/_shared/normalize.ts";
import { iconMap, toIngestItems } from "../../supabase/functions/_shared/collector.ts";

const raw = JSON.parse(readFileSync(new URL("../../fixtures/allflame-currency-2026-11-04.json", import.meta.url), "utf8"));
for (const it of raw.items) it.image = `/gen/image/${it.id}.png`;
const snap = normalizeExchangeOverview(raw, { league: "Allflame", category: "Currency" });
process.stdout.write(JSON.stringify(toIngestItems(snap.items, iconMap(raw))));
