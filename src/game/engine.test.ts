import { beforeEach, describe, expect, it } from 'vitest';
import type { GameState } from './types';
import { AIRCRAFT_TYPES, AIRPORTS, STARTING_CASH } from './data';
import { distanceKm } from './geo';
import {
  advanceDay,
  airportById,
  assignPlane,
  availableTypes,
  baselineSpeed,
  borrow,
  startNegotiation,
  sellSlot,
  concurrentCap,
  negotiationDays,
  isEasySlot,
  gateFee,
  gateFeesWeekly,
  sellRefund,
  isNegotiating,
  negotiationFor,
  buyPlane,
  currentYear,
  closeRoute,
  creditLimit,
  depositRate,
  distanceFactor,
  equity,
  evaluateNetwork,
  financeMetrics,
  profitMargin,
  recordFinanceSnapshot,
  returnOnCapital,
  evaluateRoute,
  fedFundsRate,
  fleetValue,
  interestRate,
  money,
  nearestHeldAirport,
  newGame,
  openRoute,
  holdsRights,
  pairDemand,
  planesOnRoute,
  priceLevel,
  referenceFare,
  repay,
  reputation,
  requiredReputation,
  rightsAvailable,
  rightsFee,
  routeDistance,
  routeLabel,
  routeLegs,
  routeMaxLeg,
  planeResaleValue,
  upgradeRoute,
  upgradeRouteQuote,
  airportSlotsTotal,
  airportSlotsUsed,
  MAX_HOME_SIZE,
  MAX_ROUTE_LEGS,
  PLANE_PRODUCTION_YEARS,
  setFareFactor,
  speedFareMultiplier,
  tripsPerWeek,
  weeklyTotals,
  weekNumber,
} from './engine';

const TURBOPROP = AIRCRAFT_TYPES.find((t) => t.id === 'q400')!;
const JET = AIRCRAFT_TYPES.find((t) => t.id === 'e175')!;

const lastRoute = (g: GameState) => g.routes[g.routes.length - 1];
const lastPlane = (g: GameState) => g.fleet[g.fleet.length - 1];

let g: GameState;
beforeEach(() => {
  g = newGame('crw');
  // Most tests aren't about landing rights — grant them everywhere by default.
  g.rights = AIRPORTS.map((a) => a.id);
  // Nor about the calendar — jump to 2025 so every aircraft type is in service.
  g.day = 365 * 75 + 19; // leap days through 2025 keep this mid-January
  // Nor about affordability — give a working balance (tests about cash set their own).
  g.cash = 50_000_000;
});

/** Open a route and staff it with `count` planes of `planeType`. Returns the route. */
function addRoute(stops: string[], planeType = 'e175', count = 1) {
  g.cash = 1_000_000_000; // economics tests aren't about affordability
  openRoute(g, stops);
  const route = g.routes[g.routes.length - 1];
  for (let i = 0; i < count; i++) {
    buyPlane(g, planeType);
    assignPlane(g, g.fleet[g.fleet.length - 1].id, route.id);
  }
  return route;
}

/** Total weekly both-direction seats one plane offers on a single-leg route. */
function legCapacity(distance: number, planeId = 'e175') {
  const t = AIRCRAFT_TYPES.find((a) => a.id === planeId)!;
  return tripsPerWeek(t, distance, 1) * 2 * t.capacity;
}

describe('newGame', () => {
  it('starts on day 0 with the starting cash and no debt/fleet/routes', () => {
    const fresh = newGame('crw');
    expect(fresh.day).toBe(0);
    expect(fresh.cash).toBe(STARTING_CASH);
    expect(fresh.debt).toBe(0);
    expect(fresh.fleet).toEqual([]);
    expect(fresh.routes).toEqual([]);
  });
});

