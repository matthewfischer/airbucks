import { beforeEach, describe, expect, it } from 'vitest';
import type { FinanceSnapshot, GameState } from '../game/types';
import { addAiAirlines, makeAiControlled } from '../game/ai';
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
    loadFactor: 0.7,
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

  it('shows the loan rate and operating KPIs', () => {
    const el = stubEl();
    renderFinance(g, el);
    expect(el.innerHTML).toContain('Loan rate');
    expect(el.innerHTML).toContain('Passengers / wk');
    expect(el.innerHTML).toContain('Profit / plane');
    expect(el.innerHTML).toContain('Load factor');
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
    expect(el.innerHTML).toContain('Interest rates'); // the rates chart
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

  it('offers a Propose alliance button on an unallied rival', () => {
    addAiAirlines(g, 1);
    const el = stubEl();
    renderCompetitors(g, el);
    expect(el.innerHTML).toContain('propose-alliance');
    expect(el.innerHTML).toContain('Propose alliance');
    expect(el.innerHTML).not.toContain('alliance-strip'); // not allied yet
  });

  it('shows your bloc strip + a Your ally tag once allied', () => {
    addAiAirlines(g, 1);
    player(g).alliance = g.airlines[1].alliance = 'star';
    const el = stubEl();
    renderCompetitors(g, el);
    expect(el.innerHTML).toContain('alliance-strip');
    expect(el.innerHTML).toContain('leave-alliance');
    expect(el.innerHTML).toContain('Your ally');
  });

  it('surfaces an incoming proposal with Accept / Decline', () => {
    addAiAirlines(g, 1);
    g.allianceOffers = [{ from: g.airlines[1].id, to: player(g).id, day: g.day }];
    const el = stubEl();
    renderCompetitors(g, el);
    expect(el.innerHTML).toContain('accept-alliance');
    expect(el.innerHTML).toContain('decline-alliance');
    expect(el.innerHTML).toContain('proposed an alliance');
  });

  it('replaces Accept with a reason once the incoming offer has gone illegal', () => {
    addAiAirlines(g, 1);
    const rival = g.airlines[1];
    player(g).alliance = 'yours'; // you and the rival are now in different blocs
    rival.alliance = 'star';
    g.allianceOffers = [{ from: rival.id, to: player(g).id, day: g.day }];
    const el = stubEl();
    renderCompetitors(g, el);
    expect(el.innerHTML).not.toContain('accept-alliance'); // no dead Accept button
    expect(el.innerHTML).toContain('Dismiss');
    expect(el.innerHTML).toMatch(/already/i); // shows the reason
  });

  it('shows Proposal pending with a Cancel on an outgoing offer', () => {
    addAiAirlines(g, 1);
    g.allianceOffers = [{ from: player(g).id, to: g.airlines[1].id, day: g.day }];
    const el = stubEl();
    renderCompetitors(g, el);
    expect(el.innerHTML).toContain('Proposal pending');
    expect(el.innerHTML).toContain('cancel-alliance');
  });

  it('marks a rival whose bloc is full as In another alliance', () => {
    addAiAirlines(g, 3);
    for (const al of g.airlines.slice(1)) al.alliance = 'star'; // full bloc of 3
    const el = stubEl();
    renderCompetitors(g, el);
    expect(el.innerHTML).toContain('In another alliance');
    expect(el.innerHTML).not.toContain('propose-alliance');
  });

  it('counts pending negotiations on a card', () => {
    addAiAirlines(g, 1);
    g.airlines[1].negotiations.push({ airportId: 'clt', opensDay: g.day + 30, fee: 100_000 });
    const el = stubEl();
    renderCompetitors(g, el);
    expect(el.innerHTML).toContain('1 in negotiation');
  });

  it('warns about the debt you assume on a fire-sale card', () => {
    addAiAirlines(g, 1);
    const rival = g.airlines[1];
    rival.debt = 5_000_000;
    rival.forSale = { listedDay: g.day, deadlineDay: g.day + 30, price: 1_000_000 };
    const el = stubEl();
    renderCompetitors(g, el);
    expect(el.innerHTML).toContain('You assume');
  });

  it('flags a raider on your own card and offers the forced buyback', () => {
    addAiAirlines(g, 1);
    const you = player(g);
    const rival = g.airlines[1];
    you.shares = { [you.id]: 60, public: 20, [rival.id]: 20 };
    you.cash = 1_000_000_000; // can afford the premium buyback
    const el = stubEl();
    renderCompetitors(g, el);
    expect(el.innerHTML).toContain('holds 20% of you');
    expect(el.innerHTML).toContain('Buy back held');
  });

  it('disables the forced buyback when you cannot afford a single share', () => {
    addAiAirlines(g, 1);
    const you = player(g);
    you.shares = { [you.id]: 60, public: 20, [g.airlines[1].id]: 20 };
    you.cash = 0;
    const el = stubEl();
    renderCompetitors(g, el);
    expect(el.innerHTML).toContain("Can't afford buyback");
  });

  it('renders watch mode: follow hint, Watching tag, no alliance verbs', () => {
    addAiAirlines(g, 2);
    makeAiControlled(g, player(g));
    player(g).alliance = g.airlines[1].alliance = 'star';
    const el = stubEl();
    renderCompetitors(g, el, player(g).id);
    expect(el.innerHTML).toContain('watch-only');
    expect(el.innerHTML).toContain('Watching');
    expect(el.innerHTML).not.toContain('alliance-strip');
  });
});
