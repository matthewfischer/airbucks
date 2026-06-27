import type { AircraftType, Airline, Airport, GameState, Route } from './types';
import { distanceKm } from './geo';
import type { NetworkResult } from './engine';
import { acquire, buyoutPrice, updateDistress } from './distress';
import {
  canAcquire,
  costToAccumulate,
  forceBuy,
  hasControl,
  isPlayerDominant,
  sharesOwned,
  takeover,
  takeoverCost,
  TOTAL_SHARES,
} from './shares';
import {
  airportById,
  assignPlane,
  availableTypes,
  baselineSpeed,
  borrow,
  buyPlane,
  closeRoute,
  competitiveShare,
  creditLimit,
  distanceFactor,
  equity,
  evaluateNetwork,
  rivalWeight,
  gateFee,
  isNegotiating,
  newAirline,
  openRoute,
  pairDemand,
  planesOnRoute,
  playerNews,
  priceLevel,
  rand,
  recordFinanceSnapshot,
  referenceFare,
  repay,
  rightsAvailable,
  rightsFee,
  routeMaxLeg,
  sellPlane,
  sellSlot,
  speedFareMultiplier,
  startNegotiation,
  tripsPerWeek,
  typeById,
  upgradeRoute,
  upgradeRouteQuote,
  weeklyTotals,
} from './engine';

// ---- Personalities ----------------------------------------------------------

export interface Personality {
  id: string;
  label: string;
  /** Weeks between decision passes (each pass is jittered ±25%). */
  cadenceWeeks: number;
  /** Scoring noise amplitude: each candidate's score is scaled by 1 ± noise. */
  noise: number;
  /** Fraction of the credit line the airline is willing to carry as debt. */
  debtAppetite: number;
  /** Market-size preference: >0 chases big cities, <0 prefers small ones. */
  sizeBias: number;
  /** Score multiplier for routes/slots that touch the home base. */
  hubBonus: number;
  /** Replaces aging fleets with newer types (cheapskates fly props forever). */
  upgrades: boolean;
  /** Weeks of loss-runway required before expanding while in the red. */
  runwayWeeks: number;
}

export const PERSONALITIES: Personality[] = [
  { id: 'hub-builder', label: 'Hub builder', cadenceWeeks: 4, noise: 0.3,
    debtAppetite: 0.5, sizeBias: 0.4, hubBonus: 1.6, upgrades: true, runwayWeeks: 26 },
  { id: 'cheapskate', label: 'Cheapskate', cadenceWeeks: 6, noise: 0.3,
    debtAppetite: 0.1, sizeBias: 0, hubBonus: 1.2, upgrades: false, runwayWeeks: 52 },
  { id: 'overexpander', label: 'Overexpander', cadenceWeeks: 3, noise: 0.5,
    debtAppetite: 0.95, sizeBias: 0.7, hubBonus: 1.0, upgrades: true, runwayWeeks: 8 },
  { id: 'regional', label: 'Regional', cadenceWeeks: 5, noise: 0.3,
    debtAppetite: 0.3, sizeBias: -0.7, hubBonus: 1.4, upgrades: true, runwayWeeks: 26 },
];

const personalityById = new Map(PERSONALITIES.map((p) => [p.id, p]));

// ---- Airline generation -----------------------------------------------------

// AIs call a size-3/4 secondary hub home — the player's own starting tier, so a
// rival must climb the same reputation ladder to the size-5/6 majors (ATL, LHR,
// NRT…) rather than spawning on one. The specific hubs aren't fixed: they're
// drawn by economic merit, biased toward the player's region (see pickHomes), so
// a Cape Town or Frankfurt start faces local rivals, not a wall of US airlines.
// See docs/ai-players.md.
const AI_HOME_MIN_SIZE = 3;
const AI_HOME_MAX_SIZE = 4;

/** Cap on how far a market counts toward a hub's appeal — early long-prop reach. */
const HOME_REACH_KM = 4000;

/** Distance from the player at which a hub's draw weight halves, in km. Tilts
 *  the pick toward closer hubs so a thin-region pool (Perth, Santiago) still
 *  favors its nearest neighbors over far, denser ones. */
const REGION_SCALE_KM = 3000;

const AI_NAMES = [
  'Transcontinental Airways', 'Pacific Crown', 'Lone Star Air', 'Lakeshore Airways',
  'Gulf Stream Air', 'Northern Cross', 'Cactus Air Lines', 'Maple Leaf Air',
  'Aztec Airways', 'Gateway Air', 'Bluegrass Airways', 'Cascade Air',
];

const AI_COLORS = [
  '#e85d75', '#c084fc', '#5ac8fa', '#ffd166',
  '#80ed99', '#f4845f', '#a3b18a', '#e07be0',
];

export const MAX_AI_AIRLINES = 4;

