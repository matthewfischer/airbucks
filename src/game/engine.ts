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

/** Resale fraction at zero hours (brand new). */
const PLANE_RESALE_MAX = 0.8;
/** Resale fraction at full depreciation. */
const PLANE_RESALE_MIN = 0.4;
/** Km at which a plane reaches minimum resale value. */
const PLANE_LIFETIME_KM = 5_000_000;
// Dynamic credit line: a base startup line, plus a multiple of annualized
// revenue (cash-flow capacity) and a fraction of fleet value (collateral).
const LOAN_BASE_CREDIT = 15_000_000;
const LOAN_REVENUE_MULTIPLE = 1.0;
const LOAN_COLLATERAL_FRACTION = 0.5;
const LOAN_MAX_CREDIT = 400_000_000;
// Interest rate: the era's macro rate (fed funds) is the floor, plus a credit
// spread that rises with leverage and losses. The ceiling floats with the
// macro rate, so Volcker-era debt genuinely hurts and ZIRP-era debt is cheap.
const LOAN_MAX_SPREAD = 0.12; // premium over fed funds at full leverage
const LOAN_LOSS_PREMIUM = 0.02; // extra paid by a loss-making airline
// Deposit rate: what the bank pays on positive cash balances. A fixed spread
// below the macro rate, so parking cash earns a little but never beats paying
// down debt (and tracks the era — ~14% in 1981, ~0% in the 2010s).
const DEPOSIT_SPREAD = 0.02;

// Landing rights: slots become available once the airline is big enough
// (reputation = airports held), and cost a one-time fee. Indexed by size 1..6.
const RIGHTS_SIZE_REP = [0, 0, 0, 0, 2, 4, 6];
const RIGHTS_FEE =  [0, 250_000, 750_000, 1_000_000, 3_000_000, 8_000_000, 25_000_000];
// Max number of airlines that can hold rights at an airport, by size 1..6.
const AIRPORT_SLOTS = [0, 2, 3, 4, 5, 6, 8];

export const MAX_HOME_SIZE = 3;

