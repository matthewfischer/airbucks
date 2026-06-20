import type { Airline, GameState, Negotiation } from './types';
import {
  airportById,
  equity,
  eraScale,
  fleetValue,
  money,
  playerNews,
  rightsFee,
  weeklyTotals,
} from './engine';

// An airline fails slowly, on purpose — the all-day pacing means consolidation
// should take game-decades, not weeks. Two independent triggers:
//   • cash underwater for 8 weeks (an ordinary cash crunch), or
//   • equity underwater for 2 years (the slow zombie: solvent cash flow, but
//     borrowed far past asset value — a long window so an honest overexpander
//     digging its way back out isn't killed mid-recovery).
const CASH_DISTRESS_DAYS = 8 * 7;
const EQUITY_DISTRESS_DAYS = 2 * 365;
/** How long a distressed airline sits on the block before it liquidates. */
const FOR_SALE_DAYS = 60;
/** Distress haircut on book value — a fire-sale sticker. */
const DISTRESS_DISCOUNT = 0.5;
/** Sticker price never drops below this (era-scaled) floor. */
const MIN_PRICE = 100_000;
/** Years of profit paid as goodwill when buying a healthy, going-concern airline. */
const GOODWILL_YEARS = 2;
/** Takeover premium over fair value for a healthy airline — control of a going
 *  concern doesn't sell at list price (Coke can't buy Pepsi for book). */
const CONTROL_PREMIUM = 1.3;

/** Nominal cost to acquire the held slots today — a proxy for "slot fees paid". */
export function slotInvestment(g: GameState, al: Airline): number {
  return al.rights.reduce((s, id) => s + rightsFee(g, airportById(g, id)), 0);
}

/**
 * Sticker price for a distressed airline: discounted book value (fleet resale +
 * slot investment − debt), floored. Often the floor — and the buyer still
 * assumes the debt, so a cheap sticker can hide a heavy liability.
 */
export function acquisitionPrice(g: GameState, t: Airline): number {
  const book = fleetValue(g, t) + slotInvestment(g, t) - t.debt;
  return Math.max(Math.round(MIN_PRICE * eraScale(g)), Math.round(book * DISTRESS_DISCOUNT));
}

/**
 * Price to buy a healthy, going-concern airline. Fair value is its net worth
 * plus the replacement cost of its slot portfolio (the city rights you capture —
 * the real prize) plus goodwill for its earnings; on top of that a control
 * premium, because a profitable airline's owners don't sell at list price.
 * No fire-sale discount — they aren't desperate. The buyer also inherits its
 * cash and assumes its debt. Floored.
 */
export function marketPrice(g: GameState, t: Airline): number {
  const annualNet = weeklyTotals(g, t).net * 52;
  const goodwill = Math.max(0, annualNet) * GOODWILL_YEARS;
  const fairValue = equity(g, t) + slotInvestment(g, t) + goodwill;
  return Math.max(Math.round(MIN_PRICE * eraScale(g)), Math.round(fairValue * CONTROL_PREMIUM));
}

/** What it costs to buy `t` right now: the fire-sale ask if distressed, else market. */
export const buyoutPrice = (g: GameState, t: Airline): number =>
  t.forSale ? t.forSale.price : marketPrice(g, t);

export const isForSale = (al: Airline): boolean => al.forSale !== undefined;

/** Airlines currently on the block (excludes the player). */
export const forSaleAirlines = (g: GameState): Airline[] =>
  g.airlines.filter((al) => al.ai && al.forSale);

/** Remove an airline from the game. Never removes the player (index 0). */
function removeAirline(g: GameState, al: Airline): void {
  const i = g.airlines.indexOf(al);
  if (i > 0) g.airlines.splice(i, 1);
}

/**
 * Hand an airline's whole business to `buyer` and dissolve it. The buyer pays
 * the sticker, inherits its cash, assumes its debt, and takes its rights
 * (duplicates collapse), fleet (mileage intact), and routes (planes stay
 * assigned). Works for a distressed listing or a healthy going concern.
 *
 * The target's in-progress slot negotiations carry over as-is (fees already
 * paid, opening days intact). Where the buyer was chasing the same airport, the
 * earlier-opening application wins; any whose slot the buyer already holds are
 * dropped.
 */
