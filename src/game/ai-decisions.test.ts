import { beforeEach, describe, expect, it } from 'vitest';
import type { Airline, GameState } from './types';
import {
  acquisitionActions,
  addAiAirlines,
  newRouteCandidates,
  PERSONALITIES,
  reallocateActions,
  repayActions,
  retrenchActions,
  slotActions,
} from './ai';
import type { NewRoute } from './ai';
import {
  airportById,
  assignPlane,
  buyPlane,
  creditLimit,
  equity,
  evaluateNetwork,
  newAirline,
  newGame,
  openRoute,
  typeById,
} from './engine';

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

  it('takes over a healthy rival through the share market, not only the distressed', () => {
    // g.airlines[2] exists but is not for sale — a going concern captured via a
    // hostile share takeover (it has no float, so the bid forces retained shares).
    const target = g.airlines[2];
    const actions = acquisitionActions(g, al, HUB);
    expect(actions).toHaveLength(1);

    actions[0].run();
    expect(g.airlines).not.toContain(target); // reached control + squeezed out + merged
    expect(al.acquisitions).toBeGreaterThanOrEqual(1);
  });

  it('skips a healthy takeover it cannot finance (the share-price brake)', () => {
    al.cash = 100_000; // tiny — a hostile takeover priced on a growth-aware
    al.debt = 0; //       valuation is far out of reach, even with credit
    expect(acquisitionActions(g, al, HUB)).toHaveLength(0);
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

  it('still grabs a fire-sale during the integration cooldown', () => {
    al.lastAcquireDay = g.day; // mid-integration of a prior deal
    const target = listRival(1_000_000);
    const actions = acquisitionActions(g, al, HUB);
    expect(actions).toHaveLength(1); // the rescue grab is exempt from the cooldown
    actions[0].run();
    expect(g.airlines).not.toContain(target);
  });

  it('still refuses a healthy takeover during the integration cooldown', () => {
    al.lastAcquireDay = g.day; // mid-integration — g.airlines[2] is a going concern
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

describe('reallocateActions', () => {
  /** A solvent buyer at ATL flying a thin ATL↔BNA route, plus a held JFK slot
   *  the freed plane could redeploy to. Returns the live route id. */
  function withThinRoute(): { buyer: Airline; routeId: string } {
    const buyer = newAirline('ai-z', 'Reallocator', '#fff', 'atl');
    buyer.ai = { personality: 'hub-builder', nextDecisionDay: 0 };
    buyer.cash = 100_000_000;
    buyer.rights = ['atl', 'bna', 'jfk'];
    g.airlines.push(buyer);
    buyPlane(g, buyer, 'dc3');
    const planeId = buyer.fleet[buyer.fleet.length - 1].id;
    openRoute(g, buyer, ['atl', 'bna']);
    const routeId = buyer.routes[buyer.routes.length - 1].id;
    assignPlane(g, buyer, planeId, routeId);
    return { buyer, routeId };
  }

  /** A fabricated new-route candidate to JFK with a chosen marginal value. */
  const jfkCandidate = (marginal: number): NewRoute => ({
    stops: ['atl', 'jfk'],
    a: airportById(g, 'atl'),
    b: airportById(g, 'jfk'),
    type: typeById(g, 'dc3'),
    marginal,
  });

  it('swaps a mediocre route for a clearly better alternative', () => {
    const { buyer, routeId } = withThinRoute();
    const net = evaluateNetwork(g, buyer);
    expect(net.routes.get(routeId)!.profit).toBeGreaterThan(0); // weak but positive
    const actions = reallocateActions(g, buyer, HUB, net, net.profit, [jfkCandidate(1e9)]);
    expect(actions).toHaveLength(1);

    actions[0].run();
    expect(buyer.routes.some((r) => r.stops.includes('bna'))).toBe(false); // weak closed
    expect(buyer.routes.some((r) => r.stops.includes('jfk'))).toBe(true); // alt opened
  });

  it('does not swap when the alternative fails the hysteresis margin', () => {
    const { buyer } = withThinRoute();
    const net = evaluateNetwork(g, buyer);
    // A barely-better alternative shouldn't trigger churn.
    expect(reallocateActions(g, buyer, HUB, net, net.profit, [jfkCandidate(1)])).toHaveLength(0);
  });

  it('does nothing with no alternative or no profitable route to free up', () => {
    const { buyer } = withThinRoute();
    const net = evaluateNetwork(g, buyer);
    expect(reallocateActions(g, buyer, HUB, net, net.profit, [])).toHaveLength(0);

    const idle = newAirline('ai-i', 'Idle Air', '#000', 'atl');
    g.airlines.push(idle);
    const inet = evaluateNetwork(g, idle);
    expect(reallocateActions(g, idle, HUB, inet, inet.profit, [jfkCandidate(1e9)])).toHaveLength(0);
  });
});

describe('newRouteCandidates', () => {
  /** An AI holding a hub plus a cluster of nearby small cities. */
  function clusterAirline(): Airline {
    const buyer = newAirline('ai-c', 'Chainer', '#fff', 'atl');
    buyer.ai = { personality: 'hub-builder', nextDecisionDay: 0 };
    buyer.cash = 100_000_000;
    buyer.rights = ['atl', 'tys', 'chs', 'gso']; // ATL ringed by small SE cities
    g.airlines.push(buyer);
    return buyer;
  }

  it('proposes multi-stop chains, not only point-to-point pairs', () => {
    const buyer = clusterAirline();
    const cands = newRouteCandidates(g, buyer, HUB, 0, buyer.cash);
    expect(cands.some((c) => c.stops.length >= 3)).toBe(true);
  });

  it('every candidate carries a runnable path of held airports', () => {
    const buyer = clusterAirline();
    for (const c of newRouteCandidates(g, buyer, HUB, 0, buyer.cash)) {
      expect(c.stops.length).toBeGreaterThanOrEqual(2);
      expect(c.stops.every((id) => buyer.rights.includes(id))).toBe(true);
      expect(c.stops[0]).toBe(c.a.id);
      expect(c.stops[c.stops.length - 1]).toBe(c.b.id);
    }
  });
});

describe('slotActions', () => {
  /** A carrier at TYS holding `held` spoke cities, each already flown so no
   *  unserved-rights penalty skews the slot discount. */
  function carrier(id: string, held: string[]): Airline {
    const a = newAirline(id, id, '#fff', 'tys');
    a.ai = { personality: 'hub-builder', nextDecisionDay: 0 };
    a.cash = 500_000_000;
    a.rights = ['tys', ...held];
    for (const c of held) openRoute(g, a, ['tys', c]);
    g.airlines.push(a);
    return a;
  }

  const topScore = (al: Airline) =>
    slotActions(g, al, HUB).reduce((m, x) => Math.max(m, x.score), 0);

  it('wants a hub slot more when it opens routes to several held cities', () => {
    // A slot is worth the sum of the markets it unlocks, not just the best one:
    // a carrier ringed by a cluster should covet its next hub more than a carrier
    // holding a lone spoke, even with the per-route discount held equal.
    const cluster = carrier('c', ['chs', 'gso']);
    const spoke = carrier('s', ['chs']);
    expect(topScore(cluster)).toBeGreaterThan(topScore(spoke));
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
