import { beforeEach, describe, expect, it } from 'vitest';
import type { Airline, GameState } from './types';
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
  effectiveConcurrentCap,
  grantMergerBoost,
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
  newAirline,
  newGame,
  rand,
  openRoute,
  holdsRights,
  pairDemand,
  planesOnRoute,
  player,
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

const lastRoute = (g: GameState) => player(g).routes[player(g).routes.length - 1];
const lastPlane = (g: GameState) => player(g).fleet[player(g).fleet.length - 1];

let g: GameState;
let al: Airline;
beforeEach(() => {
  g = newGame('crw');
  al = player(g);
  // Most tests aren't about landing rights — grant them everywhere by default.
  al.rights = AIRPORTS.map((a) => a.id);
  // Nor about the calendar — jump to 2025 so every aircraft type is in service.
  g.day = 365 * 75 + 19; // leap days through 2025 keep this mid-January
  // Nor about affordability — give a working balance (tests about cash set their own).
  al.cash = 50_000_000;
});

/** Open a route and staff it with `count` planes of `planeType`. Returns the route. */
function addRoute(stops: string[], planeType = 'e175', count = 1) {
  al.cash = 1_000_000_000; // economics tests aren't about affordability
  openRoute(g, al, stops);
  const route = al.routes[al.routes.length - 1];
  for (let i = 0; i < count; i++) {
    buyPlane(g, al, planeType);
    assignPlane(g, al, al.fleet[al.fleet.length - 1].id, route.id);
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
    expect(player(fresh).cash).toBe(STARTING_CASH);
    expect(player(fresh).debt).toBe(0);
    expect(player(fresh).fleet).toEqual([]);
    expect(player(fresh).routes).toEqual([]);
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
    player(fresh).cash = 1_000_000_000;
    expect(buyPlane(fresh, player(fresh), 'b787')).toMatch(/doesn't enter service until 2014/);
    expect(player(fresh).fleet).toHaveLength(0);
    fresh.day = 365 * 75; // ~2025
    expect(buyPlane(fresh, player(fresh), 'b787')).toBeNull();
  });

  it('refuses to sell a retired plane', () => {
    const fresh = newGame('crw');
    player(fresh).cash = 1_000_000_000;
    const retiredYear = 1936 + PLANE_PRODUCTION_YEARS; // 1966
    fresh.day = 5844; // Jan 1, 1966 — DC-3 production has ended
    expect(buyPlane(fresh, player(fresh), 'dc3')).toMatch(new RegExp(`left production in ${retiredYear}`));
    expect(player(fresh).fleet).toHaveLength(0);
    fresh.day = 5843; // still 1965 — DC-3 still available
    expect(buyPlane(fresh, player(fresh), 'dc3')).toBeNull();
  });

  it('announces when a type leaves production', () => {
    const fresh = newGame('crw');
    fresh.day = 5843; // Dec 31, 1965 — one day before DC-3 retires
    const logBefore = player(fresh).log.length;
    advanceDay(fresh); // ticks to Jan 1, 1966
    const newEntries = player(fresh).log.slice(0, player(fresh).log.length - logBefore);
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
    expect(creditLimit(fresh, player(fresh))).toBeLessThan(2_000_000); // vs $15M in 2025
  });

  it('starting cash affords a small 1950 fleet but not a modern jet', () => {
    const fresh = newGame('crw');
    expect(buyPlane(fresh, player(fresh), 'dc3')).toBeNull();
    expect(buyPlane(fresh, player(fresh), 'dc3')).toBeNull(); // two DC-3s fit the budget
    expect(buyPlane(fresh, player(fresh), 'dc4')).toMatch(/not enough cash/i);
  });

  it('announces types entering service at the new year', () => {
    const fresh = newGame('crw');
    fresh.day = 364; // Dec 31, 1950 -> next day is 1951
    advanceDay(fresh);
    expect(currentYear(fresh)).toBe(1951);
    // DC-6B and the Constellation both arrive in 1951.
    expect(player(fresh).log.some((l) => l.includes('DC-6B'))).toBe(true);
    expect(player(fresh).log.some((l) => l.includes('Constellation'))).toBe(true);
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
    const early = evaluateNetwork(g, al);
    g.day = 365 * 75 + 19; // ~2025
    const late = evaluateNetwork(g, al);

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
    const before = al.cash;
    expect(buyPlane(g, al, 'q400')).toBeNull();
    expect(al.fleet).toHaveLength(1);
    expect(lastPlane(g).routeId).toBeNull();
    expect(al.cash).toBe(before - TURBOPROP.price);
  });

  it('refuses when there is not enough cash', () => {
    al.cash = 1_000_000;
    expect(buyPlane(g, al, 'e195e2')).toMatch(/not enough cash/i);
    expect(al.fleet).toHaveLength(0);
  });
});

