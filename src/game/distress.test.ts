import { beforeEach, describe, expect, it } from 'vitest';
import type { Airline, GameState } from './types';
import { airportById, newAirline, newGame, player, rightsFee } from './engine';
import {
  acquire,
  acquisitionPrice,
  buyoutPrice,
  forSaleAirlines,
  isForSale,
  marketPrice,
  updateDistress,
} from './distress';

let g: GameState;
beforeEach(() => {
  g = newGame('crw', 1);
});

/** Attach an AI airline that never auto-decides (nextDecisionDay far away). */
function aiAirline(id: string, home: string): Airline {
  const al = newAirline(id, `${id.toUpperCase()} Air`, '#ffffff', home);
  al.ai = { personality: 'cheapskate', nextDecisionDay: 1e9 };
  al.log = [];
  g.airlines.push(al);
  return al;
}

/** Step the calendar in weekly ticks up to `targetDay`, running the sweep each week. */
function advanceWeeksTo(targetDay: number): void {
  while (g.day < targetDay) {
    g.day += 7;
    updateDistress(g);
  }
}

describe('acquisitionPrice', () => {
  it('floors at a small sticker when book value is deeply negative', () => {
    const t = aiAirline('ai-1', 'bna');
    t.debt = 500_000_000; // far past any asset value
    const price = acquisitionPrice(g, t);
    expect(price).toBeGreaterThan(0);
    expect(price).toBeLessThan(1_000_000); // a fire-sale sticker, not the debt
  });
});

describe('cash-crunch distress (short fuse)', () => {
  it('lists an AI airline after ~8 weeks underwater, not before', () => {
    const al = aiAirline('ai-1', 'bna');
    al.cash = -100;
    advanceWeeksTo(49);
    expect(isForSale(al)).toBe(false);
    advanceWeeksTo(70); // past 8 weeks from the first weekly observation
    expect(isForSale(al)).toBe(true);
    expect(player(g).log[0]).toMatch(/distress/i);
  });

  it('a brief dip that recovers never lists', () => {
    const al = aiAirline('ai-1', 'bna');
    al.cash = -100;
    advanceWeeksTo(28); // ~4 weeks underwater
    expect(al.cashNegSince).toBeDefined();
    al.cash = 1_000_000; // recovered
    advanceWeeksTo(35);
    expect(al.cashNegSince).toBeUndefined();
    advanceWeeksTo(365);
    expect(isForSale(al)).toBe(false);
  });
});

describe('insolvency distress (long fuse)', () => {
  it('lists an equity-negative airline only after ~2 years', () => {
    const al = aiAirline('ai-1', 'bna');
    al.cash = 1000; // positive cash, so the cash fuse never lights
    al.debt = 5_000_000; // equity = cash − debt < 0
    advanceWeeksTo(365); // one year in the red
    expect(isForSale(al)).toBe(false);
    advanceWeeksTo(365 * 3); // past two years
    expect(isForSale(al)).toBe(true);
  });

  it('an overexpander that climbs back to positive equity is spared', () => {
    const al = aiAirline('ai-1', 'bna');
    al.cash = 1000;
    al.debt = 5_000_000;
    advanceWeeksTo(365);
    expect(al.equityNegSince).toBeDefined();
    al.debt = 0; // dug out — equity positive again
    advanceWeeksTo(372);
    expect(al.equityNegSince).toBeUndefined();
    advanceWeeksTo(365 * 4);
    expect(isForSale(al)).toBe(false);
  });
});

describe('liquidation', () => {
  it('removes an unsold airline after its countdown and frees it from the game', () => {
    const al = aiAirline('ai-1', 'bna');
    al.forSale = { listedDay: g.day, deadlineDay: g.day + 60, price: 100_000 };
    advanceWeeksTo(70);
    expect(g.airlines).not.toContain(al);
    expect(player(g).log[0]).toMatch(/bankrupt/i);
  });
});

