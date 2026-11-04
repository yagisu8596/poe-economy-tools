// Runs the setup page's real inline script against a tiny fake DOM and checks
// what the copy buttons would put on the clipboard.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const html = readFileSync(new URL("../dist/supabase-setup.html", import.meta.url), "utf8");

type El = {
  id: string; textContent: string; value: string; disabled: boolean; className: string; checked: boolean; hidden: boolean;
  dataset: Record<string, string>; classList: { toggle(): void; remove(): void };
  addEventListener(t: string, f: (e?: unknown) => void): void; append(c: unknown): void; _h: Record<string, ((e?: unknown) => void)[]>;
};

export function loadPage() {
  const blocks = new Map<string, string>();
  for (const m of html.matchAll(/<script type="text\/plain" id="([^"]+)">([\s\S]*?)<\/script>/g)) blocks.set(m[1], m[2]);
  const copyIds = [...html.matchAll(/data-copy="([^"]+)" id="([^"]+)"/g)].map((m) => ({ key: m[1], id: m[2] }));
  const script = html.match(/<script>\n([\s\S]*?)<\/script>\s*$/)![1];
  const els = new Map<string, El>();
  const make = (id: string): El => ({
    id, textContent: blocks.get(id) ?? "", value: "", disabled: false, className: "", checked: false, hidden: false, dataset: {},
    classList: { toggle() {}, remove() {} }, _h: {},
    addEventListener(t, f) { (this._h[t] ??= []).push(f); }, append() {},
  });
  const el = (id: string) => { if (!els.has(id)) els.set(id, make(id)); return els.get(id)!; };
  for (const { key, id } of copyIds) el(id).dataset.copy = key;
  // Initial form values as a browser would have them.
  for (const m of html.matchAll(/<input id="([^"]+)"[^>]*?\svalue="([^"]*)"/g)) el(m[1]).value = m[2];
  for (const m of html.matchAll(/<select id="([^"]+)">([\s\S]*?)<\/select>/g)) {
    const opts = [...m[2].matchAll(/<option value="([^"]*)"( selected)?/g)];
    el(m[1]).value = (opts.find((o) => o[2]) ?? opts[0])?.[1] ?? "";
  }
  let clipboard = "";
  const document = {
    getElementById: el,
    createElement: () => make("tmp"),
    querySelectorAll: (sel: string) => (sel === "button.copy" ? copyIds.map(({ id }) => el(id)) : []),
    createRange: () => ({ selectNodeContents() {} }),
  };
  const navigator = { clipboard: { writeText: async (t: string) => { clipboard = t; } } };
  new Function("document", "localStorage", "navigator", "window", "setTimeout", script)(
    document, { getItem: () => null, setItem() {} }, navigator, { getSelection: () => null }, () => 0);
  const fire = (id: string, type = "input") => { for (const h of el(id)._h[type] ?? []) h({ target: el(id) }); };
  const set = (id: string, v: string) => { el(id).value = v; fire(id, "input"); fire(id, "change"); };
  const check = (id: string, on: boolean) => { el(id).checked = on; fire(id, "change"); };
  const copy = async (buttonId: string) => {
    clipboard = "";
    for (const h of el(buttonId)._h.click ?? []) h();
    await new Promise((r) => setImmediate(r));
    return clipboard;
  };
  return { el, set, check, copy };
}

const executed = (sql: string) => sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

// ------------------------------------------------------------- step 4
test("step 4 puts the project URL and contact into the executed SQL", async () => {
  const p = loadPage();
  p.set("contact", "o'brien@example.com");
  p.set("project-url", "https://abcdefghijklmnopqrst.supabase.co/");
  const body = executed(await p.copy("copy-schedule"));
  assert.ok(!/__[A-Z_]+__/.test(body), "no placeholder left in executed statements");
  assert.ok(body.includes("('project_url', 'https://abcdefghijklmnopqrst.supabase.co')"));
  assert.ok(body.includes("('ninja_contact', 'o''brien@example.com')"));
  assert.ok(body.includes("'prune-alerts'"), "fresh installs also schedule alert pruning");
});

test("step 4 keeps the copy button disabled for a non-Supabase URL", () => {
  const p = loadPage();
  p.set("project-url", "https://example.com");
  assert.equal(p.el("copy-schedule").disabled, true);
  assert.match(p.el("url-status").textContent, /Supabase/);
});

test("empty contact becomes 'not set' rather than a placeholder", async () => {
  const p = loadPage();
  p.set("project-url", "https://abcdefghijklmnopqrst.supabase.co");
  assert.ok(executed(await p.copy("copy-schedule")).includes("('ninja_contact', 'not set')"));
});

// ------------------------------------------------------------- U2
const HOOK = "https://discord.com/api/webhooks/1234567890/AbC_dEf-123";

