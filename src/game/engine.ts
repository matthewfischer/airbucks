import type {
  AircraftType,
  Airport,
  GameState,
  Plane,
  Route,
} from './types';
import { AIRCRAFT_TYPES, AIRPORTS, STARTING_CASH } from './data';
import { distanceKm } from './geo';

/** Usable flying hours per plane per week (≈16h/day, rest is turnaround/maintenance). */
const WEEKLY_FLY_HOURS = 112;
/** Hours lost to boarding/turnaround on each round trip. */
const TURNAROUND_HOURS = 4;

let nextId = 1;
const makeId = (prefix: string) => `${prefix}-${nextId++}`;

/** Total loan principal the bank will extend. */
export const LOAN_LIMIT = 50_000_000;
/** Annual interest rate on outstanding debt. */
export const LOAN_ANNUAL_RATE = 0.08;

export function newGame(): GameState {
  return {
    day: 0,
    cash: STARTING_CASH,
    debt: 0,
    airports: AIRPORTS,
    aircraftTypes: AIRCRAFT_TYPES,
    fleet: [],
    routes: [],
    log: ['Welcome to Air Bucks! Buy a plane, open a route, then press Play.'],
  };
}

export const airportById = (g: GameState, id: string): Airport =>
  g.airports.find((a) => a.id === id)!;

export const typeById = (g: GameState, id: string): AircraftType =>
  g.aircraftTypes.find((t) => t.id === id)!;

export interface Leg {
  fromId: string;
  toId: string;
  distance: number;
}

/** Forward legs of a route's path (one entry per consecutive pair of stops). */
export function routeLegs(g: GameState, route: Route): Leg[] {
  const legs: Leg[] = [];
  for (let i = 0; i < route.stops.length - 1; i++) {
    const a = airportById(g, route.stops[i]);
    const b = airportById(g, route.stops[i + 1]);
    legs.push({ fromId: a.id, toId: b.id, distance: distanceKm(a, b) });
  }
  return legs;
}

/** Total one-way length of the route's path. */
export const routeDistance = (g: GameState, route: Route): number =>
  routeLegs(g, route).reduce((sum, l) => sum + l.distance, 0);

/** Longest single leg — what limits which aircraft can fly the route. */
export const routeMaxLeg = (g: GameState, route: Route): number =>
  routeLegs(g, route).reduce((max, l) => Math.max(max, l.distance), 0);

export const planesOnRoute = (g: GameState, routeId: string): Plane[] =>
  g.fleet.filter((p) => p.routeId === routeId);

/** A sensible fare for a single leg of the given distance. */
export const referenceFare = (distance: number): number =>
  Math.round(40 + 0.08 * distance);

/** Weekly passenger pool (both directions) between two markets, before fares. */
export const pairDemand = (a: Airport, b: Airport): number =>
  a.size * b.size * 90;

/** Round-trip circuits a plane can fly per week over a path of the given shape. */
export function tripsPerWeek(
  type: AircraftType,
  pathLength: number,
  legCount: number,
): number {
  const circuitHours =
    (2 * pathLength) / type.speed + TURNAROUND_HOURS * legCount;
  return Math.max(1, Math.floor(WEEKLY_FLY_HOURS / circuitHours));
}

/** Cruise speed at which travelers neither pay a premium nor a discount. */
const BASELINE_SPEED = 700;

export interface RouteResult {
  passengers: number;
  seatsOffered: number;
  demand: number;
  revenue: number;
  cost: number;
  profit: number;
  /** Fare-tolerance multiplier from the assigned fleet's speed (1 = neutral). */
  speedPremium: number;
}

/** Project a route's weekly economics given its currently assigned planes. */
export function evaluateRoute(g: GameState, route: Route): RouteResult {
  const legs = routeLegs(g, route);
  const pathLength = legs.reduce((sum, l) => sum + l.distance, 0);
  const planes = planesOnRoute(g, route.id);

  // Every circuit covers every leg, so each leg is offered the same seat pool.
  let seatsPerLeg = 0; // weekly seats both directions on each leg
  let fullCircuitCost = 0; // flying cost if every possible circuit were flown
  let upkeep = 0;
  let totalSpeed = 0;
  for (const plane of planes) {
    const type = typeById(g, plane.typeId);
    const circuits = tripsPerWeek(type, pathLength, legs.length);
    seatsPerLeg += circuits * 2 * type.capacity;
    fullCircuitCost += circuits * 2 * pathLength * type.costPerKm;
    upkeep += type.weeklyUpkeep;
    totalSpeed += type.speed;
  }

  // Faster service lets the route command a higher fare before demand falls off.
  const avgSpeed = planes.length ? totalSpeed / planes.length : BASELINE_SPEED;
  const speedPremium = Math.max(0.85, Math.min(1.2, avgSpeed / BASELINE_SPEED));
  const demandMult = Math.max(0.1, Math.min(1.5, 2 - route.fareFactor / speedPremium));

  // Per-leg demand, then size frequency to satisfy the busiest leg (no more).
  let totalDemand = 0;
  let maxLegDemand = 0;
  const legDemands = legs.map((leg) => {
    const dem = Math.round(
      pairDemand(airportById(g, leg.fromId), airportById(g, leg.toId)) * demandMult,
    );
    totalDemand += dem;
    maxLegDemand = Math.max(maxLegDemand, dem);
    return dem;
  });

  const utilization = seatsPerLeg > 0 ? Math.min(1, maxLegDemand / seatsPerLeg) : 0;
  const seatsFlownPerLeg = utilization * seatsPerLeg;

  let passengers = 0;
  let revenue = 0;
  legs.forEach((leg, i) => {
    const pax = Math.min(legDemands[i], seatsFlownPerLeg);
    passengers += pax;
    revenue += pax * route.fareFactor * referenceFare(leg.distance);
  });

  const cost = utilization * fullCircuitCost + upkeep;
  return {
    passengers,
    seatsOffered: seatsPerLeg * legs.length,
    demand: totalDemand,
    revenue,
    cost,
    profit: revenue - cost,
    speedPremium,
  };
}

