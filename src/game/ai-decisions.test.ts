import { beforeEach, describe, expect, it } from 'vitest';
import type { Airline, GameState } from './types';
import {
  acquisitionActions,
  addAiAirlines,
  PERSONALITIES,
  repayActions,
  retrenchActions,
} from './ai';
import { assignPlane, buyPlane, creditLimit, equity, newGame, openRoute } from './engine';

const HUB = PERSONALITIES[0]; // debtAppetite 0.5, the workhorse personality

let g: GameState;
let al: Airline; // the AI we drive in each scenario
beforeEach(() => {
  g = newGame('crw', 11);
  addAiAirlines(g, 2);
  al = g.airlines[1];
  al.rights = [al.homeId];
  al.cash = 50_000_000;
  al.debt = 0;
});

describe('acquisitionActions', () => {
  /** List a rival for sale at the given price/debt and return it. */
  function listRival(price: number, debt = 0): Airline {
    const target = g.airlines[2];
    target.forSale = { listedDay: g.day, deadlineDay: g.day + 30, price };
    target.debt = debt;
    return target;
  }

  it('bids on an affordable, debt-light target and the bid acquires it', () => {
    const target = listRival(1_000_000);
    const actions = acquisitionActions(g, al, HUB);
    expect(actions).toHaveLength(1);

    actions[0].run();
    expect(g.airlines).not.toContain(target);
    expect(al.acquisitions).toBeGreaterThanOrEqual(1);
  });

  it('bids on a healthy rival at market price, not only the distressed', () => {
    // g.airlines[2] exists but is not for sale — a going concern.
    const target = g.airlines[2];
    const actions = acquisitionActions(g, al, HUB);
    expect(actions).toHaveLength(1);

    actions[0].run();
    expect(g.airlines).not.toContain(target);
    expect(al.acquisitions).toBeGreaterThanOrEqual(1);
  });

  it('finances a buyout with debt when cash alone is short', () => {
    al.cash = 1_000_000; // solvent, but under the sticker
    // A sticker a hair above cash, with the gap safely inside the debt appetite
    // so borrowing covers it. (A no-revenue airline has only the startup line.)
    const gap = Math.floor(HUB.debtAppetite * creditLimit(g, al) * 0.5);
    const target = listRival(al.cash + gap);
    target.cash = 0; // no inherited cash to soften the gap — force a loan
    const actions = acquisitionActions(g, al, HUB);
    expect(actions).toHaveLength(1);

    actions[0].run();
    expect(g.airlines).not.toContain(target);
    expect(al.debt).toBeGreaterThan(0); // it borrowed to cover the gap
  });

  it('does not bid when it cannot finance the sticker even with debt', () => {
    listRival(10_000_000_000); // beyond cash + the whole credit line
    expect(acquisitionActions(g, al, HUB)).toHaveLength(0);
  });

  it('never targets the human player', () => {
    g.airlines.splice(2, 1); // remove the rival, leaving only player + buyer
    expect(acquisitionActions(g, al, HUB)).toHaveLength(0);
  });

  it('does not bid while insolvent', () => {
    listRival(1_000_000);
    al.debt = al.cash + 10_000_000; // equity now negative
    expect(equity(g, al)).toBeLessThan(0);
    expect(acquisitionActions(g, al, HUB)).toHaveLength(0);
  });

  it('does not bid when carrying the target would breach its debt appetite', () => {
    const overLeveraged = HUB.debtAppetite * creditLimit(g, al) + 1;
    listRival(1_000_000, overLeveraged);
    expect(acquisitionActions(g, al, HUB)).toHaveLength(0);
  });
});

describe('repayActions', () => {
  it('stays quiet with no debt', () => {
    expect(repayActions(g, al, HUB)).toHaveLength(0);
  });

  it('stays quiet when broke, even carrying debt', () => {
    al.debt = 5_000_000;
    al.cash = 0;
    expect(repayActions(g, al, HUB)).toHaveLength(0);
  });

  it('stays quiet while debt sits within appetite', () => {
    al.debt = Math.floor(HUB.debtAppetite * creditLimit(g, al)) - 1;
    expect(repayActions(g, al, HUB)).toHaveLength(0);
  });

  it('pays down debt that runs past appetite', () => {
    al.debt = Math.ceil(HUB.debtAppetite * creditLimit(g, al)) + 100_000;
    const before = al.debt;
    const actions = repayActions(g, al, HUB);
    expect(actions).toHaveLength(1);

    actions[0].run();
    expect(al.debt).toBeLessThan(before);
  });
});

describe('retrenchActions', () => {
  it('sells idle planes to stop the upkeep bleed', () => {
    buyPlane(g, al, 'dc3');
    expect(al.fleet).toHaveLength(1);

    const actions = retrenchActions(g, al);
    expect(actions.length).toBeGreaterThanOrEqual(1);
    for (const a of actions) a.run();
    expect(al.fleet).toHaveLength(0);
  });

  it('sells off a slot no route uses', () => {
    al.rights = [al.homeId, 'jfk']; // JFK held but unflown
    const actions = retrenchActions(g, al);

    for (const a of actions) a.run();
    expect(al.rights).not.toContain('jfk');
    expect(al.rights).toContain(al.homeId); // never sheds the home base
  });

  it('keeps a slot that a route actually flies', () => {
    al.rights = [al.homeId, 'jfk'];
    openRoute(g, al, [al.homeId, 'jfk']);
    const actions = retrenchActions(g, al);

    for (const a of actions) a.run();
    expect(al.rights).toContain('jfk');
  });

  it('closes a route that bleeds real money, scrapping the planes on it', () => {
    g.day = 365 * 75 + 19; // 2025, so the jumbo below is in service
    al.cash = 1_000_000_000;
    // A jumbo on a thin short hop: huge upkeep, a trickle of revenue.
    al.rights = [al.homeId, 'jfk'];
    openRoute(g, al, [al.homeId, 'jfk']);
    const route = al.routes[0];
    buyPlane(g, al, 'b787');
    assignPlane(g, al, al.fleet[0].id, route.id);

    const actions = retrenchActions(g, al);
    for (const a of actions) a.run();
    expect(al.routes).toHaveLength(0);
    expect(al.fleet).toHaveLength(0); // the route's plane was sold off
  });
});