describe('openRoute', () => {
  it('creates a route with a default 100% fare factor', () => {
    expect(openRoute(g, al, ['crw', 'clt'])).toBeNull();
    expect(lastRoute(g).stops).toEqual(['crw', 'clt']);
    expect(lastRoute(g).fareFactor).toBe(1);
  });

  it('supports multi-stop paths', () => {
    expect(openRoute(g, al, ['crw', 'clt', 'dca'])).toBeNull();
    const legs = routeLegs(g, lastRoute(g));
    expect(legs.map((l) => [l.fromId, l.toId])).toEqual([
      ['crw', 'clt'],
      ['clt', 'dca'],
    ]);
  });

  it('requires at least two stops', () => {
    expect(openRoute(g, al, ['crw'])).toMatch(/at least two/i);
    expect(al.routes).toHaveLength(0);
  });

  it('rejects consecutive duplicate stops', () => {
    expect(openRoute(g, al, ['crw', 'crw'])).toMatch(/same airport/i);
  });

  it('rejects a duplicate route in either direction', () => {
    openRoute(g, al, ['crw', 'clt', 'dca']);
    expect(openRoute(g, al, ['crw', 'clt', 'dca'])).toMatch(/already exists/i);
    expect(openRoute(g, al, ['dca', 'clt', 'crw'])).toMatch(/already exists/i);
    expect(al.routes).toHaveLength(1);
  });

  it('caps a route at MAX_ROUTE_LEGS legs', () => {
    // Alternate two hubs so there are no consecutive duplicates.
    const stops = (legs: number) =>
      Array.from({ length: legs + 1 }, (_, i) => (i % 2 === 0 ? 'crw' : 'clt'));
    expect(stops(MAX_ROUTE_LEGS)).toHaveLength(MAX_ROUTE_LEGS + 1);
    expect(openRoute(g, al, stops(MAX_ROUTE_LEGS))).toBeNull(); // at the limit: ok
    expect(openRoute(g, al, stops(MAX_ROUTE_LEGS + 1))).toMatch(/at most 8 legs/i);
    expect(al.routes).toHaveLength(1);
  });
});

describe('routeDistance & routeMaxLeg', () => {
  it('routeDistance is the sum of leg distances; routeMaxLeg is the longest', () => {
    openRoute(g, al, ['crw', 'clt', 'dca']);
    const r = lastRoute(g);
    const legs = routeLegs(g, r);
    expect(routeDistance(g, r)).toBe(legs[0].distance + legs[1].distance);
    expect(routeMaxLeg(g, r)).toBe(Math.max(legs[0].distance, legs[1].distance));
  });
});

