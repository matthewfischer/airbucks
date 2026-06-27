import type { Airline, GameState } from './types';
import {
  airportById,
  distanceFactor,
  equity,
  eraScale,
  money,
  pairDemand,
  playerNews,
  priceLevel,
  referenceFare,
} from './engine';
import { distanceKm } from './geo';
import { mergeInto } from './distress';

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

// ---- Valuation --------------------------------------------------------------

/** Realizable fraction of a network's *theoretical* addressable revenue. The
 *  gross below assumes 100% capture of every market each held city anchors, to
 *  the whole world — wildly more than any carrier realizes — so franchise value
 *  is a small slice of it (capture rate × margin × capitalization). Tunable. */
const FRANCHISE_FACTOR = 0.0006;

/** A city's weekly addressable revenue: the theoretical demand it anchors to
 *  every other airport, at reference fares. The market's size, per city. */
function cityMarket(g: GameState, a: ReturnType<typeof airportById>): number {
  let weekly = 0;
  for (const b of g.airports) {
    if (b.id === a.id) continue;
    const dist = distanceKm(a, b);
    weekly += pairDemand(a, b) * distanceFactor(dist) * referenceFare(dist);
  }
  return weekly;
}

/** Fraction of franchise value the *public* market pays. Diluting yourself to
 *  diffuse shareholders realizes less than a control acquirer pays for the whole
 *  franchise, so issuing/open-market float trade below full intrinsic value —
 *  which keeps share issuance from being a runaway cash spigot. */
const PUBLIC_FRACTION = 0.35;

/**
 * Franchise value: what the network's market is worth to a competent operator,
 * regardless of how efficiently the *current* owner runs it (their slack is the
 * upside an acquirer buys). Sum the addressable market of every city held — so
 * it's linear in the network's size and weighted toward big markets — and take a
 * realizable slice. Buyer-independent: A and B stand on their own; a strategic
 * fit is the acquirer's premium to pay, not a change to the target's worth.
 */
export function franchiseValue(g: GameState, al: Airline): number {
  let weekly = 0;
  for (const id of al.rights) weekly += cityMarket(g, airportById(g, id));
  return Math.round(weekly * priceLevel(g) * 52 * FRANCHISE_FACTOR);
}

/** Tangible + discounted franchise, with NO portfolio term — the basis for
 *  pricing a *holding* in this airline, kept portfolio-free so cross-holdings
 *  can't value themselves in a loop. */
const basePublicValue = (g: GameState, al: Airline): number =>
  equity(g, al) + franchiseValue(g, al) * PUBLIC_FRACTION;

/**
 * Market value of the stakes `al` holds in *other* airlines — a balance-sheet
 * asset like cash or fleet, not franchise. Each stake is valued at the held
 * airline's base (portfolio-free) public per-share price — a marketable-minority
 * basis that also breaks the cross-holding recursion (A owns B owns A). Treasury
 * (self-held) shares are not a holding. Usually 0: no stakes, no work.
 */
export function portfolioValue(g: GameState, al: Airline): number {
  let total = 0;
  for (const x of g.airlines) {
    if (x === al) continue;
    const n = sharesOwned(x, al.id);
    if (n > 0) total += (n * basePublicValue(g, x)) / TOTAL_SHARES;
  }
  return Math.round(total);
}

/** Public-market value: tangible net worth, a discounted slice of franchise, and
 *  the full value of its share portfolio. The sole basis for every share trade —
 *  issuing, open-market float, buy-back, selling, and takeovers (only floated
 *  shares ever change hands, all at this price). */
export function publicValue(g: GameState, al: Airline): number {
  const value = basePublicValue(g, al) + portfolioValue(g, al);
  return Math.max(Math.round(MIN_VALUATION * eraScale(g)), Math.round(value));
}

/** Price of a single share — the one price for every trade (float buys,
 *  issuance, buy-back, sale, takeover, and squeeze-out). */
export const sharePriceBase = (g: GameState, al: Airline): number =>
  publicValue(g, al) / TOTAL_SHARES;

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

// ---- Player dominance (raid trigger) ----------------------------------------

/** Equity share above which the player is "most of the market" and rivals start
 *  hostile accumulation of the player. "Uneasy lies the crown." */
export const DOMINANCE_THRESHOLD = 0.45;

/** The player's equity as a fraction of the whole industry's positive equity
 *  (0..1). 0 if the industry has no positive equity. The player is airlines[0]. */
export function playerEquityShare(g: GameState): number {
  let total = 0;
  let mine = 0;
  for (const al of g.airlines) {
    const e = Math.max(0, equity(g, al));
    total += e;
    if (al === g.airlines[0]) mine = e;
  }
  return total > 0 ? mine / total : 0;
}

