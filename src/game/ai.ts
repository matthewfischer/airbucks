import type { AircraftType, Airline, Airport, GameState } from './types';
import { distanceKm } from './geo';
import { acquire, updateDistress } from './distress';
import {
  airportById,
  assignPlane,
  availableTypes,
  baselineSpeed,
  borrow,
  buyPlane,
  closeRoute,
  creditLimit,
  distanceFactor,
  equity,
  evaluateNetwork,
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

// North American size-3/4 secondary hubs AIs may call home — close to the
// player's own starting tier, so an AI must climb the same reputation ladder
// to reach the size-5/6 majors (ATL, ORD, JFK, LAX…) rather than spawning on
// one. Spread across regions (West, Texas, Midwest, South, Canada, Mexico,
// Caribbean) so up to eight AIs don't pile into one corner. The Appalachian
// core (PIT/CVG/CMH/CLE/SDF) is left out — that's the player's home ladder.
// See docs/ai-players.md.
export const AI_HOME_POOL = [
  // West & Mountain
  'pdx', 'slc', 'den', 'san', 'smf', 'abq',
  // Texas & South-central
  'aus', 'sat',
  // Midwest
  'stl', 'mci', 'mke', 'ind', 'dtw',
  // South & Southeast
  'bna', 'mem', 'msy', 'jax', 'tpa',
  // Canada
  'yyc', 'yeg', 'yow',
  // Mexico & Caribbean
  'gdl', 'mty', 'sju', 'pty',
];

/** Don't seed an AI this close to the player's home base, in km. */
const MIN_HOME_DISTANCE_KM = 500;

const AI_NAMES = [
  'Transcontinental Airways', 'Pacific Crown', 'Lone Star Air', 'Lakeshore Airways',
  'Gulf Stream Air', 'Northern Cross', 'Cactus Air Lines', 'Maple Leaf Air',
  'Aztec Airways', 'Gateway Air', 'Bluegrass Airways', 'Cascade Air',
];

const AI_COLORS = [
  '#e85d75', '#c084fc', '#5ac8fa', '#ffd166',
  '#80ed99', '#f4845f', '#a3b18a', '#e07be0',
];

export const MAX_AI_AIRLINES = 8;

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
 * Pick `count` AI home airports: drawn from the pool, never the player's home
 * or anywhere near it, spread apart greedily so eight AIs don't pile into one
 * corner of the map.
 */
function pickHomes(g: GameState, count: number): Airport[] {
  if (count <= 0) return [];
  const playerHome = airportById(g, g.airlines[0].homeId);
  const pool = AI_HOME_POOL
    .map((id) => airportById(g, id))
    .filter((a) => a.id !== playerHome.id && distanceKm(a, playerHome) >= MIN_HOME_DISTANCE_KM);
  const picked: Airport[] = [];
  // Random first pick, then maximize the minimum distance to everything chosen.
  const first = pool[Math.floor(rand(g) * pool.length)];
  if (first) picked.push(first);
  while (picked.length < count && picked.length < pool.length) {
    let best: Airport | null = null;
    let bestD = -1;
    for (const a of pool) {
      if (picked.includes(a)) continue;
      const d = Math.min(...picked.map((p) => distanceKm(a, p)));
      if (d > bestD) {
        bestD = d;
        best = a;
      }
    }
    if (!best) break;
    picked.push(best);
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
interface Action {
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
  const demand = pairDemand(a, b) * distanceFactor(dist) * demandMult;
  const carried = Math.min(demand, cap);
  const lf = cap > 0 ? carried / cap : 0;
  const revenue = carried * referenceFare(dist) * premium * lvl;
  const cost = lf * trips * 2 * dist * type.costPerKm * lvl + type.weeklyUpkeep * lvl;
  return revenue - cost;
}

/** Don't bother with markets earning less than this a week (1950 dollars). */
const MIN_ROUTE_PROFIT = 1_500;
const minProfit = (g: GameState): number => MIN_ROUTE_PROFIT * priceLevel(g);

/** The affordable in-production type that earns the most on this market, or null. */
function bestTypeFor(
  g: GameState,
  a: Airport,
  b: Airport,
  dist: number,
  budget: number,
): { type: AircraftType; profit: number } | null {
  let best: { type: AircraftType; profit: number } | null = null;
  for (const t of availableTypes(g)) {
    if (t.range < dist || t.price > budget) continue;
    const profit = estimateRouteProfit(g, a, b, dist, t);
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
  const owned = idle ? estimateRouteProfit(g, a, b, dist, typeById(g, idle.typeId)) : -Infinity;
  const bought = bestTypeFor(g, a, b, dist, budget)?.profit ?? -Infinity;
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
  const a = airportById(g, route.stops[0]);
  const b = airportById(g, route.stops[route.stops.length - 1]);
  const choice = bestTypeFor(g, a, b, maxLeg, spendable(g, al, p));
  if (!choice || !coverCost(g, al, p, choice.type.price)) return;
  if (buyPlane(g, al, choice.type.id) === null) {
    assignPlane(g, al, al.fleet[al.fleet.length - 1].id, routeId);
  }
}

/** Candidate: open a direct route between two held airports and staff it. */
function routeActions(g: GameState, al: Airline, p: Personality): Action[] {
  const actions: Action[] = [];
  const budget = spendable(g, al, p);
  for (let i = 0; i < al.rights.length; i++) {
    for (let j = i + 1; j < al.rights.length; j++) {
      const a = airportById(g, al.rights[i]);
      const b = airportById(g, al.rights[j]);
      if (hasRouteBetween(al, a.id, b.id)) continue;
      const dist = distanceKm(a, b);
      const profit = bestPlanFor(g, al, a, b, dist, budget);
      if (profit === null || profit < minProfit(g)) continue;
      let score = profit * sizePreference(p, a, b);
      if (a.id === al.homeId || b.id === al.homeId) score *= p.hubBonus;
      actions.push({
        score,
        run: () => {
          if (openRoute(g, al, [a.id, b.id]) === null) {
            staffRoute(g, al, p, al.routes[al.routes.length - 1].id);
            // Flag the move only if it touches a city you serve — keeps the
            // news feed about your world, not every distant AI route.
            const youHold = g.airlines[0].rights;
            if (youHold.includes(a.id) || youHold.includes(b.id))
              playerNews(g, `✈ ${al.name} opened ${a.code} → ${b.code} — moving into your network.`);
          }
        },
      });
    }
  }
  return actions;
}

/** Candidate: add capacity to a full, profitable route, or staff a plane-less one. */
function capacityActions(g: GameState, al: Airline, p: Personality): Action[] {
  if (al.routes.length === 0) return [];
  const actions: Action[] = [];
  const net = evaluateNetwork(g, al);
  const budget = spendable(g, al, p);
  for (const route of al.routes) {
    const summary = net.routes.get(route.id);
    if (!summary) continue;
    const staffed = planesOnRoute(al, route.id).length > 0;
    if (staffed && (summary.loadFactor < 0.95 || summary.profit <= 0)) continue;
    const maxLeg = routeMaxLeg(g, route);
    const a = airportById(g, route.stops[0]);
    const b = airportById(g, route.stops[route.stops.length - 1]);
    const plan = bestPlanFor(g, al, a, b, maxLeg, budget);
    if (plan === null) continue;
    // An empty route is dead weight — staffing it outranks growing a full one.
    const score = staffed ? summary.profit : Math.max(plan, 0) + 1000;
    actions.push({ score, run: () => staffRoute(g, al, p, route.id) });
  }
  return actions;
}

/** Candidate: replace a profitable route's fleet with a newer, better type. */
function upgradeActions(g: GameState, al: Airline, p: Personality): Action[] {
  if (!p.upgrades || al.routes.length === 0) return [];
  const actions: Action[] = [];
  const net = evaluateNetwork(g, al);
  const budget = spendable(g, al, p);
  for (const route of al.routes) {
    const summary = net.routes.get(route.id);
    const planes = planesOnRoute(al, route.id);
    if (!summary || summary.profit <= 0 || planes.length === 0) continue;
    const maxLeg = routeMaxLeg(g, route);
    const a = airportById(g, route.stops[0]);
    const b = airportById(g, route.stops[route.stops.length - 1]);
    const dist = distanceKm(a, b);
    const oldType = typeById(g, planes[0].typeId);
    const oldProfit = estimateRouteProfit(g, a, b, dist, oldType);
    const floor = Math.max(...planes.map((pl) => typeById(g, pl.typeId).price));
    // Best strictly-pricier in-range type (the engine enforces "pricier").
    let type: AircraftType | null = null;
    let gain = 0;
    for (const t of availableTypes(g)) {
      if (t.range < maxLeg || t.price <= floor) continue;
      const tg = estimateRouteProfit(g, a, b, dist, t) - oldProfit;
      if (tg > gain) {
        gain = tg;
        type = t;
      }
    }
    if (!type) continue;
    const quote = upgradeRouteQuote(g, al, route.id, type.id);
    if (quote.net > budget) continue;
    actions.push({
      score: gain * planes.length,
      run: () => {
        if (coverCost(g, al, p, quote.net)) upgradeRoute(g, al, route.id, type!.id);
      },
    });
  }
  return actions;
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
      const choice = bestTypeFor(g, ap, held, d, budget);
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

/**
 * Bootstrap: an airline with only its home and nothing pending must land a
 * second city before it can fly anything. From an isolated home (e.g. ABQ)
 * every reachable market can sit below the profit floor, freezing a cautious
 * AI forever — so here we ignore that floor and grab the best reachable,
 * unlocked, affordable slot (closest, then biggest). Its first slot is granted
 * instantly, so this unsticks the airline in a single pass.
 */
function bootstrapActions(g: GameState, al: Airline, p: Personality): Action[] {
  if (al.rights.length !== 1 || al.negotiations.length > 0) return [];
  const budget = spendable(g, al, p);
  const home = airportById(g, al.homeId);
  let target: Airport | null = null;
  let bestScore = -Infinity;
  for (const ap of g.airports) {
    if (!rightsAvailable(g, al, ap.id)) continue;
    if (rightsFee(g, ap) > budget) continue;
    const d = distanceKm(ap, home);
    if (!bestTypeFor(g, ap, home, d, budget)) continue; // no affordable plane can reach it
    const s = (ap.size * home.size) / Math.max(1, d); // closer & bigger = better
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

/**
 * Candidate: buy a distressed rival off the block. Only a healthy airline with
 * the credit headroom to shoulder the target's debt will bid — so consolidation
 * flows from the strong to the weak, and overexpanders become the consolidators.
 */
function acquisitionActions(g: GameState, al: Airline, p: Personality): Action[] {
  const actions: Action[] = [];
  for (const target of g.airlines) {
    if (target === al || !target.forSale) continue;
    if (al.cash < target.forSale.price) continue; // sticker paid from cash
    if (equity(g, al) <= 0) continue; // only solvent airlines acquire
    if (target.debt > p.debtAppetite * creditLimit(g, al)) continue; // can carry the debt
    // Strategic value: the franchise's revenue base (its network reach).
    const score = evaluateNetwork(g, target).revenue;
    actions.push({ score, run: () => acquire(g, al, target) });
  }
  return actions;
}

/** Candidate: a debt-shy airline pays its loan down when cash allows. */
function repayActions(g: GameState, al: Airline, p: Personality): Action[] {
  if (al.debt <= 0 || al.cash <= 0) return [];
  if (al.debt <= p.debtAppetite * creditLimit(g, al)) return [];
  // Modest, steady urge — strong enough to win a pass when nothing else shines.
  return [{ score: al.debt / 100, run: () => repay(g, al, Math.min(al.cash * 0.5, al.debt)) }];
}

/**
 * Retrenchment candidates for an airline in the red. Scores are weekly
 * savings, so the biggest bleed gets stopped first.
 */
function retrenchActions(g: GameState, al: Airline): Action[] {
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
  const actions = expanding
    ? [
        ...acquisitionActions(g, al, p),
        ...bootstrapActions(g, al, p),
        ...routeActions(g, al, p),
        ...capacityActions(g, al, p),
        ...upgradeActions(g, al, p),
        ...slotActions(g, al, p),
        ...repayActions(g, al, p),
      ]
    : [...retrenchActions(g, al), ...repayActions(g, al, p)];
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
