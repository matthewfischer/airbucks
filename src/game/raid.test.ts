import { describe, expect, it } from 'vitest';
import { advanceDay, evaluateNetwork, newGame } from './engine';
import {
  addAiAirlines,
  PERSONALITIES,
  playerBuyoutAction,
  playerFloatBuyAction,
  runAI,
} from './ai';
import {
  DOMINANCE_THRESHOLD,
  forceBuy,
  hasControl,
  isPlayerDominant,
  playerEquityShare,
  publicFloat,
  affordableForce,
  sharesOwned,
} from './shares';

const P = PERSONALITIES[0];
const BIG = 1e15; // an appetite that never gates affordability in a unit test

/** A fresh game with `n` AI rivals, RNG fixed for determinism. The player floats
 *  20% by default so rivals have something to buy on the open market. */
function game(n = 1, floatPct = 0.2) {
  const g = newGame('crw', 1, floatPct);
  g.humanControlled = true; // engage the rival-vs-player mechanic (the app sets this)
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

describe('playerFloatBuyAction — rivals buy only the public float', () => {
  it('offers nothing while the player is not dominant', () => {
    const g = game(3);
    for (const al of g.airlines) al.cash = 10_000_000;
    expect(playerFloatBuyAction(g, g.airlines[1], P, BIG)).toBeNull();
  });

  it('offers nothing in a headless sim (player slot is AI-controlled)', () => {
    const g = game(1);
    g.airlines[0].ai = { personality: P.id, nextDecisionDay: 0 };
    g.airlines[0].cash = 1_100_000_000;
    expect(playerFloatBuyAction(g, g.airlines[1], P, BIG)).toBeNull();
  });

  it('offers nothing when the player floated no shares', () => {
    const g = game(1, 0); // fully private — no public float
    g.airlines[0].cash = 1_100_000_000;
    g.airlines[1].cash = 1_000_000_000;
    expect(isPlayerDominant(g)).toBe(true);
    expect(playerFloatBuyAction(g, g.airlines[1], P, BIG)).toBeNull();
  });

  it('never buys past the float — founder shares stay with the player', () => {
    const g = game(1); // 20% floated
    const me = g.airlines[0];
    const raider = g.airlines[1];
    me.cash = 1_100_000_000;
    raider.cash = 1_000_000_000;
    expect(isPlayerDominant(g)).toBe(true);
    for (let i = 0; i < 20; i++) {
      const act = playerFloatBuyAction(g, raider, P, BIG);
      if (!act) break;
      act.run();
    }
    expect(publicFloat(me)).toBe(0); // whole float mopped up
    expect(sharesOwned(me, raider.id)).toBe(20); // but no more than the 20% floated
    expect(hasControl(me, raider.id)).toBe(false); // can never reach control this way
  });
});

describe('playerBuyoutAction — the all-or-nothing takeover', () => {
  it('offers nothing while the player is not dominant', () => {
    const g = game(3);
    for (const al of g.airlines) al.cash = 10_000_000;
    expect(playerBuyoutAction(g, g.airlines[1], P, BIG)).toBeNull();
  });

  it('offers nothing to a rival that cannot finance the whole control block', () => {
    const g = game(1);
    g.airlines[0].cash = 1_100_000_000; // a big, valuable player
    g.airlines[1].cash = 0; // and (appetite 0) no borrowing room
    expect(isPlayerDominant(g)).toBe(true);
    expect(playerBuyoutAction(g, g.airlines[1], P, 0)).toBeNull();
  });

  it('lets a powerhouse rival buy control in one move and ends the game', () => {
    const g = game(1);
    const me = g.airlines[0];
    const raider = g.airlines[1];
    me.cash = 10_000_000_000; // strictly the biggest — a dominant target
    raider.cash = 9_000_000_000; // smaller, but deep enough to buy the control block
    expect(isPlayerDominant(g)).toBe(true);

    const act = playerBuyoutAction(g, raider, P, BIG);
    expect(act).not.toBeNull();
    act!.run();

    expect(hasControl(me, raider.id)).toBe(true);
    expect(g.defeat).toBeDefined();
    expect(g.defeat!.raiderId).toBe(raider.id);
  });

  it('a prior float stake makes the buyout cheaper (counts toward control)', () => {
    const g = game(1);
    const me = g.airlines[0];
    const raider = g.airlines[1];
    me.cash = 4_000_000_000; // strictly the biggest
    raider.cash = 2_000_000_000; // far smaller, yet the last 6% is cheap
    me.shares = { [me.id]: 55, [raider.id]: 45 }; // one nudge from control
    const act = playerBuyoutAction(g, raider, P, BIG)!;
    act.run();
    expect(g.defeat).toBeDefined();
  });

  it('outscores a mere float nibble when both are on offer', () => {
    const g = game(1);
    const me = g.airlines[0];
    const raider = g.airlines[1];
    // Give the player a real network so reach (the score) is positive.
    me.ai = { personality: P.id, nextDecisionDay: 0 };
    for (let d = 0; d < 365; d++) {
      advanceDay(g);
      runAI(g);
    }
    delete me.ai;
    me.cash = 10_000_000_000;
    raider.cash = 8_000_000_000;
    expect(evaluateNetwork(g, me).revenue).toBeGreaterThan(0);
    expect(isPlayerDominant(g)).toBe(true);

    const buyout = playerBuyoutAction(g, raider, P, BIG)!;
    const nibble = playerFloatBuyAction(g, raider, P, BIG)!;
    expect(buyout).not.toBeNull();
    expect(nibble).not.toBeNull();
    expect(buyout.score).toBeGreaterThan(nibble.score);
  });

  it('offers nothing once the rival already controls the player', () => {
    const g = game(1);
    const raider = g.airlines[1];
    g.airlines[0].cash = 2_000_000_000;
    g.airlines[0].shares = { [g.airlines[0].id]: 40, [raider.id]: 60 };
    expect(playerBuyoutAction(g, raider, P, BIG)).toBeNull();
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
