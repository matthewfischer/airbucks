import { describe, expect, it } from 'vitest';
import { advanceDay, evaluateNetwork, newGame } from './engine';
import {
  addAiAirlines,
  DEFENSE_WINDOW_DAYS,
  PERSONALITIES,
  playerRaidAction,
  raidPlayer,
  runAI,
} from './ai';
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

const P = PERSONALITIES[0];
const BIG = 1e15; // an appetite that never gates affordability in a unit test

/** A fresh game with `n` AI rivals, RNG fixed for determinism. */
function game(n = 1) {
  const g = newGame('crw', 1);
  g.humanControlled = true; // engage the player-raid mechanic (the app sets this)
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

  it('requires being strictly the biggest — a tie is not dominance', () => {
    const g = game(1);
    g.airlines[0].cash = 1_000_000_000;
    g.airlines[1].cash = 1_000_000_000; // 50% share, but tied → not dominant
    expect(playerEquityShare(g)).toBeGreaterThan(DOMINANCE_THRESHOLD);
    expect(isPlayerDominant(g)).toBe(false);
  });

  it('is dominant once strictly ahead and most of the market', () => {
    const g = game(1);
    g.airlines[0].cash = 1_100_000_000;
    g.airlines[1].cash = 1_000_000_000;
    expect(isPlayerDominant(g)).toBe(true);
  });

  it('a lone player (no rivals) is never dominant', () => {
    expect(isPlayerDominant(newGame('crw', 1))).toBe(false);
  });
});

describe('playerRaidAction — a scored candidate, not an auto-drain', () => {
  it('offers no raid while the player is not dominant', () => {
    const g = game(3);
    for (const al of g.airlines) al.cash = 10_000_000;
    expect(playerRaidAction(g, g.airlines[1], P, BIG)).toBeNull();
  });

  it('offers no raid in a headless sim (player slot is AI-controlled)', () => {
    const g = game(1);
    g.airlines[0].ai = { personality: P.id, nextDecisionDay: 0 };
    g.airlines[0].cash = 1_100_000_000;
    expect(playerRaidAction(g, g.airlines[1], P, BIG)).toBeNull();
  });

  it('offers no raid the broke rival cannot finance', () => {
    const g = game(1);
    g.airlines[0].cash = 1_100_000_000;
    g.airlines[1].cash = 0; // no cash and (appetite 0) no borrowing room
    expect(playerRaidAction(g, g.airlines[1], P, 0)).toBeNull();
  });

  it('values an early nibble far below a near-complete takeover (vs. organic growth)', () => {
    // Build the player a real, revenue-earning network by running it as an AI
    // for a year, then hand it back to the human and make it dominant.
    const g = game(1);
    const me = g.airlines[0];
    const raider = g.airlines[1];
    me.ai = { personality: P.id, nextDecisionDay: 0 };
    for (let d = 0; d < 365; d++) {
      advanceDay(g);
      runAI(g);
    }
    delete me.ai;
    me.cash = 10_000_000_000; // strictly the biggest
    raider.cash = 5_000_000_000; // funded enough to bid
    const reach = evaluateNetwork(g, me).revenue;
    expect(reach).toBeGreaterThan(0);
    expect(isPlayerDominant(g)).toBe(true);

    me.shares = { [me.id]: 100 }; // raider holds nothing yet
    const early = playerRaidAction(g, raider, P, BIG)!;
    me.shares = { [me.id]: 55, [raider.id]: 45 }; // one block from control
    const late = playerRaidAction(g, raider, P, BIG)!;

    expect(early).not.toBeNull();
    expect(late.score).toBeGreaterThan(early.score); // commitment ramps toward control
    expect(early.score).toBeLessThan(reach); // a nibble is not valued as the whole merger
  });
});

describe('playerRaidAction — accumulation and control', () => {
  it('accumulates the player stock and opens a defense window on crossing control', () => {
    const g = game(1);
    g.airlines[0].cash = 4_000_000_000; // strictly the biggest
    g.airlines[1].cash = 3_000_000_000; // funded enough to fight to control
    const raider = g.airlines[1];
    expect(isPlayerDominant(g)).toBe(true);

    let opened = false;
    for (let i = 0; i < 60 && !opened; i++) {
      const act = playerRaidAction(g, raider, P, BIG);
      if (!act) break;
      act.run();
      opened = g.raid !== undefined;
    }
    expect(opened).toBe(true);
    expect(g.raid!.raiderId).toBe(raider.id);
    expect(hasControl(g.airlines[0], raider.id)).toBe(true);
    expect(g.raid!.deadlineDay).toBe(g.raid!.sinceDay + DEFENSE_WINDOW_DAYS);
  });

  it('stops offering raids once the rival already controls the player', () => {
    const g = game(1);
    const raider = g.airlines[1];
    g.airlines[0].cash = 2_000_000_000;
    g.airlines[0].shares = { [g.airlines[0].id]: 40, [raider.id]: 60 };
    expect(playerRaidAction(g, raider, P, BIG)).toBeNull();
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
    const back = game(1);
    applySave(back, deserialize(serialize(g))!);
    expect(back.raid).toEqual(g.raid);
    expect(back.defeat).toEqual(g.defeat);
  });

  it('drops a raid whose raider no longer exists on load', () => {
    const g = game(1);
    g.raid = { raiderId: 'ghost', sinceDay: 5, deadlineDay: 125 };
    const back = game(1);
    applySave(back, deserialize(serialize(g))!);
    expect(back.raid).toBeUndefined();
  });
});
