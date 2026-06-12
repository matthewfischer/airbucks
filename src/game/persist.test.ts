import { beforeEach, describe, expect, it } from 'vitest';
import type { Airline, GameState } from './types';
import {
  assignPlane,
  buyPlane,
  newAirline,
  newGame,
  openRoute,
  player,
  setFareFactor,
} from './engine';
import { applySave, deserialize, serialize, SAVE_VERSION } from './persist';

let g: GameState;
let al: Airline;
beforeEach(() => {
  g = newGame('crw');
  al = player(g);
});

/** Day far enough along that every aircraft type is in service. */
const PLAYED_DAY = 365 * 75;

/** Build a small played game: cash spent, a route, a plane on it, some days. */
function playedGame(): GameState {
  const x = newGame('crw', 42);
  const xa = player(x);
  x.day = PLAYED_DAY; // modern era, so the E175 below is purchasable
  xa.cash = 1_000_000_000;
  xa.rights = ['crw', 'clt', 'dca']; // hold rights for the route below
  openRoute(x, xa, ['crw', 'clt', 'dca']);
  setFareFactor(xa, xa.routes[0].id, 1.2);
  buyPlane(x, xa, 'e175');
  assignPlane(x, xa, xa.fleet[0].id, xa.routes[0].id);
  xa.debt = 7_000_000;
  return x;
}

/** The first (player) airline of a raw serialized save, for field surgery. */
const rawAirline = (raw: Record<string, unknown>): Record<string, unknown> =>
  (raw.airlines as Record<string, unknown>[])[0];

describe('serialize / deserialize', () => {
  it('round-trips the dynamic game fields', () => {
    const src = playedGame();
    const sal = player(src);
    const restored = deserialize(serialize(src))!;
    expect(restored.version).toBe(SAVE_VERSION);
    expect(restored.day).toBe(PLAYED_DAY);
    expect(restored.rngState).toBe(src.rngState);
    expect(restored.airlines).toHaveLength(1);
    const ra = restored.airlines[0];
    expect(ra.homeId).toBe('crw');
    expect(ra.cash).toBe(sal.cash);
    expect(ra.debt).toBe(7_000_000);
    expect(ra.routes).toEqual(sal.routes);
    expect(ra.fleet).toEqual(sal.fleet);
  });

  it('round-trips every airline, not just the player', () => {
    const src = playedGame();
    src.airlines.push(newAirline('ai-1', 'Pied Mont Air', '#f5a623', 'bna'));
    const restored = deserialize(serialize(src))!;
    expect(restored.airlines).toHaveLength(2);
    expect(restored.airlines[1].id).toBe('ai-1');
    expect(restored.airlines[1].homeId).toBe('bna');
    applySave(g, restored);
    expect(g.airlines).toHaveLength(2);
    expect(g.airlines[1].name).toBe('Pied Mont Air');
    expect(player(g).homeId).toBe('crw');
  });

  it('round-trips pending slot negotiations, dropping ones already granted', () => {
    const src = playedGame();
    player(src).negotiations = [
      { airportId: 'gso', opensDay: PLAYED_DAY + 60, fee: 1_000_000 },
      { airportId: 'clt', opensDay: PLAYED_DAY + 30, fee: 3_000_000 }, // already held
    ];
    const restored = deserialize(serialize(src))!;
    expect(restored.airlines[0].negotiations).toEqual(player(src).negotiations);
    applySave(g, restored);
    // CLT is already a held right, so its stale application is dropped on load.
    expect(player(g).negotiations).toEqual([
      { airportId: 'gso', opensDay: PLAYED_DAY + 60, fee: 1_000_000 },
    ]);
  });

  it('tolerates a save with no negotiations field', () => {
    const raw = JSON.parse(serialize(playedGame())) as Record<string, unknown>;
    delete rawAirline(raw).negotiations;
    expect(deserialize(JSON.stringify(raw))!.airlines[0].negotiations).toEqual([]);
  });

  it('round-trips earned badges, dropping any unknown ids on load', () => {
    const src = playedGame();
    player(src).badges = [
      { id: 'net-5', day: 100 },
      { id: 'no-such-badge', day: 200 }, // a badge that no longer exists
    ];
    const restored = deserialize(serialize(src))!;
    expect(restored.airlines[0].badges).toEqual(player(src).badges);
    applySave(g, restored);
    expect(player(g).badges).toEqual([{ id: 'net-5', day: 100 }]);
  });

  it('tolerates a save with no badges field', () => {
    const raw = JSON.parse(serialize(playedGame())) as Record<string, unknown>;
    delete rawAirline(raw).badges;
    expect(deserialize(JSON.stringify(raw))!.airlines[0].badges).toEqual([]);
  });

  it('round-trips finance history', () => {
    const src = playedGame();
    player(src).history.push({
      day: 7, cash: 5_000_000, debt: 1_000_000, fleetValue: 2_000_000,
      revenue: 300_000, cost: 200_000, interest: 1_000, interestEarned: 100,
      net: 99_100, pax: 1234,
    });
    const restored = deserialize(serialize(src))!;
    expect(restored.airlines[0].history).toEqual(player(src).history);
    applySave(g, restored);
    expect(player(g).history).toEqual(player(src).history);
  });

  it('tolerates a save with no history field', () => {
    const raw = JSON.parse(serialize(playedGame())) as Record<string, unknown>;
    delete rawAirline(raw).history;
    expect(deserialize(JSON.stringify(raw))!.airlines[0].history).toEqual([]);
  });

  it('rejects malformed JSON', () => {
    expect(deserialize('not json {')).toBeNull();
  });

  it('rejects an incompatible version (including pre-airlines saves)', () => {
    const bad = JSON.stringify({ version: 5, day: 0, cash: 0, debt: 0, fleet: [], routes: [] });
    expect(deserialize(bad)).toBeNull();
  });

  it('rejects a save with no airlines', () => {
    const bad = JSON.stringify({ version: SAVE_VERSION, day: 1, rngState: 0, airlines: [] });
    expect(deserialize(bad)).toBeNull();
  });

  it('rejects an airline missing required fields', () => {
    const bad = JSON.stringify({
      version: SAVE_VERSION, day: 1, rngState: 0,
      airlines: [{ homeId: 'crw', cash: 0 }],
    });
    expect(deserialize(bad)).toBeNull();
  });
});