describe('assignPlane', () => {
  it('assigns a plane to a route it can reach', () => {
    buyPlane(g, al, 'q400');
    openRoute(g, al, ['crw', 'clt']);
    expect(assignPlane(g, al, lastPlane(g).id, lastRoute(g).id)).toBeNull();
    expect(planesOnRoute(al, lastRoute(g).id)).toHaveLength(1);
  });

  it('refuses when the longest leg exceeds the aircraft range', () => {
    const custom = newGame('crw');
    custom.aircraftTypes = [{ ...TURBOPROP, id: 'shorty', range: 100 }];
    const ca = player(custom);
    ca.fleet = [{ id: 'p1', typeId: 'shorty', routeId: null, kmFlown: 0 }];
    ca.routes = [{ id: 'r1', stops: ['crw', 'clt'], fareFactor: 1 }];
    expect(assignPlane(custom, ca, 'p1', 'r1')).toMatch(/can't reach/i);
    expect(ca.fleet[0].routeId).toBeNull();
  });

  it('always allows returning a plane to the hangar', () => {
    buyPlane(g, al, 'q400');
    openRoute(g, al, ['crw', 'clt']);
    assignPlane(g, al, lastPlane(g).id, lastRoute(g).id);
    expect(assignPlane(g, al, lastPlane(g).id, null)).toBeNull();
    expect(lastPlane(g).routeId).toBeNull();
  });
});

describe('closeRoute', () => {
  it('removes the route and frees its planes back to the hangar', () => {
    buyPlane(g, al, 'q400');
    openRoute(g, al, ['crw', 'clt']);
    const routeId = lastRoute(g).id;
    assignPlane(g, al, lastPlane(g).id, routeId);

    closeRoute(g, al, routeId);
    expect(al.routes).toHaveLength(0);
    expect(lastPlane(g).routeId).toBeNull();
  });
});

describe('upgradeRoute', () => {
  it('swaps every plane on the route for the new type and keeps them assigned', () => {
    const route = addRoute(['crw', 'clt'], 'q400', 2);
    const before = al.cash;
    const quote = upgradeRouteQuote(g, al, route.id, 'e175');

    expect(upgradeRoute(g, al, route.id, 'e175')).toBeNull();
    const onRoute = al.fleet.filter((p) => p.routeId === route.id);
    expect(onRoute).toHaveLength(2);
    expect(onRoute.every((p) => p.typeId === 'e175')).toBe(true);
    // Net cash change matches the quote exactly.
    expect(al.cash).toBe(before - quote.net);
  });

  it('quote nets buy cost against resale of the planes replaced', () => {
    const route = addRoute(['crw', 'clt'], 'q400', 1);
    const plane = al.fleet.find((p) => p.routeId === route.id)!;
    const q = upgradeRouteQuote(g, al, route.id, 'e175');
    expect(q.count).toBe(1);
    expect(q.buyCost).toBe(AIRCRAFT_TYPES.find((t) => t.id === 'e175')!.price);
    expect(q.resale).toBe(planeResaleValue(g, plane));
    expect(q.net).toBe(q.buyCost - q.resale);
  });

  it('refuses when the route has no planes', () => {
    openRoute(g, al, ['crw', 'clt']);
    expect(upgradeRoute(g, al, lastRoute(g).id, 'e175')).toMatch(/no planes/i);
  });

  it("refuses a type that can't reach the route's longest leg", () => {
    const route = addRoute(['crw', 'clt'], 'e175', 1);
    const shortRange = AIRCRAFT_TYPES.reduce((a, b) => (a.range < b.range ? a : b));
    if (shortRange.range < routeMaxLeg(g, route)) {
      expect(upgradeRoute(g, al, route.id, shortRange.id)).toMatch(/can't reach/i);
    }
  });

  it('refuses a downgrade to a cheaper type', () => {
    const route = addRoute(['crw', 'clt'], 'e175', 1); // $30M jet
    expect(upgradeRoute(g, al, route.id, 'q400')).toMatch(/isn't an upgrade/i); // $20M turboprop
    expect(al.fleet.every((p) => p.typeId === 'e175')).toBe(true);
  });

  it('refuses re-buying the same type as a no-op', () => {
    const route = addRoute(['crw', 'clt'], 'e175', 1);
    expect(upgradeRoute(g, al, route.id, 'e175')).toMatch(/isn't an upgrade/i);
  });

  it('refuses when the net cost exceeds available cash', () => {
    const route = addRoute(['crw', 'clt'], 'q400', 1);
    al.cash = 0;
    expect(upgradeRoute(g, al, route.id, 'e195e2')).toMatch(/not enough cash/i);
  });
});

describe('network evaluation', () => {
  function withRoute(stops: string[], planeType = 'e175') {
    al.cash = 1_000_000_000; // economics tests aren't about affordability
    openRoute(g, al, stops);
    const route = lastRoute(g);
    buyPlane(g, al, planeType);
    assignPlane(g, al, lastPlane(g).id, route.id);
    return route;
  }

  it('carries no passengers and turns no profit with no planes', () => {
    openRoute(g, al, ['clt', 'dca']); // route exists but unflown
    const net = evaluateNetwork(g, al);
    expect(net.passengers).toBe(0);
    expect(net.revenue).toBe(0);
    expect(net.profit).toBe(0);
  });

  it('only earns in markets the airline actually connects', () => {
    withRoute(['clt', 'dca']);
    const net = evaluateNetwork(g, al);
    // CLT-DCA is served; a market touching an unserved airport (e.g. ROA) is not.
    expect(net.revenue).toBeGreaterThan(0);
    expect(net.passengers).toBeGreaterThan(0);
  });

  it('routes connecting traffic across SEPARATE routes through a shared hub', () => {
    // CVG, CMH, PIT are roughly collinear, so CVG->PIT connects via CMH.
    withRoute(['cvg', 'cmh']);
    withRoute(['cmh', 'pit']);
    const net = evaluateNetwork(g, al);
    expect(net.connectingPassengers).toBeGreaterThan(0);
  });

  it('a feeder spoke is credited for the connecting traffic it carries', () => {
    withRoute(['cvg', 'cmh']);
    const spokeId = lastRoute(g).id;
    const before = evaluateNetwork(g, al).routes.get(spokeId)!.revenue;
    withRoute(['cmh', 'pit']); // now CVG can feed onward to PIT via CMH
    const after = evaluateNetwork(g, al).routes.get(spokeId)!.revenue;
    expect(after).toBeGreaterThan(before);
  });

  it('prefers a nonstop over a connection for the same city pair', () => {
    // With a direct CRW-CVG, the through demand routes nonstop (0 connections),
    // so adding the nonstop should not increase connecting passengers there.
    withRoute(['crw', 'cvg']);
    const direct = evaluateNetwork(g, al);
    expect(direct.connectingPassengers).toBe(0);
  });

  it('reports a load factor between 0 and 1 for a flown route', () => {
    const route = withRoute(['clt', 'dca'], 'q400');
    const rs = evaluateRoute(g, al, route);
    expect(rs.loadFactor).toBeGreaterThan(0);
    expect(rs.loadFactor).toBeLessThanOrEqual(1);
  });

  it('a faster fleet lifts the route speed premium', () => {
    g.day = 21915; // 2010 — saab340 still in production
    const slow = withRoute(['clt', 'dca'], 'saab340');
    const saab = AIRCRAFT_TYPES.find((t) => t.id === 'saab340')!;
    expect(evaluateRoute(g, al, slow).speedPremium).toBeCloseTo(
      speedFareMultiplier(saab.speed, 700),
      2,
    );
    const fast = withRoute(['clt', 'cvg'], 'e175');
    expect(evaluateRoute(g, al, fast).speedPremium).toBeCloseTo(JET.speed / 700, 2);
  });

  it('the era’s best plane flies with no speed penalty', () => {
    g.day = 0; // back to 1950, when the DC-4 is the fastest thing flying
    const route = withRoute(['crw', 'clt'], 'dc4');
    expect(evaluateRoute(g, al, route).speedPremium).toBe(1);
  });

  it('no penalty while a faster type is still in its adoption window', () => {
    g.day = 0;
    const route = withRoute(['crw', 'clt'], 'dc4');
    g.day = 365 * 3 + 200; // mid-1953: Viscount is out but not yet the norm
    expect(evaluateRoute(g, al, route).speedPremium).toBe(1);
  });

  it('a brand-new faster plane earns a fare bonus during its window', () => {
    g.day = 365 * 3 + 200; // mid-1953
    const route = withRoute(['crw', 'clt'], 'viscount');
    expect(evaluateRoute(g, al, route).speedPremium).toBeCloseTo(1.2, 2);
  });

  it('a speed penalty appears once faster types settle in', () => {
    g.day = 0;
    const route = withRoute(['crw', 'clt'], 'dc4');
    g.day = 365 * 7; // ~1957: Viscount established
    const midEra = evaluateRoute(g, al, route).speedPremium;
    expect(midEra).toBeLessThan(1);
    g.day = 365 * 15; // ~1965: jet age
    const jetEra = evaluateRoute(g, al, route).speedPremium;
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
    setFareFactor(al, route.id, 2.5);
    const dearPax = evaluateNetwork(g, al).passengers;
    setFareFactor(al, route.id, 0.5);
    const cheapPax = evaluateNetwork(g, al).passengers;
    expect(cheapPax).toBeGreaterThan(dearPax);
  });
});

describe('weeklyTotals & advanceDay', () => {
  it('charges upkeep for idle planes', () => {
    al.rights = []; // isolate upkeep from slot gate fees
    buyPlane(g, al, 'q400');
    expect(weeklyTotals(g, al).cost).toBeCloseTo(TURBOPROP.weeklyUpkeep * priceLevel(g), 5);
  });

  it('includes weekly interest on outstanding debt', () => {
    al.debt = 10_000_000;
    expect(weeklyTotals(g, al).interest).toBeCloseTo(
      10_000_000 * interestRate(g, al) * (7 / 365),
      5,
    );
  });

  it('advanceDay accrues one seventh of the weekly net and ticks the day', () => {
    buyPlane(g, al, 'q400');
    const before = al.cash;
    const dayBefore = g.day;
    const net = weeklyTotals(g, al).net;
    advanceDay(g);
    expect(g.day).toBe(dayBefore + 1);
    expect(al.cash).toBeCloseTo(before + net / 7, 5);
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
    const before = al.cash;
    expect(borrow(g, al, 10_000_000)).toBe(10_000_000); // within the base credit line
    expect(al.debt).toBe(10_000_000);
    expect(al.cash).toBe(before + 10_000_000);
  });

  it('caps borrowing at the (dynamic) remaining credit line', () => {
    const limit = creditLimit(g, al);
    expect(borrow(g, al, limit + 50_000_000)).toBe(limit);
    expect(al.debt).toBe(limit);
    expect(borrow(g, al, 5_000_000)).toBe(0);
  });

  it('repaying cannot exceed debt or available cash', () => {
    borrow(g, al, 10_000_000);
    al.cash = 5_000_000;
    expect(repay(g, al, 20_000_000)).toBe(5_000_000);
    expect(al.cash).toBe(0);
    expect(al.debt).toBe(5_000_000);
  });
});

describe('dynamic credit line & interest rate', () => {
  it('a startup airline gets only the base credit line', () => {
    expect(creditLimit(g, al)).toBe(15_000_000); // no revenue, no fleet
  });

  it('credit grows with fleet collateral and revenue', () => {
    const base = creditLimit(g, al);
    al.cash = 1_000_000_000;
    buyPlane(g, al, 'e195e2'); // adds fleet collateral
    expect(creditLimit(g, al)).toBeGreaterThan(base);
    const withFleet = creditLimit(g, al);
    openRoute(g, al, ['clt', 'dca']); // now flying & earning revenue
    assignPlane(g, al, al.fleet[al.fleet.length - 1].id, lastRoute(g).id);
    expect(creditLimit(g, al)).toBeGreaterThan(withFleet);
  });

  it('a debt-free airline pays the era fed funds rate', () => {
    // These tests run in 2025 (see beforeEach), where fed funds ≈ 4.3%.
    expect(interestRate(g, al)).toBeCloseTo(fedFundsRate(g), 5);
    expect(interestRate(g, al)).toBeCloseTo(0.043, 5);
  });

  it('the rate rises with leverage', () => {
    al.debt = 5_000_000; // low leverage vs $40M starting cash
    const low = interestRate(g, al);
    al.debt = 35_000_000; // high leverage
    const high = interestRate(g, al);
    expect(high).toBeGreaterThan(low);
  });

  it('an over-leveraged, loss-making airline pays more than a solvent one', () => {
    // Solvent: lots of assets, little debt.
    al.cash = 500_000_000;
    al.debt = 5_000_000;
    const solvent = interestRate(g, al);
    // Stressed: buy a plane (now idle => operating loss), then drain cash & pile on debt.
    buyPlane(g, al, 'e195e2');
    al.cash = 1_000_000;
    al.debt = 30_000_000;
    const stressed = interestRate(g, al);
    expect(stressed).toBeGreaterThan(solvent);
    expect(stressed).toBeLessThanOrEqual(fedFundsRate(g) + 0.12); // clamped to the floating ceiling
  });

  it('fleetValue depreciates the purchase price', () => {
    buyPlane(g, al, 'e175');
    const price = AIRCRAFT_TYPES.find((t) => t.id === 'e175')!.price;
    // Brand-new plane starts at 80%; value falls toward 40% as km accumulate.
    expect(fleetValue(g, al)).toBeCloseTo(price * 0.8, 5);
    al.fleet[0].kmFlown = 5_000_000;
    expect(fleetValue(g, al)).toBeCloseTo(price * 0.4, 5);
  });
});

describe('setFareFactor', () => {
  it('clamps the fare factor to a sane band', () => {
    openRoute(g, al, ['crw', 'clt']);
    const id = lastRoute(g).id;
    setFareFactor(al, id, 99);
    expect(lastRoute(g).fareFactor).toBe(3);
    setFareFactor(al, id, 0);
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
    al.rights = ['crw', 'cvg'];
    const mem = airportById(g, 'mem');
    const near = nearestHeldAirport(g, al, mem)!;
    expect(near.id).toBe('cvg');
    expect(distanceKm(mem, near)).toBeLessThan(distanceKm(mem, airportById(g, 'crw')));
  });

  it('skips the airport itself and returns null when nothing else is held', () => {
    al.rights = ['cvg'];
    const cvg = airportById(g, 'cvg');
    expect(nearestHeldAirport(g, al, cvg)).toBeNull();
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
    const net = evaluateNetwork(g, al);
    const sum = [...net.routes.values()].reduce((s, r) => s + r.revenue, 0);
    expect(sum).toBeCloseTo(net.revenue, 4);
    // Both routes earn from the shared corridor / their markets.
    for (const r of net.routes.values()) expect(r.revenue).toBeGreaterThan(0);
  });

  it('pools capacity: a second route over a capped leg carries more of its market', () => {
    g.day = 21915; // 2010 — saab340 still in production
    // One small turboprop on a low-fare (high-demand) CLT-DCA: capacity-capped.
    const a = addRoute(['clt', 'dca'], 'saab340');
    setFareFactor(al, a.id, 0.5);
    const before = evaluateNetwork(g, al).passengers;
    // A second route adds capacity to the same CLT-DCA leg.
    addRoute(['clt', 'dca', 'pit'], 'saab340');
    setFareFactor(al, al.routes[al.routes.length - 1].id, 0.5);
    const after = evaluateNetwork(g, al).passengers;
    expect(after).toBeGreaterThan(before);
  });
});

// Task #2
describe('capacity-constrained allocation', () => {
  it('caps passengers at capacity with load factor at 1 when demand overflows', () => {
    g.day = 21915; // 2010 — saab340 still in production
    const route = addRoute(['clt', 'dca'], 'saab340');
    setFareFactor(al, route.id, 0.5); // push demand above the small plane's seats
    const cap = legCapacity(routeDistance(g, route), 'saab340');
    const rs = evaluateRoute(g, al, route);
    expect(rs.passengers).toBeCloseTo(cap, 0);
    expect(rs.loadFactor).toBeGreaterThan(0.99);
  });

  it('a demand-limited route stays below capacity (load factor < 1)', () => {
    const route = addRoute(['crw', 'gso'], 'e175'); // tiny 1x1 market
    const rs = evaluateRoute(g, al, route);
    expect(rs.loadFactor).toBeLessThan(1);
  });
});

// Task #3
describe('detour cap', () => {
  it('rejects a connection through an off-line hub (CRW-CLT-DCA ~2x detour)', () => {
    addRoute(['crw', 'clt']);
    addRoute(['clt', 'dca']);
    // CLT is far south of the CRW-DCA line, so no CRW-DCA connection forms.
    expect(evaluateNetwork(g, al).connectingPassengers).toBe(0);
  });

  it('accepts a connection through a collinear hub (CVG-CMH-PIT)', () => {
    addRoute(['cvg', 'cmh']);
    addRoute(['cmh', 'pit']);
    expect(evaluateNetwork(g, al).connectingPassengers).toBeGreaterThan(0);
  });
});

// Task #4
describe('cost right-sizing & multi-plane capacity', () => {
  it('a lightly-loaded route costs far less to fly than a capacity-capped one', () => {
    g.day = 21915; // 2010 — saab340 still in production
    const thin = addRoute(['crw', 'gso'], 'saab340'); // small market (1x2), low load
    const capped = addRoute(['clt', 'dca'], 'saab340');
    setFareFactor(al, capped.id, 0.5); // overflow the seats -> full flying
    const net = evaluateNetwork(g, al);
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
    setFareFactor(al, one.id, 0.5);
    const paxOne = evaluateRoute(g, al, one).passengers;
    buyPlane(g, al, 'saab340');
    assignPlane(g, al, al.fleet[al.fleet.length - 1].id, one.id);
    const paxTwo = evaluateRoute(g, al, one).passengers;
    expect(paxTwo).toBeGreaterThan(paxOne);
  });
});

// Task #5
describe('interest accrues through advanceDay', () => {
  it('a week of days with debt drains cash by ~the weekly interest', () => {
    al.rights = []; // isolate debt interest from slot gate fees
    borrow(g, al, 10_000_000); // within the base credit line
    al.cash = 0; // isolate debt interest from deposit interest on a cash balance
    const weeklyInterest = weeklyTotals(g, al).interest;
    const dayBefore = g.day;
    for (let i = 0; i < 7; i++) advanceDay(g);
    expect(g.day).toBe(dayBefore + 7);
    // Rate drifts slightly as cash falls, so allow a small tolerance.
    expect(Math.abs(0 - al.cash - weeklyInterest)).toBeLessThan(100);
    expect(al.debt).toBe(10_000_000); // principal unchanged
  });
});

// Task #21
describe('interest earned on positive cash', () => {
  it('pays deposit interest on a positive balance and nothing on zero/negative', () => {
    al.debt = 0;
    al.cash = 100_000_000;
    expect(weeklyTotals(g, al).interestEarned).toBeCloseTo(
      100_000_000 * depositRate(g) * (7 / 365),
      5,
    );
    al.cash = 0;
    expect(weeklyTotals(g, al).interestEarned).toBe(0);
    al.cash = -5_000_000;
    expect(weeklyTotals(g, al).interestEarned).toBe(0);
  });

  it('a debt-free week of days grows idle cash by ~the deposit interest', () => {
    al.debt = 0;
    al.rights = []; // isolate deposit interest from slot gate fees
    const start = al.cash;
    const earned = weeklyTotals(g, al).interestEarned;
    for (let i = 0; i < 7; i++) advanceDay(g);
    expect(al.cash - start).toBeCloseTo(earned, -1); // grows toward year-end
    expect(al.cash).toBeGreaterThan(start);
  });

  it('the deposit rate sits below the loan floor — parking cash never beats repaying', () => {
    expect(depositRate(g)).toBeLessThan(interestRate(g, al));
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
    al.debt = 0;
    g.day = dayForYear(1981); // expensive money
    const volckerLoan = interestRate(g, al);
    const volckerDeposit = depositRate(g);
    g.day = dayForYear(2015); // cheap money
    const zirpLoan = interestRate(g, al);
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

    setFareFactor(al, route.id, 0.5);
    const low = evaluateRoute(g, al, route);
    setFareFactor(al, route.id, 0.9);
    const high = evaluateRoute(g, al, route);

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
    openRoute(g, al, ['crw', 'clt', 'dca']);
    expect(routeLabel(g, lastRoute(g))).toBe('CRW → CLT → DCA');
  });

  it('planesOnRoute returns only the planes assigned to that route', () => {
    const route = addRoute(['clt', 'dca'], 'e175');
    buyPlane(g, al, 'q400'); // left idle in the hangar
    const on = planesOnRoute(al, route.id);
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
    const a = evaluateNetwork(g, al);
    const b = evaluateNetwork(g, al);
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
    expect(player(fresh).rights).toEqual(['crw']);
    expect(reputation(player(fresh))).toBe(1);
  });

  it('opens the regional network early but gates large airports by size', () => {
    al.rights = ['crw']; // reset to a fresh-airline footprint
    expect(rightsAvailable(g, al, 'cvg')).toBe(true); // size 3, open day 1
    expect(requiredReputation(airportById(g, 'clt'))).toBe(4); // size 5
    expect(requiredReputation(airportById(g, 'bos'))).toBe(4); // size 5
    expect(requiredReputation(airportById(g, 'lax'))).toBe(6); // size 6
    expect(rightsAvailable(g, al, 'lax')).toBe(false); // can't reach LAX on day 1
  });

  it("the airline's first slot opens immediately, the next one negotiates", () => {
    al.rights = ['crw']; // a fresh airline, home only
    al.cash = 1_000_000_000;
    expect(startNegotiation(g, al, 'gso')).toBeNull();
    expect(holdsRights(al, 'gso')).toBe(true); // instant — no wait
    expect(isNegotiating(al, 'gso')).toBe(false);
    // The second application takes the full negotiation.
    expect(startNegotiation(g, al, 'cvg')).toBeNull();
    expect(holdsRights(al, 'cvg')).toBe(false);
    expect(isNegotiating(al, 'cvg')).toBe(true);
  });

  it('filing a slot charges the fee up front but does not grant rights yet', () => {
    al.rights = ['crw', 'pit']; // past the free first slot
    al.cash = 1_000_000_000;
    const a = airportById(g, 'gso');
    const fee = rightsFee(g, a);
    expect(startNegotiation(g, al, 'gso')).toBeNull();
    expect(holdsRights(al, 'gso')).toBe(false); // not yet — it's pending
    expect(isNegotiating(al, 'gso')).toBe(true);
    expect(al.cash).toBe(1_000_000_000 - fee);
    expect(negotiationFor(al, 'gso')!.opensDay).toBe(g.day + negotiationDays(a));
  });

  it('negotiation time scales with airport size', () => {
    expect(negotiationDays(AIRPORTS.find((a) => a.size === 1)!)).toBe(60);
    expect(negotiationDays(AIRPORTS.find((a) => a.size === 2)!)).toBe(90);
    expect(negotiationDays(AIRPORTS.find((a) => a.size === 6)!)).toBe(365);
  });

  it('a merger boost raises the concurrent cap, then expires after 2 years', () => {
    al.rights = ['crw']; // base concurrent cap = 1
    expect(effectiveConcurrentCap(g, al)).toBe(1);
    grantMergerBoost(g, al);
    expect(effectiveConcurrentCap(g, al)).toBe(4); // +3 integration bonus
    g.day += 2 * 365 + 1; // past the window
    expect(effectiveConcurrentCap(g, al)).toBe(1);
  });

  it('a merger boost clears slot negotiations ~30% faster', () => {
    al.rights = ['crw', 'pit']; // past the free first slot
    al.cash = 1_000_000_000;
    const gso = airportById(g, 'gso');
    grantMergerBoost(g, al);
    expect(startNegotiation(g, al, 'gso')).toBeNull();
    expect(negotiationFor(al, 'gso')!.opensDay - g.day).toBe(Math.round(negotiationDays(gso) * 0.7));
  });

  it('a merger boost lets you file more applications at once', () => {
    al.rights = ['crw', 'clt']; // base cap 1
    al.cash = 1_000_000_000;
    grantMergerBoost(g, al);
    // cvg/cmh/ind are mid-size hubs (not easy slots); base 1 + 3 boost = 4 cap.
    expect(startNegotiation(g, al, 'cvg')).toBeNull();
    expect(startNegotiation(g, al, 'cmh')).toBeNull();
    expect(startNegotiation(g, al, 'ind')).toBeNull();
    expect(al.negotiations).toHaveLength(3);
  });

  it('a slot opens after its negotiation window and then grants rights', () => {
    al.rights = ['crw', 'pit']; // past the free first slot
    al.cash = 1_000_000_000;
    const days = negotiationDays(airportById(g, 'gso'));
    const before = reputation(al);
    startNegotiation(g, al, 'gso');
    for (let i = 0; i < days - 1; i++) advanceDay(g);
    expect(holdsRights(al, 'gso')).toBe(false); // not open yet
    advanceDay(g); // window elapsed
    expect(holdsRights(al, 'gso')).toBe(true);
    expect(isNegotiating(al, 'gso')).toBe(false);
    expect(reputation(al)).toBe(before + 1);
  });

  it('refuses a locked airport, a duplicate application, and when broke', () => {
    al.rights = ['crw', 'pit']; // past the free first slot
    al.cash = 1_000_000_000;
    expect(startNegotiation(g, al, 'lax')).toMatch(/locked/i);
    expect(startNegotiation(g, al, 'gso')).toBeNull();
    expect(startNegotiation(g, al, 'gso')).toMatch(/already negotiating/i);
    al.cash = 1000;
    expect(startNegotiation(g, al, 'ric')).toMatch(/not enough cash/i); // size 2 costs $1M
    expect(isNegotiating(al, 'ric')).toBe(false);
  });

  it('negotiates one big slot at a time to start, more as the network grows', () => {
    al.rights = ['crw', 'clt']; // past the free first slot; network of 2
    al.cash = 1_000_000_000;
    expect(concurrentCap(al)).toBe(1);
    // cvg/cmh are size-3 hubs — not "easy", so capped at one at a time.
    expect(startNegotiation(g, al, 'cvg')).toBeNull();
    expect(startNegotiation(g, al, 'cmh')).toMatch(/limit/i);
    // A bigger network lifts the base cap (+1 per 10 airports held).
    al.rights = AIRPORTS.slice(0, 10).map((a) => a.id);
    expect(concurrentCap(al)).toBe(2);
  });

  it('a small nearby airport gets a bonus negotiation to get cash flowing', () => {
    al.rights = ['crw', 'clt']; // base cap 1
    al.cash = 1_000_000_000;
    // gso/ric are small (size 2) and close to home — easy slots.
    expect(isEasySlot(g, al, airportById(g, 'gso'))).toBe(true);
    expect(startNegotiation(g, al, 'gso')).toBeNull();
    expect(startNegotiation(g, al, 'ric')).toBeNull(); // the +1 easy bonus
    expect(startNegotiation(g, al, 'tys')).toMatch(/limit/i); // base 1 + 1 easy = 2 max
    // A big hub is not easy, so it can't use the bonus even with room conceptually.
    const fresh = newGame('crw');
    player(fresh).rights = ['crw', 'clt'];
    player(fresh).cash = 1_000_000_000;
    expect(isEasySlot(fresh, player(fresh), airportById(fresh, 'lax'))).toBe(false); // size 6
  });

  it('bootstraps: growing the network unlocks the bigger regional hubs', () => {
    al.cash = 1_000_000_000;
    al.rights = ['crw'];
    expect(rightsAvailable(g, al, 'clt')).toBe(false); // size 5 regional needs rep 4
    al.rights = ['crw', 'cvg', 'pit', 'cmh']; // reputation now 4
    expect(rightsAvailable(g, al, 'clt')).toBe(true);
  });

  it('sells a slot for a partial refund, but not while routes use it', () => {
    al.rights = ['crw', 'gso'];
    al.cash = 0;
    const refund = sellRefund(g, airportById(g, 'gso'));
    expect(sellSlot(g, al, 'gso')).toBeNull();
    expect(holdsRights(al, 'gso')).toBe(false);
    expect(al.cash).toBe(refund);
    // Can't sell the home airport.
    expect(sellSlot(g, al, 'crw')).toMatch(/home/i);
  });

  it('a slot in use by a route cannot be sold until the route is closed', () => {
    al.rights = ['crw', 'clt'];
    al.cash = 1_000_000_000;
    expect(openRoute(g, al, ['crw', 'clt'])).toBeNull();
    expect(sellSlot(g, al, 'clt')).toMatch(/route/i);
  });

  it('gate fees bleed cash: 10% of each slot fee a year, accrued weekly', () => {
    al.rights = ['crw', 'gso', 'cvg']; // crw is home
    // Home base is exempt; only the two acquired slots are billed.
    const annual = gateFee(g, airportById(g, 'gso')) + gateFee(g, airportById(g, 'cvg'));
    expect(gateFeesWeekly(g, al)).toBeCloseTo((annual * 7) / 365, 6);
    expect(gateFee(g, airportById(g, 'gso'))).toBe(
      Math.round(rightsFee(g, airportById(g, 'gso')) * 0.1),
    );
  });

  it('the home airport pays no gate fee — a fresh airline bleeds nothing', () => {
    const fresh = newGame('crw');
    expect(gateFeesWeekly(fresh, player(fresh))).toBe(0);
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
    al.rights = ['crw'];
    expect(airportSlotsUsed(g, 'crw')).toBe(1);
    expect(airportSlotsUsed(g, 'gso')).toBe(0);
  });

  it('openRoute requires rights at every stop', () => {
    al.rights = ['crw', 'clt'];
    al.cash = 1_000_000_000;
    expect(openRoute(g, al, ['crw', 'dca'])).toMatch(/no landing rights at DCA/i);
    expect(openRoute(g, al, ['crw', 'clt'])).toBeNull(); // both held
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
    expect(evaluateNetwork(g, al).connectingPassengers).toBeGreaterThan(0);
  });

  it('adding onward feed improves a feeder spoke (fair fare attribution)', () => {
    const spoke = addRoute(['crw', 'clt']);
    const alone = evaluateRoute(g, al, spoke).profit;
    addRoute(['clt', 'lax'], 'e195e2'); // CLT now feeds onward; CRW carries CRW->LAX
    const fed = evaluateRoute(g, al, spoke).profit;
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
    al.cash = 10_000_000;
    al.debt = 4_000_000;
    addRoute(['crw', 'clt']);
    expect(equity(g, al)).toBeCloseTo(al.cash + fleetValue(g, al) - al.debt);
  });

  it('financeMetrics reflects the current run-rate and balance sheet', () => {
    addRoute(['crw', 'clt']);
    const w = weeklyTotals(g, al);
    const m = financeMetrics(g, al);
    expect(m.cash).toBe(al.cash);
    expect(m.debt).toBe(al.debt);
    expect(m.revenue).toBeCloseTo(w.revenue);
    expect(m.net).toBeCloseTo(w.net);
    expect(m.assets).toBeCloseTo(Math.max(0, al.cash) + fleetValue(g, al));
    expect(m.margin).toBeCloseTo(profitMargin(w.revenue, w.net));
    expect(m.roc).toBeCloseTo(returnOnCapital(m.assets, w.net));
  });
});

describe('finance history', () => {
  it('newGame seeds a single baseline snapshot', () => {
    const fresh = newGame('crw');
    expect(player(fresh).history).toHaveLength(1);
    expect(player(fresh).history[0]).toMatchObject({ day: 0, cash: STARTING_CASH, debt: 0 });
  });

  it('recordFinanceSnapshot appends a dated weekly snapshot', () => {
    addRoute(['crw', 'clt']);
    const before = al.history.length;
    const w = weeklyTotals(g, al);
    recordFinanceSnapshot(g, al);
    expect(al.history).toHaveLength(before + 1);
    const last = al.history[al.history.length - 1];
    expect(last.day).toBe(g.day);
    expect(last.revenue).toBeCloseTo(w.revenue);
    expect(last.net).toBeCloseTo(w.net);
    expect(last.fleetValue).toBeCloseTo(fleetValue(g, al));
  });

  it('caps history length so saves stay small', () => {
    for (let i = 0; i < 1700; i++) recordFinanceSnapshot(g, al);
    expect(al.history.length).toBeLessThanOrEqual(1600);
  });
});

describe('seeded RNG', () => {
  it('the same seed replays the same sequence', () => {
    const a = newGame('crw', 1234);
    const b = newGame('crw', 1234);
    const seqA = Array.from({ length: 20 }, () => rand(a));
    const seqB = Array.from({ length: 20 }, () => rand(b));
    expect(seqA).toEqual(seqB);
  });

  it('different seeds diverge and values stay in [0, 1)', () => {
    const a = newGame('crw', 1);
    const b = newGame('crw', 2);
    const seqA = Array.from({ length: 20 }, () => rand(a));
    const seqB = Array.from({ length: 20 }, () => rand(b));
    expect(seqA).not.toEqual(seqB);
    for (const v of seqA) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('newGame without a seed still starts with a valid rngState', () => {
    const fresh = newGame('crw');
    expect(Number.isInteger(fresh.rngState)).toBe(true);
    expect(fresh.rngState).toBeGreaterThanOrEqual(0);
  });
});

describe('multiple airlines', () => {
  it('the player is always airlines[0]', () => {
    const fresh = newGame('crw');
    expect(player(fresh)).toBe(fresh.airlines[0]);
    expect(player(fresh).id).toBe('player');
    expect(player(fresh).homeId).toBe('crw');
  });

  it('airportSlotsUsed counts every airline holding rights', () => {
    g.airlines.push(newAirline('ai-1', 'Rival Air', '#f5a623', 'bna'));
    al.rights = ['crw', 'gso'];
    g.airlines[1].rights = ['bna', 'gso'];
    expect(airportSlotsUsed(g, 'gso')).toBe(2);
    expect(airportSlotsUsed(g, 'crw')).toBe(1);
    expect(airportSlotsUsed(g, 'dca')).toBe(0);
  });

  it('a rival filling the slot pool blocks new applications', () => {
    // gso is size 2 -> 2 slots. Two rivals take both; the player is shut out.
    al.rights = ['crw'];
    al.cash = 1_000_000_000;
    g.airlines.push(newAirline('ai-1', 'Rival One', '#f5a623', 'gso'));
    expect(rightsAvailable(g, al, 'gso')).toBe(true); // 1 of 2 taken
    g.airlines.push(newAirline('ai-2', 'Rival Two', '#c084fc', 'bna'));
    g.airlines[2].rights.push('gso');
    expect(rightsAvailable(g, al, 'gso')).toBe(false); // full
    expect(startNegotiation(g, al, 'gso')).toMatch(/full/i);
  });

  it('advanceDay ticks every airline: cash accrues and negotiations clear for all', () => {
    const rival = newAirline('ai-1', 'Rival Air', '#f5a623', 'bna');
    g.airlines.push(rival);
    rival.negotiations.push({ airportId: 'gso', opensDay: g.day + 1, fee: 0 });
    const rivalCash = rival.cash;
    advanceDay(g);
    expect(rival.rights).toContain('gso');
    // The rival holds two slots now (one beyond home), so gate fees accrue.
    expect(rival.cash).not.toBe(rivalCash);
  });

  it('news: a rival winning a slot in a city you hold notifies the player', () => {
    al.rights = ['crw', 'gso']; // you already serve GSO
    const rival = newAirline('ai-1', 'Rival Air', '#f5a623', 'bna');
    rival.ai = { personality: 'cheapskate', nextDecisionDay: 1e9 };
    g.airlines.push(rival);
    rival.negotiations.push({ airportId: 'gso', opensDay: g.day + 1, fee: 0 });
    advanceDay(g);
    expect(al.log[0]).toMatch(/Rival Air won a slot at GSO/i);
  });

  it('news: a rival slot in a city you do NOT hold stays quiet', () => {
    al.rights = ['crw']; // you don't serve GSO
    const rival = newAirline('ai-1', 'Rival Air', '#f5a623', 'bna');
    rival.ai = { personality: 'cheapskate', nextDecisionDay: 1e9 };
    g.airlines.push(rival);
    rival.negotiations.push({ airportId: 'gso', opensDay: g.day + 1, fee: 0 });
    const before = al.log.length;
    advanceDay(g);
    expect(al.log.some((l) => /Rival Air won a slot/i.test(l))).toBe(false);
    // The player's own log only grew (if at all) from non-rival lines.
    expect(al.log.length).toBeGreaterThanOrEqual(before);
  });
});
