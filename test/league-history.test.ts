import { test } from "node:test";
import assert from "node:assert/strict";
import { buildHistory, pickLeagues, KEEP_TYPES } from "../scripts/league-history.js";

// Lines copied in the dumps' format (Mirage currency CSV, 2026-03-06…).
const currencyLines = [
  "Mirage;2026-03-06;Divine Orb;Chaos Orb;36.3;High",
  "Mirage;2026-03-07;Divine Orb;Chaos Orb;86.2;High",
  "Mirage;2026-03-08;Divine Orb;Chaos Orb;97.9;High",
  "Mirage;2026-03-06;Chaos Orb;Divine Orb;2;Low",            // pay side, ignored
  "Mirage;2026-03-06;Chromatic Orb;Chaos Orb;0.18167;High",
  "Mirage;2026-03-07;Chromatic Orb;Chaos Orb;0.14286;Low",     // low confidence -> null
  "Hardcore Mirage;2026-03-06;Divine Orb;Chaos Orb;40;High",   // other league, ignored
];
const itemLines = [
  "Mirage;2026-03-07;101;Scarab;Abyss Scarab;Abyss Scarab;;;12.5;High",
  "Mirage;2026-03-08;101;Scarab;Abyss Scarab;Abyss Scarab;;;11;Medium",
  "Mirage;2026-03-08;21503;SkillGem;Perforate;Perforate;1/20;;2;High",       // not an exchange type
  "Mirage;2026-03-08;555;Map;Map (Tier 1);Map;T1;;1;High",                  // not kept
  "Mirage;2026-03-08;777;Essence;Essence of Horror;Essence of Horror;;;58.66;High",
];

test("daily arrays start at league day 1 and keep only reliable chaos prices", () => {
  const h = buildHistory({ league: "Mirage", kind: "challenge", version: "3.28", currencyLines, itemLines });
  assert.equal(h.startedOn, "2026-03-06");
  assert.equal(h.days, 3);
  const by = Object.fromEntries(h.rows.map((r) => [r.item_name, r]));
  assert.deepEqual(by["Divine Orb"].prices, [36.3, 86.2, 97.9]);
  assert.deepEqual(by["Chromatic Orb"].prices, [0.18167, null, null]);
  assert.deepEqual(by["Abyss Scarab"].prices, [null, 12.5, 11]);
  assert.equal(by["Abyss Scarab"].category, "Scarab");
  assert.deepEqual(by["Chaos Orb"].prices, [1, 1, 1]);
  assert.equal(by["Essence of Horror"].prices[2], 58.66);
  assert.ok(!by["Perforate"] && !by["Map (Tier 1)"], "gems and maps are not exchange items");
  assert.ok(h.rows.every((r) => r.league === "Mirage" && r.kind === "challenge" && r.version === "3.28" && r.started_on === "2026-03-06"));
});

test("league picking skips permanent, hardcore, ruthless and private leagues", () => {
  const files = [
    ["Standard.currency.csv", 2522014], ["Hardcore.currency.csv", 85885], ["Mirage.currency.csv", 1658606],
    ["Hardcore Mirage.currency.csv", 769562], ["Ruthless Mirage.currency.csv", 37],
    ["I See Six Seven in my Mirage GSF (PL79915).currency.csv", 37], ["Mirage.items.csv", 422756200],
  ].map(([name, usize]) => ({ name, usize }));
  assert.deepEqual(pickLeagues(files), { sc: "Mirage", hc: "Hardcore Mirage" });
  assert.equal(pickLeagues([{ name: "Standard.currency.csv", usize: 9 }]), null);
});

test("kept types cover the live exchange categories", () => {
  for (const t of ["Scarab", "Essence", "DivinationCard", "Omen", "Tattoo", "AllflameEmber"]) assert.ok(KEEP_TYPES.has(t), t);
});