// ---- Player actions -------------------------------------------------------

export function buyPlane(g: GameState, typeId: string): string | null {
  const type = typeById(g, typeId);
  if (g.cash < type.price) return `Not enough cash to buy ${type.name}.`;
  g.cash -= type.price;
  g.fleet.push({ id: makeId('plane'), typeId, routeId: null });
  g.log.unshift(`Bought a ${type.name} for ${money(type.price)}.`);
  return null;
}

/** Human-readable path, e.g. "CRW → CLT → DCA". */
export const routeLabel = (g: GameState, route: Route): string =>
  route.stops.map((id) => airportById(g, id).code).join(' → ');

export function openRoute(g: GameState, stops: string[]): string | null {
  if (stops.length < 2) return 'Pick at least two airports.';
  for (let i = 1; i < stops.length; i++) {
    if (stops[i] === stops[i - 1]) return 'A route cannot stop at the same airport twice in a row.';
  }
  const key = (s: string[]) => s.join('>');
  const norm = key(stops);
  const rev = key([...stops].reverse());
  if (g.routes.some((r) => key(r.stops) === norm || key(r.stops) === rev))
    return 'That route already exists.';

  const route: Route = { id: makeId('route'), stops: [...stops], fareFactor: 1 };
  g.routes.push(route);
  g.log.unshift(`Opened route ${routeLabel(g, route)}.`);
  return null;
}

export function closeRoute(g: GameState, routeId: string): void {
  const route = g.routes.find((r) => r.id === routeId);
  if (!route) return;
  const label = routeLabel(g, route);
  // Send any assigned planes back to the hangar.
  for (const plane of g.fleet) if (plane.routeId === routeId) plane.routeId = null;
  g.routes = g.routes.filter((r) => r.id !== routeId);
  g.log.unshift(`Closed route ${label}.`);
}

export function assignPlane(
  g: GameState,
  planeId: string,
  routeId: string | null,
): string | null {
  const plane = g.fleet.find((p) => p.id === planeId);
  if (!plane) return 'Unknown plane.';
  if (routeId) {
    const route = g.routes.find((r) => r.id === routeId)!;
    const type = typeById(g, plane.typeId);
    const longest = routeMaxLeg(g, route);
    if (type.range < longest) {
      return `${type.name} can't reach that far (range ${type.range} km, longest leg ${longest} km).`;
    }
  }
  plane.routeId = routeId;
  return null;
}

/** Set the route's fare level (1 = the reference fare). Clamped to a sane band. */
export function setFareFactor(g: GameState, routeId: string, factor: number): void {
  const route = g.routes.find((r) => r.id === routeId);
  if (route) route.fareFactor = Math.max(0.2, Math.min(3, factor));
}

export interface WeeklyTotals {
  revenue: number;
  cost: number;
  pax: number;
  interest: number;
  net: number;
}

/** Current weekly run-rate across the whole airline (a snapshot, not accrued). */
export function weeklyTotals(g: GameState): WeeklyTotals {
  let revenue = 0;
  let cost = 0;
  let pax = 0;
  for (const route of g.routes) {
    const r = evaluateRoute(g, route);
    revenue += r.revenue;
    cost += r.cost;
    pax += r.passengers;
  }
  // Idle planes still cost upkeep.
  for (const plane of g.fleet) {
    if (plane.routeId === null) cost += typeById(g, plane.typeId).weeklyUpkeep;
  }
  const interest = g.debt * LOAN_ANNUAL_RATE * (7 / 365);
  return { revenue, cost, pax, interest, net: revenue - cost - interest };
}

/** Advance the simulation one day: accrue 1/7 of the weekly run-rate. */
export function advanceDay(g: GameState): void {
  const w = weeklyTotals(g);
  g.cash += w.net / 7;
  g.day += 1;
}

export const weekNumber = (g: GameState): number => Math.floor(g.day / 7) + 1;

/** Borrow from the bank, up to the remaining credit line. Returns amount taken. */
export function borrow(g: GameState, amount: number): number {
  const take = Math.min(amount, LOAN_LIMIT - g.debt);
  if (take <= 0) return 0;
  g.debt += take;
  g.cash += take;
  g.log.unshift(`Borrowed ${money(take)} (debt now ${money(g.debt)}).`);
  return take;
}

/** Repay loan principal from available cash. Returns amount repaid. */
export function repay(g: GameState, amount: number): number {
  const pay = Math.min(amount, g.debt, Math.max(0, g.cash));
  if (pay <= 0) return 0;
  g.debt -= pay;
  g.cash -= pay;
  g.log.unshift(`Repaid ${money(pay)} (debt now ${money(g.debt)}).`);
  return pay;
}

export function money(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}
