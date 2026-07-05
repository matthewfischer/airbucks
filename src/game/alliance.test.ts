import { beforeEach, describe, expect, it } from 'vitest';
import { AIRPORTS } from './data';
import {
  ALLIANCE_MAX,
  acceptAlliance,
  allianceGroup,
  allianceSetupFee,
  assignPlane,
  buyPlane,
  declineAlliance,
  evaluateNetwork,
  leaveAlliance,
  newAirline,
  newGame,
  openRoute,
  player,
  proposeAlliance,
} from './engine';
import { acquire } from './distress';
import { deserialize, serialize } from './persist';
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

describe('interline capture', () => {
  it('unallied, a through market crossing two carriers goes uncarried', () => {
    const a = player(g);
    const b = carrier('b', CORRIDOR.east);
    fly(a, CORRIDOR.west, CORRIDOR.hub); // A: LAX–DEN
    fly(b, CORRIDOR.hub, CORRIDOR.east); // B: DEN–JFK

    // Neither touches both ends, so LAX↔JFK goes uncarried — no connecting pax.
    expect(evaluateNetwork(g, a).connectingPassengers).toBe(0);
    expect(evaluateNetwork(g, b).connectingPassengers).toBe(0);
  });

  it('allied, the two carriers jointly carry the through market and each earns its leg', () => {
    const a = player(g);
    const b = carrier('b', CORRIDOR.east);
    fly(a, CORRIDOR.west, CORRIDOR.hub); // A: LAX–DEN
    fly(b, CORRIDOR.hub, CORRIDOR.east); // B: DEN–JFK

    const soloA = evaluateNetwork(g, a).revenue;
    a.alliance = b.alliance = 'star';

    const netA = evaluateNetwork(g, a);
    const netB = evaluateNetwork(g, b);
    // The LAX↔JFK through pax now ride A's feeder and B's leg — both see it.
    expect(netA.connectingPassengers).toBeGreaterThan(0);
    expect(netB.connectingPassengers).toBeGreaterThan(0);
    // A's feeder leg earns more once it also carries the through flow.
    expect(netA.revenue).toBeGreaterThan(soloA);
    // Each carrier is credited only for its own legs (no double count).
    expect(netA.routes.size).toBe(1);
    expect(netB.routes.size).toBe(1);
  });
});

describe('alliance formation', () => {
  it('propose then accept forms one bloc and charges both the setup fee', () => {
    const a = player(g);
    const b = carrier('b', 'jfk');
    fly(a, CORRIDOR.west, CORRIDOR.hub);
    fly(b, 'jfk', 'ord');
    const fee = allianceSetupFee(g, a, b);
    const cashA = a.cash;
    const cashB = b.cash;

    expect(proposeAlliance(g, a, b)).toBeNull();
    expect(g.allianceOffers).toHaveLength(1);
    expect(acceptAlliance(g, a, b)).toBeNull();

    expect(a.alliance).toBeDefined();
    expect(a.alliance).toBe(b.alliance);
    expect(a.cash).toBe(cashA - fee);
    expect(b.cash).toBe(cashB - fee);
    expect(g.allianceOffers ?? []).toHaveLength(0);
  });

  it('rejects self-alliance and duplicate offers', () => {
    const a = player(g);
    const b = carrier('b', 'jfk');
    expect(proposeAlliance(g, a, a)).toMatch(/itself/);
    expect(proposeAlliance(g, a, b)).toBeNull();
    expect(proposeAlliance(g, a, b)).toMatch(/pending/);
  });

  it('caps a bloc at ALLIANCE_MAX carriers', () => {
    const a = player(g);
    const b = carrier('b', 'jfk');
    const c = carrier('c', 'ord');
    const d = carrier('d', 'atl');
    a.alliance = b.alliance = c.alliance = 'star';
    expect(allianceGroup(g, a)).toHaveLength(ALLIANCE_MAX);
    expect(proposeAlliance(g, d, a)).toMatch(/at most/);
  });

  it('a solo carrier joins an existing bloc, taking its id', () => {
    const a = player(g);
    const b = carrier('b', 'jfk');
    const c = carrier('c', 'ord');
    a.alliance = b.alliance = 'star';
    expect(proposeAlliance(g, c, a)).toBeNull();
    expect(acceptAlliance(g, c, a)).toBeNull();
    expect(c.alliance).toBe('star');
  });

  it('blocks allying two carriers that are already in different blocs', () => {
    const a = player(g);
    const b = carrier('b', 'jfk');
    a.alliance = 'star';
    b.alliance = 'oneworld';
    expect(proposeAlliance(g, a, b)).toMatch(/already in alliances/);
  });

  it('leaving dissolves a two-carrier bloc entirely', () => {
    const a = player(g);
    const b = carrier('b', 'jfk');
    a.alliance = b.alliance = 'star';
    leaveAlliance(g, a);
    expect(a.alliance).toBeUndefined();
    expect(b.alliance).toBeUndefined(); // a bloc of one is just unallied
  });

  it('declining removes the pending offer', () => {
    const a = player(g);
    const b = carrier('b', 'jfk');
    proposeAlliance(g, a, b);
    declineAlliance(g, a, b);
    expect(g.allianceOffers ?? []).toHaveLength(0);
    expect(acceptAlliance(g, a, b)).toMatch(/No such proposal/);
  });

  it('acquiring an ally dissolves the leftover bloc', () => {
    const a = player(g);
    const b = carrier('b', 'jfk');
    fly(a, CORRIDOR.west, CORRIDOR.hub);
    fly(b, 'jfk', 'ord');
    a.alliance = b.alliance = 'star';
    a.cash = 10_000_000_000;
    acquire(g, a, b);
    expect(a.alliance).toBeUndefined();
  });
});

describe('alliance persistence', () => {
  it('round-trips alliance membership and pending offers', () => {
    const a = player(g);
    const b = carrier('b', 'jfk');
    const c = carrier('c', 'ord');
    a.alliance = b.alliance = 'star';
    proposeAlliance(g, c, a);

    const restored = deserialize(serialize(g));
    expect(restored).not.toBeNull();
    const ra = restored!.airlines.find((x) => x.id === a.id)!;
    const rb = restored!.airlines.find((x) => x.id === b.id)!;
    expect(ra.alliance).toBe('star');
    expect(rb.alliance).toBe('star');
    expect(restored!.allianceOffers).toHaveLength(1);
    expect(restored!.allianceOffers![0]).toMatchObject({ from: c.id, to: a.id });
  });
});
