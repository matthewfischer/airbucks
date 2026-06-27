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

/**
 * Full intrinsic value: tangible net worth (the assets a buyer inherits) plus
 * the whole franchise value of the network's addressable market. What a control
 * acquirer pays — the basis for takeover pricing.
 */
export function bookValue(g: GameState, al: Airline): number {
  const value = equity(g, al) + franchiseValue(g, al);
  return Math.max(Math.round(MIN_VALUATION * eraScale(g)), Math.round(value));
}

/** Public-market value: tangible net worth plus a discounted slice of franchise.
 *  The basis for issuing, open-market float, buy-back, and selling. */
export function publicValue(g: GameState, al: Airline): number {
  const value = equity(g, al) + franchiseValue(g, al) * PUBLIC_FRACTION;
  return Math.max(Math.round(MIN_VALUATION * eraScale(g)), Math.round(value));
}

/** Everyday (public) price of a single share — issuing/float/buyback/sell. */
export const sharePriceBase = (g: GameState, al: Airline): number =>
  publicValue(g, al) / TOTAL_SHARES;

/** Control price of a single share — what a takeover/squeeze-out pays. */
export const fullSharePrice = (g: GameState, al: Airline): number =>
  bookValue(g, al) / TOTAL_SHARES;

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
 * Cost for a buyer holding `ownedBefore` shares of `al` to acquire `count` more,
 * with price impact: each successive share is dearer, and the control-crossing
 * shares carry a premium. Open-market buys price at the public value; a takeover
 * (`full`) prices at the full control value. A per-share sum — pure/deterministic.
 */
