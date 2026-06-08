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

export const routeDistance = (g: GameState, route: Route): number =>
  distanceKm(airportById(g, route.fromId), airportById(g, route.toId));

export const planesOnRoute = (g: GameState, routeId: string): Plane[] =>
  g.fleet.filter((p) => p.routeId === routeId);

/** A sensible default fare for a route of the given distance. */
export const referenceFare = (distance: number): number =>
  Math.round(40 + 0.08 * distance);

/** Weekly passenger pool between two airports before fare effects. */
export function baseDemand(g: GameState, route: Route): number {
  const a = airportById(g, route.fromId);
  const b = airportById(g, route.toId);
  return a.size * b.size * 90;
}

/** Round trips a single plane of this type can fly per week on the route. */
export function tripsPerWeek(type: AircraftType, distance: number): number {
  const roundTripHours = (2 * distance) / type.speed + TURNAROUND_HOURS;
  return Math.max(1, Math.floor(WEEKLY_FLY_HOURS / roundTripHours));
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
  const distance = routeDistance(g, route);
  const planes = planesOnRoute(g, route.id);

  let seatsOffered = 0; // max weekly seats both directions if fully utilized
  let maxFlightCost = 0; // flying cost if every possible trip were flown
  let upkeep = 0;
  let totalSpeed = 0;
  for (const plane of planes) {
    const type = typeById(g, plane.typeId);
    const trips = tripsPerWeek(type, distance);
    // Each round trip sells seats in both directions.
    seatsOffered += trips * 2 * type.capacity;
    maxFlightCost += trips * 2 * distance * type.costPerKm;
    upkeep += type.weeklyUpkeep;
    totalSpeed += type.speed;
  }

  // Faster service lets the route command a higher fare before demand falls off.
  const avgSpeed = planes.length ? totalSpeed / planes.length : BASELINE_SPEED;
  const speedPremium = Math.max(0.85, Math.min(1.2, avgSpeed / BASELINE_SPEED));
  const ref = referenceFare(distance) * speedPremium;
  const fareRatio = route.fare / ref;
  const demandMult = Math.max(0.1, Math.min(1.5, 2 - fareRatio));
  const demand = Math.round(baseDemand(g, route) * demandMult);

  const passengers = Math.min(demand, seatsOffered);
  // Right-size frequency: only fly enough trips to carry the passengers we
  // actually have, so short, lightly-used routes don't burn fuel on empty seats.
  const utilization = seatsOffered > 0 ? passengers / seatsOffered : 0;
  const cost = utilization * maxFlightCost + upkeep;
  const revenue = passengers * route.fare;
  return {
    passengers,
    seatsOffered,
    demand,
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

export function openRoute(
  g: GameState,
  fromId: string,
  toId: string,
): string | null {
  if (fromId === toId) return 'Pick two different airports.';
  const exists = g.routes.some(
    (r) =>
      (r.fromId === fromId && r.toId === toId) ||
      (r.fromId === toId && r.toId === fromId),
  );
  if (exists) return 'That route already exists.';
  const distance = distanceKm(airportById(g, fromId), airportById(g, toId));
  const route: Route = {
    id: makeId('route'),
    fromId,
    toId,
    fare: referenceFare(distance),
  };
  g.routes.push(route);
  const a = airportById(g, fromId);
  const b = airportById(g, toId);
  g.log.unshift(`Opened route ${a.code} ⇆ ${b.code} (${distance.toLocaleString()} km).`);
  return null;
}

export function closeRoute(g: GameState, routeId: string): void {
  const route = g.routes.find((r) => r.id === routeId);
  if (!route) return;
  // Send any assigned planes back to the hangar.
  for (const plane of g.fleet) if (plane.routeId === routeId) plane.routeId = null;
  g.routes = g.routes.filter((r) => r.id !== routeId);
  const a = airportById(g, route.fromId);
  const b = airportById(g, route.toId);
  g.log.unshift(`Closed route ${a.code} ⇆ ${b.code}.`);
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
    const distance = routeDistance(g, route);
    if (type.range < distance) {
      return `${type.name} can't reach that far (range ${type.range} km, route ${distance} km).`;
    }
  }
  plane.routeId = routeId;
  return null;
}

export function setFare(g: GameState, routeId: string, fare: number): void {
  const route = g.routes.find((r) => r.id === routeId);
  if (route) route.fare = Math.max(0, Math.round(fare));
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