/** True once the player towers over the field enough to become a raid target:
 *  most of the market (≥ threshold) AND strictly the single biggest carrier. The
 *  strict-largest test means an inert/equal airline (e.g. a headless sim's unused
 *  player slot) never qualifies — only a player that has genuinely pulled ahead. */
export function isPlayerDominant(g: GameState): boolean {
  if (g.airlines.length < 2) return false;
  if (playerEquityShare(g) < DOMINANCE_THRESHOLD) return false;
  const mine = Math.max(0, equity(g, g.airlines[0]));
  for (let i = 1; i < g.airlines.length; i++) {
    if (Math.max(0, equity(g, g.airlines[i])) >= mine) return false;
  }
  return true;
}

// ---- Price with impact ------------------------------------------------------

/** Marginal-price multiplier when the buyer would own fraction `f` (0..1) after
 *  a share: rises with the stake, with a steep premium on the shares that cross
 *  control (50%). Keeps cornering progressively expensive. */
const IMPACT_SLOPE = 0.5; // gentle ramp from 1.0 toward control
const CONTROL_PREMIUM = 0.8; // surcharge on shares past 50%
const premium = (f: number): number => 1 + IMPACT_SLOPE * f + CONTROL_PREMIUM * Math.max(0, f - 0.5);

/**
 * Cost for a buyer holding `ownedBefore` shares of `al` to acquire `count` more
 * off the float, with price impact: each successive share is dearer, and the
 * control-crossing shares carry a premium. Everything prices off the public
 * value. A per-share sum — pure/deterministic.
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

// ---- Transactions -----------------------------------------------------------

/** Shares needed to control an airline (>50%). */
export const CONTROL_SHARES = Math.floor(TOTAL_SHARES / 2) + 1;

/** True if `ownerId` holds a controlling stake in `target`. */
export const hasControl = (target: Airline, ownerId: string): boolean =>
  sharesOwned(target, ownerId) >= CONTROL_SHARES;

/**
 * Move `count` shares of `target` to `buyer` at the impact price, pulling only
 * from the public float — never from the founder or other holders. You are
 * exposed exactly to the extent you floated, and not one share more. The buyer
 * pays cash; the float's proceeds leave the game (no personal accounts — Tier 3
 * is out of scope), so a buy is a real cost, not a wash with treasury the buyer
 * might later inherit. Returns shares actually transferred.
 */
function transferShares(
  g: GameState,
  buyer: Airline,
  target: Airline,
  count: number,
): number {
  const cap = { ...ownership(target) };
  const buyerId = buyer.id;
  const owned = cap[buyerId] ?? 0;
  const take = Math.min(count, cap[PUBLIC] ?? 0);
  if (take <= 0) return 0;
  const cost = costToAccumulate(g, target, owned, take);
  buyer.cash -= cost;
  cap[PUBLIC] -= take;
  cap[buyerId] = owned + take;
  for (const k of Object.keys(cap)) if (cap[k] <= 0) delete cap[k];
  target.shares = cap;
  return take;
}

/** Buy `count` shares of `target` on the open market (public float only). */
export const buyShares = (g: GameState, buyer: Airline, target: Airline, count: number): number =>
  transferShares(g, buyer, target, count);

/** Founder repurchases `count` shares from the float to re-secure its stake. */
export const buyBack = (g: GameState, al: Airline, count: number): number =>
  transferShares(g, al, al, count);

/** A holder sells `count` of its shares in `target` back to the float for cash.
 *  (The founder raises capital via `issueShares`, not this.) */
export function sellShares(g: GameState, seller: Airline, target: Airline, count: number): number {
  if (seller.id === target.id) return 0;
  const n = Math.min(count, sharesOwned(target, seller.id));
  if (n <= 0) return 0;
  const cap = { ...ownership(target) };
  cap[seller.id] -= n;
  cap[PUBLIC] = (cap[PUBLIC] ?? 0) + n;
  for (const k of Object.keys(cap)) if (cap[k] <= 0) delete cap[k];
  target.shares = cap;
  seller.cash += Math.round(sharePriceBase(g, target) * n);
  return n;
}

/** Issue (sell) `count` retained shares to the public float, raising cash for
 *  the airline — a financing lever alongside debt that also raises takeover
 *  exposure. Returns shares issued. */
