import { beforeEach, describe, expect, it } from 'vitest';
import type { GameState } from './types';
import {
  assignPlane,
  buyPlane,
  newGame,
  openRoute,
  setFareFactor,
} from './engine';
import { applySave, deserialize, serialize, SAVE_VERSION } from './persist';

let g: GameState;
beforeEach(() => {
  g = newGame();
});

/** Build a small played game: cash spent, a route, a plane on it, some days. */
function playedGame(): GameState {
  const x = newGame();
  x.cash = 1_000_000_000;
  openRoute(x, ['crw', 'clt', 'dca']);
  setFareFactor(x, x.routes[0].id, 1.2);
  buyPlane(x, 'regionaljet');
  assignPlane(x, x.fleet[0].id, x.routes[0].id);
  x.day = 42;
  x.debt = 7_000_000;
  return x;
}

describe('serialize / deserialize', () => {
  it('round-trips the dynamic game fields', () => {
    const src = playedGame();
    const restored = deserialize(serialize(src))!;
    expect(restored.version).toBe(SAVE_VERSION);
    expect(restored.day).toBe(42);
    expect(restored.cash).toBe(src.cash);
    expect(restored.debt).toBe(7_000_000);
    expect(restored.routes).toEqual(src.routes);
    expect(restored.fleet).toEqual(src.fleet);
  });

  it('rejects malformed JSON', () => {
    expect(deserialize('not json {')).toBeNull();
  });

  it('rejects an incompatible version', () => {
    const bad = JSON.stringify({ version: 999, day: 0, cash: 0, debt: 0, fleet: [], routes: [] });
    expect(deserialize(bad)).toBeNull();
  });

  it('rejects missing required fields', () => {
    const bad = JSON.stringify({ version: SAVE_VERSION, day: 1 });
    expect(deserialize(bad)).toBeNull();
  });
});

describe('applySave', () => {
  it('restores state onto a fresh game and keeps its airports/aircraft', () => {
    const src = playedGame();
    const data = deserialize(serialize(src))!;
    applySave(g, data);
    expect(g.day).toBe(42);
    expect(g.debt).toBe(7_000_000);
    expect(g.routes).toHaveLength(1);
    expect(g.fleet).toHaveLength(1);
    expect(g.fleet[0].routeId).toBe(g.routes[0].id);
    // Static data still comes from the live game, not the save.
    expect(g.airports).toBe(newGame().airports);
    expect(g.aircraftTypes.length).toBeGreaterThan(0);
  });

  it('reseeds ids so a route opened after load does not collide', () => {
    const src = playedGame(); // its route id is e.g. route-N
    applySave(g, deserialize(serialize(src))!);
    const existing = new Set(g.routes.map((r) => r.id));
    openRoute(g, ['pit', 'cvg']);
    const newId = g.routes[g.routes.length - 1].id;
    expect(existing.has(newId)).toBe(false);
  });

  it('drops routes referencing airports that no longer exist', () => {
    const data = deserialize(serialize(playedGame()))!;
    data.routes[0].stops = ['crw', 'atlantis']; // unknown airport
    applySave(g, data);
    expect(g.routes).toHaveLength(0);
  });

  it('drops planes of unknown types and idles planes on dropped routes', () => {
    const src = playedGame();
    const data = deserialize(serialize(src))!;
    data.fleet.push({ id: 'plane-ghost', typeId: 'flying-saucer', routeId: data.routes[0].id });
    data.routes[0].stops = ['crw', 'atlantis']; // route will be dropped
    applySave(g, data);
    expect(g.fleet.every((p) => p.typeId !== 'flying-saucer')).toBe(true);
    // The real plane survives but is now idle (its route was dropped).
    expect(g.fleet).toHaveLength(1);
    expect(g.fleet[0].routeId).toBeNull();
  });
});
