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
  g = newGame('crw');
});

/** Day far enough along that every aircraft type is in service. */
const PLAYED_DAY = 365 * 75;

/** Build a small played game: cash spent, a route, a plane on it, some days. */
function playedGame(): GameState {
  const x = newGame('crw');
  x.day = PLAYED_DAY; // modern era, so the E175 below is purchasable
  x.cash = 1_000_000_000;
  x.rights = ['crw', 'clt', 'dca']; // hold rights for the route below
  openRoute(x, ['crw', 'clt', 'dca']);
  setFareFactor(x, x.routes[0].id, 1.2);
  buyPlane(x, 'e175');
  assignPlane(x, x.fleet[0].id, x.routes[0].id);
  x.debt = 7_000_000;
  return x;
}

describe('serialize / deserialize', () => {
  it('round-trips the dynamic game fields', () => {
    const src = playedGame();
    const restored = deserialize(serialize(src))!;
    expect(restored.version).toBe(SAVE_VERSION);
    expect(restored.homeId).toBe('crw');
    expect(restored.day).toBe(PLAYED_DAY);
    expect(restored.cash).toBe(src.cash);
    expect(restored.debt).toBe(7_000_000);
    expect(restored.routes).toEqual(src.routes);
    expect(restored.fleet).toEqual(src.fleet);
  });

  it('round-trips pending slot negotiations, dropping ones already granted', () => {
    const src = playedGame();
    src.negotiations = [
      { airportId: 'gso', opensDay: PLAYED_DAY + 60, fee: 1_000_000 },
      { airportId: 'clt', opensDay: PLAYED_DAY + 30, fee: 3_000_000 }, // already held
    ];
    const restored = deserialize(serialize(src))!;
    expect(restored.negotiations).toEqual(src.negotiations);
    applySave(g, restored);
    // CLT is already a held right, so its stale application is dropped on load.
    expect(g.negotiations).toEqual([
      { airportId: 'gso', opensDay: PLAYED_DAY + 60, fee: 1_000_000 },
    ]);
  });

  it('tolerates a save with no negotiations field', () => {
    const raw = JSON.parse(serialize(playedGame())) as Record<string, unknown>;
    delete raw.negotiations;
    expect(deserialize(JSON.stringify(raw))!.negotiations).toEqual([]);
  });

  it('round-trips earned badges, dropping any unknown ids on load', () => {
    const src = playedGame();
    src.badges = [
      { id: 'net-5', day: 100 },
      { id: 'no-such-badge', day: 200 }, // a badge that no longer exists
    ];
    const restored = deserialize(serialize(src))!;
    expect(restored.badges).toEqual(src.badges);
    applySave(g, restored);
    expect(g.badges).toEqual([{ id: 'net-5', day: 100 }]);
  });

  it('tolerates a save with no badges field', () => {
    const raw = JSON.parse(serialize(playedGame())) as Record<string, unknown>;
    delete raw.badges;
    expect(deserialize(JSON.stringify(raw))!.badges).toEqual([]);
  });

  it('round-trips finance history', () => {
    const src = playedGame();
    src.history.push({
      day: 7, cash: 5_000_000, debt: 1_000_000, fleetValue: 2_000_000,
      revenue: 300_000, cost: 200_000, interest: 1_000, interestEarned: 100,
      net: 99_100, pax: 1234,
    });
    const restored = deserialize(serialize(src))!;
    expect(restored.history).toEqual(src.history);
    applySave(g, restored);
    expect(g.history).toEqual(src.history);
  });

  it('tolerates a save with no history field', () => {
    const raw = JSON.parse(serialize(playedGame())) as Record<string, unknown>;
    delete raw.history;
    expect(deserialize(JSON.stringify(raw))!.history).toEqual([]);
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
    expect(g.homeId).toBe('crw');
    expect(g.day).toBe(PLAYED_DAY);
    expect(g.debt).toBe(7_000_000);
    expect(g.routes).toHaveLength(1);
    expect(g.fleet).toHaveLength(1);
    expect(g.fleet[0].routeId).toBe(g.routes[0].id);
    // Static data still comes from the live game, not the save.
    expect(g.airports).toBe(newGame('crw').airports);
    expect(g.aircraftTypes.length).toBeGreaterThan(0);
  });

  it('reseeds ids so a route opened after load does not collide', () => {
    const src = playedGame(); // its route id is e.g. route-N
    applySave(g, deserialize(serialize(src))!);
    const existing = new Set(g.routes.map((r) => r.id));
    openRoute(g, ['crw', 'dca']); // airports whose rights the save restored
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
    data.fleet.push({
      id: 'plane-ghost',
      typeId: 'flying-saucer',
      routeId: data.routes[0].id,
      kmFlown: 0,
    });
    data.routes[0].stops = ['crw', 'atlantis']; // route will be dropped
    applySave(g, data);
    expect(g.fleet.every((p) => p.typeId !== 'flying-saucer')).toBe(true);
    // The real plane survives but is now idle (its route was dropped).
    expect(g.fleet).toHaveLength(1);
    expect(g.fleet[0].routeId).toBeNull();
  });

  it('migrates legacy fictional plane types to their real replacements', () => {
    const src = playedGame();
    const data = deserialize(serialize(src))!;
    data.fleet.push({
      id: 'plane-old',
      typeId: 'oceanjet', // pre-real-aircraft save
      routeId: null,
      kmFlown: 1234,
    });
    applySave(g, data);
    const migrated = g.fleet.find((p) => p.id === 'plane-old')!;
    expect(migrated.typeId).toBe('b767');
    expect(migrated.kmFlown).toBe(1234);
  });
});
