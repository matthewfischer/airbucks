import { beforeEach, describe, expect, it } from 'vitest';
import { AIRCRAFT_TYPES, AIRPORTS } from './data';
import {
  allianceGroup,
  assignPlane,
  buyPlane,
  evaluateNetwork,
  newAirline,
  newGame,
  openRoute,
  player,
} from './engine';
import type { Airline, GameState } from './types';

// A two-leg corridor LAX — DEN — JFK: roughly collinear, so DEN is a valid
// connecting hub for the LAX↔JFK through market.
const CORRIDOR = { west: 'lax', hub: 'den', east: 'jfk' } as const;

let g: GameState;
beforeEach(() => {
  g = newGame('lax');
  g.day = 365 * 75 + 19; // 2025 — every aircraft type in service
  const p = player(g);
  p.rights = AIRPORTS.map((a) => a.id);
  p.cash = 1_000_000_000;
});

/** Add a carrier to the game with rights everywhere and a working balance. */
function carrier(id: string, homeId: string): Airline {
  const al = newAirline(id, id.toUpperCase(), '#fff', homeId);
  al.rights = AIRPORTS.map((a) => a.id);
  al.cash = 1_000_000_000;
  g.airlines.push(al);
  return al;
}

/** Open a single-leg route and staff it with one jet. */
function fly(al: Airline, from: string, to: string, planeType = 'a321neo') {
  openRoute(g, al, [from, to]);
  const route = al.routes[al.routes.length - 1];
  buyPlane(g, al, planeType);
  assignPlane(g, al, al.fleet[al.fleet.length - 1].id, route.id);
  return route;
}

describe('allianceGroup', () => {
  it('returns the airline alone when unallied', () => {
    const al = player(g);
    expect(allianceGroup(g, al)).toEqual([al]);
  });

  it('returns all co-members (including self) when allied', () => {
    const a = player(g);
    const b = carrier('b', 'jfk');
    const c = carrier('c', 'ord');
    a.alliance = b.alliance = 'star';
    expect(new Set(allianceGroup(g, a))).toEqual(new Set([a, b]));
    expect(allianceGroup(g, c)).toEqual([c]);
  });
});

describe('interline requires an alliance (phase 1: no-op)', () => {
  it('two unallied carriers do not jointly carry a through market', () => {
    const a = player(g);
    const b = carrier('b', CORRIDOR.east);
    fly(a, CORRIDOR.west, CORRIDOR.hub); // A: LAX–DEN
    fly(b, CORRIDOR.hub, CORRIDOR.east); // B: DEN–JFK

    // Neither touches both ends, so LAX↔JFK goes uncarried — no connecting pax.
    expect(evaluateNetwork(g, a).connectingPassengers).toBe(0);
    expect(evaluateNetwork(g, b).connectingPassengers).toBe(0);
  });
});