export function issueShares(g: GameState, al: Airline, count: number): number {
  const n = Math.min(count, retainedShares(al));
  if (n <= 0) return 0;
  const cap = { ...ownership(al) };
  cap[al.id] -= n;
  cap[PUBLIC] = (cap[PUBLIC] ?? 0) + n;
  for (const k of Object.keys(cap)) if (cap[k] <= 0) delete cap[k];
  al.shares = cap;
  al.cash += Math.round(sharePriceBase(g, al) * n);
  return n;
}

/** Integration time after an acquisition before the buyer can launch another. */
export const ACQUIRE_COOLDOWN_DAYS = 365;

/** Whether `buyer` is past its post-acquisition integration cooldown. */
export const canAcquire = (g: GameState, buyer: Airline): boolean =>
  buyer.lastAcquireDay === undefined || g.day - buyer.lastAcquireDay >= ACQUIRE_COOLDOWN_DAYS;

/** Days left on the integration cooldown (0 if ready). */
export const acquireCooldownLeft = (g: GameState, buyer: Airline): number =>
  buyer.lastAcquireDay === undefined
    ? 0
    : Math.max(0, ACQUIRE_COOLDOWN_DAYS - (g.day - buyer.lastAcquireDay));

/** Shares of float `buyer` must still buy to control `target` (0 if already in
 *  control). */
const sharesToControl = (target: Airline, buyer: Airline): number =>
  Math.max(0, CONTROL_SHARES - sharesOwned(target, buyer.id));

/** Whether `target`'s public float is deep enough to deliver control to `buyer`.
 *  A founder that kept a majority is un-takeoverable via shares (distress is the
 *  only path for those). */
export const canReachControl = (target: Airline, buyer: Airline): boolean =>
  publicFloat(target) >= sharesToControl(target, buyer);

/** Cost to reach a controlling stake in `target` by buying the float, at the
 *  impact price (the curve carries the control premium). `Infinity` when the
 *  float can't deliver control — so callers naturally skip the un-takeoverable. */
export function controlCost(g: GameState, buyer: Airline, target: Airline): number {
  if (!canReachControl(target, buyer)) return Infinity;
  const owned = sharesOwned(target, buyer.id);
  return costToAccumulate(g, target, owned, sharesToControl(target, buyer));
}

/** Estimated total cost to fully take over `target`: buy the float to control,
 *  then cash out the remaining minority at the public price (no premium). The
 *  affordability gate for an AI or player hostile takeover; `Infinity` when the
 *  float can't reach control. */
export function takeoverCost(g: GameState, buyer: Airline, target: Airline): number {
  const control = controlCost(g, buyer, target);
  if (!Number.isFinite(control)) return Infinity;
  const afterControl = Math.max(sharesOwned(target, buyer.id), CONTROL_SHARES);
  const remaining = TOTAL_SHARES - afterControl;
  return control + Math.round(sharePriceBase(g, target) * remaining);
}

/**
 * With a controlling stake (only reachable via the float now), cash out the
 * remaining minority at the public price and merge the airline into the buyer.
 * Other-airline minority holders are paid; founder/public remainders dissolve.
 * Returns true on success.
 */
export function squeezeOut(g: GameState, buyer: Airline, target: Airline): boolean {
  if (!hasControl(target, buyer.id) || !canAcquire(g, buyer)) return false;
  const remaining = TOTAL_SHARES - sharesOwned(target, buyer.id);
  if (remaining > 0) {
    const perShare = sharePriceBase(g, target);
    buyer.cash -= Math.round(perShare * remaining);
    for (const [owner, n] of Object.entries(ownership(target))) {
      if (owner === buyer.id || owner === PUBLIC || owner === target.id) continue;
      const al = g.airlines.find((a) => a.id === owner);
      if (al && al !== buyer) al.cash += Math.round(perShare * n);
    }
  }
  const cities = target.rights.length;
  const debtNote = target.debt > 0 ? `, assuming ${money(target.debt)} debt` : '';
  mergeInto(g, buyer, target);
  playerNews(g, `🤝 ${buyer.name} took over ${target.name} — ${cities} cities${debtNote}.`);
  return true;
}

/**
 * Hostile takeover: buy the float up to a controlling stake, then cash out the
 * rest and merge. Only possible when the float can deliver control — a founder
 * that kept its majority can't be taken over this way. Returns true if control
 * was reached.
 */
export function takeover(g: GameState, buyer: Airline, target: Airline): boolean {
  if (!canAcquire(g, buyer)) return false; // still digesting the last acquisition
  const need = sharesToControl(target, buyer);
  if (need > 0) {
    if (!canReachControl(target, buyer)) return false; // float can't deliver control
    buyShares(g, buyer, target, need);
  }
  if (!hasControl(target, buyer.id)) return false;
  return squeezeOut(g, buyer, target);
}