describe('applySave', () => {
  it('restores state onto a fresh game and keeps its airports/aircraft', () => {
    const src = playedGame();
    const data = deserialize(serialize(src))!;
    applySave(g, data);
    al = player(g);
    expect(al.homeId).toBe('crw');
    expect(g.day).toBe(PLAYED_DAY);
    expect(g.rngState).toBe(src.rngState);
    expect(al.debt).toBe(7_000_000);
    expect(al.routes).toHaveLength(1);
    expect(al.fleet).toHaveLength(1);
    expect(al.fleet[0].routeId).toBe(al.routes[0].id);
    // Static data still comes from the live game, not the save.
    expect(g.airports).toBe(newGame('crw').airports);
    expect(g.aircraftTypes.length).toBeGreaterThan(0);
  });

  it('reseeds ids so a route opened after load does not collide', () => {
    const src = playedGame(); // its route id is e.g. route-N
    applySave(g, deserialize(serialize(src))!);
    al = player(g);
    const existing = new Set(al.routes.map((r) => r.id));
    openRoute(g, al, ['crw', 'dca']); // airports whose rights the save restored
    const newId = al.routes[al.routes.length - 1].id;
    expect(existing.has(newId)).toBe(false);
  });

  it('drops routes referencing airports that no longer exist', () => {
    const data = deserialize(serialize(playedGame()))!;
    data.airlines[0].routes[0].stops = ['crw', 'atlantis']; // unknown airport
    applySave(g, data);
    expect(player(g).routes).toHaveLength(0);
  });

  it('drops planes of unknown types and idles planes on dropped routes', () => {
    const src = playedGame();
    const data = deserialize(serialize(src))!;
    data.airlines[0].fleet.push({
      id: 'plane-ghost',
      typeId: 'flying-saucer',
      routeId: data.airlines[0].routes[0].id,
      kmFlown: 0,
    });
    data.airlines[0].routes[0].stops = ['crw', 'atlantis']; // route will be dropped
    applySave(g, data);
    al = player(g);
    expect(al.fleet.every((p) => p.typeId !== 'flying-saucer')).toBe(true);
    // The real plane survives but is now idle (its route was dropped).
    expect(al.fleet).toHaveLength(1);
    expect(al.fleet[0].routeId).toBeNull();
  });

  it('migrates legacy fictional plane types to their real replacements', () => {
    const src = playedGame();
    const data = deserialize(serialize(src))!;
    data.airlines[0].fleet.push({
      id: 'plane-old',
      typeId: 'oceanjet', // pre-real-aircraft save
      routeId: null,
      kmFlown: 1234,
    });
    applySave(g, data);
    const migrated = player(g).fleet.find((p) => p.id === 'plane-old')!;
    expect(migrated.typeId).toBe('b767');
    expect(migrated.kmFlown).toBe(1234);
  });
});