test("webhook: valid URL is copied in full but masked on screen", async () => {
  const p = loadPage();
  p.set("webhook", "https://evil.example.com/hook");
  assert.equal(p.el("copy-webhook").disabled, true);
  p.set("webhook", HOOK);
  assert.equal(p.el("copy-webhook").disabled, false);
  assert.ok(!p.el("sql-webhook-view").textContent.includes("AbC_dEf-123"), "secret not shown");
  assert.ok((await p.copy("copy-webhook")).includes(`'${HOOK}'`), "full URL copied");
});

test("alarm builder: default is a Divine Orb rule with an item lookup", async () => {
  const p = loadPage();
  const sql = await p.copy("copy-alarm");
  assert.match(sql, /lower\(name\) = lower\('Divine Orb'\)/);
  assert.match(sql, /raise exception/);
});

test("alarm builder: apostrophes in item names are escaped", async () => {
  const p = loadPage();
  p.set("al-item", "Hunter's Exalted Orb");
  const sql = await p.copy("copy-alarm");
  assert.ok(sql.includes("lower('Hunter''s Exalted Orb')"));
});

test("alarm builder: empty item means the whole category", async () => {
  const p = loadPage();
  p.set("al-preset", "scarab");
  const sql = await p.copy("copy-alarm");
  assert.match(sql, /'Scarab', null, 'rise', 15, null, 60, 1, 120, true/);
  assert.match(sql, /any Scarab \+15% in 1h \(confirmed\)/);
});

test("alarm builder: level rules use a unit, not a window; invalid input disables copy", async () => {
  const p = loadPage();
  p.set("al-preset", "test");
  assert.equal(p.el("al-window-field").hidden, true);
  assert.equal(p.el("al-unit-field").hidden, false);
  assert.match(await p.copy("copy-alarm"), /'above', 1, 'chaos', null, 0, 60, false/);
  p.set("al-threshold", "0");
  assert.equal(p.el("copy-alarm").disabled, true);
  p.set("al-threshold", "2");
  p.set("al-cooldown", "5");
  assert.equal(p.el("copy-alarm").disabled, true);
});

test("alarm builder: confirm option toggles confirm_next and the label; no 15/30 min windows", async () => {
  const p = loadPage();
  p.set("al-preset", "divine1h");
  assert.match(await p.copy("copy-alarm"), /, 60, 1, 60, false\)/);
  p.check("al-confirm", true);
  const sql = await p.copy("copy-alarm");
  assert.match(sql, /, 60, 1, 60, true\)/);
  assert.match(sql, /Divine Orb \+3% in 1h \(confirmed\)/);
  const html = readFileSync(new URL("../dist/supabase-setup.html", import.meta.url), "utf8");
  assert.ok(!/<option value="15">/.test(html) && !/<option value="30">/.test(html), "short windows removed");
});

test("U3 carries the market functions and the cadence migration", async () => {
  const p = loadPage();
  const sql = await p.copy("copy-u3-migration");
  assert.match(sql, /function public\.market_overview/);
  assert.match(sql, /confirm_next/);
  assert.match(sql, /greatest\(interval '25 minutes', p_window \/ 4\)/);
  assert.ok(!sql.includes("{{"), "filled");
});

test("U4 carries the league history migration", async () => {
  const sql = await loadPage().copy("copy-u4-migration");
  assert.match(sql, /create table if not exists public\.league_history/);
  assert.match(sql, /function public\.league_day_compare/);
});

// Writes the generated SQL so test/sql/page_sql.sh can run it against Postgres.
test("export generated SQL samples for the database check", async () => {
  const out = new URL("../dist/page-sql/", import.meta.url);
  mkdirSync(out, { recursive: true });
  const p = loadPage();
  p.set("project-url", "https://abcdefghijklmnopqrstuv.supabase.co");
  writeFileSync(new URL("schedule.sql", out), await p.copy("copy-schedule"));
  p.set("webhook", HOOK);
  writeFileSync(new URL("webhook.sql", out), await p.copy("copy-webhook"));
  writeFileSync(new URL("u2-migration.sql", out), await p.copy("copy-u2-migration"));
  writeFileSync(new URL("u3-migration.sql", out), await p.copy("copy-u3-migration"));
  writeFileSync(new URL("u4-migration.sql", out), await p.copy("copy-u4-migration"));
  writeFileSync(new URL("discord-test.sql", out), await p.copy("copy-discord-test"));
  writeFileSync(new URL("alarm-list.sql", out), await p.copy("copy-alarm-list"));
  writeFileSync(new URL("step2.sql", out), await p.copy("copy-migration"));
  p.set("al-preset", "test");
  writeFileSync(new URL("alarm-test.sql", out), await p.copy("copy-alarm"));
  p.set("al-preset", "scarab");
  writeFileSync(new URL("alarm-scarab.sql", out), await p.copy("copy-alarm"));
  p.set("al-preset", "divine1h");
  p.check("al-confirm", true);
  p.set("al-item", "Hunter's Exalted Orb");
  writeFileSync(new URL("alarm-apostrophe.sql", out), await p.copy("copy-alarm"));
  p.set("al-item", "Divine Orbb");
  writeFileSync(new URL("alarm-typo.sql", out), await p.copy("copy-alarm"));
});
