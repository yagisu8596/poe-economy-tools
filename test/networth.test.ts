import { test } from "node:test";
import assert from "node:assert/strict";
import { decomposeChange, valueSnapshot, type Snapshot } from "../supabase/functions/_shared/networth.ts";

const snap = (holdings: Snapshot["holdings"], league = "Allflame"): Snapshot => ({
  takenAt: "2026-11-04T00:00:00Z",
  league,
  holdings,
});

const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test("Gaining 10 divines at a flat price is pure activity", () => {
  const d = decomposeChange(
    snap([{ id: "divine", quantity: 5, chaosPrice: 400 }]),
    snap([{ id: "divine", quantity: 15, chaosPrice: 400 }]),
  );
  close(d.activityEffect, 4000);
  close(d.marketEffect, 0);
});

test("A price rise on held items is pure market effect", () => {
  const d = decomposeChange(
    snap([{ id: "annul", quantity: 20, chaosPrice: 16 }]),
    snap([{ id: "annul", quantity: 20, chaosPrice: 20 }]),
  );
  close(d.activityEffect, 0);
  close(d.marketEffect, 80);
});

test("Parts always sum to the real change in value", () => {
  const prev = snap([
    { id: "divine", quantity: 5, chaosPrice: 380 },
    { id: "annul", quantity: 20, chaosPrice: 16 },
    { id: "alt", quantity: 300, chaosPrice: 0.1 },
  ]);
  const curr = snap([
    { id: "divine", quantity: 8, chaosPrice: 401.8 },
    { id: "annul", quantity: 12, chaosPrice: 16.25 },
    { id: "awakeners-orb", quantity: 1, chaosPrice: 1138 },
  ]);
  const d = decomposeChange(prev, curr);
  close(d.totalChange, valueSnapshot(curr).chaos - valueSnapshot(prev).chaos);
  close(d.activityEffect + d.marketEffect, d.totalChange);
});

test("Selling everything of an item counts as activity at last known price", () => {
  const d = decomposeChange(
    snap([{ id: "alt", quantity: 300, chaosPrice: 0.1 }]),
    snap([]),
  );
  close(d.activityEffect, -30);
  close(d.marketEffect, 0);
});

test("Unpriced items are excluded and listed, never valued at 0", () => {
  const d = decomposeChange(
    snap([{ id: "rare-helmet", quantity: 1, chaosPrice: null }, { id: "divine", quantity: 1, chaosPrice: 400 }]),
    snap([{ id: "rare-helmet", quantity: 1, chaosPrice: null }, { id: "divine", quantity: 1, chaosPrice: 400 }]),
  );
  assert.deepEqual(d.unpriced, ["rare-helmet"]);
  close(d.totalChange, 0);
  assert.deepEqual(valueSnapshot(snap([{ id: "rare-helmet", quantity: 1, chaosPrice: null }])).unpriced, ["rare-helmet"]);
});

test("Snapshots from different leagues are not compared", () => {
  assert.throws(() => decomposeChange(snap([], "Allflame"), snap([], "Standard")), /different leagues/);
});
