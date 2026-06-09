import type { GameState, Plane, Route } from './types';
import { reseedIds } from './engine';

/** Bump when the save shape changes incompatibly. */
export const SAVE_VERSION = 1;

/** The persisted slice of a game — only the dynamic fields, not static data. */
export interface SaveData {
  version: number;
  day: number;
  cash: number;
  debt: number;
  rights: string[];
  fleet: Plane[];
  routes: Route[];
  log: string[];
}

/** Serialize a game to a JSON string (airports/aircraft come from data.ts, not saved). */
export function serialize(g: GameState): string {
  const data: SaveData = {
    version: SAVE_VERSION,
    day: g.day,
    cash: g.cash,
    debt: g.debt,
    rights: g.rights,
    fleet: g.fleet,
    routes: g.routes,
    log: g.log,
  };
  return JSON.stringify(data);
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
  if (
    typeof s.day !== 'number' ||
    typeof s.cash !== 'number' ||
    typeof s.debt !== 'number' ||
    !Array.isArray(s.fleet) ||
    !Array.isArray(s.routes)
  ) {
    return null;
  }
  return {
    version: SAVE_VERSION,
    day: s.day,
    cash: s.cash,
    debt: s.debt,
    rights: Array.isArray(s.rights) ? (s.rights as string[]) : [],
    fleet: s.fleet as Plane[],
    routes: s.routes as Route[],
    log: Array.isArray(s.log) ? (s.log as string[]) : [],
  };
}

/**
 * Apply a save onto a live game, keeping the game's current airports/aircraft.
 * Sanitizes against data drift: routes referencing unknown airports and planes
 * of unknown types are dropped, and planes on a dropped route go idle.
 */
export function applySave(g: GameState, data: SaveData): void {
  const airportIds = new Set(g.airports.map((a) => a.id));
  const typeIds = new Set(g.aircraftTypes.map((t) => t.id));

  const routes = data.routes.filter(
    (r) => r.stops.length >= 2 && r.stops.every((s) => airportIds.has(s)),
  );
  const routeIds = new Set(routes.map((r) => r.id));
  const fleet = data.fleet
    .filter((p) => typeIds.has(p.typeId))
    .map((p) => ({
      ...p,
      routeId: p.routeId && routeIds.has(p.routeId) ? p.routeId : null,
      kmFlown: p.kmFlown ?? 0,
    }));

  // Keep only rights at airports that still exist; always include home bases.
  const rights = new Set(data.rights.filter((id) => airportIds.has(id)));
  for (const a of g.airports) if (a.home) rights.add(a.id);

  g.day = data.day;
  g.cash = data.cash;
  g.debt = data.debt;
  g.rights = [...rights];
  g.routes = routes;
  g.fleet = fleet;
  g.log = data.log;
  reseedIds(g);
}
