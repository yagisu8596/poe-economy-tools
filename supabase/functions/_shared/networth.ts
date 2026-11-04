/**
 * Net worth change decomposition.
 *
 *   ΔV = Σ (q1 − q0) · p0   (your activity: items gained, lost, sold)
 *      + Σ q1 · (p1 − p0)   (market effect: price moves on what you hold now)
 *
 * The two parts always add up to the total change of the priced portion.
 * Items without a price in either snapshot are never treated as 0 — they are
 * listed separately so the user sees what was left out.
 */

export interface Holding {
  /** Stable item id (e.g. poe.ninja id) */
  id: string;
  quantity: number;
  /** Chaos price at snapshot time; null = unpriced */
  chaosPrice: number | null;
}

export interface Snapshot {
  takenAt: string;
  league: string;
  holdings: Holding[];
}

export interface Decomposition {
  /** Total change of priced holdings, in Chaos */
  totalChange: number;
  /** Change caused by quantities changing (valued at old prices) */
  activityEffect: number;
  /** Change caused by prices moving (on current quantities) */
  marketEffect: number;
  /** Items that could not be valued in one or both snapshots */
  unpriced: string[];
  perItem: { id: string; activity: number; market: number }[];
}

export function decomposeChange(prev: Snapshot, curr: Snapshot): Decomposition {
  if (prev.league !== curr.league) {
    throw new Error(`Snapshots belong to different leagues (${prev.league} vs ${curr.league}); not comparable.`);
  }
  const a = new Map(prev.holdings.map((h) => [h.id, h]));
  const b = new Map(curr.holdings.map((h) => [h.id, h]));
  const ids = new Set([...a.keys(), ...b.keys()]);

  let activityEffect = 0;
  let marketEffect = 0;
  const unpriced: string[] = [];
  const perItem: Decomposition["perItem"] = [];

  for (const id of ids) {
    const q0 = a.get(id)?.quantity ?? 0;
    const q1 = b.get(id)?.quantity ?? 0;
    // An item absent from a snapshot has no quantity there, but its price can come
    // from the other side: a newly acquired item is valued at today's price in both
    // periods (no market effect), a fully sold item at its last known price.
    const p0 = a.get(id)?.chaosPrice ?? (q0 === 0 ? b.get(id)?.chaosPrice : null) ?? null;
    const p1 = b.get(id)?.chaosPrice ?? (q1 === 0 ? a.get(id)?.chaosPrice : null) ?? null;

    if (p0 === null || p1 === null) {
      unpriced.push(id);
      continue;
    }
    const activity = (q1 - q0) * p0;
    const market = q1 * (p1 - p0);
    activityEffect += activity;
    marketEffect += market;
    perItem.push({ id, activity, market });
  }

  return {
    totalChange: activityEffect + marketEffect,
    activityEffect,
    marketEffect,
    unpriced: unpriced.sort(),
    perItem,
  };
}

/** Total value of priced holdings in Chaos, plus the list of unpriced ids. */
export function valueSnapshot(s: Snapshot): { chaos: number; unpriced: string[] } {
  let chaos = 0;
  const unpriced: string[] = [];
  for (const h of s.holdings) {
    if (h.chaosPrice === null || !Number.isFinite(h.chaosPrice)) unpriced.push(h.id);
    else chaos += h.quantity * h.chaosPrice;
  }
  return { chaos, unpriced };
}
