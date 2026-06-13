import type {
  AiState,
  Airline,
  EarnedBadge,
  FinanceSnapshot,
  ForSale,
  GameState,
  Negotiation,
  Plane,
  Route,
} from './types';
import { LEGACY_TYPE_IDS } from './data';
import { BADGE_IDS } from './badges';
import { reseedIds } from './engine';

/** Bump when the save shape changes incompatibly. */
export const SAVE_VERSION = 7;

/** One airline's persisted slice. */
export interface SavedAirline {
  id: string;
  name: string;
  color: string;
  homeId: string;
  cash: number;
  debt: number;
  rights: string[];
  negotiations: Negotiation[];
  badges: EarnedBadge[];
  fleet: Plane[];
  routes: Route[];
  log: string[];
  history: FinanceSnapshot[];
  /** AI brain state; absent on the player airline. */
  ai?: AiState;
  /** Distress streak markers + for-sale listing (AI airlines only). */
  cashNegSince?: number;
  equityNegSince?: number;
  forSale?: ForSale;
  /** Post-acquisition integration boost expiry day. */
  mergerBoostUntil?: number;
}

/** The persisted slice of a game — only the dynamic fields, not static data. */
export interface SaveData {
  version: number;
  day: number;
  rngState: number;
  nextId: number;
  airlines: SavedAirline[];
}

const saveAirline = (al: Airline): SavedAirline => ({
  id: al.id,
  name: al.name,
  color: al.color,
  homeId: al.homeId,
  cash: al.cash,
  debt: al.debt,
  rights: al.rights,
  negotiations: al.negotiations,
  badges: al.badges,
  fleet: al.fleet,
  routes: al.routes,
  log: al.log,
  history: al.history,
  ...(al.ai ? { ai: al.ai } : {}),
  ...(al.cashNegSince !== undefined ? { cashNegSince: al.cashNegSince } : {}),
  ...(al.equityNegSince !== undefined ? { equityNegSince: al.equityNegSince } : {}),
  ...(al.forSale ? { forSale: al.forSale } : {}),
  ...(al.mergerBoostUntil !== undefined ? { mergerBoostUntil: al.mergerBoostUntil } : {}),
});

const parseAi = (d: unknown): AiState | undefined => {
  if (typeof d !== 'object' || d === null) return undefined;
  const s = d as Record<string, unknown>;
  if (typeof s.personality !== 'string' || typeof s.nextDecisionDay !== 'number')
    return undefined;
  return { personality: s.personality, nextDecisionDay: s.nextDecisionDay };
};

const parseForSale = (d: unknown): ForSale | undefined => {
  if (typeof d !== 'object' || d === null) return undefined;
  const s = d as Record<string, unknown>;
  if (
    typeof s.listedDay !== 'number' ||
    typeof s.deadlineDay !== 'number' ||
    typeof s.price !== 'number'
  )
    return undefined;
  return { listedDay: s.listedDay, deadlineDay: s.deadlineDay, price: s.price };
};

const optNum = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

/** Serialize a game to a JSON string (airports/aircraft come from data.ts, not saved). */
export function serialize(g: GameState): string {
  const data: SaveData = {
    version: SAVE_VERSION,
    day: g.day,
    rngState: g.rngState,
    nextId: g.nextId,
    airlines: g.airlines.map(saveAirline),
  };
  return JSON.stringify(data);
}

function parseAirline(d: unknown): SavedAirline | null {
  if (typeof d !== 'object' || d === null) return null;
  const s = d as Record<string, unknown>;
  if (
    typeof s.homeId !== 'string' ||
    typeof s.cash !== 'number' ||
    typeof s.debt !== 'number' ||
    !Array.isArray(s.fleet) ||
    !Array.isArray(s.routes)
  ) {
    return null;
  }
  const ai = parseAi(s.ai);
  const forSale = parseForSale(s.forSale);
  const cashNegSince = optNum(s.cashNegSince);
  const equityNegSince = optNum(s.equityNegSince);
  const mergerBoostUntil = optNum(s.mergerBoostUntil);
  return {
    id: typeof s.id === 'string' ? s.id : 'player',
    name: typeof s.name === 'string' ? s.name : 'Air Bucks',
    color: typeof s.color === 'string' ? s.color : '#3fd0c9',
    homeId: s.homeId,
    cash: s.cash,
    debt: s.debt,
    rights: Array.isArray(s.rights) ? (s.rights as string[]) : [],
    negotiations: Array.isArray(s.negotiations) ? (s.negotiations as Negotiation[]) : [],
    badges: Array.isArray(s.badges) ? (s.badges as EarnedBadge[]) : [],
    fleet: s.fleet as Plane[],
    routes: s.routes as Route[],
    log: Array.isArray(s.log) ? (s.log as string[]) : [],
    history: Array.isArray(s.history) ? (s.history as FinanceSnapshot[]) : [],
    ...(ai ? { ai } : {}),
    ...(cashNegSince !== undefined ? { cashNegSince } : {}),
    ...(equityNegSince !== undefined ? { equityNegSince } : {}),
    ...(forSale ? { forSale } : {}),
    ...(mergerBoostUntil !== undefined ? { mergerBoostUntil } : {}),
  };
}

