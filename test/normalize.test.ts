import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  normalizeExchangeOverview,
  resolveDivinePrice,
  formatValue,
  toDivineTermsChange,
  compoundChange,
  DataIntegrityError,
  type RawExchangeOverview,
} from "../supabase/functions/_shared/normalize.ts";

const real: RawExchangeOverview = JSON.parse(
  readFileSync(new URL("../fixtures/allflame-currency-2026-11-04.json", import.meta.url), "utf8"),
);
const clone = (): RawExchangeOverview => structuredClone(real);
const meta = { league: "Allflame", category: "Currency", fetchedAt: "2026-11-04T00:00:00Z" };
const byId = (snap: ReturnType<typeof normalizeExchangeOverview>, id: string) => {
  const it = snap.items.find((i) => i.id === id);
  assert.ok(it, `item ${id} missing`);
  return it!;
};

test("Divine price = 401.8 chaos, not the 0.002489 rate", () => {
  assert.equal(resolveDivinePrice(real), 401.8);
});

test("1 Chaos is a tiny fraction of a Divine, never hundreds of Divines", () => {
  const snap = normalizeExchangeOverview(real, meta);
  const chaos = byId(snap, "chaos");
  assert.ok(chaos.divineValue! < 0.01, `chaos.divineValue=${chaos.divineValue}`);
  assert.ok(Math.abs(chaos.divineValue! - 1 / 401.8) < 1e-9);
  assert.equal(byId(snap, "divine").divineValue, 1);
});

test("Inverted data (rate read as price) is rejected, not displayed", () => {
  const bad = clone();
  // Simulate the old bug: divine line holding the rate instead of the price.
  bad.lines.find((l) => l.id === "divine")!.primaryValue = 0.002489;
  bad.core.rates.divine = 1 / 0.002489; // and the rate holding the price
  assert.throws(() => normalizeExchangeOverview(bad, meta), DataIntegrityError);
});

test("Divine readings that disagree are rejected", () => {
  const bad = clone();
  bad.core.rates.divine = 1 / 300; // says 300c while the line says 401.8c
  assert.throws(() => resolveDivinePrice(bad), /disagree/);
});

test("Non-chaos primary currency is rejected instead of guessed", () => {
  const bad = clone();
  bad.core.primary = "divine";
  assert.throws(() => resolveDivinePrice(bad), DataIntegrityError);
});

test("Missing price becomes null (—), never 0", () => {
  const bad = clone();
  bad.lines.find((l) => l.id === "annul")!.primaryValue = null;
  bad.lines.find((l) => l.id === "alt")!.primaryValue = 0;
  const snap = normalizeExchangeOverview(bad, meta);
  for (const id of ["annul", "alt"]) {
    const it = byId(snap, id);
    assert.equal(it.chaosValue, null);
    assert.equal(it.divineValue, null);
    assert.equal(formatValue(it.chaosValue, snap.divinePriceChaos).main, "—");
  }
});

test("Missing volume becomes null, never 0", () => {
  const bad = clone();
  delete bad.lines.find((l) => l.id === "annul")!.volumePrimaryValue;
  const it = byId(normalizeExchangeOverview(bad, meta), "annul");
  assert.equal(it.volumeChaos, null);
  assert.equal(it.confidence, "low");
});

test("maxVolumeRate cross-check agrees with real data (no warnings)", () => {
  const snap = normalizeExchangeOverview(real, meta);
  assert.deepEqual(snap.warnings, []);
});

test("maxVolumeRate cross-check flags inconsistent lines", () => {
  const bad = clone();
  bad.lines.find((l) => l.id === "annul")!.maxVolumeRate = 2.473; // implies ~162c, line says 16.25c
  const snap = normalizeExchangeOverview(bad, meta);
  assert.equal(snap.warnings.length, 1);
  assert.match(snap.warnings[0], /annul/);
});

test("Thin markets are labelled low confidence (fake +100% signals)", () => {
  const snap = normalizeExchangeOverview(real, meta);
  assert.equal(byId(snap, "hunters-exalted-orb").confidence, "low"); // ~1 unit traded
  assert.equal(byId(snap, "orb-of-intention").confidence, "low"); // 1.5 chaos volume
  assert.equal(byId(snap, "redeemers-exalted-orb").confidence, "low");
  assert.equal(byId(snap, "divine").confidence, "high");
  assert.equal(byId(snap, "annul").confidence, "high");
  // Mirror: ~3 units but 1.67M chaos traded — expensive, not thin.
  assert.equal(byId(snap, "mirror").confidence, "medium");
});

