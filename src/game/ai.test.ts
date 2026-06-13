import { describe, expect, it } from 'vitest';
import type { GameState } from './types';
import {
  addAiAirlines,
  AI_HOME_POOL,
  MAX_AI_AIRLINES,
  PERSONALITIES,
  runAI,
} from './ai';
import {
  advanceDay,
  airportById,
  airportSlotsTotal,
  airportSlotsUsed,
  equity,
  newGame,
  player,
} from './engine';
import { serialize } from './persist';
import { distanceKm } from './geo';

/** A seeded game with `n` AI airlines, fresh from setup. */
function gameWith(n: number, seed = 7): GameState {
  const g = newGame('crw', seed);
  addAiAirlines(g, n);
  return g;
}

/** Run `days` of simulation: the daily tick plus the AI pass, like main.ts. */
function run(g: GameState, days: number): void {
  for (let i = 0; i < days; i++) {
    advanceDay(g);
    runAI(g);
  }
}

describe('addAiAirlines', () => {
  it('creates the requested number of AIs after the player', () => {
    const g = gameWith(4);
    expect(g.airlines).toHaveLength(5);
    expect(player(g).ai).toBeUndefined();
    for (const al of g.airlines.slice(1)) {
      expect(al.ai).toBeDefined();
      expect(PERSONALITIES.some((p) => p.id === al.ai!.personality)).toBe(true);
    }
  });

  it('clamps the count to 0..MAX_AI_AIRLINES', () => {
    expect(gameWith(0).airlines).toHaveLength(1);
    expect(gameWith(99).airlines).toHaveLength(1 + MAX_AI_AIRLINES);
  });

  it('draws homes from the NA pool, never near the player, no duplicates', () => {
    const g = gameWith(8);
    const homes = g.airlines.slice(1).map((al) => al.homeId);
    expect(new Set(homes).size).toBe(homes.length);
    const playerHome = airportById(g, 'crw');
    for (const id of homes) {
      expect(AI_HOME_POOL).toContain(id);
      expect(distanceKm(airportById(g, id), playerHome)).toBeGreaterThanOrEqual(500);
    }
  });

  it('gives each AI a distinct name and color', () => {
    const g = gameWith(8);
    const names = g.airlines.slice(1).map((al) => al.name);
    const colors = g.airlines.slice(1).map((al) => al.color);
    expect(new Set(names).size).toBe(names.length);
    expect(new Set(colors).size).toBe(colors.length);
  });

  it('each AI starts with rights only at its own home', () => {
    const g = gameWith(3);
    for (const al of g.airlines.slice(1)) expect(al.rights).toEqual([al.homeId]);
  });
});

describe('AI decisions', () => {
  it('within a year, every AI has bought a plane and opened a route', () => {
    const g = gameWith(4);
    run(g, 365);
    for (const al of g.airlines.slice(1)) {
      expect(al.fleet.length, al.name).toBeGreaterThanOrEqual(1);
      expect(al.routes.length, al.name).toBeGreaterThanOrEqual(1);
      expect(al.rights.length, al.name).toBeGreaterThanOrEqual(2);
    }
  });

  it('AIs keep weekly finance history', () => {
    const g = gameWith(1);
    run(g, 70);
    const ai = g.airlines[1];
    expect(ai.history.length).toBeGreaterThanOrEqual(10);
  });

  it('expansion respects the per-airport slot pools', () => {
    const g = gameWith(8);
    run(g, 365 * 3);
    for (const ap of g.airports) {
      expect(airportSlotsUsed(g, ap.id), ap.code).toBeLessThanOrEqual(airportSlotsTotal(ap));
    }
  });
});

describe('determinism', () => {
  it('two games with the same seed evolve identically', () => {
    const a = gameWith(4, 99);
    const b = gameWith(4, 99);
    run(a, 365 * 2);
    run(b, 365 * 2);
    expect(serialize(a)).toBe(serialize(b));
  });

  it('different seeds diverge', () => {
    const a = gameWith(4, 1);
    const b = gameWith(4, 2);
    run(a, 365);
    run(b, 365);
    expect(serialize(a)).not.toBe(serialize(b));
  });
});

describe('long-run invariants (headless sim)', () => {
  it('ten years with 8 AIs: finances stay finite and the world stays sane', () => {
    const g = gameWith(8, 3);
    run(g, 365 * 10);
    for (const al of g.airlines) {
      expect(Number.isFinite(al.cash), `${al.name} cash`).toBe(true);
      expect(Number.isFinite(al.debt), `${al.name} debt`).toBe(true);
      expect(al.debt).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(equity(g, al))).toBe(true);
      for (const p of al.fleet) {
        expect(Number.isFinite(p.kmFlown)).toBe(true);
        if (p.routeId) expect(al.routes.some((r) => r.id === p.routeId)).toBe(true);
      }
      for (const r of al.routes) {
        expect(al.rights).toEqual(expect.arrayContaining(r.stops));
      }
    }
    // The world isn't frozen: AIs collectively built real networks.
    const aiRoutes = g.airlines.slice(1).reduce((s, al) => s + al.routes.length, 0);
    const aiPlanes = g.airlines.slice(1).reduce((s, al) => s + al.fleet.length, 0);
    expect(aiRoutes).toBeGreaterThan(8);
    expect(aiPlanes).toBeGreaterThan(8);
    // Not everyone should be dead in a decade (tuning canary, not a hard rule).
    const solvent = g.airlines.slice(1).filter((al) => equity(g, al) > 0).length;
    expect(solvent).toBeGreaterThanOrEqual(4);
  }, 60_000);
});
