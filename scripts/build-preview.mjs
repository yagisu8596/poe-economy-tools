// Builds dist/market-preview.html: the Market page as ONE self-contained file
// (for a claude.ai artifact, which cannot call Supabase), running on a data
// snapshot captured from the live database: dist/snapshot.json.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const strip = (src) => src
  .replace(/^import[\s\S]*?from\s+"[^"]+";\s*$/gm, "")
  .replace(/^export\s+(async\s+function|function|const|let)/gm, "$1");

const snapshot = JSON.parse(read("dist/snapshot.json"));
// Artifacts cannot load images from other hosts: drop icons, the page shows a placeholder.
for (const rows of Object.values(snapshot.overview)) for (const r of rows) r.icon_url = null;

const html = read("web/index.html");
const body = html.match(/<!--APP-BODY-START-->([\s\S]*?)<!--APP-BODY-END-->/)[1];
const json = JSON.stringify(snapshot).replace(/</g, "\\u003c");
const banner = `<div class="preview-banner" role="note">Preview built from a real snapshot taken ${new Date(snapshot.takenAt).toUTCString().replace(" GMT", " UTC")}. On the live site prices update as poe.ninja publishes them (about hourly) and item icons are shown. In this preview, “Same day in past leagues” covers 12 popular items (e.g. Mirror of Kalandra, Divine Orb, Mirror Shard, Hinekora’s Lock, Stacked Deck) and the 3 most recent leagues; the live site covers 94% of items and 6 leagues.</div>`;

const out = `<title>PoE Economy Tools</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cormorant+SC:wght@700&family=Source+Sans+3:wght@400;600;700&display=swap">
<style>
${read("web/styles.css")}
.preview-banner { font-size: 13px; padding: 8px 12px; border-radius: 8px; background: var(--gold-soft); color: var(--ink); }
</style>
${body.replace('<div class="shell">', '<div class="shell">\n  ' + banner)}
<script type="module">
${strip(read("web/lib.js"))}
${strip(read("web/api.js"))}
${strip(read("web/app.js"))}
const SNAPSHOT = ${json};
startApp(snapshotSource(SNAPSHOT));
</script>
`;
if (/<\/script/i.test(json)) throw new Error("snapshot contains </script");
writeFileSync(join(root, "dist/market-preview.html"), out);
console.log(`dist/market-preview.html ${out.length} bytes`);
