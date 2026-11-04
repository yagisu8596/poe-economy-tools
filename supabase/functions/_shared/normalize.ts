/**
 * Market data normalization for poe.ninja "exchange overview" responses.
 *
 * Endpoint: GET /poe1/api/economy/exchange/current/overview?league={league}&type={type}
 *
 * Field meanings (verified against live data on 2026-11-04):
 *  - core.primary            reference currency of every primaryValue (expected: "chaos")
 *  - core.rates[id]          how many units of `id` ONE primary unit buys.
 *                            rates.divine = 0.002489  =>  1 chaos = 0.002489 divine
 *                            => divine price in chaos = 1 / rates.divine (≈ 401.8).
 *                            Reading this as "divine price" is the classic inversion bug.
 *  - line.primaryValue       price of ONE unit of the item, in primary currency (chaos).
 *  - line.volumePrimaryValue traded value expressed in chaos (NOT a unit count).
 *                            The time window is not documented by poe.ninja.
 *  - line.maxVolumeRate      units of THIS item per ONE unit of maxVolumeCurrency
 *                            (24.73 annul per 1 divine). Never use it as a price.
 *  - line.sparkline.data     cumulative % change over ~7 points (not prices!) of the item's
 *                            price measured in ITS maxVolumeCurrency (the docs: "price-trend
 *                            samples for the highest-volume pair"). So annul (pair: divine)
 *                            reports its change vs Divine, alt (pair: chaos) vs Chaos.
 *                            Verified 2026-11-04: divine (pair chaos) +17.25% matches the
 *                            classic stash endpoint's divine paySparkLine +17.10%, and chaos
 *                            (pair divine) -14.71% compounds with it to ~0% chaos-in-chaos.
 *                            The v1.0.0 prototype inverted these, flipping every trend sign.
 *
 * Rules enforced here (from the project brief):
 *  - Missing / invalid prices become null, never 0.
 *  - Missing volume becomes null, never 0.
 *  - The Divine/Chaos ratio is validated before anything else is trusted.
 */

export type Confidence = "high" | "medium" | "low";

export interface RawExchangeLine {
  id: string;
  primaryValue?: number | null;
  volumePrimaryValue?: number | null;
  maxVolumeCurrency?: string | null;
  maxVolumeRate?: number | null;
  sparkline?: { totalChange?: number | null; data?: (number | null)[] } | null;
}

export interface RawExchangeOverview {
  core: {
    primary: string;
    secondary?: string;
    rates: Record<string, number>;
    items?: { id: string; name: string; category?: string }[];
  };
  lines: RawExchangeLine[];
  items?: { id: string; name: string; category?: string; detailsId?: string }[];
}

export interface NormalizedItem {
  id: string;
  name: string;
  category: string | null;
  /** Price of one unit in Chaos Orbs. null = unknown (never 0 as a stand-in). */
  chaosValue: number | null;
  /** Price of one unit in Divine Orbs. null when chaosValue is null. */
  divineValue: number | null;
  /** Traded value in Chaos (window not documented by the source). null = unavailable. */
  volumeChaos: number | null;
  /** Approximate number of units behind the volume figure. */
  approxUnitsTraded: number | null;
  /** Currency the source measured the trend against (the highest-volume pair). */
  trendPair: string | null;
  /** 7-day % change in Chaos terms (converted from the pair when needed). */
  change7dPctChaos: number | null;
  /**
   * 7-day % change in Divine terms (removes Chaos inflation).
   * null when it cannot be derived safely.
   */
  change7dPctDivine: number | null;
  confidence: Confidence;
  /** Plain-language reasons why confidence is not "high", or why data is missing. */
  notes: string[];
}

export interface NormalizedSnapshot {
  league: string;
  category: string;
  fetchedAt: string;
  divinePriceChaos: number;
  /** % change of Divine measured in Chaos over the sparkline window. */
  divineChange7dPct: number | null;
  items: NormalizedItem[];
  warnings: string[];
}

export class DataIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DataIntegrityError";
  }
}

/** Plausible range for 1 Divine in Chaos. Outside it we refuse the whole snapshot. */
export const DIVINE_SANITY_RANGE = { min: 20, max: 5000 } as const;
/** Two independent Divine readings must agree within this fraction. */
const DIVINE_AGREEMENT_TOLERANCE = 0.03;
/** maxVolumeRate cross-check tolerance before we attach a warning. */
const CROSS_CHECK_TOLERANCE = 0.15;

const isPositiveNumber = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v > 0;
const isNonNegativeNumber = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0;
const isFiniteNumber = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

/**
 * Determine the Divine price in Chaos from two independent fields and make sure
 * they agree and are plausible. Throws DataIntegrityError otherwise.
 */
