import { beforeEach, describe, expect, it } from 'vitest';
import type { GameState } from './types';
import { AIRCRAFT_TYPES, AIRPORTS, STARTING_CASH } from './data';
import {
  advanceDay,
  assignPlane,
  baseDemand,
  borrow,
  buyPlane,
  closeRoute,
  evaluateRoute,
  LOAN_ANNUAL_RATE,
  LOAN_LIMIT,
  money,
  newGame,
  openRoute,
  planesOnRoute,
  referenceFare,
  repay,
  routeDistance,
  setFare,
  tripsPerWeek,
  weeklyTotals,
  weekNumber,
} from './engine';

const TURBOPROP = AIRCRAFT_TYPES.find((t) => t.id === 'turboprop')!;
const JET = AIRCRAFT_TYPES.find((t) => t.id === 'regionaljet')!;

/** Convenience: the most recently created route / plane. */
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

describe('referenceFare & baseDemand', () => {
  it('reference fare grows with distance', () => {
    expect(referenceFare(0)).toBe(40);
    expect(referenceFare(1000)).toBe(120);
    expect(referenceFare(500)).toBeLessThan(referenceFare(1500));
  });

  it('base demand is the product of market sizes times 90', () => {
    openRoute(g, 'crw', 'clt'); // sizes 1 and 5
    expect(baseDemand(g, lastRoute(g))).toBe(1 * 5 * 90);
  });
});

describe('tripsPerWeek', () => {
  it('a faster aircraft flies more weekly trips on the same route', () => {
    expect(tripsPerWeek(JET, 400)).toBeGreaterThan(tripsPerWeek(TURBOPROP, 400));
  });

  it('always allows at least one trip, even for very long routes', () => {
    expect(tripsPerWeek(TURBOPROP, 100_000)).toBe(1);
  });
});

describe('buyPlane', () => {
  it('deducts the price and adds an idle plane', () => {
    const err = buyPlane(g, 'turboprop');
    expect(err).toBeNull();
    expect(g.fleet).toHaveLength(1);
    expect(lastPlane(g).routeId).toBeNull();
    expect(g.cash).toBe(STARTING_CASH - TURBOPROP.price);
  });

  it('refuses when there is not enough cash', () => {
    g.cash = 1_000_000;
    const err = buyPlane(g, 'cityjet');
    expect(err).toMatch(/not enough cash/i);
    expect(g.fleet).toHaveLength(0);
    expect(g.cash).toBe(1_000_000);
  });
});

describe('openRoute', () => {
  it('creates a route with the reference fare as default', () => {
    expect(openRoute(g, 'crw', 'clt')).toBeNull();
    const r = lastRoute(g);
    expect(r.fare).toBe(referenceFare(routeDistance(g, r)));
  });

  it('rejects a route between an airport and itself', () => {
    expect(openRoute(g, 'crw', 'crw')).toMatch(/different/i);
    expect(g.routes).toHaveLength(0);
  });

  it('rejects a duplicate route in either direction', () => {
    openRoute(g, 'crw', 'clt');
    expect(openRoute(g, 'crw', 'clt')).toMatch(/already exists/i);
    expect(openRoute(g, 'clt', 'crw')).toMatch(/already exists/i);
    expect(g.routes).toHaveLength(1);
  });
});

