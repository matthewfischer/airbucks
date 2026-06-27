import { describe, expect, it } from 'vitest';
import { newGame } from './engine';
import { addAiAirlines, DEFENSE_WINDOW_DAYS, raidPlayer } from './ai';
import { serialize, deserialize, applySave } from './persist';
import {
  DOMINANCE_THRESHOLD,
  forceBuy,
  hasControl,
  isPlayerDominant,
  playerEquityShare,
  affordableForce,
  sharesOwned,
} from './shares';

/** A fresh game with `n` AI rivals, RNG fixed for determinism. */
function game(n = 1) {
  const g = newGame('crw', 1);
  addAiAirlines(g, n);
  return g;
}

describe('player dominance', () => {
  it('measures the player share of total industry equity', () => {
    const g = game(1);
    g.airlines[0].cash = 900_000_000;
    g.airlines[1].cash = 100_000_000;
    expect(playerEquityShare(g)).toBeCloseTo(0.9, 2);
  });

  it('is not dominant in a balanced field', () => {
    const g = game(3);
    for (const al of g.airlines) al.cash = 10_000_000;
    expect(playerEquityShare(g)).toBeLessThan(DOMINANCE_THRESHOLD);
    expect(isPlayerDominant(g)).toBe(false);
  });

  it('a lone player (no rivals) is never dominant for raid purposes', () => {
    const g = newGame('crw', 1); // no AIs added
    expect(isPlayerDominant(g)).toBe(false);
  });
});

describe('raidPlayer — no trigger', () => {
  it('does nothing while the player is not dominant', () => {
    const g = game(3);
    for (const al of g.airlines) al.cash = 10_000_000;
    raidPlayer(g);
    expect(g.raid).toBeUndefined();
    expect(sharesOwned(g.airlines[0], g.airlines[1].id)).toBe(0);
  });

  it('never raids in a headless sim (player slot is AI-controlled)', () => {
    const g = game(1);
    g.airlines[0].ai = { personality: 'balanced', nextDecisionDay: 0 };
    g.airlines[0].cash = 1_000_000_000;
    raidPlayer(g);
    expect(g.raid).toBeUndefined();
  });
});

describe('raidPlayer — accumulation and control', () => {
  it('a dominant player gets raided until a rival crosses control', () => {
    const g = game(1);
    g.airlines[0].cash = 1_000_000_000;
    g.airlines[1].cash = 1_000_000_000; // equal → player at 50% ≥ threshold
    expect(isPlayerDominant(g)).toBe(true);

    let opened = false;
    for (let week = 0; week < 60 && !opened; week++) {
      raidPlayer(g);
      opened = g.raid !== undefined;
    }
    expect(opened).toBe(true);
    expect(g.raid!.raiderId).toBe(g.airlines[1].id);
    expect(hasControl(g.airlines[0], g.airlines[1].id)).toBe(true);
    expect(g.raid!.deadlineDay).toBe(g.raid!.sinceDay + DEFENSE_WINDOW_DAYS);
  });
});

describe('raidPlayer — defense window resolution', () => {
  function underSiege() {
    const g = game(1);
    const raider = g.airlines[1];
    g.airlines[0].shares = { [g.airlines[0].id]: 49, [raider.id]: 51 };
    g.raid = { raiderId: raider.id, sinceDay: 0, deadlineDay: 100 };
    return g;
  }

  it('holds while the window is open and the rival still controls', () => {
    const g = underSiege();
    g.day = 50;
    raidPlayer(g);
    expect(g.defeat).toBeUndefined();
    expect(g.raid).toBeDefined();
  });

  it('ends the game when the window expires under rival control', () => {
    const g = underSiege();
    g.day = 100;
    raidPlayer(g);
    expect(g.defeat).toBeDefined();
    expect(g.defeat!.raiderId).toBe(g.airlines[1].id);
  });

  it('clears the raid when the player has clawed back a majority', () => {
    const g = underSiege();
    g.airlines[0].shares = { [g.airlines[0].id]: 60, [g.airlines[1].id]: 40 };
    g.day = 50;
    raidPlayer(g);
    expect(g.raid).toBeUndefined();
    expect(g.defeat).toBeUndefined();
  });

  it('drops the raid if the raider has left the game', () => {
    const g = underSiege();
    g.airlines.splice(1, 1); // raider gone
    raidPlayer(g);
    expect(g.raid).toBeUndefined();
  });

  it('never fires twice — a defeated game stays over', () => {
    const g = underSiege();
    g.day = 100;
    raidPlayer(g);
    const first = g.defeat;
    g.day = 200;
    raidPlayer(g);
    expect(g.defeat).toBe(first);
  });
});

describe('defensive buyback (forceBuy)', () => {
  it('claws shares back from a controlling raider, breaking control', () => {
    const g = game(1);
    const me = g.airlines[0];
    me.shares = { [me.id]: 40, [g.airlines[1].id]: 60 };
    me.cash = 10_000_000_000;
    forceBuy(g, me, me, 15);
    expect(sharesOwned(me, g.airlines[1].id)).toBeLessThanOrEqual(45);
    expect(hasControl(me, g.airlines[1].id)).toBe(false);
  });

  it('affordableForce yields nothing when the defender is broke', () => {
    const g = game(1);
    const me = g.airlines[0];
    me.shares = { [me.id]: 40, [g.airlines[1].id]: 60 };
    me.cash = 0;
    expect(affordableForce(g, me, me, 10).count).toBe(0);
  });
});

describe('persistence', () => {
  it('round-trips an active raid and a defeat', () => {
    const g = game(1);
    g.raid = { raiderId: g.airlines[1].id, sinceDay: 5, deadlineDay: 125 };
    g.defeat = { raiderId: g.airlines[1].id, day: 130 };
    const back = newGame('crw', 1);
    addAiAirlines(back, 1);
    const data = deserialize(serialize(g))!;
    applySave(back, data);
    expect(back.raid).toEqual(g.raid);
    expect(back.defeat).toEqual(g.defeat);
  });

  it('drops a raid whose raider no longer exists on load', () => {
    const g = game(1);
    g.raid = { raiderId: 'ghost', sinceDay: 5, deadlineDay: 125 };
    const back = newGame('crw', 1);
    addAiAirlines(back, 1);
    applySave(back, deserialize(serialize(g))!);
    expect(back.raid).toBeUndefined();
  });
});
