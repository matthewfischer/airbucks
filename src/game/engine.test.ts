import { beforeEach, describe, expect, it } from 'vitest';
import type { GameState } from './types';
import { AIRCRAFT_TYPES, AIRPORTS, STARTING_CASH } from './data';
import {
  advanceDay,
  airportById,
  assignPlane,
  borrow,
  buyPlane,
  closeRoute,
  evaluateRoute,
  LOAN_ANNUAL_RATE,
  LOAN_LIMIT,
  money,
  newGame,
  openRoute,
  pairDemand,
  planesOnRoute,
  referenceFare,
  repay,
  routeDistance,
  routeLegs,
  routeMaxLeg,
  setFareFactor,
  tripsPerWeek,
  weeklyTotals,
  weekNumber,
} from './engine';

const TURBOPROP = AIRCRAFT_TYPES.find((t) => t.id === 'turboprop')!;
const JET = AIRCRAFT_TYPES.find((t) => t.id === 'regionaljet')!;

const lastRoute = (g: GameState) => g.routes[g.routes.length - 1];
const lastPlane = (g: GameState) => g.fleet[g.fleet.length - 1];

let g: GameState;
beforeEach(() => {
  g = newGame();
});

describe('newGame', () => {
  it('starts on day 0 with the starting cash and no debt/fleet/routes', () => {
    expect(g.day).toBe(0);
    expect(g.cash).toBe(STARTING_CASH);
    expect(g.debt).toBe(0);
    expect(g.fleet).toEqual([]);
    expect(g.routes).toEqual([]);
  });
});

describe('referenceFare & pairDemand', () => {
  it('reference fare grows with distance', () => {
    expect(referenceFare(0)).toBe(40);
    expect(referenceFare(1000)).toBe(120);
    expect(referenceFare(500)).toBeLessThan(referenceFare(1500));
  });

  it('pair demand is the product of market sizes times 90', () => {
    const crw = airportById(g, 'crw'); // size 1
    const clt = airportById(g, 'clt'); // size 5
    expect(pairDemand(crw, clt)).toBe(1 * 5 * 90);
  });
});

describe('tripsPerWeek', () => {
  it('a faster aircraft flies more weekly circuits on the same path', () => {
    expect(tripsPerWeek(JET, 400, 1)).toBeGreaterThan(tripsPerWeek(TURBOPROP, 400, 1));
  });

  it('more stops (more turnarounds) reduce weekly circuits', () => {
    expect(tripsPerWeek(JET, 800, 1)).toBeGreaterThan(tripsPerWeek(JET, 800, 4));
  });

  it('always allows at least one circuit, even for very long paths', () => {
    expect(tripsPerWeek(TURBOPROP, 100_000, 1)).toBe(1);
  });
});

describe('buyPlane', () => {
  it('deducts the price and adds an idle plane', () => {
    expect(buyPlane(g, 'turboprop')).toBeNull();
    expect(g.fleet).toHaveLength(1);
    expect(lastPlane(g).routeId).toBeNull();
    expect(g.cash).toBe(STARTING_CASH - TURBOPROP.price);
  });

  it('refuses when there is not enough cash', () => {
    g.cash = 1_000_000;
    expect(buyPlane(g, 'cityjet')).toMatch(/not enough cash/i);
    expect(g.fleet).toHaveLength(0);
  });
});

describe('openRoute', () => {
  it('creates a route with a default 100% fare factor', () => {
    expect(openRoute(g, ['crw', 'clt'])).toBeNull();
    expect(lastRoute(g).stops).toEqual(['crw', 'clt']);
    expect(lastRoute(g).fareFactor).toBe(1);
  });

  it('supports multi-stop paths', () => {
    expect(openRoute(g, ['crw', 'clt', 'dca'])).toBeNull();
    const legs = routeLegs(g, lastRoute(g));
    expect(legs.map((l) => [l.fromId, l.toId])).toEqual([
      ['crw', 'clt'],
      ['clt', 'dca'],
    ]);
  });

  it('requires at least two stops', () => {
    expect(openRoute(g, ['crw'])).toMatch(/at least two/i);
    expect(g.routes).toHaveLength(0);
  });

  it('rejects consecutive duplicate stops', () => {
    expect(openRoute(g, ['crw', 'crw'])).toMatch(/same airport/i);
  });

  it('rejects a duplicate route in either direction', () => {
    openRoute(g, ['crw', 'clt', 'dca']);
    expect(openRoute(g, ['crw', 'clt', 'dca'])).toMatch(/already exists/i);
    expect(openRoute(g, ['dca', 'clt', 'crw'])).toMatch(/already exists/i);
    expect(g.routes).toHaveLength(1);
  });
});

