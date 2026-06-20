import { describe, expect, it } from 'vitest';
import type { FinanceSnapshot } from './types';
import { newAirline, newGame } from './engine';
import {
  controllerOf,
  costToAccumulate,
  growthMultiple,
  largestRivalStake,
  ownership,
  publicFloat,
  retainedShares,
  shareValuation,
  sharesOwned,
} from './shares';
import { applySave, deserialize, serialize } from './persist';

/** A weekly snapshot with just the fields the share math reads. */
const snap = (day: number, revenue: number, net: number): FinanceSnapshot => ({
  day,
  cash: 0,
  debt: 0,
  fleetValue: 0,
  revenue,
  cost: 0,
  interest: 0,
  interestEarned: 0,
  net,
  pax: 0,
});

describe('cap table', () => {
  it('defaults an unset table to 100% self-held', () => {
    const al = newAirline('ai-1', 'A', '#fff', 'atl');
    expect(ownership(al)).toEqual({ 'ai-1': 100 });
    expect(retainedShares(al)).toBe(100);
    expect(publicFloat(al)).toBe(0);
    expect(controllerOf(al)).toBe('ai-1');
    expect(largestRivalStake(al)).toBeNull();
  });

  it('reads stakes, float, controller, and the largest rival stake', () => {
    const al = newAirline('ai-1', 'A', '#fff', 'atl');
    al.shares = { 'ai-1': 55, public: 30, player: 15 };
    expect(sharesOwned(al, 'player')).toBe(15);
    expect(publicFloat(al)).toBe(30);
    expect(controllerOf(al)).toBe('ai-1'); // 55 > 50
    expect(largestRivalStake(al)).toEqual({ ownerId: 'player', shares: 15 });

    al.shares = { 'ai-1': 40, player: 60 };
    expect(controllerOf(al)).toBe('player');
  });
});

describe('growthMultiple', () => {
  const al = newAirline('ai-1', 'A', '#fff', 'atl');

  it('is the floor for a flat or single-point history', () => {
    al.history = [snap(0, 1000, 0)];
    expect(growthMultiple(al)).toBe(2);
    al.history = [snap(0, 1000, 0), snap(365, 1000, 0)];
    expect(growthMultiple(al)).toBe(2);
  });

  it('hits the cap for a doubling (and for growth off a ~zero base)', () => {
    al.history = [snap(0, 1000, 0), snap(365, 2000, 0)];
    expect(growthMultiple(al)).toBe(15);
    al.history = [snap(0, 0, 0), snap(365, 500, 0)];
    expect(growthMultiple(al)).toBe(15);
  });

  it('scales linearly between for partial growth', () => {
    al.history = [snap(0, 1000, 0), snap(365, 1500, 0)]; // +50%/yr
    expect(growthMultiple(al)).toBeCloseTo(8.5, 5); // 2 + 13 * 0.5
  });
});

describe('shareValuation', () => {
  it('is floored positive and rises with net worth', () => {
    const g = newGame('crw', 1);
    const al = newAirline('ai-1', 'A', '#fff', 'atl');
    g.airlines.push(al);
    al.cash = 0;
    const v0 = shareValuation(g, al);
    expect(v0).toBeGreaterThan(0);
    al.cash = 10_000_000;
    expect(shareValuation(g, al)).toBeGreaterThan(v0);
  });
});

describe('costToAccumulate (price impact)', () => {
  const g = newGame('crw', 1);
  const al = newAirline('ai-1', 'A', '#fff', 'atl');
  g.airlines.push(al);
  al.cash = 50_000_000;

  it('charges nothing for zero shares', () => {
    expect(costToAccumulate(g, al, 0, 0)).toBe(0);
  });

  it('makes each successive share dearer', () => {
    expect(costToAccumulate(g, al, 99, 1)).toBeGreaterThan(costToAccumulate(g, al, 0, 1));
  });

  it('charges a control premium on the block that crosses 50%', () => {
    const below = costToAccumulate(g, al, 0, 10); // shares 1..10
    const crossing = costToAccumulate(g, al, 45, 10); // shares 46..55, crosses 50
    expect(crossing).toBeGreaterThan(below);
  });
});

describe('cap-table persistence', () => {
  it('round-trips a cap table', () => {
    const g = newGame('crw', 1);
    const ai = newAirline('ai-1', 'Rival', '#f00', 'clt');
    ai.shares = { 'ai-1': 60, public: 25, player: 15 };
    g.airlines.push(ai);
    const restored = deserialize(serialize(g))!;
    expect(restored.airlines[1].shares).toEqual({ 'ai-1': 60, public: 25, player: 15 });
  });

  it('drops stakes held by airlines that no longer exist, restoring the founder', () => {
    const g = newGame('crw', 1);
    const ai = newAirline('ai-1', 'Rival', '#f00', 'clt');
    ai.shares = { 'ai-1': 50, ghost: 50 }; // 'ghost' isn't a real airline
    g.airlines.push(ai);
    const data = deserialize(serialize(g))!;
    const g2 = newGame('crw', 1);
    applySave(g2, data);
    const r = g2.airlines.find((a) => a.id === 'ai-1')!;
    expect(r.shares).toEqual({ 'ai-1': 100 }); // ghost's 50 returns to the founder
    expect(g2.airlines[0].shares).toBeUndefined(); // a never-floated airline stays unset
  });
});