/**
 * Merge `target`'s whole business into `buyer` and dissolve it — inherit its
 * cash, assume its debt, take rights (duplicates collapse), fleet (mileage
 * intact), and routes (planes stay assigned). The target's in-progress slot
 * negotiations carry over as-is; where the buyer was chasing the same airport
 * the earlier-opening application wins, and any whose slot the buyer already
 * holds are dropped.
 *
 * Charges NO acquisition price — the caller has already paid (the distress
 * sticker in `acquire`, or share purchases + squeeze-out for a takeover).
 */
export function mergeInto(g: GameState, buyer: Airline, target: Airline): void {
  buyer.cash += target.cash; // inherit the bank account
  buyer.debt += target.debt;
  for (const id of target.rights) if (!buyer.rights.includes(id)) buyer.rights.push(id);
  buyer.fleet.push(...target.fleet);
  buyer.routes.push(...target.routes);
  buyer.acquisitions = (buyer.acquisitions ?? 0) + 1;
  const pending = new Map<string, Negotiation>();
  for (const n of [...buyer.negotiations, ...target.negotiations]) {
    if (buyer.rights.includes(n.airportId)) continue;
    const cur = pending.get(n.airportId);
    if (!cur || n.opensDay < cur.opensDay) pending.set(n.airportId, n);
  }
  buyer.negotiations = [...pending.values()];
  removeAirline(g, target);
}

/**
 * Buy an airline outright at its sticker price and absorb it — the distressed
 * fire-sale / instant-buyout path. Pays `buyoutPrice`, then merges via
 * `mergeInto`. (The share market reaches the same merge via a squeeze-out.)
 */
export function acquire(g: GameState, buyer: Airline, target: Airline): void {
  const price = buyoutPrice(g, target);
  const cities = target.rights.length;
  const debtNote = target.debt > 0 ? `, assuming ${money(target.debt)} debt` : '';
  buyer.cash -= price; // pay the sticker; cash/debt inheritance handled in mergeInto
  mergeInto(g, buyer, target);
  playerNews(
    g,
    `🤝 ${buyer.name} acquired ${target.name} for ${money(price)} — ${cities} cities${debtNote}.`,
  );
}

/** List a failing airline for sale and announce it. */
function list(g: GameState, al: Airline): void {
  const price = acquisitionPrice(g, al);
  al.forSale = { listedDay: g.day, deadlineDay: g.day + FOR_SALE_DAYS, price };
  al.cashNegSince = undefined;
  al.equityNegSince = undefined;
  playerNews(g, `⚠ ${al.name} is in distress — up for sale at ${money(price)} (assumes its debt).`);
}

/** Liquidate an unsold airline; its slots return to the pool. */
function liquidate(g: GameState, al: Airline): void {
  removeAirline(g, al);
  playerNews(g, `💥 ${al.name} has gone bankrupt and ceased operations — its slots are free again.`);
}

/**
 * Weekly distress sweep over the AI airlines: advance the cash/equity streaks,
 * list anyone who has failed long enough, and liquidate any for-sale airline
 * whose countdown has run out. Acquisitions happen in the AI decision pass.
 */
export function updateDistress(g: GameState): void {
  if (g.day % 7 !== 0) return;
  for (const al of [...g.airlines]) {
    if (!al.ai) continue;
    if (al.forSale) {
      if (g.day >= al.forSale.deadlineDay) liquidate(g, al);
      continue;
    }
    // Cash crunch: short fuse.
    if (al.cash < 0) {
      al.cashNegSince ??= g.day;
      if (g.day - al.cashNegSince >= CASH_DISTRESS_DAYS) {
        list(g, al);
        continue;
      }
    } else {
      al.cashNegSince = undefined;
    }
    // Insolvency: long fuse.
    if (equity(g, al) < 0) {
      al.equityNegSince ??= g.day;
      if (g.day - al.equityNegSince >= EQUITY_DISTRESS_DAYS) {
        list(g, al);
        continue;
      }
    } else {
      al.equityNegSince = undefined;
    }
  }
}