describe('calendar & aircraft availability', () => {
  it('starts in 1950 and the year advances with the clock', () => {
    const fresh = newGame('crw');
    expect(currentYear(fresh)).toBe(1950);
    fresh.day = 365; // Jan 1, 1951
    expect(currentYear(fresh)).toBe(1951);
  });

  it('only types already in service are available in 1950', () => {
    const fresh = newGame('crw');
    const avail = availableTypes(fresh).map((t) => t.id);
    expect(avail).toContain('dc3');
    expect(avail).toContain('dc4');
    expect(avail).not.toContain('b787');
    for (const t of availableTypes(fresh)) expect(t.introduced).toBeLessThanOrEqual(1950);
  });

  it('refuses to sell a plane from the future', () => {
    const fresh = newGame('crw');
    fresh.cash = 1_000_000_000;
    expect(buyPlane(fresh, 'b787')).toMatch(/doesn't enter service until 2014/);
    expect(fresh.fleet).toHaveLength(0);
    fresh.day = 365 * 75; // ~2025
    expect(buyPlane(fresh, 'b787')).toBeNull();
  });

  it('refuses to sell a retired plane', () => {
    const fresh = newGame('crw');
    fresh.cash = 1_000_000_000;
    const retiredYear = 1936 + PLANE_PRODUCTION_YEARS; // 1966
    fresh.day = 5844; // Jan 1, 1966 — DC-3 production has ended
    expect(buyPlane(fresh, 'dc3')).toMatch(new RegExp(`left production in ${retiredYear}`));
    expect(fresh.fleet).toHaveLength(0);
    fresh.day = 5843; // still 1965 — DC-3 still available
    expect(buyPlane(fresh, 'dc3')).toBeNull();
  });

  it('announces when a type leaves production', () => {
    const fresh = newGame('crw');
    fresh.day = 5843; // Dec 31, 1965 — one day before DC-3 retires
    const logBefore = fresh.log.length;
    advanceDay(fresh); // ticks to Jan 1, 1966
    const newEntries = fresh.log.slice(0, fresh.log.length - logBefore);
    expect(newEntries.some((e) => e.includes('DC-3') && e.includes('left production'))).toBe(true);
  });

  it('rights fees start low in 1950 and inflate to modern values', () => {
    const fresh = newGame('crw'); // 1950
    const clt = airportById(fresh, 'clt'); // size 5: $8M in modern dollars
    const early = rightsFee(fresh, clt);
    expect(early).toBeLessThan(800_000);
    fresh.day = 365 * 75 + 19; // Jan 1, 2025
    expect(rightsFee(fresh, clt)).toBe(8_000_000);
    expect(early).toBeLessThan(rightsFee(fresh, clt));
  });

  it('the startup credit line is era-scaled too', () => {
    const fresh = newGame('crw');
    expect(creditLimit(fresh)).toBeLessThan(2_000_000); // vs $15M in 2025
  });

  it('starting cash affords a small 1950 fleet but not a modern jet', () => {
    const fresh = newGame('crw');
    expect(buyPlane(fresh, 'dc3')).toBeNull();
    expect(buyPlane(fresh, 'dc3')).toBeNull(); // two DC-3s fit the budget
    expect(buyPlane(fresh, 'dc4')).toMatch(/not enough cash/i);
  });

  it('announces types entering service at the new year', () => {
    const fresh = newGame('crw');
    fresh.day = 364; // Dec 31, 1950 -> next day is 1951
    advanceDay(fresh);
    expect(currentYear(fresh)).toBe(1951);
    // DC-6B and the Constellation both arrive in 1951.
    expect(fresh.log.some((l) => l.includes('DC-6B'))).toBe(true);
    expect(fresh.log.some((l) => l.includes('Constellation'))).toBe(true);
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

  it('distance factor is 1 at the reference distance and shrinks for longer markets', () => {
    expect(distanceFactor(400)).toBeCloseTo(1, 5);
    expect(distanceFactor(200)).toBeGreaterThan(1); // short markets are denser
    expect(distanceFactor(1600)).toBeLessThan(1); // long markets are thinner
    expect(distanceFactor(50)).toBeLessThanOrEqual(1.6); // clamped
  });
});

describe('priceLevel (era inflation)', () => {
  it('anchors at 1.0 in 1950 and climbs ~3x by 2025', () => {
    const fresh = newGame('crw'); // 1950
    expect(priceLevel(fresh)).toBeCloseTo(1, 5);
    fresh.day = 365 * 75 + 19; // ~2025
    expect(priceLevel(fresh)).toBeCloseTo(3.05, 1);
  });

  it('rises monotonically with the calendar', () => {
    const fresh = newGame('crw');
    fresh.day = 0;
    const y1950 = priceLevel(fresh);
    fresh.day = 365 * 35; // ~1985
    const y1985 = priceLevel(fresh);
    fresh.day = 365 * 75; // ~2025
    const y2025 = priceLevel(fresh);
    expect(y1985).toBeGreaterThan(y1950);
    expect(y2025).toBeGreaterThan(y1985);
  });

  it('preserves the operating margin across eras — revenue and cost inflate together', () => {
    // Same fleet and network, two modern years where the speed baseline is
    // already capped, so demand is identical and only priceLevel differs.
    const route = addRoute(['crw', 'clt'], 'e175', 2);
    expect(route.stops.length).toBeGreaterThan(0);

    g.day = 365 * 65 + 16; // ~2015
    const early = evaluateNetwork(g);
    g.day = 365 * 75 + 19; // ~2025
    const late = evaluateNetwork(g);

    // Both years carry the same passengers (demand doesn't ride priceLevel).
    expect(late.passengers).toBeCloseTo(early.passengers, 5);

    // Revenue and cost scale by the same factor → margin is unchanged.
    const ratio = priceLevel({ ...g, day: 365 * 75 + 19 } as GameState) /
      priceLevel({ ...g, day: 365 * 65 + 16 } as GameState);
    expect(late.revenue / early.revenue).toBeCloseTo(ratio, 2);
    expect(late.cost / early.cost).toBeCloseTo(ratio, 2);
    expect(late.profit / late.revenue).toBeCloseTo(early.profit / early.revenue, 5);
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
    const before = g.cash;
    expect(buyPlane(g, 'q400')).toBeNull();
    expect(g.fleet).toHaveLength(1);
    expect(lastPlane(g).routeId).toBeNull();
    expect(g.cash).toBe(before - TURBOPROP.price);
  });

  it('refuses when there is not enough cash', () => {
    g.cash = 1_000_000;
    expect(buyPlane(g, 'e195e2')).toMatch(/not enough cash/i);
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

  it('caps a route at MAX_ROUTE_LEGS legs', () => {
    // Alternate two hubs so there are no consecutive duplicates.
    const stops = (legs: number) =>
      Array.from({ length: legs + 1 }, (_, i) => (i % 2 === 0 ? 'crw' : 'clt'));
    expect(stops(MAX_ROUTE_LEGS)).toHaveLength(MAX_ROUTE_LEGS + 1);
    expect(openRoute(g, stops(MAX_ROUTE_LEGS))).toBeNull(); // at the limit: ok
    expect(openRoute(g, stops(MAX_ROUTE_LEGS + 1))).toMatch(/at most 8 legs/i);
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
    buyPlane(g, 'q400');
    openRoute(g, ['crw', 'clt']);
    expect(assignPlane(g, lastPlane(g).id, lastRoute(g).id)).toBeNull();
    expect(planesOnRoute(g, lastRoute(g).id)).toHaveLength(1);
  });

  it('refuses when the longest leg exceeds the aircraft range', () => {
    const custom: GameState = {
      ...newGame('crw'),
      aircraftTypes: [{ ...TURBOPROP, id: 'shorty', range: 100 }],
      fleet: [{ id: 'p1', typeId: 'shorty', routeId: null, kmFlown: 0 }],
      routes: [{ id: 'r1', stops: ['crw', 'clt'], fareFactor: 1 }],
    };
    expect(assignPlane(custom, 'p1', 'r1')).toMatch(/can't reach/i);
    expect(custom.fleet[0].routeId).toBeNull();
  });

  it('always allows returning a plane to the hangar', () => {
    buyPlane(g, 'q400');
    openRoute(g, ['crw', 'clt']);
    assignPlane(g, lastPlane(g).id, lastRoute(g).id);
    expect(assignPlane(g, lastPlane(g).id, null)).toBeNull();
    expect(lastPlane(g).routeId).toBeNull();
  });
});

describe('closeRoute', () => {
  it('removes the route and frees its planes back to the hangar', () => {
    buyPlane(g, 'q400');
    openRoute(g, ['crw', 'clt']);
    const routeId = lastRoute(g).id;
    assignPlane(g, lastPlane(g).id, routeId);

    closeRoute(g, routeId);
    expect(g.routes).toHaveLength(0);
    expect(lastPlane(g).routeId).toBeNull();
  });
});

describe('upgradeRoute', () => {
  it('swaps every plane on the route for the new type and keeps them assigned', () => {
    const route = addRoute(['crw', 'clt'], 'q400', 2);
    const before = g.cash;
    const quote = upgradeRouteQuote(g, route.id, 'e175');

    expect(upgradeRoute(g, route.id, 'e175')).toBeNull();
    const onRoute = g.fleet.filter((p) => p.routeId === route.id);
    expect(onRoute).toHaveLength(2);
    expect(onRoute.every((p) => p.typeId === 'e175')).toBe(true);
    // Net cash change matches the quote exactly.
    expect(g.cash).toBe(before - quote.net);
  });

  it('quote nets buy cost against resale of the planes replaced', () => {
    const route = addRoute(['crw', 'clt'], 'q400', 1);
    const plane = g.fleet.find((p) => p.routeId === route.id)!;
    const q = upgradeRouteQuote(g, route.id, 'e175');
    expect(q.count).toBe(1);
    expect(q.buyCost).toBe(AIRCRAFT_TYPES.find((t) => t.id === 'e175')!.price);
    expect(q.resale).toBe(planeResaleValue(g, plane));
    expect(q.net).toBe(q.buyCost - q.resale);
  });

  it('refuses when the route has no planes', () => {
    openRoute(g, ['crw', 'clt']);
    expect(upgradeRoute(g, lastRoute(g).id, 'e175')).toMatch(/no planes/i);
  });

  it("refuses a type that can't reach the route's longest leg", () => {
    const route = addRoute(['crw', 'clt'], 'e175', 1);
    const shortRange = AIRCRAFT_TYPES.reduce((a, b) => (a.range < b.range ? a : b));
    if (shortRange.range < routeMaxLeg(g, route)) {
      expect(upgradeRoute(g, route.id, shortRange.id)).toMatch(/can't reach/i);
    }
  });

  it('refuses a downgrade to a cheaper type', () => {
    const route = addRoute(['crw', 'clt'], 'e175', 1); // $30M jet
    expect(upgradeRoute(g, route.id, 'q400')).toMatch(/isn't an upgrade/i); // $20M turboprop
    expect(g.fleet.every((p) => p.typeId === 'e175')).toBe(true);
  });

  it('refuses re-buying the same type as a no-op', () => {
    const route = addRoute(['crw', 'clt'], 'e175', 1);
    expect(upgradeRoute(g, route.id, 'e175')).toMatch(/isn't an upgrade/i);
  });

  it('refuses when the net cost exceeds available cash', () => {
    const route = addRoute(['crw', 'clt'], 'q400', 1);
    g.cash = 0;
    expect(upgradeRoute(g, route.id, 'e195e2')).toMatch(/not enough cash/i);
  });
});

describe('network evaluation', () => {
  function withRoute(stops: string[], planeType = 'e175') {
    g.cash = 1_000_000_000; // economics tests aren't about affordability
    openRoute(g, stops);
    const route = lastRoute(g);
    buyPlane(g, planeType);
    assignPlane(g, lastPlane(g).id, route.id);
    return route;
  }

  it('carries no passengers and turns no profit with no planes', () => {
    openRoute(g, ['clt', 'dca']); // route exists but unflown
    const net = evaluateNetwork(g);
    expect(net.passengers).toBe(0);
    expect(net.revenue).toBe(0);
    expect(net.profit).toBe(0);
  });

  it('only earns in markets the airline actually connects', () => {
    withRoute(['clt', 'dca']);
    const net = evaluateNetwork(g);
    // CLT-DCA is served; a market touching an unserved airport (e.g. ROA) is not.
    expect(net.revenue).toBeGreaterThan(0);
    expect(net.passengers).toBeGreaterThan(0);
  });

  it('routes connecting traffic across SEPARATE routes through a shared hub', () => {
    // CVG, CMH, PIT are roughly collinear, so CVG->PIT connects via CMH.
    withRoute(['cvg', 'cmh']);
    withRoute(['cmh', 'pit']);
    const net = evaluateNetwork(g);
    expect(net.connectingPassengers).toBeGreaterThan(0);
  });

  it('a feeder spoke is credited for the connecting traffic it carries', () => {
    withRoute(['cvg', 'cmh']);
    const spokeId = lastRoute(g).id;
    const before = evaluateNetwork(g).routes.get(spokeId)!.revenue;
    withRoute(['cmh', 'pit']); // now CVG can feed onward to PIT via CMH
    const after = evaluateNetwork(g).routes.get(spokeId)!.revenue;
    expect(after).toBeGreaterThan(before);
  });

  it('prefers a nonstop over a connection for the same city pair', () => {
    // With a direct CRW-CVG, the through demand routes nonstop (0 connections),
    // so adding the nonstop should not increase connecting passengers there.
    withRoute(['crw', 'cvg']);
    const direct = evaluateNetwork(g);
    expect(direct.connectingPassengers).toBe(0);
  });

  it('reports a load factor between 0 and 1 for a flown route', () => {
    const route = withRoute(['clt', 'dca'], 'q400');
    const rs = evaluateRoute(g, route);
    expect(rs.loadFactor).toBeGreaterThan(0);
    expect(rs.loadFactor).toBeLessThanOrEqual(1);
  });

  it('a faster fleet lifts the route speed premium', () => {
    g.day = 21915; // 2010 — saab340 still in production
    const slow = withRoute(['clt', 'dca'], 'saab340');
    const saab = AIRCRAFT_TYPES.find((t) => t.id === 'saab340')!;
    expect(evaluateRoute(g, slow).speedPremium).toBeCloseTo(
      speedFareMultiplier(saab.speed, 700),
      2,
    );
    const fast = withRoute(['clt', 'cvg'], 'e175');
    expect(evaluateRoute(g, fast).speedPremium).toBeCloseTo(JET.speed / 700, 2);
  });

  it('the era’s best plane flies with no speed penalty', () => {
    g.day = 0; // back to 1950, when the DC-4 is the fastest thing flying
    const route = withRoute(['crw', 'clt'], 'dc4');
    expect(evaluateRoute(g, route).speedPremium).toBe(1);
  });

  it('no penalty while a faster type is still in its adoption window', () => {
    g.day = 0;
    const route = withRoute(['crw', 'clt'], 'dc4');
    g.day = 365 * 3 + 200; // mid-1953: Viscount is out but not yet the norm
    expect(evaluateRoute(g, route).speedPremium).toBe(1);
  });

  it('a brand-new faster plane earns a fare bonus during its window', () => {
    g.day = 365 * 3 + 200; // mid-1953
    const route = withRoute(['crw', 'clt'], 'viscount');
    expect(evaluateRoute(g, route).speedPremium).toBeCloseTo(1.2, 2);
  });

  it('a speed penalty appears once faster types settle in', () => {
    g.day = 0;
    const route = withRoute(['crw', 'clt'], 'dc4');
    g.day = 365 * 7; // ~1957: Viscount established
    const midEra = evaluateRoute(g, route).speedPremium;
    expect(midEra).toBeLessThan(1);
    g.day = 365 * 15; // ~1965: jet age
    const jetEra = evaluateRoute(g, route).speedPremium;
    expect(jetEra).toBeLessThan(midEra);
  });

  it('baseline speed lags introductions by 3 years, capped at 700', () => {
    g.day = 0;
    expect(baselineSpeed(g)).toBe(365); // DC-4
    g.day = 365 * 4 + 200; // mid-1954: DC-6/Connie (1951) now established
    expect(baselineSpeed(g)).toBe(550);
    g.day = 365 * 75 + 19; // 2025
    expect(baselineSpeed(g)).toBe(700);
  });

  it('lower fares draw more passengers system-wide (price elasticity)', () => {
    const route = withRoute(['clt', 'dca'], 'e195e2');
    setFareFactor(g, route.id, 2.5);
    const dearPax = evaluateNetwork(g).passengers;
    setFareFactor(g, route.id, 0.5);
    const cheapPax = evaluateNetwork(g).passengers;
    expect(cheapPax).toBeGreaterThan(dearPax);
  });
});

describe('weeklyTotals & advanceDay', () => {
  it('charges upkeep for idle planes', () => {
    g.rights = []; // isolate upkeep from slot gate fees
    buyPlane(g, 'q400');
    expect(weeklyTotals(g).cost).toBeCloseTo(TURBOPROP.weeklyUpkeep * priceLevel(g), 5);
  });

  it('includes weekly interest on outstanding debt', () => {
    g.debt = 10_000_000;
    expect(weeklyTotals(g).interest).toBeCloseTo(
      10_000_000 * interestRate(g) * (7 / 365),
      5,
    );
  });

  it('advanceDay accrues one seventh of the weekly net and ticks the day', () => {
    buyPlane(g, 'q400');
    const before = g.cash;
    const dayBefore = g.day;
    const net = weeklyTotals(g).net;
    advanceDay(g);
    expect(g.day).toBe(dayBefore + 1);
    expect(g.cash).toBeCloseTo(before + net / 7, 5);
  });

  it('weekNumber rolls over every 7 days', () => {
    g.day = 0;
    expect(weekNumber(g)).toBe(1);
    g.day = 6;
    expect(weekNumber(g)).toBe(1);
    g.day = 7;
    expect(weekNumber(g)).toBe(2);
  });
});

describe('loans', () => {
  it('borrowing adds to cash and debt and returns the amount taken', () => {
    const before = g.cash;
    expect(borrow(g, 10_000_000)).toBe(10_000_000); // within the base credit line
    expect(g.debt).toBe(10_000_000);
    expect(g.cash).toBe(before + 10_000_000);
  });

  it('caps borrowing at the (dynamic) remaining credit line', () => {
    const limit = creditLimit(g);
    expect(borrow(g, limit + 50_000_000)).toBe(limit);
    expect(g.debt).toBe(limit);
    expect(borrow(g, 5_000_000)).toBe(0);
  });

  it('repaying cannot exceed debt or available cash', () => {
    borrow(g, 10_000_000);
    g.cash = 5_000_000;
    expect(repay(g, 20_000_000)).toBe(5_000_000);
    expect(g.cash).toBe(0);
    expect(g.debt).toBe(5_000_000);
  });
});

describe('dynamic credit line & interest rate', () => {
  it('a startup airline gets only the base credit line', () => {
    expect(creditLimit(g)).toBe(15_000_000); // no revenue, no fleet
  });

  it('credit grows with fleet collateral and revenue', () => {
    const base = creditLimit(g);
    g.cash = 1_000_000_000;
    buyPlane(g, 'e195e2'); // adds fleet collateral
    expect(creditLimit(g)).toBeGreaterThan(base);
    const withFleet = creditLimit(g);
    openRoute(g, ['clt', 'dca']); // now flying & earning revenue
    assignPlane(g, g.fleet[g.fleet.length - 1].id, lastRoute(g).id);
    expect(creditLimit(g)).toBeGreaterThan(withFleet);
  });

  it('a debt-free airline pays the era fed funds rate', () => {
    // These tests run in 2025 (see beforeEach), where fed funds ≈ 4.3%.
    expect(interestRate(g)).toBeCloseTo(fedFundsRate(g), 5);
    expect(interestRate(g)).toBeCloseTo(0.043, 5);
  });

  it('the rate rises with leverage', () => {
    g.debt = 5_000_000; // low leverage vs $40M starting cash
    const low = interestRate(g);
    g.debt = 35_000_000; // high leverage
    const high = interestRate(g);
    expect(high).toBeGreaterThan(low);
  });

  it('an over-leveraged, loss-making airline pays more than a solvent one', () => {
    // Solvent: lots of assets, little debt.
    g.cash = 500_000_000;
    g.debt = 5_000_000;
    const solvent = interestRate(g);
    // Stressed: buy a plane (now idle => operating loss), then drain cash & pile on debt.
    buyPlane(g, 'e195e2');
    g.cash = 1_000_000;
    g.debt = 30_000_000;
    const stressed = interestRate(g);
    expect(stressed).toBeGreaterThan(solvent);
    expect(stressed).toBeLessThanOrEqual(fedFundsRate(g) + 0.12); // clamped to the floating ceiling
  });

  it('fleetValue depreciates the purchase price', () => {
    buyPlane(g, 'e175');
    const price = AIRCRAFT_TYPES.find((t) => t.id === 'e175')!.price;
    // Brand-new plane starts at 80%; value falls toward 40% as km accumulate.
    expect(fleetValue(g)).toBeCloseTo(price * 0.8, 5);
    g.fleet[0].kmFlown = 5_000_000;
    expect(fleetValue(g)).toBeCloseTo(price * 0.4, 5);
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

describe('nearestHeldAirport', () => {
  it('returns the closest airport with rights, excluding itself', () => {
    g.rights = ['crw', 'cvg'];
    const mem = airportById(g, 'mem');
    const near = nearestHeldAirport(g, mem)!;
    expect(near.id).toBe('cvg');
    expect(distanceKm(mem, near)).toBeLessThan(distanceKm(mem, airportById(g, 'crw')));
  });

  it('skips the airport itself and returns null when nothing else is held', () => {
    g.rights = ['cvg'];
    const cvg = airportById(g, 'cvg');
    expect(nearestHeldAirport(g, cvg)).toBeNull();
  });
});

describe('airport data integrity', () => {
  it('has a valid default home base (crw)', () => {
    const home = AIRPORTS.find((a) => a.id === 'crw');
    expect(home).toBeDefined();
    expect(home!.size).toBeLessThanOrEqual(MAX_HOME_SIZE);
  });

  it('uses unique airport ids', () => {
    const ids = AIRPORTS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('no small airport (size ≤ 2) sits within 60 miles of a bigger-or-equal one', () => {
    // Isolation = value: a tiny field is only worth a node if it has no
    // larger-or-equal neighbor nearby (keeps a remote field, culls a redundant
    // one next to a hub). Guards map clutter as the city list grows.
    const MILES_KM = 1.60934;
    const limitKm = 60 * MILES_KM;
    const violations: string[] = [];
    for (const a of AIRPORTS) {
      if (a.size > 2) continue;
      for (const b of AIRPORTS) {
        if (a.id === b.id || b.size < a.size) continue;
        const d = distanceKm(a, b);
        if (d < limitKm) violations.push(`${a.code}↔${b.code} ${Math.round(d / MILES_KM)}mi`);
      }
    }
    expect(violations).toEqual([]);
  });
});

// Task #1
describe('shared legs (pooling & attribution)', () => {
  it('conserves revenue: per-route attributed revenue sums to the network total', () => {
    // CLT-DCA leg is shared between a nonstop and a route that overflies it.
    addRoute(['clt', 'dca']);
    addRoute(['pit', 'clt', 'dca']);
    const net = evaluateNetwork(g);
    const sum = [...net.routes.values()].reduce((s, r) => s + r.revenue, 0);
    expect(sum).toBeCloseTo(net.revenue, 4);
    // Both routes earn from the shared corridor / their markets.
    for (const r of net.routes.values()) expect(r.revenue).toBeGreaterThan(0);
  });

  it('pools capacity: a second route over a capped leg carries more of its market', () => {
    g.day = 21915; // 2010 — saab340 still in production
    // One small turboprop on a low-fare (high-demand) CLT-DCA: capacity-capped.
    const a = addRoute(['clt', 'dca'], 'saab340');
    setFareFactor(g, a.id, 0.5);
    const before = evaluateNetwork(g).passengers;
    // A second route adds capacity to the same CLT-DCA leg.
    addRoute(['clt', 'dca', 'pit'], 'saab340');
    setFareFactor(g, g.routes[g.routes.length - 1].id, 0.5);
    const after = evaluateNetwork(g).passengers;
    expect(after).toBeGreaterThan(before);
  });
});

// Task #2
describe('capacity-constrained allocation', () => {
  it('caps passengers at capacity with load factor at 1 when demand overflows', () => {
    g.day = 21915; // 2010 — saab340 still in production
    const route = addRoute(['clt', 'dca'], 'saab340');
    setFareFactor(g, route.id, 0.5); // push demand above the small plane's seats
    const cap = legCapacity(routeDistance(g, route), 'saab340');
    const rs = evaluateRoute(g, route);
    expect(rs.passengers).toBeCloseTo(cap, 0);
    expect(rs.loadFactor).toBeGreaterThan(0.99);
  });

  it('a demand-limited route stays below capacity (load factor < 1)', () => {
    const route = addRoute(['crw', 'gso'], 'e175'); // tiny 1x1 market
    const rs = evaluateRoute(g, route);
    expect(rs.loadFactor).toBeLessThan(1);
  });
});

// Task #3
describe('detour cap', () => {
  it('rejects a connection through an off-line hub (CRW-CLT-DCA ~2x detour)', () => {
    addRoute(['crw', 'clt']);
    addRoute(['clt', 'dca']);
    // CLT is far south of the CRW-DCA line, so no CRW-DCA connection forms.
    expect(evaluateNetwork(g).connectingPassengers).toBe(0);
  });

  it('accepts a connection through a collinear hub (CVG-CMH-PIT)', () => {
    addRoute(['cvg', 'cmh']);
    addRoute(['cmh', 'pit']);
    expect(evaluateNetwork(g).connectingPassengers).toBeGreaterThan(0);
  });
});

// Task #4
describe('cost right-sizing & multi-plane capacity', () => {
  it('a lightly-loaded route costs far less to fly than a capacity-capped one', () => {
    g.day = 21915; // 2010 — saab340 still in production
    const thin = addRoute(['crw', 'gso'], 'saab340'); // small market (1x2), low load
    const capped = addRoute(['clt', 'dca'], 'saab340');
    setFareFactor(g, capped.id, 0.5); // overflow the seats -> full flying
    const net = evaluateNetwork(g);
    const thinCost = net.routes.get(thin.id)!.cost;
    const cappedCost = net.routes.get(capped.id)!.cost;
    // Upkeep inflates with the era, same as the flying cost it's compared against.
    const upkeep = AIRCRAFT_TYPES.find((t) => t.id === 'saab340')!.weeklyUpkeep * priceLevel(g);
    expect(thinCost).toBeLessThan(cappedCost);
    expect(thinCost).toBeGreaterThanOrEqual(upkeep); // upkeep is always paid
    expect(thinCost).toBeLessThan(upkeep * 1.7); // little actual flying
  });

  it('a second plane on a capped route increases passengers carried', () => {
    g.day = 21915; // 2010 — saab340 still in production
    const one = addRoute(['clt', 'dca'], 'saab340');
    setFareFactor(g, one.id, 0.5);
    const paxOne = evaluateRoute(g, one).passengers;
    buyPlane(g, 'saab340');
    assignPlane(g, g.fleet[g.fleet.length - 1].id, one.id);
    const paxTwo = evaluateRoute(g, one).passengers;
    expect(paxTwo).toBeGreaterThan(paxOne);
  });
});

// Task #5
describe('interest accrues through advanceDay', () => {
  it('a week of days with debt drains cash by ~the weekly interest', () => {
    g.rights = []; // isolate debt interest from slot gate fees
    borrow(g, 10_000_000); // within the base credit line
    g.cash = 0; // isolate debt interest from deposit interest on a cash balance
    const weeklyInterest = weeklyTotals(g).interest;
    const dayBefore = g.day;
    for (let i = 0; i < 7; i++) advanceDay(g);
    expect(g.day).toBe(dayBefore + 7);
    // Rate drifts slightly as cash falls, so allow a small tolerance.
    expect(Math.abs(0 - g.cash - weeklyInterest)).toBeLessThan(100);
    expect(g.debt).toBe(10_000_000); // principal unchanged
  });
});

// Task #21
describe('interest earned on positive cash', () => {
  it('pays deposit interest on a positive balance and nothing on zero/negative', () => {
    g.debt = 0;
    g.cash = 100_000_000;
    expect(weeklyTotals(g).interestEarned).toBeCloseTo(
      100_000_000 * depositRate(g) * (7 / 365),
      5,
    );
    g.cash = 0;
    expect(weeklyTotals(g).interestEarned).toBe(0);
    g.cash = -5_000_000;
    expect(weeklyTotals(g).interestEarned).toBe(0);
  });

  it('a debt-free week of days grows idle cash by ~the deposit interest', () => {
    g.debt = 0;
    g.rights = []; // isolate deposit interest from slot gate fees
    const start = g.cash;
    const earned = weeklyTotals(g).interestEarned;
    for (let i = 0; i < 7; i++) advanceDay(g);
    expect(g.cash - start).toBeCloseTo(earned, -1); // grows toward year-end
    expect(g.cash).toBeGreaterThan(start);
  });

  it('the deposit rate sits below the loan floor — parking cash never beats repaying', () => {
    expect(depositRate(g)).toBeLessThan(interestRate(g));
  });
});

describe('historical fed funds rate', () => {
  const dayForYear = (year: number) => Math.round((year - 1950) * 365.25);

  it('hits the anchors exactly', () => {
    g.day = 0; // 1950
    expect(currentYear(g)).toBe(1950);
    expect(fedFundsRate(g)).toBeCloseTo(0.015, 5);

    g.day = dayForYear(1981); // Volcker spike
    expect(currentYear(g)).toBe(1981);
    expect(fedFundsRate(g)).toBeCloseTo(0.16, 5);

    g.day = dayForYear(2015); // ZIRP
    expect(currentYear(g)).toBe(2015);
    expect(fedFundsRate(g)).toBeCloseTo(0.001, 5);
  });

  it('interpolates linearly between anchors', () => {
    g.day = dayForYear(1955); // halfway between 1950 (1.5%) and 1960 (3.5%)
    expect(currentYear(g)).toBe(1955);
    expect(fedFundsRate(g)).toBeCloseTo(0.025, 5);
  });

  it('clamps past the last anchor', () => {
    g.day = dayForYear(2040);
    expect(fedFundsRate(g)).toBeCloseTo(0.043, 5); // 2025 anchor
  });

  it('loan and deposit rates track the era', () => {
    g.debt = 0;
    g.day = dayForYear(1981); // expensive money
    const volckerLoan = interestRate(g);
    const volckerDeposit = depositRate(g);
    g.day = dayForYear(2015); // cheap money
    const zirpLoan = interestRate(g);
    const zirpDeposit = depositRate(g);
    expect(volckerLoan).toBeGreaterThan(zirpLoan);
    expect(volckerDeposit).toBeGreaterThan(zirpDeposit);
    expect(volckerDeposit).toBeCloseTo(0.14, 5); // 16% − 2% spread
    expect(zirpDeposit).toBe(0); // floored at zero when fed funds < spread
  });
});

// Task #6
describe('fare factor on a capacity-capped route', () => {
  it('raising fares lifts revenue while passengers stay pinned at capacity', () => {
    g.day = 21915; // 2010 — saab340 still in production
    const route = addRoute(['clt', 'dca'], 'saab340');
    const cap = legCapacity(routeDistance(g, route), 'saab340');

    setFareFactor(g, route.id, 0.5);
    const low = evaluateRoute(g, route);
    setFareFactor(g, route.id, 0.9);
    const high = evaluateRoute(g, route);

    // Still demand-saturated at both fares, so seats sold barely move...
    expect(low.passengers).toBeCloseTo(cap, 0);
    expect(high.passengers).toBeCloseTo(cap, 0);
    // ...but the higher fare earns more.
    expect(high.revenue).toBeGreaterThan(low.revenue);
  });
});

// Task #7
describe('data sanity & helpers', () => {
  it('every aircraft type has positive stats', () => {
    for (const t of AIRCRAFT_TYPES) {
      expect(t.capacity).toBeGreaterThan(0);
      expect(t.range).toBeGreaterThan(0);
      expect(t.speed).toBeGreaterThan(0);
      expect(t.price).toBeGreaterThan(0);
      expect(t.costPerKm).toBeGreaterThan(0);
      expect(t.weeklyUpkeep).toBeGreaterThan(0);
    }
  });

  it('no airport is stranded beyond the longest-range jet from every neighbor', () => {
    // On a global map the farthest market pair is ~half the planet — no plane
    // flies that nonstop (that's why bridge airports exist). The invariant that
    // matters: every airport has at least one neighbor the best jet can reach,
    // so the whole network is connectable with the top of the fleet.
    const maxRange = Math.max(...AIRCRAFT_TYPES.map((t) => t.range));
    for (const a of AIRPORTS) {
      const nearest = Math.min(
        ...AIRPORTS.filter((b) => b.id !== a.id).map((b) => distanceKm(a, b)),
      );
      expect(nearest, a.code).toBeLessThanOrEqual(maxRange);
    }
  });

  it('starting cash affords at least the cheapest aircraft', () => {
    const cheapest = Math.min(...AIRCRAFT_TYPES.map((t) => t.price));
    expect(STARTING_CASH).toBeGreaterThanOrEqual(cheapest);
  });

  it('routeLabel renders the path with arrows', () => {
    openRoute(g, ['crw', 'clt', 'dca']);
    expect(routeLabel(g, lastRoute(g))).toBe('CRW → CLT → DCA');
  });

  it('planesOnRoute returns only the planes assigned to that route', () => {
    const route = addRoute(['clt', 'dca'], 'e175');
    buyPlane(g, 'q400'); // left idle in the hangar
    const on = planesOnRoute(g, route.id);
    expect(on).toHaveLength(1);
    expect(on[0].routeId).toBe(route.id);
  });
});

// Task #8
describe('determinism', () => {
  it('evaluateNetwork yields identical results across repeated calls', () => {
    addRoute(['crw', 'cmh']);
    addRoute(['cmh', 'pit']);
    addRoute(['clt', 'dca'], 'q400');
    const a = evaluateNetwork(g);
    const b = evaluateNetwork(g);
    expect(b.revenue).toBe(a.revenue);
    expect(b.cost).toBe(a.cost);
    expect(b.passengers).toBe(a.passengers);
    expect(b.connectingPassengers).toBe(a.connectingPassengers);
    for (const [id, ra] of a.routes) {
      expect(b.routes.get(id)!.revenue).toBe(ra.revenue);
      expect(b.routes.get(id)!.cost).toBe(ra.cost);
    }
  });
});

describe('landing rights', () => {
  it('a new game holds rights only at its home base', () => {
    const fresh = newGame('crw');
    expect(fresh.rights).toEqual(['crw']);
    expect(reputation(fresh)).toBe(1);
  });

  it('opens the regional network early but gates large airports by size', () => {
    g.rights = ['crw']; // reset to a fresh-airline footprint
    expect(rightsAvailable(g, 'cvg')).toBe(true); // size 3, open day 1
    expect(requiredReputation(airportById(g, 'clt'))).toBe(4); // size 5
    expect(requiredReputation(airportById(g, 'bos'))).toBe(4); // size 5
    expect(requiredReputation(airportById(g, 'lax'))).toBe(6); // size 6
    expect(rightsAvailable(g, 'lax')).toBe(false); // can't reach LAX on day 1
  });

  it("the airline's first slot opens immediately, the next one negotiates", () => {
    g.rights = ['crw']; // a fresh airline, home only
    g.cash = 1_000_000_000;
    expect(startNegotiation(g, 'gso')).toBeNull();
    expect(holdsRights(g, 'gso')).toBe(true); // instant — no wait
    expect(isNegotiating(g, 'gso')).toBe(false);
    // The second application takes the full negotiation.
    expect(startNegotiation(g, 'cvg')).toBeNull();
    expect(holdsRights(g, 'cvg')).toBe(false);
    expect(isNegotiating(g, 'cvg')).toBe(true);
  });

  it('filing a slot charges the fee up front but does not grant rights yet', () => {
    g.rights = ['crw', 'pit']; // past the free first slot
    g.cash = 1_000_000_000;
    const a = airportById(g, 'gso');
    const fee = rightsFee(g, a);
    expect(startNegotiation(g, 'gso')).toBeNull();
    expect(holdsRights(g, 'gso')).toBe(false); // not yet — it's pending
    expect(isNegotiating(g, 'gso')).toBe(true);
    expect(g.cash).toBe(1_000_000_000 - fee);
    expect(negotiationFor(g, 'gso')!.opensDay).toBe(g.day + negotiationDays(a));
  });

  it('negotiation time scales with airport size', () => {
    expect(negotiationDays(AIRPORTS.find((a) => a.size === 1)!)).toBe(60);
    expect(negotiationDays(AIRPORTS.find((a) => a.size === 2)!)).toBe(90);
    expect(negotiationDays(AIRPORTS.find((a) => a.size === 6)!)).toBe(365);
  });

  it('a slot opens after its negotiation window and then grants rights', () => {
    g.rights = ['crw', 'pit']; // past the free first slot
    g.cash = 1_000_000_000;
    const days = negotiationDays(airportById(g, 'gso'));
    const before = reputation(g);
    startNegotiation(g, 'gso');
    for (let i = 0; i < days - 1; i++) advanceDay(g);
    expect(holdsRights(g, 'gso')).toBe(false); // not open yet
    advanceDay(g); // window elapsed
    expect(holdsRights(g, 'gso')).toBe(true);
    expect(isNegotiating(g, 'gso')).toBe(false);
    expect(reputation(g)).toBe(before + 1);
  });

  it('refuses a locked airport, a duplicate application, and when broke', () => {
    g.rights = ['crw', 'pit']; // past the free first slot
    g.cash = 1_000_000_000;
    expect(startNegotiation(g, 'lax')).toMatch(/locked/i);
    expect(startNegotiation(g, 'gso')).toBeNull();
    expect(startNegotiation(g, 'gso')).toMatch(/already negotiating/i);
    g.cash = 1000;
    expect(startNegotiation(g, 'ric')).toMatch(/not enough cash/i); // size 2 costs $1M
    expect(isNegotiating(g, 'ric')).toBe(false);
  });

  it('negotiates one big slot at a time to start, more as the network grows', () => {
    g.rights = ['crw', 'clt']; // past the free first slot; network of 2
    g.cash = 1_000_000_000;
    expect(concurrentCap(g)).toBe(1);
    // cvg/cmh are size-3 hubs — not "easy", so capped at one at a time.
    expect(startNegotiation(g, 'cvg')).toBeNull();
    expect(startNegotiation(g, 'cmh')).toMatch(/limit/i);
    // A bigger network lifts the base cap (+1 per 10 airports held).
    g.rights = AIRPORTS.slice(0, 10).map((a) => a.id);
    expect(concurrentCap(g)).toBe(2);
  });

  it('a small nearby airport gets a bonus negotiation to get cash flowing', () => {
    g.rights = ['crw', 'clt']; // base cap 1
    g.cash = 1_000_000_000;
    // gso/ric are small (size 2) and close to home — easy slots.
    expect(isEasySlot(g, airportById(g, 'gso'))).toBe(true);
    expect(startNegotiation(g, 'gso')).toBeNull();
    expect(startNegotiation(g, 'ric')).toBeNull(); // the +1 easy bonus
    expect(startNegotiation(g, 'tys')).toMatch(/limit/i); // base 1 + 1 easy = 2 max
    // A big hub is not easy, so it can't use the bonus even with room conceptually.
    const fresh = newGame('crw');
    fresh.rights = ['crw', 'clt'];
    fresh.cash = 1_000_000_000;
    expect(isEasySlot(fresh, airportById(fresh, 'lax'))).toBe(false); // size 6
  });

  it('bootstraps: growing the network unlocks the bigger regional hubs', () => {
    g.cash = 1_000_000_000;
    g.rights = ['crw'];
    expect(rightsAvailable(g, 'clt')).toBe(false); // size 5 regional needs rep 4
    g.rights = ['crw', 'cvg', 'pit', 'cmh']; // reputation now 4
    expect(rightsAvailable(g, 'clt')).toBe(true);
  });

  it('sells a slot for a partial refund, but not while routes use it', () => {
    g.rights = ['crw', 'gso'];
    g.cash = 0;
    const refund = sellRefund(g, airportById(g, 'gso'));
    expect(sellSlot(g, 'gso')).toBeNull();
    expect(holdsRights(g, 'gso')).toBe(false);
    expect(g.cash).toBe(refund);
    // Can't sell the home airport.
    expect(sellSlot(g, 'crw')).toMatch(/home/i);
  });

  it('a slot in use by a route cannot be sold until the route is closed', () => {
    g.rights = ['crw', 'clt'];
    g.cash = 1_000_000_000;
    expect(openRoute(g, ['crw', 'clt'])).toBeNull();
    expect(sellSlot(g, 'clt')).toMatch(/route/i);
  });

  it('gate fees bleed cash: 10% of each slot fee a year, accrued weekly', () => {
    g.rights = ['crw', 'gso', 'cvg']; // crw is home
    // Home base is exempt; only the two acquired slots are billed.
    const annual = gateFee(g, airportById(g, 'gso')) + gateFee(g, airportById(g, 'cvg'));
    expect(gateFeesWeekly(g)).toBeCloseTo((annual * 7) / 365, 6);
    expect(gateFee(g, airportById(g, 'gso'))).toBe(
      Math.round(rightsFee(g, airportById(g, 'gso')) * 0.1),
    );
  });

  it('the home airport pays no gate fee — a fresh airline bleeds nothing', () => {
    const fresh = newGame('crw');
    expect(gateFeesWeekly(fresh)).toBe(0);
  });

  it('no airport is free — all fees are positive, even in 1950', () => {
    const fresh = newGame('crw');
    for (const a of AIRPORTS) {
      expect(rightsFee(g, a)).toBeGreaterThan(0);
      expect(rightsFee(fresh, a)).toBeGreaterThan(0);
    }
  });

  it('slot cap: small airports have 2 slots, the largest have 6', () => {
    expect(airportSlotsTotal(AIRPORTS.find((a) => a.size === 1)!)).toBe(2);
    expect(airportSlotsTotal(AIRPORTS.find((a) => a.size === 6)!)).toBe(6);
  });

  it('slot cap: a held airport shows 1 slot used, unacquired shows 0', () => {
    g.rights = ['crw'];
    expect(airportSlotsUsed(g, 'crw')).toBe(1);
    expect(airportSlotsUsed(g, 'gso')).toBe(0);
  });

  it('openRoute requires rights at every stop', () => {
    g.rights = ['crw', 'clt'];
    g.cash = 1_000_000_000;
    expect(openRoute(g, ['crw', 'dca'])).toMatch(/no landing rights at DCA/i);
    expect(openRoute(g, ['crw', 'clt'])).toBeNull(); // both held
  });
});

describe('national gateways', () => {
  it('the data includes large airports (size 5+) reachable via the network', () => {
    expect(AIRPORTS.some((a) => a.size >= 5)).toBe(true);
  });

  it('feeds a far national gateway from a regional spoke via a hub', () => {
    addRoute(['crw', 'clt']); // regional feeder
    addRoute(['clt', 'lax'], 'e195e2'); // long-haul to a national gateway
    // CRW travelers reach LAX by connecting at CLT.
    expect(evaluateNetwork(g).connectingPassengers).toBeGreaterThan(0);
  });

  it('adding onward feed improves a feeder spoke (fair fare attribution)', () => {
    const spoke = addRoute(['crw', 'clt']);
    const alone = evaluateRoute(g, spoke).profit;
    addRoute(['clt', 'lax'], 'e195e2'); // CLT now feeds onward; CRW carries CRW->LAX
    const fed = evaluateRoute(g, spoke).profit;
    expect(fed).toBeGreaterThan(alone);
  });
});

describe('finance metrics', () => {
  it('profit margin is net over revenue, and zero with no revenue', () => {
    expect(profitMargin(1000, 250)).toBeCloseTo(0.25);
    expect(profitMargin(0, -50)).toBe(0);
  });

  it('return on capital annualizes the weekly net over the capital base', () => {
    expect(returnOnCapital(52_000, 1000)).toBeCloseTo(1); // 1000×52 / 52000
    expect(returnOnCapital(0, 1000)).toBe(52_000); // guards against /0
  });

  it('equity is cash plus fleet value minus debt', () => {
    g.cash = 10_000_000;
    g.debt = 4_000_000;
    addRoute(['crw', 'clt']);
    expect(equity(g)).toBeCloseTo(g.cash + fleetValue(g) - g.debt);
  });

  it('financeMetrics reflects the current run-rate and balance sheet', () => {
    addRoute(['crw', 'clt']);
    const w = weeklyTotals(g);
    const m = financeMetrics(g);
    expect(m.cash).toBe(g.cash);
    expect(m.debt).toBe(g.debt);
    expect(m.revenue).toBeCloseTo(w.revenue);
    expect(m.net).toBeCloseTo(w.net);
    expect(m.assets).toBeCloseTo(Math.max(0, g.cash) + fleetValue(g));
    expect(m.margin).toBeCloseTo(profitMargin(w.revenue, w.net));
    expect(m.roc).toBeCloseTo(returnOnCapital(m.assets, w.net));
  });
});

describe('finance history', () => {
  it('newGame seeds a single baseline snapshot', () => {
    const fresh = newGame('crw');
    expect(fresh.history).toHaveLength(1);
    expect(fresh.history[0]).toMatchObject({ day: 0, cash: STARTING_CASH, debt: 0 });
  });

  it('recordFinanceSnapshot appends a dated weekly snapshot', () => {
    addRoute(['crw', 'clt']);
    const before = g.history.length;
    const w = weeklyTotals(g);
    recordFinanceSnapshot(g);
    expect(g.history).toHaveLength(before + 1);
    const last = g.history[g.history.length - 1];
    expect(last.day).toBe(g.day);
    expect(last.revenue).toBeCloseTo(w.revenue);
    expect(last.net).toBeCloseTo(w.net);
    expect(last.fleetValue).toBeCloseTo(fleetValue(g));
  });

  it('caps history length so saves stay small', () => {
    for (let i = 0; i < 1700; i++) recordFinanceSnapshot(g);
    expect(g.history.length).toBeLessThanOrEqual(1600);
  });
});