export function costToAccumulate(
  g: GameState,
  al: Airline,
  ownedBefore: number,
  count: number,
  full = false,
): number {
  const base = full ? fullSharePrice(g, al) : sharePriceBase(g, al);
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
/** Premium paid to minority holders when forcing them out at a squeeze-out. */
const SQUEEZE_PREMIUM = 1.25;

/** True if `ownerId` holds a controlling stake in `target`. */
export const hasControl = (target: Airline, ownerId: string): boolean =>
  sharesOwned(target, ownerId) >= CONTROL_SHARES;

/**
 * Move `count` shares of `target` to `buyer` at the impact price, pulling from
 * the public float first, then — only if `force` — the founder and other
 * holders. The buyer pays cash; proceeds go only to *other airlines* whose
 * stakes are bought (they realize the investment). Founder and public proceeds
 * leave the game (no personal accounts — Tier 3 is out of scope), so a takeover
 * is a real cost, not a wash with the treasury the buyer later inherits.
 * Returns shares actually transferred.
 */
function transferShares(
  g: GameState,
  buyer: Airline,
  target: Airline,
  count: number,
  force: boolean,
): number {
  const cap = { ...ownership(target) };
  const buyerId = buyer.id;
  const sources: string[] = [PUBLIC];
  if (force) {
    sources.push(target.id);
    for (const o of Object.keys(cap)) {
      if (o !== PUBLIC && o !== target.id && o !== buyerId) sources.push(o);
    }
  }
  let owned = cap[buyerId] ?? 0;
  let need = count;
  let cost = 0;
  const credit = new Map<string, number>();
  for (const src of sources) {
    if (need <= 0) break;
    if (src === buyerId) continue;
    const take = Math.min(need, cap[src] ?? 0);
    if (take <= 0) continue;
    // A forced acquisition (takeover) pays the full control price; open-market
    // float trades at the public price.
    const c = costToAccumulate(g, target, owned, take, force);
    cost += c;
    // Only other airlines (not the founder, not the public) pocket the proceeds.
    if (src !== PUBLIC && src !== target.id) credit.set(src, (credit.get(src) ?? 0) + c);
    cap[src] -= take;
    cap[buyerId] = (cap[buyerId] ?? 0) + take;
    owned += take;
    need -= take;
  }
  cost = Math.round(cost);
  const got = count - need;
  if (got <= 0) return 0;
  buyer.cash -= cost;
  for (const [owner, amt] of credit) {
    const al = g.airlines.find((a) => a.id === owner);
    if (al && al !== buyer) al.cash += Math.round(amt);
  }
  for (const k of Object.keys(cap)) if (cap[k] <= 0) delete cap[k];
  target.shares = cap;
  return got;
}

/** Buy `count` shares of `target` on the open market (public float only). */
export const buyShares = (g: GameState, buyer: Airline, target: Airline, count: number): number =>
  transferShares(g, buyer, target, Math.min(count, publicFloat(target)), false);

/** Founder repurchases `count` shares from the float to re-secure its stake. */
export const buyBack = (g: GameState, al: Airline, count: number): number =>
  transferShares(g, al, al, Math.min(count, publicFloat(al)), false);

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

/** Cost to reach a controlling stake in `target` (at the full control price; the
 *  price-impact curve carries the control premium). */
export function controlCost(g: GameState, buyer: Airline, target: Airline): number {
  const owned = sharesOwned(target, buyer.id);
  return costToAccumulate(g, target, owned, Math.max(0, CONTROL_SHARES - owned), true);
}

/** Estimated total cost to fully take over `target` from the buyer's current
 *  holding: reach control, then squeeze out the rest. The affordability gate for
 *  an AI or player hostile takeover. */
export function takeoverCost(g: GameState, buyer: Airline, target: Airline): number {
  const remaining = TOTAL_SHARES - CONTROL_SHARES;
  const squeeze = Math.round(fullSharePrice(g, target) * remaining * SQUEEZE_PREMIUM);
  return controlCost(g, buyer, target) + squeeze;
}

/**
 * With a controlling stake, force-buy the remaining minority at a premium and
 * merge the airline into the buyer. Other-airline minority holders are paid;
 * founder/public remainders leave the game. Returns true on success.
 */
export function squeezeOut(g: GameState, buyer: Airline, target: Airline): boolean {
  if (!hasControl(target, buyer.id) || !canAcquire(g, buyer)) return false;
  const remaining = TOTAL_SHARES - sharesOwned(target, buyer.id);
  if (remaining > 0) {
    const perShare = fullSharePrice(g, target) * SQUEEZE_PREMIUM;
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
 * Hostile takeover: buy up to a controlling stake (forcing retained shares at
 * the control-premium price when the float is short), then squeeze out the rest
 * and merge. Always possible at a price — never permanently blocked. Returns
 * true if control was reached.
 */
export function takeover(g: GameState, buyer: Airline, target: Airline): boolean {
  if (!canAcquire(g, buyer)) return false; // still digesting the last acquisition
  const need = Math.max(0, CONTROL_SHARES - sharesOwned(target, buyer.id));
  if (need > 0) transferShares(g, buyer, target, need, true);
  if (!hasControl(target, buyer.id)) return false;
  return squeezeOut(g, buyer, target);
}

/**
 * Force-buy `count` shares of `target` for `buyer` at the control price, biting
 * into retained shares when the float runs short. The engine behind a gradual
 * raid (buyer ≠ target) and the player's defensive buyback (buyer === target,
 * clawing the stake back from a controlling rival). Returns shares transferred.
 */
export const forceBuy = (g: GameState, buyer: Airline, target: Airline, count: number): number =>
  transferShares(g, buyer, target, count, true);

/** The largest block (≤ `max`) of `target` that `buyer` can force-buy out of
 *  cash on hand, with its cost. {count:0} if even one share is unaffordable. */
export function affordableForce(
  g: GameState,
  buyer: Airline,
  target: Airline,
  max: number,
): { count: number; cost: number } {
  const owned = sharesOwned(target, buyer.id);
  let n = Math.min(max, TOTAL_SHARES - owned);
  while (n > 0) {
    const cost = costToAccumulate(g, target, owned, n, true);
    if (cost <= buyer.cash) return { count: n, cost };
    n--;
  }
  return { count: 0, cost: 0 };
}