describe('routeDistance & routeMaxLeg', () => {
  it('routeDistance is the sum of leg distances; routeMaxLeg is the longest', () => {
    openRoute(g, ['crw', 'clt', 'dca']);
    const r = lastRoute(g);
    const legs = routeLegs(g, r);
    expect(routeDistance(g, r)).toBe(legs[0].distance + legs[1].distance);
    expect(routeMaxLeg(g, r)).toBe(Math.max(legs[0].distance, legs[1].distance));
  });
});

describe('assignPlane', () => {
  it('assigns a plane to a route it can reach', () => {
    buyPlane(g, 'turboprop');
    openRoute(g, ['crw', 'clt']);
    expect(assignPlane(g, lastPlane(g).id, lastRoute(g).id)).toBeNull();
    expect(planesOnRoute(g, lastRoute(g).id)).toHaveLength(1);
  });

  it('refuses when the longest leg exceeds the aircraft range', () => {
    const custom: GameState = {
      ...newGame(),
      aircraftTypes: [{ ...TURBOPROP, id: 'shorty', range: 100 }],
      fleet: [{ id: 'p1', typeId: 'shorty', routeId: null }],
      routes: [{ id: 'r1', stops: ['crw', 'clt'], fareFactor: 1 }],
    };
    expect(assignPlane(custom, 'p1', 'r1')).toMatch(/can't reach/i);
    expect(custom.fleet[0].routeId).toBeNull();
  });

  it('always allows returning a plane to the hangar', () => {
    buyPlane(g, 'turboprop');
    openRoute(g, ['crw', 'clt']);
    assignPlane(g, lastPlane(g).id, lastRoute(g).id);
    expect(assignPlane(g, lastPlane(g).id, null)).toBeNull();
    expect(lastPlane(g).routeId).toBeNull();
  });
});

describe('closeRoute', () => {
  it('removes the route and frees its planes back to the hangar', () => {
    buyPlane(g, 'turboprop');
    openRoute(g, ['crw', 'clt']);
    const routeId = lastRoute(g).id;
    assignPlane(g, lastPlane(g).id, routeId);

    closeRoute(g, routeId);
    expect(g.routes).toHaveLength(0);
    expect(lastPlane(g).routeId).toBeNull();
  });
});

describe('evaluateRoute', () => {
  function withRoute(stops: string[], planeType?: string) {
    openRoute(g, stops);
    const route = lastRoute(g);
    if (planeType) {
      buyPlane(g, planeType);
      assignPlane(g, lastPlane(g).id, route.id);
    }
    return route;
  }

  it('carries no passengers and turns no profit with no planes', () => {
    const route = withRoute(['clt', 'dca']);
    const r = evaluateRoute(g, route);
    expect(r.passengers).toBe(0);
    expect(r.revenue).toBe(0);
    expect(r.profit).toBe(0);
    expect(r.demand).toBeGreaterThan(0);
  });

  it('carries the lesser of demand and offered seats (single leg)', () => {
    const route = withRoute(['clt', 'dca'], 'turboprop');
    const r = evaluateRoute(g, route);
    expect(r.passengers).toBeCloseTo(Math.min(r.demand, r.seatsOffered), 5);
  });

  it('a multi-stop route aggregates demand across all legs', () => {
    const route = withRoute(['crw', 'clt', 'dca']);
    const r = evaluateRoute(g, route);
    const crw = airportById(g, 'crw');
    const clt = airportById(g, 'clt');
    const dca = airportById(g, 'dca');
    // No planes => demand multiplier 1, so demand is the raw pair sum.
    expect(r.demand).toBe(pairDemand(crw, clt) + pairDemand(clt, dca));
  });

  it('demand falls as the fare factor rises (price elasticity)', () => {
    const route = withRoute(['clt', 'dca']);
    setFareFactor(g, route.id, 0.5);
    const cheap = evaluateRoute(g, route).demand;
    setFareFactor(g, route.id, 2.5);
    const dear = evaluateRoute(g, route).demand;
    expect(cheap).toBeGreaterThan(dear);
  });

  it('a faster fleet earns a fare premium and draws more demand', () => {
    const route = withRoute(['clt', 'dca'], 'turboprop');
    const slow = evaluateRoute(g, route);

    assignPlane(g, lastPlane(g).id, null);
    buyPlane(g, 'regionaljet');
    assignPlane(g, lastPlane(g).id, route.id);
    const fast = evaluateRoute(g, route);

    expect(slow.speedPremium).toBeCloseTo(0.85, 2); // turboprop clamps to the floor
    expect(fast.speedPremium).toBeCloseTo(JET.speed / 700, 2);
    expect(fast.demand).toBeGreaterThan(slow.demand);
  });
});

describe('weeklyTotals & advanceDay', () => {
  it('charges upkeep for idle planes', () => {
    buyPlane(g, 'turboprop');
    expect(weeklyTotals(g).cost).toBe(TURBOPROP.weeklyUpkeep);
  });

  it('includes weekly interest on outstanding debt', () => {
    g.debt = 10_000_000;
    expect(weeklyTotals(g).interest).toBeCloseTo(
      10_000_000 * LOAN_ANNUAL_RATE * (7 / 365),
      5,
    );
  });

  it('advanceDay accrues one seventh of the weekly net and ticks the day', () => {
    buyPlane(g, 'turboprop');
    const before = g.cash;
    const net = weeklyTotals(g).net;
    advanceDay(g);
    expect(g.day).toBe(1);
    expect(g.cash).toBeCloseTo(before + net / 7, 5);
  });

  it('weekNumber rolls over every 7 days', () => {
    expect(weekNumber(g)).toBe(1);
    g.day = 6;
    expect(weekNumber(g)).toBe(1);
    g.day = 7;
    expect(weekNumber(g)).toBe(2);
  });
});

describe('loans', () => {
  it('borrowing adds to cash and debt and returns the amount taken', () => {
    expect(borrow(g, 20_000_000)).toBe(20_000_000);
    expect(g.debt).toBe(20_000_000);
    expect(g.cash).toBe(STARTING_CASH + 20_000_000);
  });

  it('caps borrowing at the remaining credit line', () => {
    borrow(g, LOAN_LIMIT);
    expect(g.debt).toBe(LOAN_LIMIT);
    expect(borrow(g, 5_000_000)).toBe(0);
    expect(g.debt).toBe(LOAN_LIMIT);
  });

  it('repaying cannot exceed debt or available cash', () => {
    borrow(g, 20_000_000);
    g.cash = 5_000_000;
    expect(repay(g, 20_000_000)).toBe(5_000_000);
    expect(g.cash).toBe(0);
    expect(g.debt).toBe(15_000_000);
  });
});

describe('setFareFactor', () => {
  it('clamps the fare factor to a sane band', () => {
    openRoute(g, ['crw', 'clt']);
    const id = lastRoute(g).id;
    setFareFactor(g, id, 99);
    expect(lastRoute(g).fareFactor).toBe(3);
    setFareFactor(g, id, 0);
    expect(lastRoute(g).fareFactor).toBe(0.2);
  });
});

describe('money formatting', () => {
  it('formats magnitudes with K / M / B suffixes', () => {
    expect(money(0)).toBe('$0');
    expect(money(750)).toBe('$750');
    expect(money(12_000)).toBe('$12K');
    expect(money(1_500_000)).toBe('$1.5M');
    expect(money(2_300_000_000)).toBe('$2.30B');
  });

  it('keeps the minus sign for negative amounts', () => {
    expect(money(-85_000_000)).toBe('-$85.0M');
  });
});

describe('airport data integrity', () => {
  it('has exactly one home base', () => {
    expect(AIRPORTS.filter((a) => a.home)).toHaveLength(1);
  });

  it('uses unique airport ids', () => {
    const ids = AIRPORTS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
