import type { Airline, GameState } from './types';
import { equity, eraScale, weeklyTotals } from './engine';
import { slotInvestment } from './distress';

// A stock market for airlines (RRT-direction). Each carrier has a cap table of
// 100 shares; takeover difficulty is self-inflicted (you're exposed in
// proportion to the float you issued), young privately-held rivals cost an
// expensive hostile bid on a growth-aware valuation, and a dominant player
// becomes a raid target. See docs/airline-shares.md.
//
// This module (phase 1) holds the data model, valuation, and price curve. The
// transactional ops (buy/sell/issue/buyback/squeeze-out) build on top of it.

/** Total shares in every airline's cap table. */
export const TOTAL_SHARES = 100;

/** Pseudo-owner id for the freely-tradeable open float. */
export const PUBLIC = 'public';

/** Valuation never drops below this (era-scaled) floor, so a struggling airline
 *  still has a non-zero share price. */
const MIN_VALUATION = 100_000;

// ---- Growth-aware valuation -------------------------------------------------

const GROWTH_MULT_MIN = 2; // flat/mature airline: a low earnings multiple
const GROWTH_MULT_MAX = 15; // fast grower: a high multiple (like a growth stock)
const GROWTH_CAP = 1.0; // growth at/above +100%/yr earns the max multiple

/**
 * Earnings multiple applied to a healthy airline's profit, scaled by how fast
 * it's growing — measured from the revenue trend in its weekly `history`,
 * recent vs ~a year prior. A young, fast-growing carrier commands a high
 * multiple (expensive to buy young); a flat/mature one a low one. Bounded so a
 * tiny revenue base can't produce an absurd multiple.
 */
export function growthMultiple(al: Airline): number {
  const h = al.history;
  if (h.length < 2) return GROWTH_MULT_MIN;
  const now = h[h.length - 1];
  // The snapshot closest to a year before `now` (history is oldest-first).
  const cutoff = now.day - 365;
  let prev = h[0];
  for (const s of h) {
    if (s.day <= cutoff) prev = s;
    else break;
  }
  const r0 = prev.revenue;
  const r1 = now.revenue;
  // From ~zero to positive revenue is maximal growth; flat/declining is minimal.
  if (r0 <= 0) return r1 > 0 ? GROWTH_MULT_MAX : GROWTH_MULT_MIN;
  const growth = Math.min(GROWTH_CAP, Math.max(0, (r1 - r0) / r0));
  return GROWTH_MULT_MIN + (GROWTH_MULT_MAX - GROWTH_MULT_MIN) * (growth / GROWTH_CAP);
}

/**
 * Growth-aware enterprise value of an airline: net worth + the replacement cost
 * of its slot portfolio + growth-scaled goodwill on its earnings. Floored. This
 * is the basis for the share price; the cheap-acquisition window closes from
 * both ends (young = growth premium on goodwill, old = large equity).
 */
export function shareValuation(g: GameState, al: Airline): number {
  const annualNet = weeklyTotals(g, al).net * 52;
  const goodwill = Math.max(0, annualNet) * growthMultiple(al);
  const value = equity(g, al) + slotInvestment(g, al) + goodwill;
  return Math.max(Math.round(MIN_VALUATION * eraScale(g)), Math.round(value));
}

/** Plain (no-impact) price of a single share — the valuation split 100 ways. */
export const sharePriceBase = (g: GameState, al: Airline): number =>
  shareValuation(g, al) / TOTAL_SHARES;

// ---- Cap table --------------------------------------------------------------

/** The cap table, defaulting an unset one to 100% self-held. */
export const ownership = (al: Airline): Record<string, number> =>
  al.shares ?? { [al.id]: TOTAL_SHARES };

/** Shares of `al` held by `ownerId` (0 if none). */
export const sharesOwned = (al: Airline, ownerId: string): number =>
  ownership(al)[ownerId] ?? 0;

/** Shares the airline still holds in itself (founder stake). */
export const retainedShares = (al: Airline): number => sharesOwned(al, al.id);

/** Shares sitting in the open float, freely buyable. */
export const publicFloat = (al: Airline): number => sharesOwned(al, PUBLIC);

/** The owner with a controlling (>50%) stake, or null if no one controls. */
export function controllerOf(al: Airline): string | null {
  for (const [owner, n] of Object.entries(ownership(al))) {
    if (n > TOTAL_SHARES / 2) return owner;
  }
  return null;
}

/** The largest stake any other airline holds in `al` (excludes the founder and
 *  the public float) — the raid/loss signal. Returns { ownerId, shares } | null. */
export function largestRivalStake(al: Airline): { ownerId: string; shares: number } | null {
  let best: { ownerId: string; shares: number } | null = null;
  for (const [owner, n] of Object.entries(ownership(al))) {
    if (owner === al.id || owner === PUBLIC) continue;
    if (!best || n > best.shares) best = { ownerId: owner, shares: n };
  }
  return best;
}

// ---- Price with impact ------------------------------------------------------

/** Marginal-price multiplier when the buyer would own fraction `f` (0..1) after
 *  a share: rises with the stake, with a steep premium on the shares that cross
 *  control (50%). Keeps cornering progressively expensive. */
const IMPACT_SLOPE = 1.0; // gentle ramp from 1.0 toward control
const CONTROL_PREMIUM = 2.0; // steep surcharge on shares past 50%
const premium = (f: number): number => 1 + IMPACT_SLOPE * f + CONTROL_PREMIUM * Math.max(0, f - 0.5);

/**
 * Cost for a buyer holding `ownedBefore` shares of `al` to acquire `count` more,
 * with price impact: each successive share is dearer, and the control-crossing
 * shares carry a premium. A per-share sum (≤100 terms) — pure and deterministic.
 */
export function costToAccumulate(
  g: GameState,
  al: Airline,
  ownedBefore: number,
  count: number,
): number {
  const base = sharePriceBase(g, al);
  let total = 0;
  for (let i = 1; i <= count; i++) {
    const ownedAfter = ownedBefore + i;
    total += base * premium(ownedAfter / TOTAL_SHARES);
  }
  return Math.round(total);
}