test("Volume is chaos value; approximate units derived from it", () => {
  const it = byId(normalizeExchangeOverview(real, meta), "annul");
  assert.equal(it.volumeChaos, 14533);
  assert.ok(Math.abs(it.approxUnitsTraded! - 14533 / 16.25) < 1e-6);
});

test("Sparkline totalChange is a percentage, exposed as change, not price", () => {
  const it = byId(normalizeExchangeOverview(real, meta), "alt");
  assert.equal(it.change7dPctChaos, 55.35);
  assert.equal(it.chaosValue, 0.1119); // price is NOT taken from sparkline
});

test("Divine-terms change removes chaos inflation", () => {
  // Divine +17.25% in chaos over the window. An item +17.25% in chaos is flat in divine.
  assert.ok(Math.abs(toDivineTermsChange(17.25, 17.25)!) < 1e-9);
});

test("Trend is read against each line's own pair, not always chaos", () => {
  const snap = normalizeExchangeOverview(real, meta);
  // alt trades vs chaos: +55.35% is already chaos terms.
  const alt = byId(snap, "alt");
  assert.equal(alt.trendPair, "chaos");
  assert.equal(alt.change7dPctChaos, 55.35);
  assert.ok(Math.abs(alt.change7dPctDivine! - ((1.5535 / 1.1725 - 1) * 100)) < 1e-6);
  // annul trades vs divine: -1.94% is divine terms; in chaos it is about +15%.
  const annul = byId(snap, "annul");
  assert.equal(annul.trendPair, "divine");
  assert.equal(annul.change7dPctDivine, -1.94);
  assert.ok(Math.abs(annul.change7dPctChaos! - ((0.9806 * 1.1725 - 1) * 100)) < 1e-6);
});

test("Divine rose ~17% in chaos (matches stash endpoint +17.10%); sign is not flipped", () => {
  const snap = normalizeExchangeOverview(real, meta);
  assert.equal(snap.divineChange7dPct, 17.25);
  assert.equal(byId(snap, "divine").change7dPctChaos, 17.25);
  // The v1.0.0 prototype showed -14.71 here.
  assert.ok(byId(snap, "divine").change7dPctChaos! > 0);
});

test("Real data is self-consistent: chaos vs divine compounded with divine vs chaos is ~0%", () => {
  // chaos line: -14.71% vs divine; divine line: +17.25% vs chaos.
  const chaosInChaos = compoundChange(-14.71, 17.25)!;
  assert.ok(Math.abs(chaosInChaos) < 0.01, `got ${chaosInChaos}`);
  const snap = normalizeExchangeOverview(real, meta);
  assert.equal(byId(snap, "chaos").change7dPctChaos, 0);
  assert.equal(byId(snap, "chaos").change7dPctDivine, -14.71);
});

test("Unknown trend pair leaves change empty instead of guessing", () => {
  const bad = clone();
  bad.lines.find((l) => l.id === "annul")!.maxVolumeCurrency = "exalted";
  bad.lines.find((l) => l.id === "annul")!.maxVolumeRate = null; // skip price cross-check
  const annul = byId(normalizeExchangeOverview(bad, meta), "annul");
  assert.equal(annul.change7dPctChaos, null);
  assert.equal(annul.change7dPctDivine, null);
});

test("Display rule: >= 1 divine shows div, below shows chaos", () => {
  assert.deepEqual(formatValue(401.8 * 2.5, 401.8), { main: "2.50 div", alt: "1,005 c" });
  assert.deepEqual(formatValue(16.25, 401.8), { main: "16.3 c", alt: "0.040 div" });
  assert.deepEqual(formatValue(null, 401.8), { main: "—", alt: null });
});

test("Duplicate lines are ignored with a warning", () => {
  const bad = clone();
  bad.lines.push({ ...bad.lines.find((l) => l.id === "annul")!, primaryValue: 999 });
  const snap = normalizeExchangeOverview(bad, meta);
  assert.equal(byId(snap, "annul").chaosValue, 16.25);
  assert.ok(snap.warnings.some((w) => w.includes("Duplicate")));
});
