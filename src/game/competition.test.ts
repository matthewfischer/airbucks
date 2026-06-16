import { beforeEach, describe, expect, it } from 'vitest';
import type { Airline, Airport, GameState } from './types';
import {
  competitiveShare,
  evaluateNetwork,
  newAirline,
  newGame,
  player,
  rivalWeight,
} from './engine';

const MODERN = 365 * 75 + 19; // 2025 — every aircraft type is in service

/** Push a direct route from `from` to `to` flown by `n` planes of `typeId`. */
function flyDirect(al: Airline, from: string, to: string, typeId: string, n = 1): string {
  const rid = `r-${al.id}-${from}-${to}`;
  al.rights = [...new Set([...al.rights, from, to])];
  al.routes.push({ id: rid, stops: [from, to], fareFactor: 1 });
  for (let i = 0; i < n; i++)
    al.fleet.push({ id: `p-${rid}-${i}`, typeId, routeId: rid, kmFlown: 0 });
  return rid;
}

let g: GameState;
let me: Airline;
beforeEach(() => {
  g = newGame('crw');
  g.day = MODERN;
  me = player(g);
  // A jumbo on a thin market, so demand — not seats — is the binding constraint
  // and a rival splitting that demand actually shows up as fewer passengers.
  flyDirect(me, 'crw', 'jfk', 'b787');
});

describe('competitiveShare', () => {
  it('is the full market when there are no rivals', () => {
    expect(competitiveShare(100, 0)).toBe(1);
    expect(competitiveShare(0, 0)).toBe(1); // empty market: no divide-by-zero
  });

  it('splits evenly between equal offers and scales with weight', () => {
    expect(competitiveShare(100, 100)).toBeCloseTo(0.5, 6);
    expect(competitiveShare(300, 100)).toBeCloseTo(0.75, 6);
    expect(competitiveShare(100, 300)).toBeCloseTo(0.25, 6);
  });
});

describe('rivalWeight', () => {
  it('is zero on a market the airline flies alone', () => {
    expect(rivalWeight(g, me, 'crw', 'jfk')).toBe(0);
  });

  it('turns positive once a rival flies the same city-pair', () => {
    const rival = newAirline('ai-1', 'Rival', '#f00', 'crw');
    flyDirect(rival, 'crw', 'jfk', 'b787');
    g.airlines.push(rival);
    expect(rivalWeight(g, me, 'crw', 'jfk')).toBeGreaterThan(0);
  });
});

describe('demand sharing', () => {
  it('a rival on the same leg cuts your passengers, splitting the pool', () => {
    const solo = evaluateNetwork(g, me).passengers;

    const rival = newAirline('ai-1', 'Rival', '#f00', 'crw');
    flyDirect(rival, 'crw', 'jfk', 'b787');
    g.airlines.push(rival);

    const contested = evaluateNetwork(g, me).passengers;
    expect(contested).toBeLessThan(solo);
    // Identical offers → an even split of the same pool.
    expect(contested).toBeCloseTo(solo / 2, 0);
    expect(evaluateNetwork(g, rival).passengers).toBeCloseTo(contested, 0);
  });

  it('leaves you whole when the rival flies an unrelated market', () => {
    const solo = evaluateNetwork(g, me).passengers;

    const rival = newAirline('ai-1', 'Rival', '#f00', 'lax');
    flyDirect(rival, 'lax', 'sea', 'b787'); // no overlap with CRW–JFK
    g.airlines.push(rival);

    expect(evaluateNetwork(g, me).passengers).toBeCloseTo(solo, 6);
  });

  it('a fare undercut grabs a bigger share of the pool', () => {
    const rival = newAirline('ai-1', 'Rival', '#f00', 'crw');
    const rid = flyDirect(rival, 'crw', 'jfk', 'b787');
    g.airlines.push(rival);

    const even = evaluateNetwork(g, me).passengers;
    rival.routes.find((r) => r.id === rid)!.fareFactor = 1.4; // rival charges more
    const undercut = evaluateNetwork(g, me).passengers;
    expect(undercut).toBeGreaterThan(even); // cheaper fare → more travelers
  });
});

describe('nonstop vs one-stop', () => {
  // Three collinear cities A–M–B: the one-stop A→M→B exactly traces the direct
  // A→B line, so it competes for the A–B market but pays the connection penalty.
  function linearWorld(): { g: GameState; nonstop: Airline; oneStop: Airline } {
    const lw = newGame('crw');
    lw.day = MODERN;
    const mk = (id: string, lon: number): Airport => ({
      id, code: id.toUpperCase(), city: id, lat: 0, lon, size: 4, population: 1_000_000,
    });
    lw.airports = [mk('a', 0), mk('m', 3), mk('b', 6)];

    const nonstop = newAirline('non', 'Nonstop Air', '#0f0', 'a');
    flyDirect(nonstop, 'a', 'b', 'b787');
    const oneStop = newAirline('one', 'Connector', '#00f', 'a');
    flyDirect(oneStop, 'a', 'm', 'b787');
    flyDirect(oneStop, 'm', 'b', 'b787');

    lw.airlines = [nonstop, oneStop];
    return { g: lw, nonstop, oneStop };
  }

  it('weighs a nonstop offer above a one-stop offer on the same city-pair', () => {
    const { g: lw, nonstop, oneStop } = linearWorld();
    // Each airline's own contribution to the A–B market shows up as the other's
    // rival weight, so we can read both offers off the same shared market.
    const nonstopWeight = rivalWeight(lw, oneStop, 'a', 'b');
    const oneStopWeight = rivalWeight(lw, nonstop, 'a', 'b');
    expect(oneStopWeight).toBeGreaterThan(0); // it does compete
    // The connection penalty docks the one-stop, so it draws meaningfully less
    // than the nonstop — even though its shorter legs fly a touch more often.
    expect(oneStopWeight).toBeLessThan(nonstopWeight);
    expect(oneStopWeight / nonstopWeight).toBeLessThan(0.85);
  });
});