/** Deterministically shuffle (Fisher–Yates over the game RNG). */
function shuffle<T>(g: GameState, items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand(g) * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Economic merit of a hub as a base: its own market weight times the
 * distance-discounted size of every city within early-aircraft reach — the
 * same demand math the engine rewards (pairDemand × distanceFactor). A big hub
 * ringed by sizable cities at flyable distance scores high; one stranded among
 * distant or tiny neighbors scores low.
 */
function hubAppeal(g: GameState, home: Airport): number {
  let sum = 0;
  for (const b of g.airports) {
    if (b.id === home.id) continue;
    const d = distanceKm(home, b);
    if (d > HOME_REACH_KM) continue;
    sum += b.size * distanceFactor(d);
  }
  return home.size * sum;
}

/**
 * Pick `count` AI home airports by economic merit, within the player's region.
 * The candidate pool is the secondary hubs (size 3/4) nearest the player —
 * which keeps rivals regional wherever you start, and naturally borrows from
 * the next continent when your own is thin (a Perth start reaches into SE Asia).
 * Within that pool each hub is drawn weighted by its appeal as a base
 * (hubAppeal), with no spacing rule: rivals settle where the money is, free to
 * cluster near the player or each other when that pays. Drawn without
 * replacement (deterministically, over the game RNG) so no two share a home.
 */
function pickHomes(g: GameState, count: number): Airport[] {
  if (count <= 0) return [];
  const playerHome = airportById(g, g.airlines[0].homeId);
  const remaining = g.airports
    .filter((a) => a.id !== playerHome.id && a.size >= AI_HOME_MIN_SIZE && a.size <= AI_HOME_MAX_SIZE)
    .sort((a, b) => distanceKm(a, playerHome) - distanceKm(b, playerHome))
    .slice(0, Math.max(10, count * 3));
  const weight = new Map(remaining.map((a) => {
    const proximity = 1 / (1 + (distanceKm(a, playerHome) / REGION_SCALE_KM) ** 2);
    return [a.id, hubAppeal(g, a) * proximity];
  }));
  const picked: Airport[] = [];
  while (picked.length < count && remaining.length > 0) {
    const total = remaining.reduce((s, a) => s + weight.get(a.id)!, 0);
    let r = rand(g) * total;
    let i = 0;
    while (i < remaining.length - 1 && (r -= weight.get(remaining[i].id)!) > 0) i++;
    picked.push(remaining.splice(i, 1)[0]);
  }
  return picked;
}

/** Schedule the next decision pass: the personality cadence, jittered ±25%. */
const scheduleNext = (g: GameState, p: Personality): number =>
  g.day + Math.max(7, Math.round(p.cadenceWeeks * 7 * (0.75 + 0.5 * rand(g))));

/**
 * Add `count` computer airlines to a fresh game. Call once after newGame,
 * before play starts. Names, colors, homes, and personalities are drawn
 * deterministically from the game RNG.
 */
export function addAiAirlines(g: GameState, count: number): void {
  const n = Math.max(0, Math.min(MAX_AI_AIRLINES, count));
  const homes = pickHomes(g, n);
  const names = shuffle(g, AI_NAMES);
  const personalities = shuffle(g, PERSONALITIES);
  for (let i = 0; i < homes.length; i++) {
    const al = newAirline(`ai-${i + 1}`, names[i % names.length], AI_COLORS[i % AI_COLORS.length], homes[i].id);
    const p = personalities[i % personalities.length];
    al.log = [];
    al.ai = { personality: p.id, nextDecisionDay: scheduleNext(g, p) };
    g.airlines.push(al);
  }
}

// ---- Decision pass ----------------------------------------------------------

/** One candidate move, scored; the pass executes the noisy best. */
export interface Action {
  score: number;
  run: () => void;
}

/** Cash this airline is willing to put toward a purchase, borrowing included. */
function spendable(g: GameState, al: Airline, p: Personality): number {
  const headroom = Math.max(0, p.debtAppetite * creditLimit(g, al) - al.debt);
  return Math.max(0, al.cash) + headroom;
}

/** Borrow whatever is missing to cover `cost`, within appetite. True if covered. */
function coverCost(g: GameState, al: Airline, p: Personality, cost: number): boolean {
  if (al.cash >= cost) return true;
  if (spendable(g, al, p) < cost) return false;
  borrow(g, al, Math.ceil(cost - al.cash));
  return al.cash >= cost;
}

/** An idle plane able to fly `maxLeg`, or null. */
const idlePlaneFor = (g: GameState, al: Airline, maxLeg: number) =>
  al.fleet.find((pl) => pl.routeId === null && typeById(g, pl.typeId).range >= maxLeg) ?? null;

/** True if the airline already flies directly between these two airports. */
const hasRouteBetween = (al: Airline, a: string, b: string): boolean =>
  al.routes.some((r) => {
    for (let i = 0; i < r.stops.length - 1; i++) {
      if ((r.stops[i] === a && r.stops[i + 1] === b) || (r.stops[i] === b && r.stops[i + 1] === a))
        return true;
    }
    return false;
  });

/** Personality lens on a market: bias toward big or small cities. */
const sizePreference = (p: Personality, a: Airport, b: Airport): number =>
  ((a.size * b.size) / 9) ** p.sizeBias; // 1.0 at a 3×3 market

/**
 * Rough weekly profit of flying one `type` plane on a direct a↔b route —
 * the same arithmetic the engine uses (speed premium, price-elastic demand),
 * minus connecting traffic. Conservative is good: routes the AI opens on
 * this basis really do earn, so it never oscillates open→lose→close.
 */
function estimateRouteProfit(
  g: GameState,
  al: Airline,
  a: Airport,
  b: Airport,
  dist: number,
  type: AircraftType,
): number {
  const lvl = priceLevel(g);
  const premium = speedFareMultiplier(type.speed, baselineSpeed(g));
  const trips = tripsPerWeek(type, dist, 1);
  const cap = trips * 2 * type.capacity;
  const demandMult = Math.max(0.1, Math.min(1.5, 2 - 1 / premium));
  // Split the market with anyone already flying it: this plane's seats×appeal
  // against the rivals' weight. A contested trunk route is worth proportionally
  // less, so the AI won't pile into a market it can only win a sliver of.
  const share = competitiveShare(cap * demandMult, rivalWeight(g, al, a.id, b.id));
  const demand = pairDemand(a, b) * distanceFactor(dist) * demandMult * share;
  const carried = Math.min(demand, cap);
  const lf = cap > 0 ? carried / cap : 0;
  const revenue = carried * referenceFare(dist) * premium * lvl;
  const cost = lf * trips * 2 * dist * type.costPerKm * lvl + type.weeklyUpkeep * lvl;
  return revenue - cost;
}

/** Don't bother with markets earning less than this a week (1950 dollars). */
const MIN_ROUTE_PROFIT = 1_500;
const minProfit = (g: GameState): number => MIN_ROUTE_PROFIT * priceLevel(g);

/** How many candidate routes/types survive the cheap pre-filter into the
 *  (more expensive) what-if marginal-network-profit scoring. Keeps the eval
 *  count per decision pass bounded. */
const ROUTE_FINALISTS = 6;
const TYPE_FINALISTS = 4;
/** Only the N most profitable routes are worth an upgrade what-if each pass. */
const UPGRADE_CANDIDATES = 6;

/** A reallocation only fires when the alternative deployment beats the route
 *  it would replace by this factor — hysteresis against open→close→open churn. */
const REALLOC_MARGIN = 1.5;

/** The affordable in-production type that earns the most on this market, or null. */
function bestTypeFor(
  g: GameState,
  al: Airline,
  a: Airport,
  b: Airport,
  dist: number,
  budget: number,
): { type: AircraftType; profit: number } | null {
  let best: { type: AircraftType; profit: number } | null = null;
  for (const t of availableTypes(g)) {
    if (t.range < dist || t.price > budget) continue;
    const profit = estimateRouteProfit(g, al, a, b, dist, t);
    if (!best || profit > best.profit) best = { type: t, profit };
  }
  return best;
}

/** Best estimated weekly profit for a↔b using an idle plane or the budget, or null. */
function bestPlanFor(
  g: GameState,
  al: Airline,
  a: Airport,
  b: Airport,
  dist: number,
  budget: number,
): number | null {
  const idle = idlePlaneFor(g, al, dist);
  const owned = idle ? estimateRouteProfit(g, al, a, b, dist, typeById(g, idle.typeId)) : -Infinity;
  const bought = bestTypeFor(g, al, a, b, dist, budget)?.profit ?? -Infinity;
  const profit = Math.max(owned, bought);
  return profit === -Infinity ? null : profit;
}

/** Get a plane onto this route: reuse an idle one, else buy the type that
 *  earns the most here (borrowing within appetite if needed). */
function staffRoute(g: GameState, al: Airline, p: Personality, routeId: string): void {
  const route = al.routes.find((r) => r.id === routeId);
  if (!route) return;
  const maxLeg = routeMaxLeg(g, route);
  const idle = idlePlaneFor(g, al, maxLeg);
  if (idle) {
    assignPlane(g, al, idle.id, routeId);
    return;
  }
  // Buy the type that adds the most *network* profit here (connection traffic
  // included), not just the best point-to-point earner.
  const pick = bestPlaneTypeForRoute(g, al, route, spendable(g, al, p), networkProfit(g, al));
  if (!pick || !coverCost(g, al, p, pick.type.price)) return;
  if (buyPlane(g, al, pick.type.id) === null) {
    assignPlane(g, al, al.fleet[al.fleet.length - 1].id, routeId);
  }
}

// ---- Connection-aware valuation (what-if marginal network profit) ----------
// The engine's evaluateNetwork already pays a route for the connecting traffic
// it carries. So instead of scoring a move by its standalone point-to-point
// estimate, we clone the airline, apply the hypothetical change, and re-evaluate
// — the delta is the move's true weekly network value. The clone uses throwaway
// ids and never touches the game, rand, or makeId, so this stays deterministic.

/** Whole-network weekly operating profit, connecting traffic included. */
const networkProfit = (g: GameState, al: Airline): number => evaluateNetwork(g, al).profit;

/** Weekly network-profit delta of a hypothetical change vs `base`. `apply`
 *  mutates a throwaway clone (use '_hyp' ids). Pure and deterministic. */
function marginalProfit(
  g: GameState,
  al: Airline,
  base: number,
  apply: (clone: Airline) => void,
): number {
  const clone: Airline = {
    ...al,
    routes: al.routes.map((r) => ({ ...r })),
    fleet: al.fleet.map((pl) => ({ ...pl })),
  };
  apply(clone);
  return networkProfit(g, clone) - base;
}

/** Affordable, in-range types for a route's longest leg, cheaply pre-ranked by
 *  standalone profit and capped — so the what-if loop stays bounded. */
function candidateTypes(
  g: GameState,
  al: Airline,
  a: Airport,
  b: Airport,
  dist: number,
  maxLeg: number,
  budget: number,
): AircraftType[] {
  return availableTypes(g)
    .filter((t) => t.range >= maxLeg && t.price <= budget)
    .map((t) => ({ t, pre: estimateRouteProfit(g, al, a, b, dist, t) }))
    .sort((x, y) => y.pre - x.pre || (x.t.id < y.t.id ? -1 : 1))
    .slice(0, TYPE_FINALISTS)
    .map((x) => x.t);
}

/** Best type + its marginal network profit for adding one plane to an EXISTING
 *  route, connection-aware. null if nothing affordable is in range. */
function bestPlaneTypeForRoute(
  g: GameState,
  al: Airline,
  route: Route,
  budget: number,
  base: number,
): { type: AircraftType; marginal: number } | null {
  const maxLeg = routeMaxLeg(g, route);
  const a = airportById(g, route.stops[0]);
  const b = airportById(g, route.stops[route.stops.length - 1]);
  const dist = distanceKm(a, b);
  let best: { type: AircraftType; marginal: number } | null = null;
  for (const t of candidateTypes(g, al, a, b, dist, maxLeg, budget)) {
    const m = marginalProfit(g, al, base, (clone) => {
      clone.fleet.push({ id: '_hyp', typeId: t.id, routeId: route.id, kmFlown: 0 });
    });
    if (!best || m > best.marginal) best = { type: t, marginal: m };
  }
  return best;
}

/** Held-airport pairs without a route yet, ranked by the cheap standalone
 *  estimate (best first) and capped — the shortlist worth a what-if. */
function candidatePairs(
  g: GameState,
  al: Airline,
  p: Personality,
  budget: number,
): { a: Airport; b: Airport }[] {
  const pairs: { a: Airport; b: Airport; pre: number }[] = [];
  for (let i = 0; i < al.rights.length; i++) {
    for (let j = i + 1; j < al.rights.length; j++) {
      const a = airportById(g, al.rights[i]);
      const b = airportById(g, al.rights[j]);
      if (hasRouteBetween(al, a.id, b.id)) continue;
      const dist = distanceKm(a, b);
      const profit = bestPlanFor(g, al, a, b, dist, budget);
      if (profit === null) continue;
      let pre = profit * sizePreference(p, a, b);
      if (a.id === al.homeId || b.id === al.homeId) pre *= p.hubBonus;
      pairs.push({ a, b, pre });
    }
  }
  pairs.sort((x, y) => y.pre - x.pre || (x.a.id + x.b.id < y.a.id + y.b.id ? -1 : 1));
  return pairs.slice(0, ROUTE_FINALISTS).map(({ a, b }) => ({ a, b }));
}

export interface NewRoute {
  /** The route's path. Two stops for a point-to-point; three or more for a
   *  multi-stop "milk run" that serves several legs with one plane. */
  stops: string[];
  /** Path endpoints — used for size/hub scoring and the player news line. */
  a: Airport;
  b: Airport;
  type: AircraftType;
  marginal: number;
}

/** Longest leg of a path (what limits which aircraft can fly it). */
function pathMaxLeg(g: GameState, stops: string[]): number {
  let max = 0;
  for (let i = 0; i < stops.length - 1; i++)
    max = Math.max(max, distanceKm(airportById(g, stops[i]), airportById(g, stops[i + 1])));
  return max;
}

/** True if the airline already flies this exact path (either direction). */
function hasRouteWithStops(al: Airline, stops: string[]): boolean {
  const fwd = stops.join('>');
  const rev = [...stops].reverse().join('>');
  return al.routes.some((r) => r.stops.join('>') === fwd || r.stops.join('>') === rev);
}

/** Affordable, in-range type that earns the most flown over a whole path, by
 *  the cheap per-leg standalone estimate (no clone). null if nothing fits. */
function bestTypeForStops(
  g: GameState,
  al: Airline,
  stops: string[],
  budget: number,
): AircraftType | null {
  const maxLeg = pathMaxLeg(g, stops);
  let best: { type: AircraftType; est: number } | null = null;
  for (const t of availableTypes(g)) {
    if (t.range < maxLeg || t.price > budget) continue;
    let est = 0;
    for (let i = 0; i < stops.length - 1; i++) {
      const a = airportById(g, stops[i]);
      const b = airportById(g, stops[i + 1]);
      est += estimateRouteProfit(g, al, a, b, distanceKm(a, b), t);
    }
    if (!best || est > best.est) best = { type: t, est };
  }
  return best?.type ?? null;
}

/** True if any stop on the path is the airline's home base. */
const touchesHome = (al: Airline, stops: string[]): boolean => stops.includes(al.homeId);

/** Cap on a chain's stops, and how many held cities anchor a chain. */
const MAX_CHAIN_STOPS = 4;
const CHAIN_ANCHORS = 3;

/**
 * Multi-stop "milk run" candidates: chains that string several held cities onto
 * one plane's circuit. The engine pays each leg for the connecting traffic it
 * carries, so one plane chaining three thin markets can clear the floor where
 * three dedicated point-to-point planes never would — capital the AI otherwise
 * leaves on the table. Built greedily (nearest held city, within early-plane
 * leg reach) from a few anchors (home first, then the largest held cities), so
 * the eval count stays bounded. Each prefix of length ≥3 is one what-if; length
 * 2 is already covered by the point-to-point pair candidates.
 */
function chainCandidates(
  g: GameState,
  al: Airline,
  p: Personality,
  base: number,
  budget: number,
): NewRoute[] {
  if (al.rights.length < 3) return [];
  const held = al.rights.map((id) => airportById(g, id));
  const anchors = [...held]
    .sort((x, y) => Number(y.id === al.homeId) - Number(x.id === al.homeId) || y.size - x.size)
    .slice(0, CHAIN_ANCHORS);
  const out: NewRoute[] = [];
  const seen = new Set<string>();
  for (const anchor of anchors) {
    const stops = [anchor.id];
    const used = new Set([anchor.id]);
    while (stops.length < MAX_CHAIN_STOPS) {
      const last = airportById(g, stops[stops.length - 1]);
      let next: Airport | null = null;
      let nearest = Infinity;
      for (const c of held) {
        if (used.has(c.id)) continue;
        const d = distanceKm(last, c);
        if (d <= HOME_REACH_KM && d < nearest) {
          nearest = d;
          next = c;
        }
      }
      if (!next) break;
      stops.push(next.id);
      used.add(next.id);
      if (stops.length < 3 || hasRouteWithStops(al, stops)) continue;
      const norm = [...stops].sort().join('|');
      if (seen.has(norm)) continue;
      seen.add(norm);
      const type = bestTypeForStops(g, al, stops, budget);
      if (!type) continue;
      const path = [...stops];
      const a = anchor;
      const b = next;
      const marginal = marginalProfit(g, al, base, (clone) => {
        clone.routes.push({ id: '_hyp', stops: path, fareFactor: 1 });
        clone.fleet.push({ id: '_hypp', typeId: type.id, routeId: '_hyp', kmFlown: 0 });
      });
      out.push({ stops: path, a, b, type, marginal });
    }
  }
  return out;
}

/** The shortlist of new routes, each scored by connection-aware marginal
 *  network profit: point-to-point pairs plus multi-stop chains, which compete
 *  on equal footing so the AI picks a milk run when it beats serving the same
 *  cities with separate planes. One what-if per finalist (the plane type is the
 *  cheap standalone pick; run() sizes the real plane connection-aware via
 *  staffRoute), so the eval count per pass is bounded regardless of network
 *  size. Computed once per decision pass and shared by route + realloc actions. */
export function newRouteCandidates(
  g: GameState,
  al: Airline,
  p: Personality,
  base: number,
  budget: number,
): NewRoute[] {
  const out: NewRoute[] = [];
  for (const { a, b } of candidatePairs(g, al, p, budget)) {
    const choice = bestTypeFor(g, al, a, b, distanceKm(a, b), budget);
    if (!choice) continue;
    const marginal = marginalProfit(g, al, base, (clone) => {
      clone.routes.push({ id: '_hyp', stops: [a.id, b.id], fareFactor: 1 });
      clone.fleet.push({ id: '_hypp', typeId: choice.type.id, routeId: '_hyp', kmFlown: 0 });
    });
    out.push({ stops: [a.id, b.id], a, b, type: choice.type, marginal });
  }
  out.push(...chainCandidates(g, al, p, base, budget));
  return out;
}

/** Candidate: open a direct route between two held airports and staff it.
 *  Scored by connection-aware marginal network profit, so a route that's weak
 *  point-to-point but feeds the hub still earns its place. */
function routeActions(g: GameState, al: Airline, p: Personality, candidates: NewRoute[]): Action[] {
  const actions: Action[] = [];
  for (const { a, b, stops, marginal } of candidates) {
    if (marginal < minProfit(g)) continue;
    let score = marginal * sizePreference(p, a, b);
    if (touchesHome(al, stops)) score *= p.hubBonus;
    actions.push({
      score,
      run: () => {
        if (openRoute(g, al, stops) === null) {
          staffRoute(g, al, p, al.routes[al.routes.length - 1].id);
          // Flag the move only if it touches a city you serve — keeps the
          // news feed about your world, not every distant AI route.
          const youHold = g.airlines[0].rights;
          if (stops.some((id) => youHold.includes(id)))
            playerNews(g, `✈ ${al.name} opened ${a.code} → ${b.code} — moving into your network.`);
        }
      },
    });
  }
  return actions;
}

/** Candidate: add capacity to a full, profitable route, or staff a plane-less
 *  one. A full route's connection-inclusive profit (from `net`) is the proxy for
 *  the demand another plane would capture — no extra eval; run() sizes the plane
 *  connection-aware via staffRoute. */
function capacityActions(g: GameState, al: Airline, p: Personality, net: NetworkResult): Action[] {
  if (al.routes.length === 0) return [];
  const actions: Action[] = [];
  const budget = spendable(g, al, p);
  for (const route of al.routes) {
    const summary = net.routes.get(route.id);
    if (!summary) continue;
    const staffed = planesOnRoute(al, route.id).length > 0;
    if (staffed && (summary.loadFactor < 0.95 || summary.profit <= 0)) continue;
    // Affordability gate (cheap, standalone): skip unless an idle plane or the
    // budget for one is actually available — otherwise the run() would no-op.
    const a = airportById(g, route.stops[0]);
    const b = airportById(g, route.stops[route.stops.length - 1]);
    if (bestPlanFor(g, al, a, b, routeMaxLeg(g, route), budget) === null) continue;
    // An empty route is dead weight — staffing it outranks growing a full one.
    const score = staffed ? summary.profit : 1000 * priceLevel(g);
    actions.push({ score, run: () => staffRoute(g, al, p, route.id) });
  }
  return actions;
}

/** Candidate: replace a profitable route's fleet with a newer, better type.
 *  Only the most profitable routes (by connection-inclusive `net`) are worth the
 *  what-if, and each gets a single eval against its best standalone-pricier type
 *  — so the eval count stays bounded. Scored by the swap's marginal network profit. */
function upgradeActions(
  g: GameState,
  al: Airline,
  p: Personality,
  net: NetworkResult,
  base: number,
): Action[] {
  if (!p.upgrades || al.routes.length === 0) return [];
  const budget = spendable(g, al, p);
  const routes = al.routes
    .filter((r) => {
      const s = net.routes.get(r.id);
      return s && s.profit > 0 && planesOnRoute(al, r.id).length > 0;
    })
    .sort((x, y) => net.routes.get(y.id)!.profit - net.routes.get(x.id)!.profit)
    .slice(0, UPGRADE_CANDIDATES);
  const actions: Action[] = [];
  for (const route of routes) {
    const planes = planesOnRoute(al, route.id);
    const maxLeg = routeMaxLeg(g, route);
    const a = airportById(g, route.stops[0]);
    const b = airportById(g, route.stops[route.stops.length - 1]);
    const dist = distanceKm(a, b);
    const floor = Math.max(...planes.map((pl) => typeById(g, pl.typeId).price));
    // Best strictly-pricier in-range type by the cheap standalone estimate, then
    // a single what-if to score the connection-inclusive gain.
    const cand = availableTypes(g)
      .filter((t) => t.range >= maxLeg && t.price > floor)
      .map((t) => ({ t, pre: estimateRouteProfit(g, al, a, b, dist, t) }))
      .sort((x, y) => y.pre - x.pre || (x.t.id < y.t.id ? -1 : 1))[0]?.t;
    if (!cand) continue;
    const quote = upgradeRouteQuote(g, al, route.id, cand.id);
    if (quote.net > budget) continue;
    const gain = marginalProfit(g, al, base, (clone) => {
      for (const pl of clone.fleet) if (pl.routeId === route.id) pl.typeId = cand.id;
    });
    if (gain <= 0) continue;
    actions.push({
      score: gain,
      run: () => {
        if (coverCost(g, al, p, quote.net)) upgradeRoute(g, al, route.id, cand.id);
      },
    });
  }
  return actions;
}

/** Candidate: tear down a positive-but-mediocre route and redeploy its plane
 *  into a clearly better one — the capital churn the player does by hand and the
 *  AI otherwise never does (retrench only closes money-losers). Feeder spokes
 *  are safe automatically: their connection-inclusive profit is high, so they're
 *  never the weak link, and a confirming what-if checks the full removal cost. */
export function reallocateActions(
  g: GameState,
  al: Airline,
  p: Personality,
  net: NetworkResult,
  base: number,
  candidates: NewRoute[],
): Action[] {
  if (al.routes.length === 0 || candidates.length === 0) return [];
  // 1) Weakest staffed route by connection-inclusive profit (cheap, from net).
  let weak: Route | null = null;
  let weakProfit = Infinity;
  for (const route of al.routes) {
    if (planesOnRoute(al, route.id).length === 0) continue; // empty: capacity's job
    const s = net.routes.get(route.id);
    if (!s || s.profit <= 0) continue; // losers are retrench's job, not realloc's
    if (s.profit < weakProfit) {
      weakProfit = s.profit;
      weak = route;
    }
  }
  if (!weak) return [];
  // 2) Best alternative deployment of the freed plane (from the shared shortlist).
  const alt = candidates.reduce((best, c) => (c.marginal > best.marginal ? c : best));
  // 3) Confirm the weak route's *true* contribution (removal can also break the
  //    connecting itineraries its spoke carried) before committing to the swap.
  const contribution = -marginalProfit(g, al, base, (clone) => {
    clone.routes = clone.routes.filter((r) => r.id !== weak!.id);
  });
  if (alt.marginal <= contribution * REALLOC_MARGIN) return [];
  const source = weak;
  const { stops } = alt;
  return [
    {
      score: alt.marginal - contribution,
      run: () => {
        closeRoute(g, al, source.id); // planes go idle…
        if (openRoute(g, al, stops) === null)
          staffRoute(g, al, p, al.routes[al.routes.length - 1].id); // …and get reused
      },
    },
  ];
}

/** Rights the airline holds but doesn't fly to (or from) yet. */
const unservedRights = (al: Airline): number =>
  al.rights.filter((id) => !al.routes.some((r) => r.stops.includes(id))).length;

/** Candidate: file for a slot at a reachable, affordable, attractive airport. */
function slotActions(g: GameState, al: Airline, p: Personality): Action[] {
  const actions: Action[] = [];
  const budget = spendable(g, al, p);
  // A slot is future value: discount it against flying today, and discount
  // harder while already-held cities sit unserved — fly what you own first.
  const discount = 0.6 / (1 + unservedRights(al));
  for (const ap of g.airports) {
    if (!rightsAvailable(g, al, ap.id) || isNegotiating(al, ap.id)) continue;
    const fee = rightsFee(g, ap);
    if (fee > budget) continue;
    // Value: the best single route this slot would enable from a held airport.
    let bestPair = 0;
    for (const id of al.rights) {
      const held = airportById(g, id);
      const d = distanceKm(ap, held);
      const choice = bestTypeFor(g, al, ap, held, d, budget);
      if (!choice || choice.profit < minProfit(g)) continue;
      bestPair = Math.max(bestPair, choice.profit * sizePreference(p, ap, held));
    }
    if (bestPair <= 0) continue;
    const score = bestPair * discount * (al.homeId === ap.id ? p.hubBonus : 1);
    actions.push({
      score,
      run: () => {
        if (coverCost(g, al, p, fee)) startNegotiation(g, al, ap.id);
      },
    });
  }
  return actions;
}

/** Floor-ignoring reach only fires while the network is this small — enough to
 *  escape an isolated home, not so much that an airline sprawls a thin network
 *  that never clears the profit floor. Real growth comes from profitable moves. */
const REACH_MAX_CITIES = 8;

/**
 * Reach: grab the best reachable, unlocked, affordable slot (closest to a held
 * city, then biggest), *ignoring the profit floor*. From an isolated home (e.g.
 * ABQ, or PTY worldwide) every reachable market can sit below the floor — a
 * cold-start airline never gets a second city, and a small one boxed in past
 * its first few freezes for the rest of the game. Distance is measured from the
 * nearest city already held, so an airline grows outward from its network, not
 * just its hub. Only fires while still small (and called only when no profitable
 * move exists), so it unsticks without turning a cautious AI into a sprawler.
 */
function reachActions(g: GameState, al: Airline, p: Personality): Action[] {
  if (al.negotiations.length > 0 || al.rights.length > REACH_MAX_CITIES) return [];
  const budget = spendable(g, al, p);
  let target: Airport | null = null;
  let bestScore = -Infinity;
  for (const ap of g.airports) {
    if (!rightsAvailable(g, al, ap.id)) continue;
    if (rightsFee(g, ap) > budget) continue;
    // Nearest held city this slot would connect to, and a plane that reaches it.
    let nearest = Infinity;
    let from: Airport | null = null;
    for (const id of al.rights) {
      const held = airportById(g, id);
      const d = distanceKm(ap, held);
      if (d < nearest) {
        nearest = d;
        from = held;
      }
    }
    if (!from || !bestTypeFor(g, al, ap, from, nearest, budget)) continue;
    const s = (ap.size * from.size) / Math.max(1, nearest); // closer & bigger = better
    if (s > bestScore) {
      bestScore = s;
      target = ap;
    }
  }
  if (!target) return [];
  const pick = target;
  // Floor-level urgency: outranks idling/repay, yields to any profitable move.
  return [
    {
      score: minProfit(g),
      run: () => {
        if (coverCost(g, al, p, rightsFee(g, pick))) startNegotiation(g, al, pick.id);
      },
    },
  ];
}

/** How much more an AI wants a distressed bargain than a full-price going
 *  concern — it's cheap and clears a failing rival's slots before someone else
 *  grabs them. */
const DISTRESS_PREFERENCE = 1.5;

/**
 * Candidate: take over a rival. A distressed one is bought off the block at the
 * cheap fire-sale sticker (the instant-buyout path); a healthy going concern is
 * captured through the share market — an expensive hostile takeover priced on a
 * growth-aware valuation, so a young fast-grower can't be rolled up cheaply.
 * Only a solvent airline with the credit headroom to carry the combined debt
 * plus the financing will bid. The human (airlines[0]) is never acquired here
 * (rivals only raid the player once dominant — handled separately).
 */
export function acquisitionActions(g: GameState, al: Airline, p: Personality): Action[] {
  const actions: Action[] = [];
  if (equity(g, al) <= 0) return actions; // only solvent airlines acquire
  if (!canAcquire(g, al)) return actions; // still digesting the last acquisition
  const appetite = p.debtAppetite * creditLimit(g, al);
  for (const target of g.airlines) {
    if (target === al || !target.ai) continue; // never the human; not self
    const reach = evaluateNetwork(g, target).revenue; // strategic value
    if (target.forSale) {
      // Fire-sale: buy off the block at the cheap sticker (cash + debt alike).
      const price = buyoutPrice(g, target);
      const borrowNeed = Math.max(0, price - al.cash - target.cash);
      if (al.debt + target.debt + borrowNeed > appetite) continue;
      if (spendable(g, al, p) + target.cash < price) continue;
      actions.push({
        score: reach * DISTRESS_PREFERENCE,
        run: () => {
          if (coverCost(g, al, p, Math.max(0, buyoutPrice(g, target) - target.cash)))
            acquire(g, al, target);
        },
      });
    } else {
      // Healthy: hostile takeover via the share market — expensive by design.
      const cost = takeoverCost(g, al, target);
      const borrowNeed = Math.max(0, cost - al.cash);
      if (al.debt + target.debt + borrowNeed > appetite) continue;
      if (spendable(g, al, p) < cost) continue;
      actions.push({
        score: reach,
        run: () => {
          if (coverCost(g, al, p, takeoverCost(g, al, target))) takeover(g, al, target);
        },
      });
    }
  }
  return actions;
}

/** Candidate: a debt-shy airline pays its loan down when cash allows. */
export function repayActions(g: GameState, al: Airline, p: Personality): Action[] {
  if (al.debt <= 0 || al.cash <= 0) return [];
  if (al.debt <= p.debtAppetite * creditLimit(g, al)) return [];
  // Modest, steady urge — strong enough to win a pass when nothing else shines.
  return [{ score: al.debt / 100, run: () => repay(g, al, Math.min(al.cash * 0.5, al.debt)) }];
}

/**
 * Retrenchment candidates for an airline in the red. Scores are weekly
 * savings, so the biggest bleed gets stopped first.
 */
export function retrenchActions(g: GameState, al: Airline): Action[] {
  const actions: Action[] = [];
  const lvl = priceLevel(g);

  // Sell every idle plane — pure upkeep with no revenue.
  const idle = al.fleet.filter((pl) => pl.routeId === null);
  if (idle.length) {
    const savings = idle.reduce((s, pl) => s + typeById(g, pl.typeId).weeklyUpkeep * lvl, 0);
    actions.push({
      score: savings,
      run: () => {
        for (const pl of [...idle]) sellPlane(g, al, pl.id);
      },
    });
  }

  // Close the routes that lose real money, selling the planes that flew them.
  // Near-breakeven routes get grace — they may feed connecting traffic.
  if (al.routes.length) {
    const net = evaluateNetwork(g, al);
    for (const route of al.routes) {
      const summary = net.routes.get(route.id);
      if (!summary || summary.profit >= -500 * priceLevel(g)) continue;
      actions.push({
        score: -summary.profit,
        run: () => {
          const planes = planesOnRoute(al, route.id);
          closeRoute(g, al, route.id);
          for (const pl of planes) sellPlane(g, al, pl.id);
        },
      });
    }
  }

  // Sell a slot no route uses — stop the gate fees, pocket the partial refund.
  for (const id of al.rights) {
    if (id === al.homeId) continue;
    if (al.routes.some((r) => r.stops.includes(id))) continue;
    const ap = airportById(g, id);
    actions.push({
      score: (gateFee(g, ap) * 7) / 365,
      run: () => sellSlot(g, al, id),
    });
  }

  return actions;
}

/** One decision pass: gather candidates, jitter their scores, run the best. */
function decide(g: GameState, al: Airline, p: Personality): void {
  const w = weeklyTotals(g, al);
  // Expand while profitable, or while there's runway to absorb the losses;
  // otherwise switch to stopping the bleed.
  const expanding =
    w.net >= 0 || spendable(g, al, p) > -w.net * p.runwayWeeks;
  // One network eval per pass: its whole-network profit is the baseline every
  // what-if is measured against, and its per-route summaries (connection
  // traffic included) drive the capacity/upgrade/realloc decisions.
  const net = evaluateNetwork(g, al);
  const base = net.profit;
  let actions: Action[];
  if (expanding) {
    // New-route what-ifs are the only network-size-dependent cost; compute the
    // bounded shortlist once and share it between opening and reallocating.
    const candidates = newRouteCandidates(g, al, p, base, spendable(g, al, p));
    const growth = [
      ...routeActions(g, al, p, candidates),
      ...capacityActions(g, al, p, net),
      ...upgradeActions(g, al, p, net, base),
      ...slotActions(g, al, p),
    ];
    actions = [
      ...acquisitionActions(g, al, p),
      ...growth,
      ...reallocateActions(g, al, p, net, base, candidates),
      ...repayActions(g, al, p),
    ];
    // No profitable way to grow. A cold-start or small, boxed-in airline reaches
    // for the best city anyway (ignoring the floor) to escape an isolated home;
    // one that's already bleeding stops the bleed instead of idling in the red.
    if (growth.length === 0) {
      actions.push(
        ...(w.net < 0 && al.rights.length > 1 ? retrenchActions(g, al) : reachActions(g, al, p)),
      );
    }
  } else {
    actions = [...retrenchActions(g, al), ...repayActions(g, al, p)];
  }
  if (actions.length === 0) return;
  let best: Action | null = null;
  let bestScore = -Infinity;
  for (const a of actions) {
    const noisy = a.score * (1 + p.noise * (rand(g) * 2 - 1));
    if (noisy > bestScore) {
      bestScore = noisy;
      best = a;
    }
  }
  best!.run();
}

/**
 * Advance every AI airline one day. Call right after advanceDay. Cheap on
 * non-decision days: each airline acts only when its jittered cadence comes up.
 */
export function runAI(g: GameState): void {
  updateDistress(g); // list the failing, liquidate the unsold (self-gates weekly)
  // Snapshot: an acquisition or liquidation can remove an airline mid-pass.
  for (const al of [...g.airlines]) {
    if (!al.ai || !g.airlines.includes(al)) continue; // gone this tick — skip
    // AI airlines keep finance history too (distress checks, acquisitions UI).
    if (g.day % 7 === 0) recordFinanceSnapshot(g, al);
    if (al.forSale) continue; // in limbo on the block — no new moves
    if (g.day < al.ai.nextDecisionDay) continue;
    const p = personalityById.get(al.ai.personality) ?? PERSONALITIES[0];
    decide(g, al, p);
    al.ai.nextDecisionDay = scheduleNext(g, p);
  }
}

// ---- "Uneasy lies the crown": rivals raid a dominant player ------------------

/** Days the player has to claw a raider back below control before losing. */
export const DEFENSE_WINDOW_DAYS = 120;
/** A rival stake in the player big enough to warrant an early heads-up. */
const RAID_WARN_SHARES = 30;
/** Shares a raider grabs in one weekly press of the bid. */
const RAID_BLOCK = 8;

/** The strongest solvent AI — the natural aggressor against a dominant player
 *  ("the strongest rival can bid for you back"), and the one that can fund it. */
function strongestRaider(g: GameState): Airline | null {
  let best: Airline | null = null;
  let bestEq = -Infinity;
  for (const al of g.airlines) {
    if (!al.ai || al.forSale) continue;
    const eq = equity(g, al);
    if (eq > 0 && eq > bestEq) {
      bestEq = eq;
      best = al;
    }
  }
  return best;
}

/** Raider grabs up to RAID_BLOCK of the player's shares it can finance, forcing
 *  retained shares at the control premium once the float is exhausted. Returns
 *  shares taken this press. */
function pressRaid(g: GameState, raider: Airline): number {
  const player = g.airlines[0];
  const p = personalityById.get(raider.ai!.personality) ?? PERSONALITIES[0];
  const owned = sharesOwned(player, raider.id);
  let n = Math.min(RAID_BLOCK, TOTAL_SHARES - owned);
  while (n > 0) {
    const cost = costToAccumulate(g, player, owned, n, true);
    if (coverCost(g, raider, p, cost)) return forceBuy(g, raider, player, n);
    n--;
  }
  return 0;
}

/**
 * Once-a-week raid sweep against the human. Only fires when the player is
 * dominant; the strongest rival accumulates the player's stock (warning the
 * player along the way), and on crossing control opens a defense window. Letting
 * that window expire while still controlled ends the game. Driven from the main
 * loop, not runAI — headless sims (no human) never call it.
 */
export function raidPlayer(g: GameState): void {
  if (g.defeat) return;
  const player = g.airlines[0];
  if (player.ai) return; // no human to depose

  if (g.raid) {
    const raider = g.airlines.find((a) => a.id === g.raid!.raiderId);
    if (!raider || !raider.ai) {
      g.raid = undefined; // raider merged away or liquidated — threat gone
      return;
    }
    if (!hasControl(player, raider.id)) {
      playerNews(g, `🛡 You fought off ${raider.name}'s takeover — ${player.name} is yours again.`);
      g.raid = undefined;
      return;
    }
    if (g.day >= g.raid.deadlineDay) {
      g.defeat = { raiderId: raider.id, day: g.day };
      playerNews(g, `🏴 ${raider.name} completed its takeover of ${player.name}. Game over.`);
      return;
    }
    pressRaid(g, raider); // tighten the grip while the clock runs
    return;
  }

  if (!isPlayerDominant(g)) return;
  const raider = strongestRaider(g);
  if (!raider) return;
  const before = sharesOwned(player, raider.id);
  if (pressRaid(g, raider) === 0) return; // couldn't fund a single share
  const after = sharesOwned(player, raider.id);
  if (hasControl(player, raider.id)) {
    g.raid = { raiderId: raider.id, sinceDay: g.day, deadlineDay: g.day + DEFENSE_WINDOW_DAYS };
    const months = Math.round(DEFENSE_WINDOW_DAYS / 30);
    playerNews(
      g,
      `⚠ ${raider.name} seized control of ${player.name} (${after}%)! Buy back a majority within ${months} months or lose.`,
    );
  } else if (after >= RAID_WARN_SHARES && before < RAID_WARN_SHARES) {
    playerNews(g, `⚠ ${raider.name} is raiding your stock — it now holds ${after}% of you.`);
  }
}
