import { describe, expect, it } from 'vitest';
import type { GameState } from './types';
import {
  addAiAirlines,
  MAX_AI_AIRLINES,
  PERSONALITIES,
  runAI,
} from './ai';
import { continentOf } from './data';
import { distanceKm } from './geo';
import {
  advanceDay,
  airportById,
  airportSlotsTotal,
  airportSlotsUsed,
  equity,
  newAirline,
  newGame,
  player,
} from './engine';
import { serialize } from './persist';

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

  it('homes are distinct size-3/4 secondary hubs, never the player home', () => {
    const g = gameWith(8);
    const homes = g.airlines.slice(1).map((al) => al.homeId);
    expect(new Set(homes).size).toBe(homes.length);
    for (const id of homes) {
      expect(id).not.toBe('crw');
      const ap = airportById(g, id);
      expect(ap.size, `${id} size`).toBeGreaterThanOrEqual(3);
      expect(ap.size, `${id} size`).toBeLessThanOrEqual(4);
    }
  });

  it('seeds a regional majority plus a global contingent', () => {
    // Most rivals share the player's continent — a CRW start draws mostly North
    // American rivals — but a few megacarriers spawn worldwide, on other
    // continents, so the late game collides with distant powers too.
    const shares = (home: string) => {
      const want = continentOf(home);
      const ph = airportById(newGame(home, 0), home);
      let regional = 0, far = 0, total = 0;
      for (let seed = 0; seed < 60; seed++) {
        const g = newGame(home, seed);
        addAiAirlines(g, MAX_AI_AIRLINES);
        for (const al of g.airlines.slice(1)) {
          total++;
          if (continentOf(al.homeId) === want) regional++;
          if (distanceKm(ph, airportById(g, al.homeId)) >= 6000) far++;
        }
      }
      return { regional: regional / total, far: far / total };
    };
    for (const home of ['crw', 'cpt', 'zrh']) {
      const s = shares(home);
      expect(s.regional, `${home} regional`).toBeGreaterThan(0.5); // still mostly local
      expect(s.far, `${home} far`).toBeGreaterThan(0.25); // but a global contingent
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

  it('an AI at an isolated home (ABQ) bootstraps instead of idling forever', () => {
    // Regression: seed-1 Gulf Stream sat at 1 city for 25 years from ABQ, where
    // every reachable market was below the profit floor. Bootstrap must unstick it.
    const g = newGame('crw', 5);
    const ai = newAirline('ai-x', 'Isolated Air', '#ffffff', 'abq');
    ai.ai = { personality: 'cheapskate', nextDecisionDay: 0 };
    g.airlines.push(ai);
    run(g, 365 * 3);
    expect(ai.rights.length).toBeGreaterThanOrEqual(2);
    expect(ai.routes.length).toBeGreaterThanOrEqual(1);
  });

  it('a small airline boxed in by an isolated home keeps growing, not freezing', () => {
    // Regression: a hub-builder at PTY (worldwide map) reached ~3 cities, then
    // every further market sat below the profit floor — so it froze there for
    // 20 years while rivals grew into the billions. Floor-ignoring reach must
    // keep a small, boxed-in airline expanding past that wall.
    const g = newGame('crw', 5);
    const ai = newAirline('ai-x', 'Boxed Air', '#ffffff', 'pty');
    ai.ai = { personality: 'hub-builder', nextDecisionDay: 0 };
    g.airlines.push(ai);
    run(g, 365 * 10);
    expect(ai.rights.length).toBeGreaterThan(4);
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

// A full 10-year, max-rivals sim takes ~2.5 min of synchronous work — long
// enough to trip vitest's worker-RPC heartbeat when it shares threads with the
// rest of the suite. It's excluded from the default `npm test` and runs on its
// own via `npm run test:slow` (RUN_SLOW_TESTS=1), which CI runs as a separate
// isolated job. See .github/workflows/ci.yml.
describe.runIf(process.env.RUN_SLOW_TESTS)('long-run invariants (headless sim)', () => {
  it('ten years at max AIs: finances stay finite and the world stays sane', () => {
    const g = gameWith(MAX_AI_AIRLINES, 3);
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
    // Consolidation is expected now — strong AIs absorb rivals, so the field may
    // shrink. The canary: survivors still exist and at least one is a healthy,
    // solvent network (not a field of zombies or a smoking crater).
    const survivors = g.airlines.slice(1);
    expect(survivors.length).toBeGreaterThanOrEqual(1);
    expect(survivors.some((al) => equity(g, al) > 0)).toBe(true);
    // Slow on purpose: a full 8-rival field rolling each other up via hostile
    // takeovers builds huge merged networks, so the per-day sim is heavy.
  }, 600_000);
});