export function newGame(homeId: string): GameState {
  return {
    day: 0,
    cash: STARTING_CASH,
    debt: 0,
    homeId,
    rights: [homeId],
    airports: AIRPORTS,
    aircraftTypes: AIRCRAFT_TYPES,
    fleet: [],
    routes: [],
    log: ['Welcome to Air Bucks! Buy a plane, open a route, then press Play.'],
    history: [{
      day: 0,
      cash: STARTING_CASH,
      debt: 0,
      fleetValue: 0,
      revenue: 0,
      cost: 0,
      interest: 0,
      interestEarned: 0,
      net: 0,
      pax: 0,
    }],
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

/** Cap on the cruise speed travelers will reward — the jet-age plateau. */
const BASELINE_SPEED_CAP = 700;

/** Years before a newly introduced type resets travelers' expectations. */
const BASELINE_ADOPTION_LAG = 3;

/**
 * The speed travelers judge fares against: the fastest type that has been in
 * service long enough to feel normal. During a new type's adoption window it
 * flies above this baseline and earns a fare bonus instead of moving the bar.
 */
export const baselineSpeed = (g: GameState): number => {
  const establishedBy = currentYear(g) - BASELINE_ADOPTION_LAG;
  const speeds = g.aircraftTypes
    .filter((t) => t.introduced <= establishedBy)
    .map((t) => t.speed);
  return Math.min(BASELINE_SPEED_CAP, Math.max(...speeds));
};

/**
 * Fare multiplier vs. the established norm: planes at or above it earn a
 * premium (capped +20%); slower craft are discounted at half their speed
 * gap, so a piston liner loses ~15% once turboprops settle in and ~25% in
 * the jet age.
 */
export const speedFareMultiplier = (speed: number, baseline: number): number =>
  speed >= baseline
    ? Math.min(1.2, speed / baseline)
    : Math.max(0.7, 1 + (speed / baseline - 1) / 2);
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
  const baseline = baselineSpeed(g);
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
      const speedPremium = speedFareMultiplier(wSpeed / wSum, baseline);
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
  const legConnecting = new Map<string, number>();

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
      if (m.path.connections > 0)
        legConnecting.set(key, (legConnecting.get(key) ?? 0) + carried);
      const li = legs.get(key)!;
      const legFareShare = m.fare * (referenceFare(li.distance) / refSum);
      for (const [rid, rcap] of li.routeCap) {
        const share = rcap / li.capacity;
        const rs = summaries.get(rid)!;
        rs.revenue += carried * legFareShare * share;
      }
    }
  }

  // 4) Per-route cost: fly only enough circuits to cover the busiest leg's load.
  //    Passengers and connecting passengers are set from the busiest leg so they
  //    stay consistent with loadFactor and don't double-count connecting pax
  //    across legs on multi-stop routes.
  let totalCost = 0;
  for (const route of g.routes) {
    const rs = summaries.get(route.id)!;
    let maxLF = 0;
    let maxLegPax = 0;
    let connectingOnMaxLeg = 0;
    let wSpeed = 0;
    let wDist = 0;
    for (const l of routeLegs(g, route)) {
      const key = legKey(l.fromId, l.toId);
      const li = legs.get(key);
      if (!li || li.capacity <= 0) continue;
      const lf = (legCarried.get(key) ?? 0) / li.capacity;
      if (lf > maxLF) {
        maxLF = lf;
        const share = (li.routeCap.get(route.id) ?? 0) / li.capacity;
        maxLegPax = (legCarried.get(key) ?? 0) * share;
        connectingOnMaxLeg = (legConnecting.get(key) ?? 0) * share;
      }
      wSpeed += (li.speedCapSum / li.capacity) * l.distance;
      wDist += l.distance;
    }
    rs.loadFactor = maxLF;
    rs.passengers = maxLegPax;
    rs.connectingPassengers = connectingOnMaxLeg;
    rs.speedPremium = wDist > 0 ? speedFareMultiplier(wSpeed / wDist, baseline) : 1;
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

/** Current resale value of a plane, based on mileage wear. */
export function planeResaleValue(g: GameState, plane: Plane): number {
  const type = typeById(g, plane.typeId);
  const wear = Math.min(1, plane.kmFlown / PLANE_LIFETIME_KM);
  const fraction = PLANE_RESALE_MAX - (PLANE_RESALE_MAX - PLANE_RESALE_MIN) * wear;
  return Math.round(fraction * type.price);
}

// ---- Calendar -------------------------------------------------------------

export const START_YEAR = 1950;
export const START_EPOCH = Date.UTC(START_YEAR, 0, 1);

export const currentYear = (g: GameState): number =>
  new Date(START_EPOCH + g.day * 86_400_000).getUTCFullYear();

// Fees and credit are quoted in modern dollars; earlier eras scale them down
// by ~3.8%/yr inflation (≈16x from 1950 to 2025). Aircraft prices don't scale:
// the roster itself is the ladder — period planes are period-cheap.
const ERA_ANCHOR_YEAR = 2025;
const ERA_INFLATION = 1.038;
export const eraScale = (g: GameState): number =>
  ERA_INFLATION ** (currentYear(g) - ERA_ANCHOR_YEAR);

// Historical fed funds rate (annual average), as sparse anchors keyed to year.
// Linearly interpolated between, clamped at the ends. Captures the shape that
// matters: the Volcker spike (~16% in '81), ZIRP (~0% in the 2010s), and the
// 2022–23 climb. This is the macro floor under loan and deposit rates.
const FED_FUNDS_ANCHORS: ReadonlyArray<readonly [number, number]> = [
  [1950, 0.015],
  [1960, 0.035],
  [1970, 0.07],
  [1975, 0.058],
  [1979, 0.11],
  [1981, 0.16],
  [1984, 0.1],
  [1990, 0.08],
  [1993, 0.03],
  [2000, 0.062],
  [2003, 0.01],
  [2007, 0.05],
  [2009, 0.002],
  [2015, 0.001],
  [2019, 0.022],
  [2020, 0.004],
  [2023, 0.051],
  [2025, 0.043],
];

/** The era's macro interest rate (annual), interpolated from history. */
export function fedFundsRate(g: GameState): number {
  const year = currentYear(g);
  const a = FED_FUNDS_ANCHORS;
  if (year <= a[0][0]) return a[0][1];
  if (year >= a[a.length - 1][0]) return a[a.length - 1][1];
  for (let i = 1; i < a.length; i++) {
    if (year <= a[i][0]) {
      const [y0, r0] = a[i - 1];
      const [y1, r1] = a[i];
      return r0 + ((r1 - r0) * (year - y0)) / (y1 - y0);
    }
  }
  return a[a.length - 1][1]; // unreachable
}

/** Years a type stays in production after introduction. */
export const PLANE_PRODUCTION_YEARS = 30;

/** Whether an aircraft type is currently available for purchase. */
export const typeAvailable = (g: GameState, type: AircraftType): boolean => {
  const year = currentYear(g);
  return type.introduced <= year && year < type.introduced + PLANE_PRODUCTION_YEARS;
};

export const availableTypes = (g: GameState): AircraftType[] =>
  g.aircraftTypes.filter((t) => typeAvailable(g, t));

export function buyPlane(g: GameState, typeId: string): string | null {
  const type = typeById(g, typeId);
  if (!typeAvailable(g, type)) {
    const year = currentYear(g);
    if (type.introduced > year)
      return `The ${type.name} doesn't enter service until ${type.introduced}.`;
    return `The ${type.name} left production in ${type.introduced + PLANE_PRODUCTION_YEARS}.`;
  }
  if (g.cash < type.price) return `Not enough cash to buy ${type.name}.`;
  g.cash -= type.price;
  g.fleet.push({ id: makeId('plane'), typeId, routeId: null, kmFlown: 0 });
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
  RIGHTS_SIZE_REP[a.size] ?? 0;

/** One-time fee to acquire landing rights at an airport, in era dollars. */
export const rightsFee = (g: GameState, a: Airport): number =>
  Math.max(1000, Math.round(((RIGHTS_FEE[a.size] ?? 0) * eraScale(g)) / 1000) * 1000);

/** Maximum number of airlines that can hold rights at an airport. */
export const airportSlotsTotal = (a: Airport): number => AIRPORT_SLOTS[a.size] ?? 2;

export const holdsRights = (g: GameState, airportId: string): boolean =>
  g.rights.includes(airportId);

/** How many airlines currently hold rights at this airport (player + future AI). */
export const airportSlotsUsed = (g: GameState, airportId: string): number =>
  holdsRights(g, airportId) ? 1 : 0;

/** True if the airline can acquire this airport now (unlocked, has open slots, not held). */
export const rightsAvailable = (g: GameState, airportId: string): boolean => {
  const a = airportById(g, airportId);
  return (
    !holdsRights(g, airportId) &&
    reputation(g) >= requiredReputation(a) &&
    airportSlotsUsed(g, airportId) < airportSlotsTotal(a)
  );
};

/** Nearest airport (other than `a`) where the airline holds rights, or null. */
export function nearestHeldAirport(g: GameState, a: Airport): Airport | null {
  let best: Airport | null = null;
  let bestD = Infinity;
  for (const id of g.rights) {
    if (id === a.id) continue;
    const other = airportById(g, id);
    const d = distanceKm(a, other);
    if (d < bestD) {
      bestD = d;
      best = other;
    }
  }
  return best;
}

/** Buy landing rights at an airport. Returns an error string, or null on success. */
export function acquireRights(g: GameState, airportId: string): string | null {
  const a = airportById(g, airportId);
  if (holdsRights(g, airportId)) return `Already hold rights at ${a.code}.`;
  const need = requiredReputation(a);
  if (reputation(g) < need)
    return `${a.code} is locked — needs a ${need}-airport network (you have ${reputation(g)}).`;
  const fee = rightsFee(g, a);
  if (g.cash < fee)
    return `Not enough cash for rights at ${a.code} (${money(fee)}).`;
  g.cash -= fee;
  g.rights.push(airportId);
  g.log.unshift(`Acquired landing rights at ${a.code} (${a.city}) for ${money(fee)}.`);
  return null;
}

/** Most legs a single route may have. Beyond this, turnaround time eats the
 *  weekly circuit and the path gets unwieldy. (legs = stops − 1.) */
export const MAX_ROUTE_LEGS = 8;

export function openRoute(g: GameState, stops: string[]): string | null {
  if (stops.length < 2) return 'Pick at least two airports.';
  if (stops.length - 1 > MAX_ROUTE_LEGS)
    return `A route can have at most ${MAX_ROUTE_LEGS} legs.`;
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

/** Sell a plane at its current mileage-based resale value. */
export function sellPlane(g: GameState, planeId: string): string | null {
  const plane = g.fleet.find((p) => p.id === planeId);
  if (!plane) return 'Unknown plane.';
  const type = typeById(g, plane.typeId);
  const proceeds = planeResaleValue(g, plane);
  g.fleet = g.fleet.filter((p) => p.id !== planeId);
  g.cash += proceeds;
  g.log.unshift(`Sold ${type.name} for ${money(proceeds)}.`);
  return null;
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

export interface UpgradeQuote {
  /** Number of planes currently on the route (the count to be replaced). */
  count: number;
  /** Total cost to buy that many of the new type. */
  buyCost: number;
  /** Total resale value of the planes being replaced. */
  resale: number;
  /** Net cash change: buyCost − resale (positive = you pay, negative = you gain). */
  net: number;
}

/** What it would cost to swap every plane on a route to `newTypeId`. Pure — no mutation. */
export function upgradeRouteQuote(g: GameState, routeId: string, newTypeId: string): UpgradeQuote {
  const planes = planesOnRoute(g, routeId);
  const buyCost = typeById(g, newTypeId).price * planes.length;
  const resale = planes.reduce((sum, p) => sum + planeResaleValue(g, p), 0);
  return { count: planes.length, buyCost, resale, net: buyCost - resale };
}

/**
 * Replace every plane on a route with a freshly bought plane of `newTypeId`,
 * keeping the route assignment so the route is never left uncovered.
 */
export function upgradeRoute(g: GameState, routeId: string, newTypeId: string): string | null {
  const route = g.routes.find((r) => r.id === routeId);
  if (!route) return 'Unknown route.';
  const type = typeById(g, newTypeId);
  if (!typeAvailable(g, type)) {
    const year = currentYear(g);
    if (type.introduced > year)
      return `The ${type.name} doesn't enter service until ${type.introduced}.`;
    return `The ${type.name} left production in ${type.introduced + PLANE_PRODUCTION_YEARS}.`;
  }
  const longest = routeMaxLeg(g, route);
  if (type.range < longest)
    return `${type.name} can't reach that far (range ${type.range} km, longest leg ${longest} km).`;
  const planes = planesOnRoute(g, routeId);
  if (planes.length === 0) return 'No planes on this route to upgrade.';
  // Upgrades only go up. Buying a cheaper type is a downgrade — do it by hand.
  const floor = Math.max(...planes.map((p) => typeById(g, p.typeId).price));
  if (type.price <= floor)
    return `The ${type.name} isn't an upgrade — sell and rebuy manually to switch to it.`;
  const quote = upgradeRouteQuote(g, routeId, newTypeId);
  if (g.cash < quote.net) return `Not enough cash to upgrade (net ${money(quote.net)}).`;
  g.cash -= quote.net;
  g.fleet = g.fleet.map((p) =>
    p.routeId === routeId ? { id: makeId('plane'), typeId: newTypeId, routeId, kmFlown: 0 } : p,
  );
  g.log.unshift(
    `Upgraded ${routeLabel(g, route)} to ${quote.count} × ${type.name} (net ${money(quote.net)}).`,
  );
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
  /** Debt interest paid this week (a cost). */
  interest: number;
  /** Deposit interest earned on positive cash this week (income). */
  interestEarned: number;
  net: number;
}

/** Annual rate the bank pays on a positive cash balance. */
export const depositRate = (g: GameState): number =>
  Math.max(0, fedFundsRate(g) - DEPOSIT_SPREAD);

/** Weekly deposit interest the airline earns on its current positive cash. */
export const cashInterestWeekly = (g: GameState): number =>
  Math.max(0, g.cash) * depositRate(g) * (7 / 365);

/** Current weekly run-rate across the whole airline (a snapshot, not accrued). */
export function weeklyTotals(g: GameState): WeeklyTotals {
  const net = evaluateNetwork(g);
  let cost = net.cost;
  // Idle planes still cost upkeep.
  for (const plane of g.fleet) {
    if (plane.routeId === null) cost += typeById(g, plane.typeId).weeklyUpkeep;
  }
  const interest = g.debt * interestRate(g) * (7 / 365);
  const interestEarned = cashInterestWeekly(g);
  return {
    revenue: net.revenue,
    cost,
    pax: net.passengers,
    interest,
    interestEarned,
    net: net.revenue - cost - interest + interestEarned,
  };
}

/** Advance the simulation one day: accrue 1/7 of the weekly run-rate. */
export function advanceDay(g: GameState): void {
  const w = weeklyTotals(g);
  g.cash += w.net / 7;
  const yearBefore = currentYear(g);
  g.day += 1;
  const year = currentYear(g);
  if (year !== yearBefore) {
    for (const t of g.aircraftTypes) {
      if (t.introduced === year)
        g.log.unshift(`✈ The ${t.name} has entered service (${year}).`);
      if (t.introduced + PLANE_PRODUCTION_YEARS === year)
        g.log.unshift(`The ${t.name} has left production (${year}).`);
    }
  }
  for (const plane of g.fleet) {
    if (!plane.routeId) continue;
    const route = g.routes.find((r) => r.id === plane.routeId);
    if (!route) continue;
    const type = typeById(g, plane.typeId);
    const rlegs = routeLegs(g, route);
    const pathLength = rlegs.reduce((s, l) => s + l.distance, 0);
    const circuits = tripsPerWeek(type, pathLength, rlegs.length);
    plane.kmFlown += (circuits * 2 * pathLength) / 7;
  }
}

export const weekNumber = (g: GameState): number => Math.floor(g.day / 7) + 1;

/** Depreciated resale/book value of the whole fleet. */
export function fleetValue(g: GameState): number {
  return g.fleet.reduce((s, p) => s + planeResaleValue(g, p), 0);
}

/** Assets backing the airline: spare cash plus fleet book value. */
export const airlineAssets = (g: GameState): number =>
  Math.max(0, g.cash) + fleetValue(g);

/** Net worth: everything the airline owns minus what it owes. */
export const equity = (g: GameState): number =>
  g.cash + fleetValue(g) - g.debt;

/** Capital base for return-on-capital: cash plus fleet, the assets put to work. */
const capitalEmployed = (assets: number): number => Math.max(1, assets);

/**
 * Net profit margin for a week: bottom-line net as a share of revenue.
 * Zero when there's no revenue (rather than undefined).
 */
export const profitMargin = (revenue: number, net: number): number =>
  revenue > 0 ? net / revenue : 0;

/**
 * Annualized return on capital: a week's net scaled to a year, over the assets
 * employed. A quick read on how hard the airline's capital is working.
 */
export const returnOnCapital = (assets: number, net: number): number =>
  (net * 52) / capitalEmployed(assets);

export interface FinanceMetrics {
  cash: number;
  debt: number;
  fleetValue: number;
  /** cash + fleet − debt. */
  equity: number;
  /** max(0, cash) + fleet. */
  assets: number;
  revenue: number;
  cost: number;
  net: number;
  /** net / revenue. */
  margin: number;
  /** annualized net / assets. */
  roc: number;
}

/** Current finance KPIs, computed from the live state's weekly run-rate. */
export function financeMetrics(g: GameState): FinanceMetrics {
  const w = weeklyTotals(g);
  const fv = fleetValue(g);
  const assets = Math.max(0, g.cash) + fv;
  return {
    cash: g.cash,
    debt: g.debt,
    fleetValue: fv,
    equity: g.cash + fv - g.debt,
    assets,
    revenue: w.revenue,
    cost: w.cost,
    net: w.net,
    margin: profitMargin(w.revenue, w.net),
    roc: returnOnCapital(assets, w.net),
  };
}

/** Append a weekly financial snapshot, capping history to keep saves small. */
export function recordFinanceSnapshot(g: GameState): void {
  const w = weeklyTotals(g);
  g.history.push({
    day: g.day,
    cash: g.cash,
    debt: g.debt,
    fleetValue: fleetValue(g),
    revenue: w.revenue,
    cost: w.cost,
    interest: w.interest,
    interestEarned: w.interestEarned,
    net: w.net,
    pax: w.pax,
  });
  // ~30 years of weekly points is plenty; drop the oldest beyond that.
  const MAX_SNAPSHOTS = 1600;
  if (g.history.length > MAX_SNAPSHOTS) g.history.shift();
}

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
  // The startup line is in era dollars; revenue and fleet value already are.
  const limit =
    LOAN_BASE_CREDIT * eraScale(g) +
    LOAN_REVENUE_MULTIPLE * annualRevenue +
    LOAN_COLLATERAL_FRACTION * fleetValue(g);
  return Math.min(LOAN_MAX_CREDIT, Math.round(limit));
}

/** Annual interest rate: the era's fed funds rate plus a credit spread that
 *  rises with leverage and losses. */
export function interestRate(g: GameState): number {
  const base = fedFundsRate(g);
  const assets = airlineAssets(g);
  const leverage = assets > 0 ? g.debt / assets : g.debt > 0 ? 1 : 0;
  let rate = base + LOAN_MAX_SPREAD * Math.min(1, leverage);
  if (operatingNet(g) < 0) rate += LOAN_LOSS_PREMIUM; // a loss-making airline pays more
  return Math.min(base + LOAN_MAX_SPREAD, rate); // ceiling floats with the era
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