/** Parse and validate a save string. Returns null on anything malformed/incompatible. */
export function deserialize(json: string): SaveData | null {
  let d: unknown;
  try {
    d = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof d !== 'object' || d === null) return null;
  const s = d as Record<string, unknown>;
  if (s.version !== SAVE_VERSION) return null;
  if (typeof s.day !== 'number' || !Array.isArray(s.airlines) || s.airlines.length === 0)
    return null;
  const airlines: SavedAirline[] = [];
  for (const a of s.airlines) {
    const parsed = parseAirline(a);
    if (!parsed) return null;
    airlines.push(parsed);
  }
  return {
    version: SAVE_VERSION,
    day: s.day,
    rngState: typeof s.rngState === 'number' ? s.rngState >>> 0 : 0,
    // Missing/garbage counter is fine — applySave reseeds past every loaded id.
    nextId: typeof s.nextId === 'number' ? s.nextId : 1,
    airlines,
  };
}

/**
 * Rebuild one live airline from its saved slice, sanitizing against data
 * drift: routes referencing unknown airports and planes of unknown types are
 * dropped, and planes on a dropped route go idle.
 */
function applyAirline(
  data: SavedAirline,
  airportIds: Set<string>,
  typeIds: Set<string>,
): Airline {
  const routes = data.routes.filter(
    (r) => r.stops.length >= 2 && r.stops.every((s) => airportIds.has(s)),
  );
  const routeIds = new Set(routes.map((r) => r.id));
  const fleet = data.fleet
    .map((p) => ({ ...p, typeId: LEGACY_TYPE_IDS[p.typeId] ?? p.typeId }))
    .filter((p) => typeIds.has(p.typeId))
    .map((p) => ({
      ...p,
      routeId: p.routeId && routeIds.has(p.routeId) ? p.routeId : null,
      kmFlown: p.kmFlown ?? 0,
    }));

  // Keep only rights at airports that still exist; always include the home base.
  const rights = new Set(data.rights.filter((id) => airportIds.has(id)));
  rights.add(data.homeId);

  // Drop pending applications at vanished airports or ones already granted.
  const negotiations = (data.negotiations ?? []).filter(
    (n) => airportIds.has(n.airportId) && !rights.has(n.airportId),
  );

  return {
    id: data.id,
    name: data.name,
    color: data.color,
    homeId: data.homeId,
    cash: data.cash,
    debt: data.debt,
    rights: [...rights],
    negotiations,
    // Drop any badges whose definitions no longer exist.
    badges: (data.badges ?? []).filter((b) => BADGE_IDS.has(b.id)),
    fleet,
    routes,
    log: data.log,
    history: data.history,
    ...(data.ai ? { ai: data.ai } : {}),
    ...(data.cashNegSince !== undefined ? { cashNegSince: data.cashNegSince } : {}),
    ...(data.equityNegSince !== undefined ? { equityNegSince: data.equityNegSince } : {}),
    ...(data.forSale ? { forSale: data.forSale } : {}),
    ...(data.mergerBoostUntil !== undefined ? { mergerBoostUntil: data.mergerBoostUntil } : {}),
  };
}

/** Apply a save onto a live game, keeping the game's current airports/aircraft. */
export function applySave(g: GameState, data: SaveData): void {
  const airportIds = new Set(g.airports.map((a) => a.id));
  const typeIds = new Set(g.aircraftTypes.map((t) => t.id));
  g.day = data.day;
  g.rngState = data.rngState;
  g.nextId = data.nextId;
  g.airlines = data.airlines.map((a) => applyAirline(a, airportIds, typeIds));
  reseedIds(g);
}