describe('assignPlane', () => {
  it('assigns a plane to a route it can reach', () => {
    buyPlane(g, 'turboprop');
    openRoute(g, 'crw', 'clt');
    expect(assignPlane(g, lastPlane(g).id, lastRoute(g).id)).toBeNull();
    expect(planesOnRoute(g, lastRoute(g).id)).toHaveLength(1);
  });

  it('refuses a route beyond the aircraft range', () => {
    const custom: GameState = {
      ...newGame(),
      aircraftTypes: [{ ...TURBOPROP, id: 'shorty', range: 100 }],
      fleet: [{ id: 'p1', typeId: 'shorty', routeId: null }],
      routes: [{ id: 'r1', fromId: 'crw', toId: 'clt', fare: 50 }],
    };
    expect(assignPlane(custom, 'p1', 'r1')).toMatch(/can't reach/i);
    expect(custom.fleet[0].routeId).toBeNull();
  });

  it('always allows returning a plane to the hangar', () => {
    buyPlane(g, 'turboprop');
    openRoute(g, 'crw', 'clt');
    assignPlane(g, lastPlane(g).id, lastRoute(g).id);
    expect(assignPlane(g, lastPlane(g).id, null)).toBeNull();
    expect(lastPlane(g).routeId).toBeNull();
  });
});

describe('closeRoute', () => {
  it('removes the route and frees its planes back to the hangar', () => {
    buyPlane(g, 'turboprop');
    openRoute(g, 'crw', 'clt');
    const routeId = lastRoute(g).id;
    assignPlane(g, lastPlane(g).id, routeId);

    closeRoute(g, routeId);
    expect(g.routes).toHaveLength(0);
    expect(lastPlane(g).routeId).toBeNull();
  });
});

describe('evaluateRoute', () => {
  function withRoute(planeType?: string) {
    openRoute(g, 'clt', 'dca'); // big trunk market
    const route = lastRoute(g);
    if (planeType) {
      buyPlane(g, planeType);
      assignPlane(g, lastPlane(g).id, route.id);
    }
    return route;
  }

  it('carries no passengers and turns no profit with no planes', () => {
    const route = withRoute();
    const r = evaluateRoute(g, route);
    expect(r.passengers).toBe(0);
    expect(r.revenue).toBe(0);
    expect(r.profit).toBe(0);
    expect(r.demand).toBeGreaterThan(0); // latent demand still exists
  });

  it('carries the lesser of demand and offered seats', () => {
    const route = withRoute('turboprop');
    const r = evaluateRoute(g, route);
    expect(r.passengers).toBe(Math.min(r.demand, r.seatsOffered));
  });

  it('demand falls as fare rises (price elasticity)', () => {
    const route = withRoute();
    setFare(g, route.id, 40);
    const cheap = evaluateRoute(g, route).demand;
    setFare(g, route.id, 400);
    const dear = evaluateRoute(g, route).demand;
    expect(cheap).toBeGreaterThan(dear);
  });

  it('a faster fleet earns a fare premium and draws more demand at equal fare', () => {
    const route = withRoute('turboprop');
    const slow = evaluateRoute(g, route);

    // Swap the turboprop for a jet on the same route at the same fare.
    assignPlane(g, lastPlane(g).id, null);
    buyPlane(g, 'regionaljet');
    assignPlane(g, lastPlane(g).id, route.id);
    const fast = evaluateRoute(g, route);

    // Turboprop (540/700 ≈ 0.77) sits below the 0.85 floor, so it clamps.
    expect(slow.speedPremium).toBeCloseTo(0.85, 2);
    expect(fast.speedPremium).toBeCloseTo(JET.speed / 700, 2);
    expect(fast.speedPremium).toBeGreaterThan(slow.speedPremium);
    expect(fast.demand).toBeGreaterThan(slow.demand);
  });
});

describe('weeklyTotals & advanceDay', () => {
  it('charges upkeep for idle planes', () => {
    buyPlane(g, 'turboprop'); // idle in hangar
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
    buyPlane(g, 'turboprop'); // pure upkeep cost, no revenue
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
    const took = borrow(g, 20_000_000);
    expect(took).toBe(20_000_000);
    expect(g.debt).toBe(20_000_000);
    expect(g.cash).toBe(STARTING_CASH + 20_000_000);
  });

  it('caps borrowing at the remaining credit line', () => {
    borrow(g, LOAN_LIMIT);
    expect(g.debt).toBe(LOAN_LIMIT);
    expect(borrow(g, 5_000_000)).toBe(0); // already maxed out
    expect(g.debt).toBe(LOAN_LIMIT);
  });

  it('repaying cannot exceed debt or available cash', () => {
    borrow(g, 20_000_000);
    g.cash = 5_000_000; // less than the debt
    const paid = repay(g, 20_000_000);
    expect(paid).toBe(5_000_000);
    expect(g.cash).toBe(0);
    expect(g.debt).toBe(15_000_000);
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
