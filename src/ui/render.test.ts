import { beforeEach, describe, expect, it } from 'vitest';
import type { FinanceSnapshot, GameState } from '../game/types';
import { addAiAirlines } from '../game/ai';
import { buyPlane, newGame, player } from '../game/engine';
import { renderAwards } from './awards';
import { renderCompetitors } from './competitors';
import { renderFinance } from './finance';

/** Minimal stand-in for the render target — captures the HTML that gets set. */
function stubEl(): HTMLElement {
  return { innerHTML: '' } as unknown as HTMLElement;
}

/** A weekly snapshot with sensible defaults, overridable per field. */
function snap(over: Partial<FinanceSnapshot> = {}): FinanceSnapshot {
  return {
    day: 7,
    cash: 1_000_000,
    debt: 0,
    fleetValue: 500_000,
    revenue: 200_000,
    cost: 150_000,
    interest: 0,
    interestEarned: 0,
    net: 50_000,
    pax: 1_200,
    ...over,
  };
}

let g: GameState;
beforeEach(() => {
  g = newGame('crw', 3);
});

describe('renderAwards', () => {
  it('renders the trophy case with the earned count and all groups', () => {
    const el = stubEl();
    renderAwards(g, el);
    expect(el.innerHTML).toContain('Awards');
    expect(el.innerHTML).toContain('0 /'); // none earned on a fresh game
    expect(el.innerHTML).toContain('Exploration');
    expect(el.innerHTML).toContain('Milestones');
  });

  it('shows an earned badge with its date when the player holds it', () => {
    player(g).badges = [{ id: 'reach-eu', day: 365 }];
    const el = stubEl();
    renderAwards(g, el);
    expect(el.innerHTML).toContain('badge-card earned');
    expect(el.innerHTML).toContain('1 /');
  });
});

describe('renderFinance', () => {
  it('shows the KPI grid and a prompt to play when history is thin', () => {
    const el = stubEl();
    renderFinance(g, el);
    expect(el.innerHTML).toContain('Net worth');
    expect(el.innerHTML).toContain('fin-empty'); // < 2 snapshots → no charts yet
  });

  it('charts the history once a couple of weeks have accrued', () => {
    player(g).history = [
      snap({ day: 7, cash: 1_000_000, net: 50_000 }),
      snap({ day: 14, cash: 1_100_000, net: 60_000 }),
      snap({ day: 21, cash: 900_000, debt: 200_000, net: -20_000 }),
    ];
    const el = stubEl();
    renderFinance(g, el);
    expect(el.innerHTML).not.toContain('fin-empty');
    expect(el.innerHTML).toContain('<svg'); // line charts drawn
    expect(el.innerHTML).toContain('Net worth');
  });

  it('survives a flat history without producing NaN coordinates', () => {
    player(g).history = [snap({ day: 7 }), snap({ day: 14 })]; // identical values
    const el = stubEl();
    renderFinance(g, el);
    expect(el.innerHTML).toContain('<svg');
    expect(el.innerHTML).not.toContain('NaN');
  });
});

describe('renderCompetitors', () => {
  it('explains a solo game when there are no rivals', () => {
    const el = stubEl();
    renderCompetitors(g, el);
    expect(el.innerHTML).toContain('solo game');
    expect(el.innerHTML).toContain('Competitors');
  });

  it('ranks every airline and tags the player card', () => {
    addAiAirlines(g, 3);
    const el = stubEl();
    renderCompetitors(g, el);
    expect(el.innerHTML).toContain('1st');
    expect(el.innerHTML).toContain('comp-you-tag'); // the player's own card
    expect(el.innerHTML).toContain('Net worth');
  });

  it('flags a for-sale rival and counts it in the header', () => {
    addAiAirlines(g, 2);
    g.airlines[1].forSale = { listedDay: g.day, deadlineDay: g.day + 30, price: 1_000_000 };
    const el = stubEl();
    renderCompetitors(g, el);
    expect(el.innerHTML).toContain('FOR SALE');
    expect(el.innerHTML).toContain('1 for sale');
    expect(el.innerHTML).toContain('Asking');
  });

  it('reads an insolvent, money-losing rival as struggling', () => {
    addAiAirlines(g, 1);
    const rival = g.airlines[1];
    rival.debt = rival.cash + 10_000_000; // equity underwater
    buyPlane(g, rival, 'dc3'); // idle plane → weekly net goes negative
    const el = stubEl();
    renderCompetitors(g, el);
    expect(el.innerHTML).toContain('Struggling');
    expect(el.innerHTML).toContain('losing money');
  });
});
