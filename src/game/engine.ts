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
const idNum = (id: string) => {
  const n = Number(id.split('-')[1]);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Advance the id counter past every id already in the game, so ids minted
 * after loading a save can't collide with the loaded ones.
 */
export function reseedIds(g: GameState): void {
  let max = 0;
  for (const r of g.routes) max = Math.max(max, idNum(r.id));
  for (const p of g.fleet) max = Math.max(max, idNum(p.id));
  nextId = Math.max(nextId, max + 1);
}

/** Resale/book value of an aircraft as a fraction of its purchase price. */
const PLANE_RESALE_FRACTION = 0.6;
// Dynamic credit line: a base startup line, plus a multiple of annualized
// revenue (cash-flow capacity) and a fraction of fleet value (collateral).
const LOAN_BASE_CREDIT = 15_000_000;
const LOAN_REVENUE_MULTIPLE = 1.0;
const LOAN_COLLATERAL_FRACTION = 0.5;
const LOAN_MAX_CREDIT = 400_000_000;
// Interest rate: a floor for a solvent airline, rising with leverage and losses.
const LOAN_BASE_RATE = 0.04;
const LOAN_MAX_RATE = 0.16;

// Landing rights: an airport's slots only become available once the airline is
// big enough (reputation = number of airports held), and cost a fee by size.
// Indexed by airport size (1..6).
const RIGHTS_REQUIRED_REP = [0, 0, 0, 3, 5, 8, 11];
const RIGHTS_FEE = [0, 2_000_000, 3_000_000, 8_000_000, 15_000_000, 25_000_000, 40_000_000];

export function newGame(): GameState {
  return {
    day: 0,
    cash: STARTING_CASH,
    debt: 0,
    rights: AIRPORTS.filter((a) => a.home).map((a) => a.id),
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
/** Distance (km) at which the distance factor is exactly 1. */
const REF_DISTANCE = 400;
/** Fraction of through-travelers willing to accept each extra connection. */
const CONNECTION_PENALTY = 0.6;

/**
 * How a market's size scales with distance: shorter markets have more
 * travelers, longer ones fewer (but they pay a higher, distance-based fare).
 */
export const distanceFactor = (distance: number): number =>
  Math.max(0.4, Math.min(1.6, Math.sqrt(REF_DISTANCE / Math.max(1, distance))));

/** Maximum intermediate stops a traveler will accept on a connecting itinerary. */
const MAX_CONNECTIONS = 2;
/** A connecting path may be at most this much longer than the direct distance. */
const MAX_DETOUR = 1.4;

const legKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** Aggregate weekly capacity the airline flies over one airport-pair leg. */
interface LegInfo {
  a: string;
  b: string;
  distance: number;
  capacity: number; // weekly seats, both directions, across all routes
  speedCapSum: number; // Σ speed×capacity, for a capacity-weighted mean
  fareCapSum: number; // Σ fareFactor×capacity
  routeCap: Map<string, number>; // capacity contributed per route
}

/** A route's slice of the network result. */
export interface RouteSummary {
  routeId: string;
  /** Passenger-legs carried on this route's legs (attributed by capacity share). */
  passengers: number;
  connectingPassengers: number;
  /** This route's attributed share of fares on the legs it flies. */
  revenue: number;
  cost: number;
  profit: number;
  /** Busiest-leg load factor (0..1). */
  loadFactor: number;
  speedPremium: number;
}

/** Airline-wide weekly economics, with a per-route breakdown. */
export interface NetworkResult {
  revenue: number;
  /** Flying cost + upkeep of assigned planes (idle upkeep handled separately). */
  cost: number;
  profit: number;
  passengers: number;
  connectingPassengers: number;
  routes: Map<string, RouteSummary>;
}

interface NetPath {
  legKeys: string[];
  pathDist: number;
  connections: number;
}

/** The airline's best itinerary between two airports: fewest stops, then shortest. */
function bestPath(
  legs: Map<string, LegInfo>,
  adj: Map<string, Set<string>>,
  from: string,
  to: string,
  directDist: number,
): NetPath | null {
  let best: NetPath | null = null;
  const maxLegs = MAX_CONNECTIONS + 1;
  const visited = new Set<string>([from]);
  const keys: string[] = [];
  const walk = (node: string, dist: number) => {
    for (const next of adj.get(node) ?? []) {
      if (visited.has(next)) continue;
      const key = legKey(node, next);
      const nd = dist + legs.get(key)!.distance;
      if (nd > directDist * MAX_DETOUR + 1) continue;
      keys.push(key);
      if (next === to) {
        const connections = keys.length - 1;
        if (
          !best ||
          connections < best.connections ||
          (connections === best.connections && nd < best.pathDist)
        ) {
          best = { legKeys: [...keys], pathDist: nd, connections };
        }
      } else if (keys.length < maxLegs) {
        visited.add(next);
        walk(next, nd);
        visited.delete(next);
      }
      keys.pop();
    }
  };
  walk(from, 0);
  return best;
}

/**
 * Evaluate the whole airline as a network: pool all flying into legs, route
 * every O&D market over the best path the airline offers (nonstop or
 * connecting), and let each leg earn from every passenger flow crossing it —
 * so feeder spokes are paid for the connecting traffic they carry.
 */
export function evaluateNetwork(g: GameState): NetworkResult {
  const legs = new Map<string, LegInfo>();
  const routeFly = new Map<string, number>(); // full-frequency flying cost
  const routeUp = new Map<string, number>();
  const summaries = new Map<string, RouteSummary>();

  // 1) Build leg capacities and per-route flying cost / upkeep.
  for (const route of g.routes) {
    summaries.set(route.id, {
      routeId: route.id,
      passengers: 0,
      connectingPassengers: 0,
      revenue: 0,
      cost: 0,
      profit: 0,
      loadFactor: 0,
      speedPremium: 1,
    });
    const rlegs = routeLegs(g, route);
    const pathLength = rlegs.reduce((s, l) => s + l.distance, 0);
    let fly = 0;
    let up = 0;
    for (const plane of planesOnRoute(g, route.id)) {
      const type = typeById(g, plane.typeId);
      const circuits = tripsPerWeek(type, pathLength, rlegs.length);
      const cap = circuits * 2 * type.capacity;
      fly += circuits * 2 * pathLength * type.costPerKm;
      up += type.weeklyUpkeep;
      for (const l of rlegs) {
        const key = legKey(l.fromId, l.toId);
        let info = legs.get(key);
        if (!info) {
          info = {
            a: l.fromId,
            b: l.toId,
            distance: l.distance,
            capacity: 0,
            speedCapSum: 0,
            fareCapSum: 0,
            routeCap: new Map(),
          };
          legs.set(key, info);
        }
        info.capacity += cap;
        info.speedCapSum += type.speed * cap;
        info.fareCapSum += route.fareFactor * cap;
        info.routeCap.set(route.id, (info.routeCap.get(route.id) ?? 0) + cap);
      }
    }
    routeFly.set(route.id, fly);
    routeUp.set(route.id, up);
  }

  // Adjacency over served legs.
  const adj = new Map<string, Set<string>>();
  for (const info of legs.values()) {
    (adj.get(info.a) ?? adj.set(info.a, new Set()).get(info.a)!).add(info.b);
    (adj.get(info.b) ?? adj.set(info.b, new Set()).get(info.b)!).add(info.a);
  }

  // 2) Build every O&D market the airline can serve, with a routed path.
  interface Mkt {
    path: NetPath;
    demand: number;
    fare: number;
  }
  const markets: Mkt[] = [];
  const aps = g.airports;
  for (let i = 0; i < aps.length; i++) {
    for (let j = i + 1; j < aps.length; j++) {
      const A = aps[i];
      const B = aps[j];
      if (!adj.has(A.id) || !adj.has(B.id)) continue;
      const directDist = distanceKm(A, B);
      const path = bestPath(legs, adj, A.id, B.id, directDist);
      if (!path) continue;
      let wSpeed = 0;
      let wFare = 0;
      let wSum = 0;
      for (const key of path.legKeys) {
        const li = legs.get(key)!;
        wSpeed += (li.speedCapSum / li.capacity) * li.distance;
        wFare += (li.fareCapSum / li.capacity) * li.distance;
        wSum += li.distance;
      }
      const speedPremium = Math.max(0.85, Math.min(1.2, wSpeed / wSum / BASELINE_SPEED));
      const fareFactor = wFare / wSum;
      const demandMult = Math.max(0.1, Math.min(1.5, 2 - fareFactor / speedPremium));
      const demand =
        pairDemand(A, B) *
        distanceFactor(directDist) *
        CONNECTION_PENALTY ** path.connections *
        demandMult;
      markets.push({ path, demand, fare: referenceFare(directDist) * fareFactor });
    }
  }

  // 3) Allocate seats: highest yield-per-seat first, bottlenecked by each
  //    path's fullest leg. A connecting passenger consumes a seat on every leg.
  markets.sort(
    (m1, m2) => m2.fare / m2.path.legKeys.length - m1.fare / m1.path.legKeys.length,
  );
  const remaining = new Map<string, number>();
  for (const [k, info] of legs) remaining.set(k, info.capacity);
  const legCarried = new Map<string, number>();

  let revenue = 0;
  let passengers = 0;
  let connectingPassengers = 0;
  for (const m of markets) {
    let avail = Infinity;
    for (const key of m.path.legKeys) avail = Math.min(avail, remaining.get(key)!);
    const carried = Math.min(m.demand, Math.max(0, avail));
    if (carried <= 0) continue;
    revenue += carried * m.fare;
    passengers += carried;
    if (m.path.connections > 0) connectingPassengers += carried;
    // Split the itinerary fare across legs by each leg's standalone reference
    // fare. This gives short feeder legs a fair base share (vs. distance, which
    // would hand almost the whole long-haul fare to the longest leg), so a
    // spoke is credited enough to cover the connecting traffic it carries.
    let refSum = 0;
    for (const key of m.path.legKeys) refSum += referenceFare(legs.get(key)!.distance);
    for (const key of m.path.legKeys) {
      remaining.set(key, remaining.get(key)! - carried);
      legCarried.set(key, (legCarried.get(key) ?? 0) + carried);
      const li = legs.get(key)!;
      const legFareShare = m.fare * (referenceFare(li.distance) / refSum);
      for (const [rid, rcap] of li.routeCap) {
        const share = rcap / li.capacity;
        const rs = summaries.get(rid)!;
        rs.revenue += carried * legFareShare * share;
        rs.passengers += carried * share;
        if (m.path.connections > 0) rs.connectingPassengers += carried * share;
      }
    }
  }

  // 4) Per-route cost: fly only enough circuits to cover the busiest leg's load.
  let totalCost = 0;
  for (const route of g.routes) {
    const rs = summaries.get(route.id)!;
    let maxLF = 0;
    let wSpeed = 0;
    let wDist = 0;
    for (const l of routeLegs(g, route)) {
      const key = legKey(l.fromId, l.toId);
      const li = legs.get(key);
      if (!li || li.capacity <= 0) continue;
      maxLF = Math.max(maxLF, (legCarried.get(key) ?? 0) / li.capacity);
      wSpeed += (li.speedCapSum / li.capacity) * l.distance;
      wDist += l.distance;
    }
    rs.loadFactor = maxLF;
    rs.speedPremium =
      wDist > 0 ? Math.max(0.85, Math.min(1.2, wSpeed / wDist / BASELINE_SPEED)) : 1;
    rs.cost = maxLF * (routeFly.get(route.id) ?? 0) + (routeUp.get(route.id) ?? 0);
    rs.profit = rs.revenue - rs.cost;
    totalCost += rs.cost;
  }

  return {
    revenue,
    cost: totalCost,
    profit: revenue - totalCost,
    passengers,
    connectingPassengers,
    routes: summaries,
  };
}

const EMPTY_SUMMARY = (routeId: string): RouteSummary => ({
  routeId,
  passengers: 0,
  connectingPassengers: 0,
  revenue: 0,
  cost: 0,
  profit: 0,
  loadFactor: 0,
  speedPremium: 1,
});

/** A single route's slice of the latest network evaluation (convenience). */
export function evaluateRoute(g: GameState, route: Route): RouteSummary {
  return evaluateNetwork(g).routes.get(route.id) ?? EMPTY_SUMMARY(route.id);
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

// ---- Landing rights -------------------------------------------------------

/** Network size — how many airports the airline holds rights at. */
export const reputation = (g: GameState): number => g.rights.length;

/** Minimum reputation before an airport's rights become available to acquire. */
export const requiredReputation = (a: Airport): number =>
  RIGHTS_REQUIRED_REP[a.size] ?? 0;

/** One-time fee to acquire landing rights at an airport. */
export const rightsFee = (a: Airport): number => RIGHTS_FEE[a.size] ?? 0;

export const holdsRights = (g: GameState, airportId: string): boolean =>
  g.rights.includes(airportId);

/** True if the airline can acquire this airport now (unlocked and not held). */
export const rightsAvailable = (g: GameState, airportId: string): boolean =>
  !holdsRights(g, airportId) &&
  reputation(g) >= requiredReputation(airportById(g, airportId));

/** Buy landing rights at an airport. Returns an error string, or null on success. */
export function acquireRights(g: GameState, airportId: string): string | null {
  const a = airportById(g, airportId);
  if (holdsRights(g, airportId)) return `Already hold rights at ${a.code}.`;
  const need = requiredReputation(a);
  if (reputation(g) < need)
    return `${a.code} is locked — needs a ${need}-airport network (you have ${reputation(g)}).`;
  const fee = rightsFee(a);
  if (g.cash < fee)
    return `Not enough cash for rights at ${a.code} (${money(fee)}).`;
  g.cash -= fee;
  g.rights.push(airportId);
  g.log.unshift(`Acquired landing rights at ${a.code} (${a.city}) for ${money(fee)}.`);
  return null;
}

export function openRoute(g: GameState, stops: string[]): string | null {
  if (stops.length < 2) return 'Pick at least two airports.';
  for (let i = 1; i < stops.length; i++) {
    if (stops[i] === stops[i - 1]) return 'A route cannot stop at the same airport twice in a row.';
  }
  for (const s of stops) {
    if (!holdsRights(g, s))
      return `No landing rights at ${airportById(g, s).code} — acquire them first.`;
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
  const net = evaluateNetwork(g);
  let cost = net.cost;
  // Idle planes still cost upkeep.
  for (const plane of g.fleet) {
    if (plane.routeId === null) cost += typeById(g, plane.typeId).weeklyUpkeep;
  }
  const interest = g.debt * interestRate(g) * (7 / 365);
  return {
    revenue: net.revenue,
    cost,
    pax: net.passengers,
    interest,
    net: net.revenue - cost - interest,
  };
}

/** Advance the simulation one day: accrue 1/7 of the weekly run-rate. */
export function advanceDay(g: GameState): void {
  const w = weeklyTotals(g);
  g.cash += w.net / 7;
  g.day += 1;
}

export const weekNumber = (g: GameState): number => Math.floor(g.day / 7) + 1;

/** Depreciated resale/book value of the whole fleet. */
export function fleetValue(g: GameState): number {
  return g.fleet.reduce(
    (s, p) => s + PLANE_RESALE_FRACTION * typeById(g, p.typeId).price,
    0,
  );
}

/** Assets backing the airline: spare cash plus fleet book value. */
export const airlineAssets = (g: GameState): number =>
  Math.max(0, g.cash) + fleetValue(g);

/** Weekly operating result before debt interest — used to price loan risk. */
function operatingNet(g: GameState): number {
  const net = evaluateNetwork(g);
  let cost = net.cost;
  for (const plane of g.fleet)
    if (plane.routeId === null) cost += typeById(g, plane.typeId).weeklyUpkeep;
  return net.revenue - cost;
}

/** The bank's credit line: scales with cash flow (revenue) and collateral (fleet). */
export function creditLimit(g: GameState): number {
  const annualRevenue = evaluateNetwork(g).revenue * 52;
  const limit =
    LOAN_BASE_CREDIT +
    LOAN_REVENUE_MULTIPLE * annualRevenue +
    LOAN_COLLATERAL_FRACTION * fleetValue(g);
  return Math.min(LOAN_MAX_CREDIT, Math.round(limit));
}

/** Annual interest rate: lowest when solvent, rising with leverage and losses. */
export function interestRate(g: GameState): number {
  const assets = airlineAssets(g);
  const leverage = assets > 0 ? g.debt / assets : g.debt > 0 ? 1 : 0;
  let rate = LOAN_BASE_RATE + (LOAN_MAX_RATE - LOAN_BASE_RATE) * Math.min(1, leverage);
  if (operatingNet(g) < 0) rate += 0.02; // a loss-making airline pays more
  return Math.min(LOAN_MAX_RATE, rate);
}

/** Borrow from the bank, up to the remaining credit line. Returns amount taken. */
export function borrow(g: GameState, amount: number): number {
  const take = Math.min(amount, creditLimit(g) - g.debt);
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
