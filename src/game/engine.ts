import type {
  AircraftType,
  Airline,
  Airport,
  GameState,
  Plane,
  Route,
} from './types';
import { AIRCRAFT_TYPES, AIRPORTS, STARTING_CASH } from './data';
import { distanceKm } from './geo';
import { checkBadges } from './badges';

/** Usable flying hours per plane per week (≈16h/day, rest is turnaround/maintenance). */
const WEEKLY_FLY_HOURS = 112;
/** Hours lost to boarding/turnaround on each round trip. */
const TURNAROUND_HOURS = 4;

const makeId = (g: GameState, prefix: string) => `${prefix}-${g.nextId++}`;
const idNum = (id: string) => {
  const n = Number(id.split('-')[1]);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Advance the game's id counter past every id already in it, so ids minted
 * after loading a save can't collide with the loaded ones.
 */
export function reseedIds(g: GameState): void {
  let max = 0;
  for (const al of g.airlines) {
    for (const r of al.routes) max = Math.max(max, idNum(r.id));
    for (const p of al.fleet) max = Math.max(max, idNum(p.id));
  }
  g.nextId = Math.max(g.nextId, max + 1);
}

/** The human player's airline — by convention always airlines[0]. */
export const player = (g: GameState): Airline => g.airlines[0];

/** Push a one-line item to the player's news feed (airlines[0]'s log). */
export function playerNews(g: GameState, line: string): void {
  g.airlines[0]?.log.unshift(line);
}

/**
 * Deterministic uniform random in [0, 1): mulberry32 over g.rngState.
 * All in-game randomness (AI decisions) must draw from here so a given
 * seed replays identically.
 */
export function rand(g: GameState): number {
  g.rngState = (g.rngState + 0x6d2b79f5) >>> 0;
  let t = g.rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
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
const LOAN_REVENUE_MULTIPLE = 0.7;
const LOAN_COLLATERAL_FRACTION = 0.5;
const LOAN_MAX_CREDIT = 400_000_000;
// Loan-to-value ceiling: total debt can't exceed this fraction of assets
// (cash + fleet), so every plane and buyout needs real equity behind it — no
// infinite serial leverage. This gates *how much* you can owe; the spread above
// gates *how expensive* it is.
const LOAN_MAX_LTV = 0.5;
// Interest rate: the era's macro rate (fed funds) is the floor, plus a credit
// spread that rises with leverage and losses. The ceiling floats with the
// macro rate, so Volcker-era debt genuinely hurts and ZIRP-era debt is cheap.
const LOAN_MAX_SPREAD = 0.12; // premium over fed funds at full leverage
const LOAN_LOSS_PREMIUM = 0.02; // extra paid by a loss-making airline
// The spread is keyed to debt vs. annual revenue (what you owe vs. what you
// earn), not debt vs. assets. A winner with a huge equity cushion still pays up
// when it owes a lot relative to its income — borrowing can't get cheaper just
// because past profits piled up. Debt worth a full year of revenue pays the max.
const LOAN_FULL_SPREAD_DTR = 1.0;
// Required amortization: debt is not interest-only. Each year a slice of the
// outstanding balance comes due as principal, paid from cash on top of interest,
// so parking at the credit ceiling forever isn't free — a levered airline must
// keep generating cash to retire it.
const LOAN_AMORT_RATE = 0.2; // 20%/yr of the balance, due as principal (5-year loans)
// Deposit rate: what the bank pays on positive cash balances. A fixed spread
// below the macro rate, so parking cash earns a little but never beats paying
// down debt (and tracks the era — ~14% in 1981, ~0% in the 2010s).
const DEPOSIT_SPREAD = 0.02;

// Landing rights: slots become available once the airline is big enough
// (reputation = airports held), and cost a one-time fee. Indexed by size 1..6.
const RIGHTS_SIZE_REP = [0, 0, 0, 0, 2, 4, 6];
const RIGHTS_FEE =  [0, 250_000, 750_000, 1_000_000, 3_000_000, 8_000_000, 25_000_000];
// Max number of airlines that can hold rights at an airport, by size 1..6.
// Contested by design: small fields seat few carriers, the largest just six.
const AIRPORT_SLOTS = [0, 2, 2, 3, 4, 5, 6];

// A slot isn't bought outright — you file an application and wait for it to
// clear. Bigger airports negotiate slower (a regional in ~2 months, a mega-hub
// up to a year). Indexed by size 1..6.
const NEGOTIATION_DAYS_BY_SIZE = [0, 60, 90, 120, 180, 270, 365];
// You negotiate one slot at a time to start, earning parallelism as the network
// grows (+1 every 10 airports held).
const NEGOTIATION_BASE = 1;
const NEGOTIATION_PER_AIRPORTS = 10;
// Plus one bonus negotiation reserved for an "easy" slot: a small airport close
// to home, so a young airline can get cash flowing. It's an opening-game
// bootstrap only — it switches off once the network has its feet (5 airports),
// and "close" means close to the hub, not to a sprawling worldwide network.
const EASY_SLOT_MAX_SIZE = 2;
const EASY_SLOT_RANGE_KM = 1600; // ~1000 mi — one starter-plane hop from home
const EASY_SLOT_MAX_HELD = 5; // bonus only while still bootstrapping
// Annual gate fee to keep a slot, as a share of its one-time rights fee.
const GATE_FEE_RATE = 0.1;
// Fraction of the rights fee refunded when you sell a slot back.
const SELL_REFUND_RATE = 0.25;
export const MAX_HOME_SIZE = 3;

// Share of the airline floated to the public at launch that the picker starts on.
// Floating raises cash but dilutes the founder; 0% is a fully private bootstrap.
export const DEFAULT_FLOAT = 0.2;
// Owner id for freely-tradeable public float (mirrors PUBLIC in shares.ts; kept a
// literal here to avoid an engine→shares import cycle).
const PUBLIC_OWNER = 'public';

/** Cash raised at launch as a function of the floated fraction. 0% float is the
 *  private baseline (== STARTING_CASH); each 10% floated adds 25% more capital. */
export const startingCash = (floatPct: number): number =>
  Math.round(STARTING_CASH * (1 + floatPct * 2.5));

/** A fresh airline with the starting stake, holding only its home slot. Floats
 *  `floatPct` of itself to the public at launch (0 = fully founder-owned). */
export function newAirline(
  id: string,
  name: string,
  color: string,
  homeId: string,
  floatPct = 0,
): Airline {
  const cash = startingCash(floatPct);
  const floatShares = Math.round(floatPct * 100);
  return {
    id,
    name,
    color,
    cash,
    ...(floatShares > 0 ? { shares: { [id]: 100 - floatShares, [PUBLIC_OWNER]: floatShares } } : {}),
    debt: 0,
    homeId,
    rights: [homeId],
    negotiations: [],
    badges: [],
    fleet: [],
    routes: [],
    log: ['Welcome to Air Bucks! Buy a plane, open a route, then press Play.'],
    history: [{
      day: 0,
      cash,
      debt: 0,
      fleetValue: 0,
      revenue: 0,
      cost: 0,
      interest: 0,
      interestEarned: 0,
      net: 0,
      pax: 0,
      loadFactor: 0,
    }],
  };
}

export function newGame(homeId: string, seed?: number, floatPct = 0): GameState {
  return {
    day: 0,
    rngState: (seed ?? Math.floor(Math.random() * 2 ** 32)) >>> 0,
    nextId: 1,
    airports: AIRPORTS,
    aircraftTypes: AIRCRAFT_TYPES,
    airlines: [newAirline('player', 'Air Bucks', '#3fd0c9', homeId, floatPct)],
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

export const planesOnRoute = (al: Airline, routeId: string): Plane[] =>
  al.fleet.filter((p) => p.routeId === routeId);

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
  /** Portion of `revenue` earned on interline itineraries — through-markets the
   *  alliance jointly carries that this airline couldn't serve end-to-end alone.
   *  0 for a solo carrier. */
  interlineRevenue: number;
  /** Flying cost + upkeep of assigned planes (idle upkeep handled separately). */
  cost: number;
  profit: number;
  passengers: number;
  connectingPassengers: number;
  /** System load factor: seats filled ÷ seats offered across all legs (0..1). */
  loadFactor: number;
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

interface LegBuild {
  legs: Map<string, LegInfo>;
  adj: Map<string, Set<string>>;
  routeFly: Map<string, number>;
  routeUp: Map<string, number>;
  /** routeId → owning airline id, for per-carrier revenue/pax attribution. */
  routeOwner: Map<string, string>;
}

/** Pool a group's flying into legs: capacity, fare/speed sums, and per-route
 *  flying cost + upkeep. The group is an alliance (or a singleton for the
 *  unallied) — legs merge by city-pair across members, so a shared pair presents
 *  combined capacity and each member keeps its own routeCap share. Shared by the
 *  full network eval and the offer scan. */
function buildLegs(g: GameState, group: Airline[]): LegBuild {
  const legs = new Map<string, LegInfo>();
  const routeFly = new Map<string, number>();
  const routeUp = new Map<string, number>();
  const routeOwner = new Map<string, string>();
  for (const al of group)
  for (const route of al.routes) {
    routeOwner.set(route.id, al.id);
    const rlegs = routeLegs(g, route);
    const pathLength = rlegs.reduce((s, l) => s + l.distance, 0);
    let fly = 0;
    let up = 0;
    for (const plane of planesOnRoute(al, route.id)) {
      const type = typeById(g, plane.typeId);
      const circuits = tripsPerWeek(type, pathLength, rlegs.length);
      const cap = circuits * 2 * type.capacity;
      fly += circuits * 2 * pathLength * type.costPerKm * priceLevel(g);
      up += type.weeklyUpkeep * priceLevel(g);
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
  const adj = new Map<string, Set<string>>();
  for (const info of legs.values()) {
    (adj.get(info.a) ?? adj.set(info.a, new Set()).get(info.a)!).add(info.b);
    (adj.get(info.b) ?? adj.set(info.b, new Set()).get(info.b)!).add(info.a);
  }
  return { legs, adj, routeFly, routeUp, routeOwner };
}

interface MarketCalc {
  path: NetPath;
  /** Monopoly demand (before competition share). */
  demand: number;
  /** This airline's draw on the market: bottleneck seats × attractiveness. */
  weight: number;
  fare: number;
}

/** The airline's offer on the A↔B market: its best path, the demand that path
 *  would draw alone, and a competition weight (seats × price/speed appeal). */
function marketCalc(
  g: GameState,
  legBuild: LegBuild,
  A: Airport,
  B: Airport,
  baseline: number,
): MarketCalc | null {
  const { legs, adj } = legBuild;
  const directDist = distanceKm(A, B);
  const path = bestPath(legs, adj, A.id, B.id, directDist);
  if (!path) return null;
  let wSpeed = 0;
  let wFare = 0;
  let wSum = 0;
  let bottleneckSeats = Infinity;
  for (const key of path.legKeys) {
    const li = legs.get(key)!;
    wSpeed += (li.speedCapSum / li.capacity) * li.distance;
    wFare += (li.fareCapSum / li.capacity) * li.distance;
    wSum += li.distance;
    bottleneckSeats = Math.min(bottleneckSeats, li.capacity);
  }
  const speedPremium = speedFareMultiplier(wSpeed / wSum, baseline);
  const fareFactor = wFare / wSum;
  const demandMult = Math.max(0.1, Math.min(1.5, 2 - fareFactor / speedPremium));
  const appeal = CONNECTION_PENALTY ** path.connections * demandMult;
  return {
    path,
    demand: pairDemand(A, B) * distanceFactor(directDist) * appeal * demandLevel(g),
    weight: bottleneckSeats * appeal,
    fare: referenceFare(directDist) * fareFactor * priceLevel(g),
  };
}

/** The carriers that pool their networks with `al` (its alliance), or `[al]`
 *  alone if unallied. A solo airline is just an alliance of one — that framing
 *  lets the whole eval run group-vs-group with no special-casing. */
export function allianceGroup(g: GameState, al: Airline): Airline[] {
  if (!al.alliance) return [al];
  // Always lead with al itself — it may be a detached what-if clone that shares
  // an id with a live member but isn't in g.airlines — then add its co-members.
  const others = g.airlines.filter((x) => x.id !== al.id && x.alliance === al.alliance);
  return [al, ...others];
}

/** Competition partition key: the alliance id, or the airline's own id if solo. */
const groupKey = (al: Airline): string => al.alliance ?? al.id;

/** Max carriers in one alliance (D3): small blocs, no board-wide super-network. */
export const ALLIANCE_MAX = 3;

// One-time integration cost per route in the combined network (D4). Allying is a
// deliberate investment scaled to how much network you're plugging together —
// no standing weekly fee. The two carriers split this 50/50, so each pays
// `allianceSetupFee` (half the total): a big bloc's fee stays affordable, and
// the smaller joiner still pays a fair equal share.
const ALLIANCE_SETUP_PER_ROUTE = 250_000;

/** The one-time fee EACH side pays to form/join — half the combined network's
 *  integration cost (routes × rate × price level), split 50/50 (D4). */
export function allianceSetupFee(g: GameState, a: Airline, b: Airline): number {
  const members = new Set([...allianceGroup(g, a), ...allianceGroup(g, b)]);
  let routes = 0;
  for (const al of members) routes += al.routes.length;
  return Math.round((routes * ALLIANCE_SETUP_PER_ROUTE * priceLevel(g)) / 2);
}

/** Members the two carriers' blocs would form if they allied (self included). */
function mergedMembers(g: GameState, a: Airline, b: Airline): Set<Airline> {
  return new Set([...allianceGroup(g, a), ...allianceGroup(g, b)]);
}

/** Why `from` cannot ally with `to` right now (a player-facing reason), or null
 *  if the tie-up is legal. Exposed so the UI can label a dead Accept button. */
export function allianceBlock(g: GameState, from: Airline, to: Airline): string | null {
  if (from === to) return 'An airline cannot ally with itself.';
  if (from.alliance && from.alliance === to.alliance) return 'Already in the same alliance.';
  if (from.alliance && to.alliance) return 'Both carriers are already in alliances.';
  if (mergedMembers(g, from, to).size > ALLIANCE_MAX)
    return `An alliance can hold at most ${ALLIANCE_MAX} carriers.`;
  return null;
}

/** Whether from could legally propose an alliance to to right now (UI gate). */
export const allianceProposable = (g: GameState, from: Airline, to: Airline): boolean =>
  allianceBlock(g, from, to) === null;

/** Propose an alliance from → to. Records a pending offer; charges nothing yet. */
export function proposeAlliance(g: GameState, from: Airline, to: Airline): string | null {
  const blocked = allianceBlock(g, from, to);
  if (blocked) return blocked;
  const offers = (g.allianceOffers ??= []);
  if (offers.some((o) => o.from === from.id && o.to === to.id)) return 'Offer already pending.';
  offers.push({ from: from.id, to: to.id, day: g.day });
  return null;
}

/** Accept a pending from → to proposal: both pay the setup fee and join one
 *  bloc (a new id, or the existing one when a solo joins an alliance). */
export function acceptAlliance(g: GameState, from: Airline, to: Airline): string | null {
  const offers = g.allianceOffers ?? [];
  const idx = offers.findIndex((o) => o.from === from.id && o.to === to.id);
  if (idx < 0) return 'No such proposal.';
  const blocked = allianceBlock(g, from, to);
  if (blocked) {
    offers.splice(idx, 1); // a since-invalidated offer: drop it
    return blocked;
  }
  const fee = allianceSetupFee(g, from, to);
  if (from.cash < fee || to.cash < fee) return `Both carriers need ${money(fee)} to ally.`;
  from.cash -= fee;
  to.cash -= fee;
  const id = from.alliance ?? to.alliance ?? makeId(g, 'alliance');
  from.alliance = id;
  to.alliance = id;
  // Drop this offer and any reciprocal one between the same two carriers.
  g.allianceOffers = offers.filter(
    (o) =>
      !((o.from === from.id && o.to === to.id) || (o.from === to.id && o.to === from.id)),
  );
  if (!g.allianceOffers.length) g.allianceOffers = undefined;
  const you = g.airlines[0];
  if (from === you || to === you) {
    playerNews(g, `🤝 You formed an alliance with ${(from === you ? to : from).name}.`);
  } else {
    // A rival–rival tie-up: surface it only when it reaches into your network.
    const youHold = new Set(you?.rights ?? []);
    const touches = [from, to].some((c) =>
      c.routes.some((r) => r.stops.some((s) => youHold.has(s))),
    );
    if (touches) playerNews(g, `🤝 ${from.name} and ${to.name} formed an alliance.`);
  }
  return null;
}

/** Decline (or rescind) a pending from → to proposal. */
export function declineAlliance(g: GameState, from: Airline, to: Airline): void {
  if (!g.allianceOffers) return;
  g.allianceOffers = g.allianceOffers.filter((o) => !(o.from === from.id && o.to === to.id));
}

/** Leave the current alliance. A bloc that drops to one carrier dissolves (an
 *  alliance of one is just unallied); pending offers involving al are cleared. */
export function leaveAlliance(g: GameState, al: Airline): void {
  if (!al.alliance) return;
  al.alliance = undefined;
  sanitizeAlliances(g);
  if (g.allianceOffers)
    g.allianceOffers = g.allianceOffers.filter((o) => o.from !== al.id && o.to !== al.id);
  if (al === g.airlines[0]) playerNews(g, `👋 You left your alliance.`);
}

/** Repair alliance state after roster changes (a merge, a load): drop offers
 *  referencing vanished carriers and dissolve any bloc with fewer than 2 members. */
export function sanitizeAlliances(g: GameState): void {
  const ids = new Set(g.airlines.map((a) => a.id));
  if (g.allianceOffers) {
    const kept = g.allianceOffers.filter((o) => ids.has(o.from) && ids.has(o.to));
    g.allianceOffers = kept.length ? kept : undefined;
  }
  const counts = new Map<string, number>();
  for (const al of g.airlines)
    if (al.alliance) counts.set(al.alliance, (counts.get(al.alliance) ?? 0) + 1);
  for (const al of g.airlines)
    if (al.alliance && (counts.get(al.alliance) ?? 0) < 2) al.alliance = undefined;
}

/** Every airport-pair a group serves, keyed canonically, with the group's
 *  competition weight on that market. The raw material for the rivalry split. */
function groupOffers(g: GameState, group: Airline[]): Map<string, number> {
  const legBuild = buildLegs(g, group);
  const baseline = baselineSpeed(g);
  const served = g.airports.filter((a) => legBuild.adj.has(a.id));
  const offers = new Map<string, number>();
  for (let i = 0; i < served.length; i++) {
    for (let j = i + 1; j < served.length; j++) {
      const mc = marketCalc(g, legBuild, served[i], served[j], baseline);
      if (mc) offers.set(legKey(served[i].id, served[j].id), mc.weight);
    }
  }
  return offers;
}

interface Competition {
  sig: number;
  /** Total competition weight on each market, summed over all airlines. */
  total: Map<string, number>;
  /** Each airline's own weight per market. */
  offers: Map<string, Map<string, number>>;
}

// Per-game competition context, rebuilt only when the networks change. Transient
// (never serialized), keyed by the live game object so it can't outlive it.
const compCache = new WeakMap<GameState, Competition>();

/** Cheap structural fingerprint: changes whenever any network the offers depend
 *  on changes (day, routes, fleet assignments, fares). */
function compSignature(g: GameState): number {
  let s = g.day * 1_000_003;
  for (const al of g.airlines) {
    for (const r of al.routes)
      s += r.stops.length * 131 + Math.round(r.fareFactor * 97);
    for (const p of al.fleet) s += (p.routeId ? 17 : 3) + p.typeId.length;
    if (al.alliance) s += al.alliance.length * 149;
  }
  return s;
}

function competition(g: GameState): Competition {
  const sig = compSignature(g);
  const cached = compCache.get(g);
  if (cached && cached.sig === sig) return cached;
  // Weight is pooled per alliance group, so allied carriers present a united
  // front instead of competing. Each group is visited once (keyed by groupKey).
  const offers = new Map<string, Map<string, number>>();
  const total = new Map<string, number>();
  const seen = new Set<string>();
  for (const al of g.airlines) {
    const key = groupKey(al);
    if (seen.has(key)) continue;
    seen.add(key);
    const off = groupOffers(g, allianceGroup(g, al));
    offers.set(key, off);
    for (const [od, w] of off) total.set(od, (total.get(od) ?? 0) + w);
  }
  const ctx: Competition = { sig, total, offers };
  compCache.set(g, ctx);
  return ctx;
}

/** Combined competition weight of everyone except `al` on the A↔B market. */
export function rivalWeight(g: GameState, al: Airline, aId: string, bId: string): number {
  const ctx = competition(g);
  const od = legKey(aId, bId);
  return (ctx.total.get(od) ?? 0) - (ctx.offers.get(groupKey(al))?.get(od) ?? 0);
}

/** An airline's share of a contested market: its weight vs. the field. 1 alone. */
export const competitiveShare = (own: number, rival: number): number =>
  own + rival > 0 ? own / (own + rival) : 1;

/** Yield kept on a multi-carrier interline itinerary (D2): real interline fares
 *  leak vs. a single carrier's end-to-end fare. */
const INTERLINE_YIELD = 0.75;

/** True when the itinerary is a genuine interline hand-off — no single carrier
 *  flies every leg. A one-leg pair (even one two allies both fly) is never
 *  interline: some carrier covers the whole trip, so it keeps full fare. */
function isInterline(
  path: NetPath,
  legs: Map<string, LegInfo>,
  routeOwner: Map<string, string>,
): boolean {
  let common: Set<string> | null = null;
  for (const key of path.legKeys) {
    const owners = new Set<string>();
    for (const rid of legs.get(key)!.routeCap.keys())
      owners.add(routeOwner.get(rid)!);
    if (common === null) {
      common = owners;
    } else {
      for (const c of [...common]) if (!owners.has(c)) common.delete(c);
    }
    if (common.size === 0) return true; // no carrier spans every leg so far
  }
  return false;
}

/**
 * Evaluate `al` as a network: pool the flying of its whole alliance group (just
 * itself if unallied) into legs, route every O&D market over the best path the
 * group offers (nonstop or connecting, possibly handing off between partners at
 * a shared hub), and let each leg earn from every passenger flow crossing it —
 * so feeder spokes are paid for the connecting traffic they carry. Demand on
 * each market is split with rival groups flying the same city-pair.
 *
 * The pool is shared, but the returned totals are `al`'s own slice: revenue and
 * cost of `al`'s routes, passengers on markets `al` helps carry, load over
 * `al`'s seats. A partner's legs are captured in the pool (so through-markets
 * fill) but credited to the partner, not to `al`.
 */
export function evaluateNetwork(g: GameState, al: Airline): NetworkResult {
  const group = allianceGroup(g, al);
  const legBuild = buildLegs(g, group);
  const { legs, routeFly, routeUp, routeOwner } = legBuild;
  // Summaries span every group route: a through-market's fare is attributed to
  // whichever route flew each leg, partner routes included, so the split lands.
  const summaries = new Map<string, RouteSummary>();
  for (const member of group)
    for (const route of member.routes) {
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
    }

  // al's own seats per leg, for slicing its load factor and passengers out of the
  // pooled result (a leg shared with a partner counts only al's routeCap share).
  const alCapByLeg = new Map<string, number>();
  for (const [key, li] of legs) {
    let cap = 0;
    for (const [rid, rcap] of li.routeCap)
      if (routeOwner.get(rid) === al.id) cap += rcap;
    if (cap > 0) alCapByLeg.set(key, cap);
  }

  // Build every O&D market the group can serve, splitting each market's demand
  // with the rival groups flying the same city-pair.
  interface Mkt {
    path: NetPath;
    demand: number;
    fare: number;
    interline: boolean;
  }
  const markets: Mkt[] = [];
  const baseline = baselineSpeed(g);
  // Only airports the group actually touches can anchor a market. Filtering here
  // (preserving g.airports order) turns an all-pairs O(airports²) scan into
  // O(served²) — a large win once a network spans only a few dozen of the cities.
  const served = g.airports.filter((a) => legBuild.adj.has(a.id));
  for (let i = 0; i < served.length; i++) {
    for (let j = i + 1; j < served.length; j++) {
      const A = served[i];
      const B = served[j];
      const mc = marketCalc(g, legBuild, A, B, baseline);
      if (!mc) continue;
      const share = competitiveShare(mc.weight, rivalWeight(g, al, A.id, B.id));
      // D2: a genuine interline itinerary (no single carrier flies every leg)
      // leaks yield — earn INTERLINE_YIELD of the single-carrier fare.
      const interline = isInterline(mc.path, legs, routeOwner);
      const fare = interline ? mc.fare * INTERLINE_YIELD : mc.fare;
      markets.push({ path: mc.path, demand: mc.demand * share, fare, interline });
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

  // al's slice: passengers on any market whose path uses one of al's legs.
  let passengers = 0;
  let connectingPassengers = 0;
  // Revenue al earns specifically on interline itineraries (its alliance dividend).
  let interlineRevenue = 0;
  for (const m of markets) {
    let avail = Infinity;
    for (const key of m.path.legKeys) avail = Math.min(avail, remaining.get(key)!);
    const carried = Math.min(m.demand, Math.max(0, avail));
    if (carried <= 0) continue;
    if (m.path.legKeys.some((k) => alCapByLeg.has(k))) {
      passengers += carried;
      if (m.path.connections > 0) connectingPassengers += carried;
    }
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
        const rev = carried * legFareShare * share;
        rs.revenue += rev;
        if (m.interline && routeOwner.get(rid) === al.id) interlineRevenue += rev;
      }
    }
  }

  // System load factor over al's own seats: seats sold on al's legs (its share
  // of a shared leg's load) over al's seats offered.
  let seatsOffered = 0;
  let seatsFilled = 0;
  for (const [k, info] of legs) {
    const alCap = alCapByLeg.get(k);
    if (!alCap) continue;
    seatsOffered += alCap;
    seatsFilled += (legCarried.get(k) ?? 0) * (alCap / info.capacity);
  }
  const loadFactor = seatsOffered > 0 ? seatsFilled / seatsOffered : 0;

  // 4) Per-route cost: fly only enough circuits to cover the busiest leg's load.
  //    Passengers and connecting passengers are set from the busiest leg so they
  //    stay consistent with loadFactor and don't double-count connecting pax
  //    across legs on multi-stop routes. Only al's own routes are costed and
  //    returned; partner routes were evaluated only to fill the pooled legs.
  let revenue = 0;
  let totalCost = 0;
  for (const route of al.routes) {
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
    revenue += rs.revenue;
    totalCost += rs.cost;
  }

  // Return only al's own route summaries (partner routes stay in the pool).
  const ownRoutes = new Map<string, RouteSummary>();
  for (const route of al.routes) ownRoutes.set(route.id, summaries.get(route.id)!);

  return {
    revenue,
    interlineRevenue,
    cost: totalCost,
    profit: revenue - totalCost,
    passengers,
    connectingPassengers,
    loadFactor,
    routes: ownRoutes,
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
export function evaluateRoute(g: GameState, al: Airline, route: Route): RouteSummary {
  return evaluateNetwork(g, al).routes.get(route.id) ?? EMPTY_SUMMARY(route.id);
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

/** Calendar year of a given game-day (day 0 = START_YEAR). */
export const yearAtDay = (day: number): number =>
  new Date(START_EPOCH + day * 86_400_000).getUTCFullYear();

export const currentYear = (g: GameState): number => yearAtDay(g.day);

/** Linear interpolation over sparse [x, y] anchors (x strictly increasing),
 *  clamped flat outside the ends. The shared shape behind the historical
 *  fed-funds, and demand-cycle curves. */
function interpAnchors(anchors: ReadonlyArray<readonly [number, number]>, x: number): number {
  if (x <= anchors[0][0]) return anchors[0][1];
  const last = anchors[anchors.length - 1];
  if (x >= last[0]) return last[1];
  for (let i = 1; i < anchors.length; i++) {
    if (x <= anchors[i][0]) {
      const [x0, y0] = anchors[i - 1];
      const [x1, y1] = anchors[i];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return last[1]; // unreachable
}

// Fees and credit are quoted in modern dollars; earlier eras scale them down
// by ~3.8%/yr inflation (≈16x from 1950 to 2025). Aircraft prices don't scale:
// the roster itself is the ladder — period planes are period-cheap.
const ERA_ANCHOR_YEAR = 2025;
const ERA_INFLATION = 1.038;
export const eraScale = (g: GameState): number =>
  ERA_INFLATION ** (currentYear(g) - ERA_ANCHOR_YEAR);

// Nominal prices drift up over the decades. Fares, flying cost (fuel), and
// upkeep all ride this single index together, anchored at 1.0 in 1950 and
// ~3x by 2025 (~1.5%/yr — gentler than CPI, matching how jets made real
// airfares fall). Because revenue and operating cost scale by the same factor,
// the operating margin is preserved across every era: 1950 plays at today's
// balance, later decades just carry bigger nominal numbers.
const PRICE_LEVEL_RATE = 1.015;
export const priceLevel = (g: GameState): number =>
  PRICE_LEVEL_RATE ** (currentYear(g) - START_YEAR);

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
  return interpAnchors(FED_FUNDS_ANCHORS, currentYear(g));
}

// Demand cycle: aviation-weighted historical downturns as sparse [year, level]
// anchors (level 1.0 = normal), linearly interpolated and clamped like the
// fed-funds curve — deterministic from the calendar, no persisted state. Each
// real recession gets a trough scaled to its aviation severity, shaped by 1.0
// shoulders: 2001 (9/11) and 2020 (COVID) bite hardest, 1973–75 and 1981–82
// carry the oil shocks, the late-'50s dips stay mild. Multiplied into the
// market pool (see marketCalc), so every carrier's traffic shrinks together.
const DEMAND_ANCHORS: ReadonlyArray<readonly [number, number]> = [
  [1950, 1.0],
  [1956, 1.0], [1958, 0.86], [1959, 1.0], // 1957–58, sharp/brief
  [1961, 0.92], [1963, 1.0], // 1960–61, mild
  [1969, 1.0], [1970, 0.86], [1972, 1.0], // 1969–70, moderate
  [1974, 0.76], [1976, 1.0], // 1973–75 oil embargo, long
  [1979, 1.0], [1980, 0.88], [1981, 0.97], [1982, 0.74], [1984, 1.0], // 1980 + Volcker double-dip
  [1990, 1.0], [1991, 0.85], [1993, 1.0], // 1990–91 + Gulf War oil
  [2000, 1.0], [2001, 0.78], [2003, 1.0], // dot-com + 9/11 air-travel collapse
  [2007, 1.0], [2009, 0.68], [2011, 1.0], // Great Recession, deep/long
  [2019, 1.0], [2020, 0.52], [2022, 1.0], // COVID, catastrophic but brief
  [2025, 1.0],
];

/** Global demand multiplier for the current era (1.0 normal, dips in a known
 *  historical downturn). Scales the market pool, not competitive share. */
export function demandLevel(g: GameState): number {
  return interpAnchors(DEMAND_ANCHORS, currentYear(g));
}

const demandLevelAtDay = (day: number): number =>
  interpAnchors(DEMAND_ANCHORS, yearAtDay(day));

// A downturn is a stretch where demand sits below this; the telegraph warns
// ahead of one (the schedule is known) and notes the recovery when it lifts.
const DOWNTURN_LEVEL = 0.9;
const DOWNTURN_LOOKAHEAD_DAYS = 182; // ~6 months' warning

/** Demand is currently in a real downturn (below the threshold). */
const inDownturn = (day: number): boolean => demandLevelAtDay(day) < DOWNTURN_LEVEL;

/** Not yet in a downturn, but one begins within the lookahead window. */
const downturnAhead = (day: number): boolean =>
  demandLevelAtDay(day) >= DOWNTURN_LEVEL &&
  demandLevelAtDay(day + DOWNTURN_LOOKAHEAD_DAYS) < DOWNTURN_LEVEL;

/** A downturn window for AI caution: active, or within its run-up. */
export const inDownturnWindow = (g: GameState): boolean =>
  inDownturn(g.day) || downturnAhead(g.day);

/** Emit the player's downturn warning / recovery news at the day's transitions.
 *  Deterministic from the calendar, so it fires once per crossing. */
function telegraphDemand(g: GameState): void {
  if (downturnAhead(g.day) && !downturnAhead(g.day - 1))
    playerNews(g, '📉 Economic clouds gathering — analysts warn of a downturn ahead.');
  if (!inDownturn(g.day) && inDownturn(g.day - 1))
    playerNews(g, '📈 The economy is recovering — air-travel demand is rebounding.');
}

/** First year a type can no longer be bought; Infinity if still in production. */
export const productionEnd = (type: AircraftType): number => type.retired ?? Infinity;

/** Whether an aircraft type is currently available for purchase. */
export const typeAvailable = (g: GameState, type: AircraftType): boolean => {
  const year = currentYear(g);
  return type.introduced <= year && year < productionEnd(type);
};

export const availableTypes = (g: GameState): AircraftType[] =>
  g.aircraftTypes.filter((t) => typeAvailable(g, t));

export function buyPlane(g: GameState, al: Airline, typeId: string): string | null {
  const type = typeById(g, typeId);
  if (!typeAvailable(g, type)) {
    const year = currentYear(g);
    if (type.introduced > year)
      return `The ${type.name} doesn't enter service until ${type.introduced}.`;
    return `The ${type.name} left production in ${type.retired}.`;
  }
  if (al.cash < type.price) return `Not enough cash to buy ${type.name}.`;
  al.cash -= type.price;
  al.fleet.push({ id: makeId(g, 'plane'), typeId, routeId: null, kmFlown: 0 });
  al.log.unshift(`Bought a ${type.name} for ${money(type.price)}.`);
  return null;
}

/** Human-readable path, e.g. "CRW → CLT → DCA". */
export const routeLabel = (g: GameState, route: Route): string =>
  route.stops.map((id) => airportById(g, id).code).join(' → ');

// Aircraft makers, longest-first so "McDonnell Douglas" wins over "Douglas".
const PLANE_MAKERS = [
  'McDonnell Douglas', 'De Havilland', 'Douglas', 'Vickers', 'Lockheed',
  'Bombardier', 'Embraer', 'Boeing', 'Airbus', 'Saab',
];

/** Model name without its maker or parenthetical: "Douglas DC-4" → "DC-4". */
export function shortPlaneName(name: string): string {
  const base = name.split(' (')[0];
  for (const m of PLANE_MAKERS) if (base.startsWith(m + ' ')) return base.slice(m.length + 1);
  return base;
}

// ---- Landing rights -------------------------------------------------------

/** Network size — how many airports the airline holds rights at. */
export const reputation = (al: Airline): number => al.rights.length;

/** Minimum reputation before an airport's rights become available to acquire. */
export const requiredReputation = (a: Airport): number =>
  RIGHTS_SIZE_REP[a.size] ?? 0;

/** One-time fee to acquire landing rights at an airport, in era dollars. */
export const rightsFee = (g: GameState, a: Airport): number =>
  Math.max(1000, Math.round(((RIGHTS_FEE[a.size] ?? 0) * eraScale(g)) / 1000) * 1000);

/** Maximum number of airlines that can hold rights at an airport. */
export const airportSlotsTotal = (a: Airport): number => AIRPORT_SLOTS[a.size] ?? 2;

export const holdsRights = (al: Airline, airportId: string): boolean =>
  al.rights.includes(airportId);

/** The in-progress slot application for an airport, if any. */
export const negotiationFor = (al: Airline, airportId: string) =>
  al.negotiations.find((n) => n.airportId === airportId) ?? null;

/** True if a slot application is already running for this airport. */
export const isNegotiating = (al: Airline, airportId: string): boolean =>
  al.negotiations.some((n) => n.airportId === airportId);

/** How many airlines currently hold rights at this airport. */
export const airportSlotsUsed = (g: GameState, airportId: string): number =>
  g.airlines.filter((al) => holdsRights(al, airportId)).length;

/** Base concurrent slot applications: 1, plus one per 10 airports held. */
export const concurrentCap = (al: Airline): number =>
  NEGOTIATION_BASE + Math.floor(reputation(al) / NEGOTIATION_PER_AIRPORTS);

/** How long an airport's slot takes to negotiate, in days (bigger = slower). */
export const negotiationDays = (a: Airport): number =>
  NEGOTIATION_DAYS_BY_SIZE[a.size] ?? 60;

/** A regional slot — a small airport within starter-plane range of home. This
 *  is fixed by the airport's geometry, independent of how many slots the airline
 *  holds, so an in-progress regional stays "regional" even after the airline
 *  grows past the bootstrap window. */
export const isRegionalSlot = (g: GameState, al: Airline, a: Airport): boolean => {
  if (a.size > EASY_SLOT_MAX_SIZE) return false;
  const home = airportById(g, al.homeId);
  return distanceKm(a, home) <= EASY_SLOT_RANGE_KM;
};

/** An "easy" slot — a regional slot the airline can still *start* during the
 *  opening-game bootstrap. It grants a bonus concurrent negotiation so a young
 *  airline can get cash flowing, but only while the airline still holds fewer
 *  than EASY_SLOT_MAX_HELD airports. Crossing that threshold blocks starting a
 *  new one; it does not retroactively un-easy a regional already in progress
 *  (see hasEasyNegotiation). */
export const isEasySlot = (g: GameState, al: Airline, a: Airport): boolean =>
  reputation(al) < EASY_SLOT_MAX_HELD && isRegionalSlot(g, al, a);

/** True while a new regional bonus slot can still be started — i.e. the airline
 *  is still bootstrapping and holds fewer than EASY_SLOT_MAX_HELD airports. */
export const regionalBonusAvailable = (al: Airline): boolean =>
  reputation(al) < EASY_SLOT_MAX_HELD;

/** True if any in-progress negotiation is for a regional slot. Uses the geometry,
 *  not the bootstrap gate, so the bonus it reserves outlives the bootstrap window:
 *  landing a big slot (crossing EASY_SLOT_MAX_HELD) never retroactively locks out
 *  a regional that was already filed. */
export const hasEasyNegotiation = (g: GameState, al: Airline): boolean =>
  al.negotiations.some((n) => isRegionalSlot(g, al, airportById(g, n.airportId)));

/** Concurrent applications allowed when filing for this airport: the effective
 *  cap, plus the bonus regional slot. The bonus stays reserved for an easy slot
 *  — it counts whenever this airport is easy or an easy negotiation is already
 *  running — so a regional never eats a base slot. */
export const negotiationCapFor = (g: GameState, al: Airline, a: Airport): number =>
  concurrentCap(al) + (isEasySlot(g, al, a) || hasEasyNegotiation(g, al) ? 1 : 0);

/** Annual gate fee to keep one airport's slot, in era dollars. */
export const gateFee = (g: GameState, a: Airport): number =>
  Math.round(rightsFee(g, a) * GATE_FEE_RATE);

/** Weekly gate fee across every acquired slot (a cost). Home base is exempt. */
export const gateFeesWeekly = (g: GameState, al: Airline): number =>
  al.rights
    .filter((id) => id !== al.homeId)
    .reduce((s, id) => s + gateFee(g, airportById(g, id)), 0) * (7 / 365);

/** Cash back when selling a slot at this airport. */
export const sellRefund = (g: GameState, a: Airport): number =>
  Math.round(rightsFee(g, a) * SELL_REFUND_RATE);

/** True if a slot application could be filed now (unlocked, open slot, not held/pending). */
export const rightsAvailable = (g: GameState, al: Airline, airportId: string): boolean => {
  const a = airportById(g, airportId);
  return (
    !holdsRights(al, airportId) &&
    !isNegotiating(al, airportId) &&
    reputation(al) >= requiredReputation(a) &&
    airportSlotsUsed(g, airportId) < airportSlotsTotal(a)
  );
};

/** Nearest airport (other than `a`) where the airline holds rights, or null. */
export function nearestHeldAirport(g: GameState, al: Airline, a: Airport): Airport | null {
  let best: Airport | null = null;
  let bestD = Infinity;
  for (const id of al.rights) {
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

/** Grant landing rights immediately. Used when a slot application clears. */
function grantRights(al: Airline, airportId: string): void {
  if (!al.rights.includes(airportId)) al.rights.push(airportId);
}

/** The airline's very first slot opens immediately, so a fresh airline can
 *  start flying without sitting through a 2-month wait. Later slots negotiate. */
export const firstSlotInstant = (al: Airline): boolean =>
  al.rights.length === 1 && al.negotiations.length === 0;

/** File a slot application. Fee is paid up front; rights land after ~2 months.
 *  Returns an error string, or null on success. */
export function startNegotiation(g: GameState, al: Airline, airportId: string): string | null {
  const a = airportById(g, airportId);
  if (holdsRights(al, airportId)) return `Already hold a slot at ${a.code}.`;
  if (isNegotiating(al, airportId)) return `Already negotiating a slot at ${a.code}.`;
  const need = requiredReputation(a);
  if (reputation(al) < need)
    return `${a.code} is locked — needs a ${need}-airport network (you have ${reputation(al)}).`;
  if (airportSlotsUsed(g, airportId) >= airportSlotsTotal(a))
    return `${a.code} is full — no slots available.`;
  const cap = negotiationCapFor(g, al, a);
  if (al.negotiations.length >= cap)
    return `At your negotiation limit (${al.negotiations.length}/${cap}). Wait for one to clear.`;
  const fee = rightsFee(g, a);
  if (al.cash < fee)
    return `Not enough cash for a slot at ${a.code} (${money(fee)}).`;
  al.cash -= fee;
  if (firstSlotInstant(al)) {
    grantRights(al, airportId);
    al.log.unshift(`Acquired your first slot at ${a.code} (${a.city}) for ${money(fee)}.`);
    return null;
  }
  const days = negotiationDays(a);
  al.negotiations.push({ airportId, opensDay: g.day + days, fee });
  al.log.unshift(
    `Filed for a slot at ${a.code} (${a.city}) — ${money(fee)}, ~${Math.round(days / 30)} months.`,
  );
  return null;
}

/** Sell back a slot for a partial refund. Blocked while routes still use it.
 *  Returns an error string, or null on success. */
export function sellSlot(g: GameState, al: Airline, airportId: string): string | null {
  const a = airportById(g, airportId);
  if (!holdsRights(al, airportId)) return `No slot held at ${a.code}.`;
  if (airportId === al.homeId) return `Can't sell your home airport.`;
  const inUse = al.routes.filter((r) => r.stops.includes(airportId)).length;
  if (inUse > 0)
    return `Can't sell ${a.code} — ${inUse} route${inUse !== 1 ? 's' : ''} use it.`;
  const refund = sellRefund(g, a);
  al.cash += refund;
  al.rights = al.rights.filter((id) => id !== airportId);
  al.log.unshift(`Sold the slot at ${a.code} (${a.city}) for ${money(refund)}.`);
  return null;
}

/** Most legs a single route may have. Beyond this, turnaround time eats the
 *  weekly circuit and the path gets unwieldy. (legs = stops − 1.) */
export const MAX_ROUTE_LEGS = 8;

export function openRoute(g: GameState, al: Airline, stops: string[]): string | null {
  if (stops.length < 2) return 'Pick at least two airports.';
  if (stops.length - 1 > MAX_ROUTE_LEGS)
    return `A route can have at most ${MAX_ROUTE_LEGS} legs.`;
  for (let i = 1; i < stops.length; i++) {
    if (stops[i] === stops[i - 1]) return 'A route cannot stop at the same airport twice in a row.';
  }
  for (const s of stops) {
    if (!holdsRights(al, s))
      return `No landing rights at ${airportById(g, s).code} — acquire them first.`;
  }
  const key = (s: string[]) => s.join('>');
  const norm = key(stops);
  const rev = key([...stops].reverse());
  if (al.routes.some((r) => key(r.stops) === norm || key(r.stops) === rev))
    return 'That route already exists.';

  const route: Route = { id: makeId(g, 'route'), stops: [...stops], fareFactor: 1 };
  al.routes.push(route);
  al.log.unshift(`Opened route ${routeLabel(g, route)}.`);
  return null;
}

export function closeRoute(g: GameState, al: Airline, routeId: string): void {
  const route = al.routes.find((r) => r.id === routeId);
  if (!route) return;
  const label = routeLabel(g, route);
  // Send any assigned planes back to the hangar.
  for (const plane of al.fleet) if (plane.routeId === routeId) plane.routeId = null;
  al.routes = al.routes.filter((r) => r.id !== routeId);
  al.log.unshift(`Closed route ${label}.`);
}

/** Sell a plane at its current mileage-based resale value. */
export function sellPlane(g: GameState, al: Airline, planeId: string): string | null {
  const plane = al.fleet.find((p) => p.id === planeId);
  if (!plane) return 'Unknown plane.';
  const type = typeById(g, plane.typeId);
  const proceeds = planeResaleValue(g, plane);
  al.fleet = al.fleet.filter((p) => p.id !== planeId);
  al.cash += proceeds;
  al.log.unshift(`Sold ${type.name} for ${money(proceeds)}.`);
  return null;
}

export function assignPlane(
  g: GameState,
  al: Airline,
  planeId: string,
  routeId: string | null,
): string | null {
  const plane = al.fleet.find((p) => p.id === planeId);
  if (!plane) return 'Unknown plane.';
  if (routeId) {
    const route = al.routes.find((r) => r.id === routeId)!;
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
export function upgradeRouteQuote(g: GameState, al: Airline, routeId: string, newTypeId: string): UpgradeQuote {
  const planes = planesOnRoute(al, routeId);
  const buyCost = typeById(g, newTypeId).price * planes.length;
  const resale = planes.reduce((sum, p) => sum + planeResaleValue(g, p), 0);
  return { count: planes.length, buyCost, resale, net: buyCost - resale };
}

/**
 * Replace every plane on a route with a freshly bought plane of `newTypeId`,
 * keeping the route assignment so the route is never left uncovered.
 */
export function upgradeRoute(g: GameState, al: Airline, routeId: string, newTypeId: string): string | null {
  const route = al.routes.find((r) => r.id === routeId);
  if (!route) return 'Unknown route.';
  const type = typeById(g, newTypeId);
  if (!typeAvailable(g, type)) {
    const year = currentYear(g);
    if (type.introduced > year)
      return `The ${type.name} doesn't enter service until ${type.introduced}.`;
    return `The ${type.name} left production in ${type.retired}.`;
  }
  const longest = routeMaxLeg(g, route);
  if (type.range < longest)
    return `${type.name} can't reach that far (range ${type.range} km, longest leg ${longest} km).`;
  const planes = planesOnRoute(al, routeId);
  if (planes.length === 0) return 'No planes on this route to upgrade.';
  // Upgrades only go up. Buying a cheaper type is a downgrade — do it by hand.
  const floor = Math.max(...planes.map((p) => typeById(g, p.typeId).price));
  if (type.price <= floor)
    return `The ${type.name} isn't an upgrade — sell and rebuy manually to switch to it.`;
  const quote = upgradeRouteQuote(g, al, routeId, newTypeId);
  if (al.cash < quote.net) return `Not enough cash to upgrade (net ${money(quote.net)}).`;
  al.cash -= quote.net;
  al.fleet = al.fleet.map((p) =>
    p.routeId === routeId ? { id: makeId(g, 'plane'), typeId: newTypeId, routeId, kmFlown: 0 } : p,
  );
  al.log.unshift(
    `Upgraded ${routeLabel(g, route)} to ${quote.count} × ${type.name} (net ${money(quote.net)}).`,
  );
  return null;
}

/** Set the route's fare level (1 = the reference fare). Clamped to a sane band. */
export function setFareFactor(al: Airline, routeId: string, factor: number): void {
  const route = al.routes.find((r) => r.id === routeId);
  if (route) route.fareFactor = Math.max(0.2, Math.min(3, factor));
}

export interface WeeklyTotals {
  revenue: number;
  /** Slice of `revenue` from interline itineraries (alliance dividend). */
  interlineRevenue: number;
  cost: number;
  pax: number;
  /** System load factor this week: seats filled ÷ seats offered (0..1). */
  loadFactor: number;
  /** Debt interest paid this week (a cost). */
  interest: number;
  /** Required principal repayment this week (a cash outflow, not a P&L cost). */
  principal: number;
  /** Deposit interest earned on positive cash this week (income). */
  interestEarned: number;
  net: number;
}

/** Annual rate the bank pays on a positive cash balance. */
export const depositRate = (g: GameState): number =>
  Math.max(0, fedFundsRate(g) - DEPOSIT_SPREAD);

/** Weekly deposit interest the airline earns on its current positive cash. */
export const cashInterestWeekly = (g: GameState, al: Airline): number =>
  Math.max(0, al.cash) * depositRate(g) * (7 / 365);

/** Current weekly run-rate across the whole airline (a snapshot, not accrued). */
export function weeklyTotals(g: GameState, al: Airline): WeeklyTotals {
  const net = evaluateNetwork(g, al);
  let cost = net.cost;
  // Idle planes still cost upkeep.
  for (const plane of al.fleet) {
    if (plane.routeId === null)
      cost += typeById(g, plane.typeId).weeklyUpkeep * priceLevel(g);
  }
  cost += gateFeesWeekly(g, al);
  const interest = al.debt * interestRate(g, al) * (7 / 365);
  const principal = al.debt * LOAN_AMORT_RATE * (7 / 365);
  const interestEarned = cashInterestWeekly(g, al);
  return {
    revenue: net.revenue,
    interlineRevenue: net.interlineRevenue,
    cost,
    pax: net.passengers,
    loadFactor: net.loadFactor,
    interest,
    principal,
    interestEarned,
    // Principal is a balance-sheet move (cash down, debt down), not a P&L cost,
    // so it stays out of net — but it's a real cash draw, applied in advanceDay.
    net: net.revenue - cost - interest + interestEarned,
  };
}

/** Advance the simulation one day: accrue 1/7 of each airline's weekly run-rate. */
export function advanceDay(g: GameState): void {
  // Snapshot every run-rate before the day ticks, so airline order can't matter.
  const totals = g.airlines.map((al) => weeklyTotals(g, al));
  const yearBefore = currentYear(g);
  g.day += 1;
  const year = currentYear(g);
  telegraphDemand(g); // warn ahead of / note recovery from a scheduled downturn
  for (let i = 0; i < g.airlines.length; i++) {
    const al = g.airlines[i];
    al.cash += totals[i].net / 7;
    // Required principal repayment: retire a slice of debt from cash each day,
    // on top of the interest already in net. Can draw cash negative — that's the
    // pressure that pushes an over-borrowed airline toward distress.
    const principalDue = Math.min(totals[i].principal / 7, al.debt);
    al.debt -= principalDue;
    al.cash -= principalDue;
    // Clear any slot applications that have come through.
    if (al.negotiations.length) {
      const cleared = al.negotiations.filter((n) => g.day >= n.opensDay);
      const isPlayer = al === g.airlines[0];
      for (const n of cleared) {
        const a = airportById(g, n.airportId);
        // Re-check the pool: a rival may have filled the last gate while this
        // application was pending. The loser of the race gets its fee back.
        if (!holdsRights(al, n.airportId) && airportSlotsUsed(g, n.airportId) >= airportSlotsTotal(a)) {
          al.cash += n.fee;
          al.log.unshift(`Slot at ${a.code} (${a.city}) fell through — the gate filled first. Fee refunded.`);
          continue;
        }
        grantRights(al, n.airportId);
        al.log.unshift(`Slot at ${a.code} (${a.city}) is open — you're now flying there.`);
        // A rival landing a slot at a city you also hold is worth a heads-up —
        // with how tight the gate is getting, so you can grab a slot before
        // it's gone (or know you've been locked out).
        if (!isPlayer && g.airlines[0].rights.includes(n.airportId)) {
          const left = airportSlotsTotal(a) - airportSlotsUsed(g, n.airportId);
          const tail =
            left <= 0
              ? `took the last slot — ${a.code} is now full.`
              : `won a slot at ${a.code} (${a.city}) — ${left} slot${left !== 1 ? 's' : ''} left.`;
          playerNews(g, `✈ ${al.name} ${tail}`);
        }
      }
      if (cleared.length)
        al.negotiations = al.negotiations.filter((n) => g.day < n.opensDay);
    }
    if (year !== yearBefore) {
      for (const t of g.aircraftTypes) {
        if (t.introduced === year)
          al.log.unshift(`✈ The ${t.name} has entered service (${year}).`);
        if (t.retired === year)
          al.log.unshift(`The ${t.name} has left production (${year}).`);
      }
    }
    for (const plane of al.fleet) {
      if (!plane.routeId) continue;
      const route = al.routes.find((r) => r.id === plane.routeId);
      if (!route) continue;
      const type = typeById(g, plane.typeId);
      const rlegs = routeLegs(g, route);
      const pathLength = rlegs.reduce((s, l) => s + l.distance, 0);
      const circuits = tripsPerWeek(type, pathLength, rlegs.length);
      plane.kmFlown += (circuits * 2 * pathLength) / 7;
    }
    checkBadges(g, al);
  }
}

export const weekNumber = (g: GameState): number => Math.floor(g.day / 7) + 1;

/** Depreciated resale/book value of the whole fleet. */
export function fleetValue(g: GameState, al: Airline): number {
  return al.fleet.reduce((s, p) => s + planeResaleValue(g, p), 0);
}

/** Assets backing the airline: spare cash plus fleet book value. */
export const airlineAssets = (g: GameState, al: Airline): number =>
  Math.max(0, al.cash) + fleetValue(g, al);

/** Net worth: everything the airline owns minus what it owes. */
export const equity = (g: GameState, al: Airline): number =>
  al.cash + fleetValue(g, al) - al.debt;

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
  /** Passengers carried this week. */
  pax: number;
  /** Planes owned. */
  fleetSize: number;
  /** Weekly net ÷ planes owned (0 with an empty fleet). */
  profitPerPlane: number;
  /** System load factor: seats filled ÷ seats offered (0..1). */
  loadFactor: number;
}

/** Current finance KPIs, computed from the live state's weekly run-rate. */
export function financeMetrics(g: GameState, al: Airline): FinanceMetrics {
  const w = weeklyTotals(g, al);
  const fv = fleetValue(g, al);
  const assets = Math.max(0, al.cash) + fv;
  return {
    cash: al.cash,
    debt: al.debt,
    fleetValue: fv,
    equity: al.cash + fv - al.debt,
    assets,
    revenue: w.revenue,
    cost: w.cost,
    net: w.net,
    margin: profitMargin(w.revenue, w.net),
    roc: returnOnCapital(assets, w.net),
    pax: w.pax,
    fleetSize: al.fleet.length,
    profitPerPlane: al.fleet.length > 0 ? w.net / al.fleet.length : 0,
    loadFactor: w.loadFactor,
  };
}

export interface FinalStats {
  /** Longest route by total path distance, or null with no routes. */
  longestRoute: { label: string; distanceKm: number } | null;
  /** Lifetime passengers flown, summed across weekly history. */
  paxCarried: number;
  /** Highest net worth ever recorded (peaks above the final figure on a downturn). */
  peakNetWorth: number;
  fleetSize: number;
  /** Most-flown aircraft type in the fleet, ties broken by capacity. */
  flagship: { name: string; count: number } | null;
  rivalsAbsorbed: number;
  awards: number;
  routes: number;
  /** Total one-way legs across every route. */
  legs: number;
}

/** End-of-game scorecard for an airline: the standout numbers from its run. */
export function finalStats(g: GameState, al: Airline): FinalStats {
  let longestRoute: FinalStats['longestRoute'] = null;
  let legs = 0;
  for (const r of al.routes) {
    legs += r.stops.length - 1;
    const distanceKm = routeDistance(g, r);
    if (!longestRoute || distanceKm > longestRoute.distanceKm)
      longestRoute = { label: routeLabel(g, r), distanceKm };
  }

  const paxCarried = al.history.reduce((sum, s) => sum + s.pax, 0);
  const peakNetWorth = al.history.reduce(
    (peak, s) => Math.max(peak, s.cash + s.fleetValue - s.debt),
    equity(g, al),
  );

  // Flagship: the type the airline owns the most of; ties go to the roomier plane.
  const counts = new Map<string, number>();
  for (const p of al.fleet) counts.set(p.typeId, (counts.get(p.typeId) ?? 0) + 1);
  let flagship: FinalStats['flagship'] = null;
  let best = { count: 0, capacity: 0 };
  for (const [typeId, count] of counts) {
    const t = typeById(g, typeId);
    if (count > best.count || (count === best.count && t.capacity > best.capacity)) {
      best = { count, capacity: t.capacity };
      flagship = { name: t.name, count };
    }
  }

  return {
    longestRoute,
    paxCarried,
    peakNetWorth,
    fleetSize: al.fleet.length,
    flagship,
    rivalsAbsorbed: al.acquisitions ?? 0,
    awards: al.badges.length,
    routes: al.routes.length,
    legs,
  };
}

/** Append a weekly financial snapshot, capping history to keep saves small. */
export function recordFinanceSnapshot(g: GameState, al: Airline): void {
  const w = weeklyTotals(g, al);
  al.history.push({
    day: g.day,
    cash: al.cash,
    debt: al.debt,
    fleetValue: fleetValue(g, al),
    revenue: w.revenue,
    interlineRevenue: w.interlineRevenue,
    cost: w.cost,
    interest: w.interest,
    interestEarned: w.interestEarned,
    loanRate: interestRate(g, al),
    depositRate: depositRate(g),
    net: w.net,
    pax: w.pax,
    loadFactor: w.loadFactor,
  });
  // ~30 years of weekly points is plenty; drop the oldest beyond that.
  const MAX_SNAPSHOTS = 1600;
  if (al.history.length > MAX_SNAPSHOTS) al.history.shift();
}

/** Weekly operating result before debt interest — used to price loan risk. */
function operatingNet(g: GameState, al: Airline): number {
  const net = evaluateNetwork(g, al);
  let cost = net.cost;
  for (const plane of al.fleet)
    if (plane.routeId === null)
      cost += typeById(g, plane.typeId).weeklyUpkeep * priceLevel(g);
  return net.revenue - cost;
}

/** The bank's credit line: scales with cash flow (revenue) and collateral (fleet). */
export function creditLimit(g: GameState, al: Airline): number {
  const annualRevenue = evaluateNetwork(g, al).revenue * 52;
  // The startup line is in era dollars; revenue and fleet value already are.
  const startupLine = LOAN_BASE_CREDIT * eraScale(g);
  const formula =
    startupLine +
    LOAN_REVENUE_MULTIPLE * annualRevenue +
    LOAN_COLLATERAL_FRACTION * fleetValue(g, al);
  // Loan-to-value ceiling: the bank won't let debt outrun the asset base, so a
  // fully-levered airline must repay or grow equity before it can borrow again —
  // this is what stops an endless self-financing buyout snowball. The unsecured
  // startup line stays available as a floor so a cash-light newcomer can begin.
  const ltvCap = LOAN_MAX_LTV * airlineAssets(g, al);
  const limit = Math.max(startupLine, Math.min(formula, ltvCap));
  return Math.min(LOAN_MAX_CREDIT, Math.round(limit));
}

/** Annual interest rate: the era's fed funds rate plus a credit spread that
 *  rises with leverage and losses. */
export function interestRate(g: GameState, al: Airline): number {
  const base = fedFundsRate(g);
  // Debt-to-revenue: what you owe vs. a year of what you earn. No revenue but
  // carrying debt is the riskiest case, so it pays the full spread.
  const annualRevenue = evaluateNetwork(g, al).revenue * 52;
  const dtr =
    annualRevenue > 0 ? al.debt / annualRevenue : al.debt > 0 ? LOAN_FULL_SPREAD_DTR : 0;
  let rate = base + LOAN_MAX_SPREAD * Math.min(1, dtr / LOAN_FULL_SPREAD_DTR);
  if (operatingNet(g, al) < 0) rate += LOAN_LOSS_PREMIUM; // a loss-making airline pays more
  return Math.min(base + LOAN_MAX_SPREAD, rate); // ceiling floats with the era
}

/** Borrow from the bank, up to the remaining credit line. Returns amount taken. */
export function borrow(g: GameState, al: Airline, amount: number): number {
  const take = Math.min(amount, creditLimit(g, al) - al.debt);
  if (take <= 0) return 0;
  al.debt += take;
  al.cash += take;
  al.log.unshift(`Borrowed ${money(take)} (debt now ${money(al.debt)}).`);
  return take;
}

/** Repay loan principal from available cash. Returns amount repaid.
 *  Takes g for symmetry with borrow, though only the airline is touched. */
export function repay(_g: GameState, al: Airline, amount: number): number {
  const pay = Math.min(amount, al.debt, Math.max(0, al.cash));
  if (pay <= 0) return 0;
  al.debt -= pay;
  al.cash -= pay;
  al.log.unshift(`Repaid ${money(pay)} (debt now ${money(al.debt)}).`);
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