describe('acquire', () => {
  it('merges the network, assumes the debt, pays the sticker, and dissolves the target', () => {
    const buyer = aiAirline('ai-1', 'bna');
    buyer.cash = 10_000_000;
    buyer.rights = ['bna', 'clt'];
    const target = aiAirline('ai-2', 'sea');
    target.cash = 0; // a fire-sale airline is broke
    target.debt = 2_000_000;
    target.rights = ['sea', 'clt', 'pdx'];
    target.fleet = [{ id: 'plane-99', typeId: 'dc3', routeId: 'route-99', kmFlown: 500 }];
    target.routes = [{ id: 'route-99', stops: ['sea', 'pdx'], fareFactor: 1 }];
    target.forSale = { listedDay: 0, deadlineDay: 60, price: 500_000 };

    acquire(g, buyer, target);

    expect(g.airlines).not.toContain(target);
    expect(buyer.cash).toBe(10_000_000 - 500_000); // inherits target cash (0) − sticker
    expect(buyer.debt).toBe(2_000_000); // assumed
    expect(buyer.rights).toEqual(['bna', 'clt', 'sea', 'pdx']); // CLT duplicate collapses
    expect(buyer.fleet.find((p) => p.id === 'plane-99')?.kmFlown).toBe(500); // mileage intact
    expect(buyer.routes.some((r) => r.id === 'route-99')).toBe(true);
    expect(player(g).log[0]).toMatch(/acquired/i);
  });
});

describe('buying a healthy airline (not distressed)', () => {
  it('market price = (net worth + slot value) × control premium, above the fire-sale price', () => {
    const t = aiAirline('ai-1', 'bna');
    t.cash = 5_000_000;
    t.debt = 0; // equity 5M, only the home slot, no routes → no goodwill
    const fair = 5_000_000 + rightsFee(g, airportById(g, t.homeId));
    expect(marketPrice(g, t)).toBe(Math.round(fair * 1.3));
    expect(marketPrice(g, t)).toBeGreaterThan(acquisitionPrice(g, t));
  });

  it('buyoutPrice uses the fire-sale ask when listed, the market price otherwise', () => {
    const t = aiAirline('ai-1', 'bna');
    t.cash = 5_000_000;
    expect(buyoutPrice(g, t)).toBe(marketPrice(g, t));
    t.forSale = { listedDay: 0, deadlineDay: 60, price: 250_000 };
    expect(buyoutPrice(g, t)).toBe(250_000);
  });

  it('acquiring a healthy airline inherits its cash, assumes its debt, pays market', () => {
    const buyer = aiAirline('ai-1', 'bna');
    buyer.cash = 20_000_000;
    const target = aiAirline('ai-2', 'sea');
    target.cash = 4_000_000;
    target.debt = 1_000_000;
    target.rights = ['sea', 'pdx'];
    const price = marketPrice(g, target);

    acquire(g, buyer, target);

    expect(g.airlines).not.toContain(target);
    expect(buyer.cash).toBe(20_000_000 + 4_000_000 - price); // inherited cash, then paid
    expect(buyer.debt).toBe(1_000_000);
    expect(buyer.rights).toEqual(expect.arrayContaining(['bna', 'sea', 'pdx']));
  });

  it('inherits the target\'s in-progress slot applications as-is', () => {
    const buyer = aiAirline('ai-1', 'bna');
    buyer.cash = 50_000_000;
    const target = aiAirline('ai-2', 'sea');
    target.rights = ['sea'];
    target.negotiations = [{ airportId: 'pdx', opensDay: 300, fee: 100_000 }];
    acquire(g, buyer, target);
    expect(buyer.negotiations).toEqual([{ airportId: 'pdx', opensDay: 300, fee: 100_000 }]);
  });

  it('drops an inherited application whose slot the buyer already holds', () => {
    const buyer = aiAirline('ai-1', 'bna');
    buyer.cash = 50_000_000;
    buyer.rights = ['bna', 'pdx'];
    const target = aiAirline('ai-2', 'sea');
    target.rights = ['sea'];
    target.negotiations = [{ airportId: 'pdx', opensDay: 300, fee: 100_000 }];
    acquire(g, buyer, target);
    expect(buyer.negotiations).toEqual([]);
  });

  it('on an overlapping application keeps the one that opens soonest', () => {
    const buyer = aiAirline('ai-1', 'bna');
    buyer.cash = 50_000_000;
    buyer.negotiations = [{ airportId: 'pdx', opensDay: 500, fee: 100_000 }];
    const target = aiAirline('ai-2', 'sea');
    target.rights = ['sea'];
    target.negotiations = [{ airportId: 'pdx', opensDay: 300, fee: 100_000 }];
    acquire(g, buyer, target);
    expect(buyer.negotiations).toEqual([{ airportId: 'pdx', opensDay: 300, fee: 100_000 }]);
  });
});

describe('the player is exempt', () => {
  it('is never listed or liquidated, however broke', () => {
    player(g).cash = -50_000_000;
    advanceWeeksTo(365 * 5);
    expect(g.airlines).toContain(player(g));
    expect(isForSale(player(g))).toBe(false);
    expect(forSaleAirlines(g)).toEqual([]);
  });
});
