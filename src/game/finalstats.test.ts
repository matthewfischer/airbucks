import { beforeEach, describe, expect, it } from 'vitest';
import type { Airline, GameState } from './types';
import { AIRPORTS } from './data';
import {
  assignPlane,
  buyPlane,
  finalStats,
  newGame,
  openRoute,
  player,
  routeDistance,
} from './engine';

let g: GameState;
let al: Airline;
beforeEach(() => {
  g = newGame('crw');
  al = player(g);
  al.rights = AIRPORTS.map((a) => a.id);
  g.day = 365 * 75 + 19; // 2025, so every aircraft type is in service
  al.cash = 1_000_000_000;
});

describe('finalStats', () => {
  it('reports nulls and zeros for a bare airline', () => {
    const s = finalStats(g, al);
    expect(s.longestRoute).toBeNull();
    expect(s.flagship).toBeNull();
    expect(s.routes).toBe(0);
    expect(s.legs).toBe(0);
    expect(s.paxCarried).toBe(0);
    expect(s.fleetSize).toBe(0);
  });

  it('picks the longest route by total distance and counts legs', () => {
    openRoute(g, al, ['crw', 'jfk']); // short
    openRoute(g, al, ['crw', 'lhr', 'hkg']); // long, 2 legs
    const long = al.routes[1];
    const s = finalStats(g, al);
    expect(s.routes).toBe(2);
    expect(s.legs).toBe(3); // 1 + 2
    expect(s.longestRoute?.label).toBe('CRW → LHR → HKG');
    expect(s.longestRoute?.distanceKm).toBeCloseTo(routeDistance(g, long), 5);
  });

  it('names the flagship as the most-owned type', () => {
    openRoute(g, al, ['crw', 'jfk']);
    const r = al.routes[0];
    buyPlane(g, al, 'e175');
    buyPlane(g, al, 'e175');
    buyPlane(g, al, 'a321neo');
    assignPlane(g, al, al.fleet[0].id, r.id);
    const s = finalStats(g, al);
    expect(s.fleetSize).toBe(3);
    expect(s.flagship?.count).toBe(2);
    expect(s.flagship?.name).toContain('E175');
  });

  it('sums lifetime passengers and tracks the peak net worth above the final', () => {
    al.history = [
      { day: 7, cash: 100, debt: 0, fleetValue: 0, revenue: 0, cost: 0, interest: 0, interestEarned: 0, net: 0, pax: 1000 },
      { day: 14, cash: 5000, debt: 0, fleetValue: 0, revenue: 0, cost: 0, interest: 0, interestEarned: 0, net: 0, pax: 1500 },
    ];
    al.cash = 200; // current worth well below the week-14 peak of 5000
    const s = finalStats(g, al);
    expect(s.paxCarried).toBe(2500);
    expect(s.peakNetWorth).toBe(5000);
  });

  it('reads acquisitions and badges straight through', () => {
    al.acquisitions = 4;
    al.badges = [
      { id: 'a', day: 1 },
      { id: 'b', day: 2 },
    ] as Airline['badges'];
    const s = finalStats(g, al);
    expect(s.rivalsAbsorbed).toBe(4);
    expect(s.awards).toBe(2);
  });
});
