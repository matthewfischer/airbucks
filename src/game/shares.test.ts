import { describe, expect, it } from 'vitest';
import { newAirline, newGame } from './engine';
import {
  buyBack,
  buyShares,
  controllerOf,
  costToAccumulate,
  franchiseValue,
  hasControl,
  issueShares,
  largestRivalStake,
  ownership,
  portfolioValue,
  publicFloat,
  publicValue,
  retainedShares,
  sellShares,
  sharePriceBase,
  sharesOwned,
  takeover,
  takeoverCost,
} from './shares';
import { applySave, deserialize, serialize } from './persist';

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

describe('franchiseValue (market footprint)', () => {
  it('grows with the network — a bigger footprint is worth more', () => {
    const g = newGame('crw', 1);
    const solo = newAirline('s', 'S', '#fff', 'clt');
    solo.rights = ['clt'];
    const net = newAirline('n', 'N', '#000', 'atl');
    net.rights = ['atl', 'jfk', 'bna', 'den'];
    g.airlines.push(solo, net);
    expect(franchiseValue(g, solo)).toBeGreaterThan(0);
    expect(franchiseValue(g, net)).toBeGreaterThan(franchiseValue(g, solo));
  });
});

describe('publicValue', () => {
  it('is floored positive and rises with net worth', () => {
    const g = newGame('crw', 1);
    const al = newAirline('ai-1', 'A', '#fff', 'atl');
    g.airlines.push(al);
    al.cash = 0;
    const v0 = publicValue(g, al);
    expect(v0).toBeGreaterThan(0);
    al.cash = 10_000_000;
    expect(publicValue(g, al)).toBeGreaterThan(v0);
  });

  it('is higher for a bigger-market network at equal net worth', () => {
    const g = newGame('crw', 1);
    const small = newAirline('a', 'A', '#fff', 'clt');
    small.cash = 5_000_000;
    small.rights = ['clt'];
    const big = newAirline('b', 'B', '#000', 'atl');
    big.cash = 5_000_000;
    big.rights = ['atl', 'jfk', 'bna', 'den', 'clt'];
    g.airlines.push(small, big);
    expect(publicValue(g, big)).toBeGreaterThan(publicValue(g, small)); // same equity, more market
  });
});