export function resolveDivinePrice(raw: RawExchangeOverview): number {
  if (raw?.core?.primary !== "chaos") {
    throw new DataIntegrityError(
      `Expected primary currency "chaos", got "${raw?.core?.primary}". Refusing to guess a conversion.`,
    );
  }
  const rate = raw.core.rates?.divine;
  const fromRate = isPositiveNumber(rate) ? 1 / rate : null;
  const divineLine = raw.lines?.find((l) => l.id === "divine");
  const fromLine = isPositiveNumber(divineLine?.primaryValue) ? divineLine!.primaryValue! : null;

  const candidate = fromLine ?? fromRate;
  if (candidate === null) {
    throw new DataIntegrityError("No usable Divine price in response (neither rates.divine nor a divine line).");
  }
  if (fromLine !== null && fromRate !== null) {
    const diff = Math.abs(fromLine - fromRate) / fromLine;
    if (diff > DIVINE_AGREEMENT_TOLERANCE) {
      throw new DataIntegrityError(
        `Divine price readings disagree: line=${fromLine}, 1/rate=${fromRate.toFixed(2)} (${(diff * 100).toFixed(1)}%).`,
      );
    }
  }
  if (candidate < DIVINE_SANITY_RANGE.min || candidate > DIVINE_SANITY_RANGE.max) {
    throw new DataIntegrityError(
      `Divine price ${candidate} chaos is outside the plausible range ` +
        `${DIVINE_SANITY_RANGE.min}–${DIVINE_SANITY_RANGE.max}. Possible inversion; snapshot rejected.`,
    );
  }
  return candidate;
}

/**
 * Initial heuristic. Thin markets produce fake "+100%" signals, so the scanner
 * must be able to hide or label them.
 */
export function classifyConfidence(
  chaosValue: number | null,
  volumeChaos: number | null,
): { confidence: Confidence; approxUnits: number | null; notes: string[] } {
  if (chaosValue === null) return { confidence: "low", approxUnits: null, notes: ["No price data."] };
  if (volumeChaos === null) return { confidence: "low", approxUnits: null, notes: ["No volume data."] };
  const units = volumeChaos / chaosValue;
  // Expensive items (Mirror) trade in few units, so "few units" alone is not thin:
  // low = about one unit changed hands, or the whole market is worth < 100 chaos.
  if (units < 2 || volumeChaos < 100) {
    return {
      confidence: "low",
      approxUnits: units,
      notes: [`Very few trades (~${formatUnits(units)} units, ${Math.round(volumeChaos)} chaos). Price can move easily.`],
    };
  }
  if (units < 20 || volumeChaos < 2000) {
    return { confidence: "medium", approxUnits: units, notes: ["Moderate trading volume."] };
  }
  return { confidence: "high", approxUnits: units, notes: [] };
}

function formatUnits(u: number): string {
  return u < 10 ? u.toFixed(1) : String(Math.round(u));
}

/**
 * Convert a Chaos-terms % change into Divine terms.
 * (1 + item%) / (1 + divine%) − 1, where divine% is Divine's change in Chaos.
 */
export function toDivineTermsChange(itemPctChaos: number | null, divinePctChaos: number | null): number | null {
  if (!isFiniteNumber(itemPctChaos) || !isFiniteNumber(divinePctChaos)) return null;
  const denom = 1 + divinePctChaos / 100;
  if (denom <= 0) return null;
  return ((1 + itemPctChaos / 100) / denom - 1) * 100;
}

/** Compound two % changes: (1 + a)(1 + b) − 1. */
export function compoundChange(a: number | null, b: number | null): number | null {
  if (!isFiniteNumber(a) || !isFiniteNumber(b)) return null;
  return ((1 + a / 100) * (1 + b / 100) - 1) * 100;
}

/**
 * Express a pair-relative trend in Chaos and Divine terms.
 * divineVsChaos = Divine's own change measured in Chaos.
 */
export function trendInBothUnits(
  pairChange: number | null,
  pair: string | null | undefined,
  divineVsChaos: number | null,
): { chaos: number | null; divine: number | null } {
  if (!isFiniteNumber(pairChange)) return { chaos: null, divine: null };
  if (pair === "chaos") return { chaos: pairChange, divine: toDivineTermsChange(pairChange, divineVsChaos) };
  if (pair === "divine") return { chaos: compoundChange(pairChange, divineVsChaos), divine: pairChange };
  // Other pairs (rare) would need that pair's own trend; refuse to guess.
  return { chaos: null, divine: null };
}

/** Implied chaos price from maxVolumeRate, for cross-checking only. */
export function impliedPriceFromMaxVolume(line: RawExchangeLine, divinePriceChaos: number): number | null {
  if (!isPositiveNumber(line.maxVolumeRate)) return null;
  if (line.maxVolumeCurrency === "chaos") return 1 / line.maxVolumeRate;
  if (line.maxVolumeCurrency === "divine") return divinePriceChaos / line.maxVolumeRate;
  return null;
}

/**
 * Divine reference taken from the same league's Currency overview. Other
 * categories (Scarab, Essence, …) carry only core.rates.divine and no divine
 * line, so they borrow Divine's 7-day trend from here.
 */
export interface DivineContext {
  divinePriceChaos: number;
  divineChange7dPct: number | null;
}

/** Categories are fetched minutes apart and Divine moves fast late in a league. */
const CONTEXT_WARN_TOLERANCE = 0.1;
const CONTEXT_REJECT_TOLERANCE = 0.25;

