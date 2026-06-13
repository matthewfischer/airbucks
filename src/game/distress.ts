import type { Airline, GameState } from './types';
import {
  airportById,
  equity,
  eraScale,
  fleetValue,
  money,
  rightsFee,
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

/** Nominal cost to acquire the held slots today — a proxy for "slot fees paid". */
function slotInvestment(g: GameState, al: Airline): number {
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

export const isForSale = (al: Airline): boolean => al.forSale !== undefined;

/** Airlines currently on the block (excludes the player). */
export const forSaleAirlines = (g: GameState): Airline[] =>
  g.airlines.filter((al) => al.ai && al.forSale);

/** Push a news line to the player's log (airlines[0] is the player). */
function news(g: GameState, line: string): void {
  g.airlines[0]?.log.unshift(line);
}

/** Remove an airline from the game. Never removes the player (index 0). */
function removeAirline(g: GameState, al: Airline): void {
  const i = g.airlines.indexOf(al);
  if (i > 0) g.airlines.splice(i, 1);
}

/**
 * Hand a distressed airline's whole network to `buyer` and dissolve it. The
 * buyer pays the sticker, assumes the debt, and inherits rights (duplicates
 * collapse), fleet (mileage intact), and routes (planes stay assigned).
 */
export function acquire(g: GameState, buyer: Airline, target: Airline): void {
  const price = target.forSale?.price ?? acquisitionPrice(g, target);
  const cities = target.rights.length;
  buyer.cash -= price;
  buyer.debt += target.debt;
  for (const id of target.rights) if (!buyer.rights.includes(id)) buyer.rights.push(id);
  buyer.fleet.push(...target.fleet);
  buyer.routes.push(...target.routes);
  removeAirline(g, target);
  news(
    g,
    `🤝 ${buyer.name} acquired ${target.name} for ${money(price)} — ${cities} cities, ` +
      `assuming ${money(target.debt)} debt.`,
  );
}

/** List a failing airline for sale and announce it. */
function list(g: GameState, al: Airline): void {
  const price = acquisitionPrice(g, al);
  al.forSale = { listedDay: g.day, deadlineDay: g.day + FOR_SALE_DAYS, price };
  al.cashNegSince = undefined;
  al.equityNegSince = undefined;
  news(g, `⚠ ${al.name} is in distress — up for sale at ${money(price)} (assumes its debt).`);
}

/** Liquidate an unsold airline; its slots return to the pool. */
function liquidate(g: GameState, al: Airline): void {
  removeAirline(g, al);
  news(g, `💥 ${al.name} has gone bankrupt and ceased operations — its slots are free again.`);
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