describe('portfolioValue (stakes are balance-sheet assets)', () => {
  it('is zero with no cross-holdings', () => {
    const g = newGame('crw', 1);
    const a = newAirline('a', 'A', '#fff', 'clt');
    a.rights = ['clt'];
    g.airlines.push(a);
    expect(portfolioValue(g, a)).toBe(0);
  });

  it('values a stake at the issuer’s public per-share price', () => {
    const g = newGame('crw', 1);
    const holder = newAirline('h', 'H', '#fff', 'clt');
    holder.rights = ['clt'];
    const issuer = newAirline('i', 'I', '#000', 'atl');
    issuer.rights = ['atl', 'jfk', 'bna', 'den'];
    g.airlines.push(holder, issuer);
    issuer.shares = { i: 70, h: 30 }; // holder owns 30% of the issuer
    // Issuer holds nothing itself, so its public value is its base value.
    expect(portfolioValue(g, holder)).toBeCloseTo(publicValue(g, issuer) * 0.3, -3);
  });

  it('lifts the holder’s public value (and so its takeover price)', () => {
    const g = newGame('crw', 1);
    const holder = newAirline('h', 'H', '#fff', 'clt');
    holder.rights = ['clt'];
    holder.cash = 5_000_000;
    const issuer = newAirline('i', 'I', '#000', 'atl');
    issuer.rights = ['atl', 'jfk', 'bna', 'den'];
    g.airlines.push(holder, issuer);
    const before = publicValue(g, holder);
    issuer.shares = { i: 70, h: 30 };
    expect(publicValue(g, holder)).toBeGreaterThan(before);
  });

  it('does not recurse on a mutual cross-holding', () => {
    const g = newGame('crw', 1);
    const a = newAirline('a', 'A', '#fff', 'clt');
    a.rights = ['clt', 'atl'];
    const b = newAirline('b', 'B', '#000', 'atl');
    b.rights = ['atl', 'jfk'];
    g.airlines.push(a, b);
    a.shares = { a: 80, b: 20 }; // b owns 20% of a
    b.shares = { b: 80, a: 20 }; // a owns 20% of b
    expect(Number.isFinite(publicValue(g, a))).toBe(true);
    expect(Number.isFinite(publicValue(g, b))).toBe(true);
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

describe('valuation pricing (everything prices off public value)', () => {
  it('issuing 10% raises ~10% of public value', () => {
    const g = newGame('crw', 1);
    const al = newAirline('a', 'A', '#fff', 'clt');
    al.cash = 5_000_000;
    g.airlines.push(al);
    const pub = publicValue(g, al);
    const before = al.cash;
    issueShares(g, al, 10);
    const raised = al.cash - before;
    expect(raised).toBeGreaterThan(pub * 0.08);
    expect(raised).toBeLessThan(pub * 0.12);
  });

  it('prices a takeover off the public value, and is Infinity without enough float', () => {
    const g = newGame('crw', 1);
    const t = newAirline('t', 'T', '#fff', 'atl');
    t.cash = 5_000_000;
    t.rights = ['atl', 'jfk', 'bna', 'den'];
    const buyer = newAirline('b', 'B', '#00f', 'clt');
    buyer.cash = 1_000_000_000;
    g.airlines.push(t, buyer);
    // 100%-held: no float can deliver control — un-takeoverable via shares.
    expect(takeoverCost(g, buyer, t)).toBe(Infinity);
    // Float a majority and the cost becomes finite, scaled to the public value.
    issueShares(g, t, 60);
    const cost = takeoverCost(g, buyer, t);
    expect(Number.isFinite(cost)).toBe(true);
    expect(cost).toBeGreaterThan(publicValue(g, t) / 2); // ~control's worth, with impact
  });
});

describe('share transactions', () => {
  it('issues shares to the float, raising cash for the airline', () => {
    const g = newGame('crw', 1);
    const al = newAirline('a', 'A', '#fff', 'atl');
    al.cash = 1_000_000;
    g.airlines.push(al);
    const before = al.cash;
    expect(issueShares(g, al, 30)).toBe(30);
    expect(retainedShares(al)).toBe(70);
    expect(publicFloat(al)).toBe(30);
    expect(al.cash).toBeGreaterThan(before);
  });

  it('open-market buys take only the float — control needs more than that', () => {
    const g = newGame('crw', 1);
    const t = newAirline('t', 'T', '#f00', 'clt');
    t.cash = 10_000_000;
    g.airlines.push(t);
    issueShares(g, t, 30); // float 30, founder 70
    const b = newAirline('b', 'B', '#fff', 'atl');
    b.cash = 1_000_000_000;
    g.airlines.push(b);
    expect(buyShares(g, b, t, 100)).toBe(30); // clamped to the float
    expect(sharesOwned(t, 'b')).toBe(30);
    expect(publicFloat(t)).toBe(0);
    expect(hasControl(t, 'b')).toBe(false); // can't corner a majority founder via float alone
  });

  it('buys back float to re-secure the founder stake', () => {
    const g = newGame('crw', 1);
    const al = newAirline('a', 'A', '#fff', 'atl');
    al.cash = 1_000_000_000;
    g.airlines.push(al);
    issueShares(g, al, 40); // retained 60, float 40
    buyBack(g, al, 10);
    expect(retainedShares(al)).toBe(70);
    expect(publicFloat(al)).toBe(30);
  });

  it('lets a holder sell its stake back for cash', () => {
    const g = newGame('crw', 1);
    const t = newAirline('t', 'T', '#f00', 'clt');
    t.cash = 10_000_000;
    g.airlines.push(t);
    issueShares(g, t, 40);
    const b = newAirline('b', 'B', '#fff', 'atl');
    b.cash = 1_000_000_000;
    g.airlines.push(b);
    buyShares(g, b, t, 20);
    const cash0 = b.cash;
    expect(sellShares(g, b, t, 20)).toBe(20);
    expect(sharesOwned(t, 'b')).toBe(0);
    expect(b.cash).toBeGreaterThan(cash0);
  });

  it('cannot take over a founder that kept its majority — no float to reach control', () => {
    const g = newGame('crw', 1);
    const b = newAirline('b', 'B', '#fff', 'atl');
    b.cash = 1_000_000_000;
    const t = newAirline('t', 'T', '#f00', 'clt');
    t.cash = 5_000_000;
    g.airlines.push(b, t);
    issueShares(g, t, 40); // founder keeps 60 — float can't deliver control
    const before = b.cash;
    expect(takeover(g, b, t)).toBe(false);
    expect(g.airlines).toContain(t); // still standing
    expect(b.cash).toBe(before); // nothing spent on a doomed bid
  });

  it('takes over once the float exceeds control, at a real cost', () => {
    const g = newGame('crw', 1);
    const b = newAirline('b', 'B', '#fff', 'atl');
    b.cash = 1_000_000_000;
    const t = newAirline('t', 'T', '#f00', 'clt');
    t.cash = 5_000_000;
    g.airlines.push(b, t);
    issueShares(g, t, 60); // float 60 > 51 needed
    const before = b.cash;
    expect(takeover(g, b, t)).toBe(true);
    expect(g.airlines.find((a) => a.id === 't')).toBeUndefined(); // merged & dissolved
    expect(b.rights).toContain('clt'); // network inherited
    expect(b.cash).toBeLessThan(before); // a real cost, not a wash
  });

  it('blocks a second acquisition during the integration cooldown', () => {
    const g = newGame('crw', 1);
    const b = newAirline('b', 'B', '#fff', 'atl');
    b.cash = 1_000_000_000;
    const t1 = newAirline('t1', 'T1', '#f00', 'clt');
    t1.cash = 2_000_000;
    const t2 = newAirline('t2', 'T2', '#00f', 'den');
    t2.cash = 2_000_000;
    g.airlines.push(b, t1, t2);
    issueShares(g, t1, 60); // both floated enough to be takeoverable
    issueShares(g, t2, 60);

    expect(takeover(g, b, t1)).toBe(true); // first acquisition lands
    expect(g.airlines).not.toContain(t1);
    expect(takeover(g, b, t2)).toBe(false); // second blocked — still integrating
    expect(g.airlines).toContain(t2);

    g.day += 365; // integration done
    expect(takeover(g, b, t2)).toBe(true);
    expect(g.airlines).not.toContain(t2);
  });

  it('cashes out an other-airline minority at the public price (no premium)', () => {
    const g = newGame('crw', 1);
    const t = newAirline('t', 'T', '#f00', 'clt');
    t.cash = 5_000_000;
    g.airlines.push(t);
    issueShares(g, t, 90); // founder 10, float 90
    const x = newAirline('x', 'X', '#0f0', 'den');
    x.cash = 1_000_000_000;
    g.airlines.push(x);
    buyShares(g, x, t, 20); // x holds 20, float 70
    const b = newAirline('b', 'B', '#fff', 'sea');
    b.cash = 1_000_000_000;
    g.airlines.push(b);
    const perShare = sharePriceBase(g, t); // public price is stable through a float buy
    const xCash0 = x.cash;
    takeover(g, b, t); // buy float to control, then squeeze out the rest
    expect(g.airlines.find((a) => a.id === 't')).toBeUndefined();
    expect(x.cash - xCash0).toBeCloseTo(perShare * 20, -3); // public price, no premium
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