export function normalizeExchangeOverview(
  raw: RawExchangeOverview,
  meta: { league: string; category: string; fetchedAt?: string; context?: DivineContext },
): NormalizedSnapshot {
  const divinePriceChaos = resolveDivinePrice(raw);
  const warnings: string[] = [];

  if (meta.context) {
    const ref = meta.context.divinePriceChaos;
    const diff = Math.abs(divinePriceChaos - ref) / ref;
    if (diff > CONTEXT_REJECT_TOLERANCE) {
      throw new DataIntegrityError(
        `${meta.category}: Divine ${divinePriceChaos.toFixed(1)}c differs from Currency's ${ref.toFixed(1)}c by ${(diff * 100).toFixed(0)}%.`,
      );
    }
    if (diff > CONTEXT_WARN_TOLERANCE) {
      warnings.push(`Divine ${divinePriceChaos.toFixed(1)}c vs Currency ${ref.toFixed(1)}c (${(diff * 100).toFixed(0)}% apart).`);
    }
  }

  const names = new Map<string, { name: string; category: string | null }>();
  for (const it of [...(raw.core.items ?? []), ...(raw.items ?? [])]) {
    names.set(it.id, { name: it.name, category: it.category ?? null });
  }

  // Divine's trend is only usable as the Chaos<->Divine bridge when it was
  // measured against Chaos.
  const divineLine = raw.lines.find((l) => l.id === "divine");
  const ownDivineChange =
    divineLine?.maxVolumeCurrency === "chaos" && isFiniteNumber(divineLine?.sparkline?.totalChange)
      ? divineLine!.sparkline!.totalChange!
      : null;
  const divineChange7dPct = ownDivineChange ?? meta.context?.divineChange7dPct ?? null;
  if (divineChange7dPct === null) warnings.push("Divine trend vs Chaos unavailable; 7-day changes left empty.");

  const seen = new Set<string>();
  const items: NormalizedItem[] = [];
  for (const line of raw.lines ?? []) {
    if (!line?.id) {
      warnings.push("Skipped a line without id.");
      continue;
    }
    if (seen.has(line.id)) {
      warnings.push(`Duplicate line "${line.id}" ignored.`);
      continue;
    }
    seen.add(line.id);

    const notes: string[] = [];
    const chaosValue = isPositiveNumber(line.primaryValue) ? line.primaryValue : null;
    if (chaosValue === null) notes.push("Source gave no valid price.");
    const volumeChaos = isNonNegativeNumber(line.volumePrimaryValue) ? line.volumePrimaryValue : null;

    if (chaosValue !== null) {
      const implied = impliedPriceFromMaxVolume(line, divinePriceChaos);
      if (implied !== null && Math.abs(implied - chaosValue) / chaosValue > CROSS_CHECK_TOLERANCE) {
        warnings.push(
          `"${line.id}": primaryValue ${chaosValue} vs implied ${implied.toFixed(4)} from maxVolumeRate differ by >${CROSS_CHECK_TOLERANCE * 100}%.`,
        );
        notes.push("Price sources disagree.");
      }
    }

    const pairChange = isFiniteNumber(line.sparkline?.totalChange) ? line.sparkline!.totalChange! : null;
    const trend =
      line.id === "chaos"
        ? { chaos: 0, divine: pairChange } // chaos never moves in chaos terms
        : line.id === "divine"
          ? { chaos: divineChange7dPct, divine: 0 }
          : trendInBothUnits(pairChange, line.maxVolumeCurrency, divineChange7dPct);
    const conf = classifyConfidence(chaosValue, volumeChaos);
    const info = names.get(line.id);

    items.push({
      id: line.id,
      name: info?.name ?? line.id,
      category: info?.category ?? null,
      chaosValue,
      divineValue: chaosValue === null ? null : chaosValue / divinePriceChaos,
      volumeChaos,
      approxUnitsTraded: conf.approxUnits,
      trendPair: line.maxVolumeCurrency ?? null,
      change7dPctChaos: trend.chaos,
      change7dPctDivine: trend.divine,
      confidence: conf.confidence,
      notes: [...notes, ...conf.notes],
    });
  }

  return {
    league: meta.league,
    category: meta.category,
    fetchedAt: meta.fetchedAt ?? new Date().toISOString(),
    divinePriceChaos,
    divineChange7dPct,
    items,
    warnings,
  };
}

/**
 * Display rule from the brief: total >= 1 Divine -> show Divine, else Chaos.
 * null -> "—" (never "0").
 */
export function formatValue(chaos: number | null, divinePriceChaos: number): { main: string; alt: string | null } {
  if (chaos === null || !Number.isFinite(chaos)) return { main: "—", alt: null };
  const div = chaos / divinePriceChaos;
  const fmt = (n: number) =>
    n >= 100 ? Math.round(n).toLocaleString("en-US") : n >= 10 ? n.toFixed(1) : n >= 1 ? n.toFixed(2) : n.toFixed(3);
  if (div >= 1) return { main: `${fmt(div)} div`, alt: `${fmt(chaos)} c` };
  return { main: `${fmt(chaos)} c`, alt: `${fmt(div)} div` };
}
