import { beforeEach, describe, expect, it } from 'vitest';
import type { Airline, GameState, Plane } from './types';
import { AIRCRAFT_TYPES } from './data';
import { continentOf } from './data';
import { currentYear, newGame, player } from './engine';
import { BADGES, badgeById, checkBadges } from './badges';

let g: GameState;
let al: Airline;
beforeEach(() => {
  g = newGame('crw');
  al = player(g);
});

const has = (id: string) => al.badges.some((b) => b.id === id);
const makePlane = (typeId: string): Plane => ({
  id: `p${Math.random()}`,
  typeId,
  routeId: null,
  kmFlown: 0,
});

describe('continent classification', () => {
  it('maps overseas markets to their continent and everything else to North America', () => {
    expect(continentOf('lhr')).toBe('Europe');
    expect(continentOf('nrt')).toBe('Asia');
    expect(continentOf('dxb')).toBe('Asia'); // Middle East folds into Asia
    expect(continentOf('jnb')).toBe('Africa');
    expect(continentOf('gru')).toBe('South America');
    expect(continentOf('syd')).toBe('Oceania');
    expect(continentOf('crw')).toBe('North America'); // home
    expect(continentOf('kef')).toBe('North America'); // an Atlantic refuel bridge
  });

  it('every badge has a unique id', () => {
    const ids = BADGES.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('checkBadges', () => {
  it('a fresh airline has earned nothing', () => {
    checkBadges(g, al);
    expect(al.badges).toEqual([]);
  });

  it('awards an exploration badge the day a continent is reached, and records the day', () => {
    g.day = 1234;
    al.rights = ['crw', 'lhr'];
    const newly = checkBadges(g, al);
    expect(newly).toContain('reach-eu');
    expect(badgeById('reach-eu')!.name).toBe('Old World');
    expect(al.badges.find((b) => b.id === 'reach-eu')!.day).toBe(1234);
  });

  it('Globetrotter needs all six continents at once', () => {
    al.rights = ['crw', 'lhr', 'nrt', 'jnb', 'gru']; // missing Oceania
    checkBadges(g, al);
    expect(has('globetrotter')).toBe(false);
    al.rights.push('syd');
    checkBadges(g, al);
    expect(has('globetrotter')).toBe(true);
  });

  it('awards network badges at their thresholds', () => {
    al.rights = ['crw', 'clt', 'dca', 'pit', 'cle', 'cvg', 'cmh', 'ric', 'sdf', 'tys'];
    checkBadges(g, al);
    expect(has('net-5')).toBe(true);
    expect(has('net-10')).toBe(true);
    expect(has('net-25')).toBe(false);
  });

  it('awards fleet-size and all-jet badges', () => {
    const jet = AIRCRAFT_TYPES.find((t) => t.propulsion === 'jet')!;
    al.fleet = Array.from({ length: 5 }, () => makePlane(jet.id));
    checkBadges(g, al);
    expect(has('fleet-1')).toBe(true);
    expect(has('all-jet')).toBe(true);
    // A single prop in the mix breaks the all-jet streak (but it's already earned).
    const prop = AIRCRAFT_TYPES.find((t) => t.propulsion !== 'jet');
    if (prop) {
      const fresh = newGame('crw');
      const fal = player(fresh);
      fal.fleet = [makePlane(jet.id), makePlane(jet.id), makePlane(jet.id),
        makePlane(jet.id), makePlane(prop.id)];
      checkBadges(fresh, fal);
      expect(fal.badges.some((b) => b.id === 'all-jet')).toBe(false);
    }
  });

  it('Cutting Edge needs a young fleet of at least three', () => {
    const newest = [...AIRCRAFT_TYPES].sort((a, b) => b.introduced - a.introduced)[0];
    g.day = 0;
    const startYear = currentYear(g);
    g.day = (newest.introduced - startYear) * 365 + 30; // ~the year it entered service
    al.fleet = Array.from({ length: 3 }, () => makePlane(newest.id));
    checkBadges(g, al);
    expect(has('young-fleet')).toBe(true);
  });

  it('Debt Free needs a history of debt, then a zero balance', () => {
    al.debt = 0;
    checkBadges(g, al);
    expect(has('debt-free')).toBe(false); // never borrowed
    al.history.push({ ...al.history[0], debt: 5_000_000 });
    checkBadges(g, al);
    expect(has('debt-free')).toBe(true);
  });

  it('awards transatlantic/transpacific for an ocean-spanning route', () => {
    al.routes = [{ id: 'r1', stops: ['jfk', 'lhr'], fareFactor: 1 }];
    checkBadges(g, al);
    expect(has('transatlantic')).toBe(true);
    expect(has('transpacific')).toBe(false);
    al.routes.push({ id: 'r2', stops: ['lax', 'nrt'], fareFactor: 1 });
    checkBadges(g, al);
    expect(has('transpacific')).toBe(true);
  });

  it('Supersonic needs a supersonic airliner; Full Spectrum needs all three classes', () => {
    const concorde = AIRCRAFT_TYPES.find((t) => t.speed >= 1000)!;
    al.fleet = [makePlane(concorde.id)];
    checkBadges(g, al);
    expect(has('supersonic')).toBe(true);
    expect(has('full-spectrum')).toBe(false);
    const prop = AIRCRAFT_TYPES.find((t) => t.propulsion === 'prop')!;
    const turbo = AIRCRAFT_TYPES.find((t) => t.propulsion === 'turboprop')!;
    const jet = AIRCRAFT_TYPES.find((t) => t.propulsion === 'jet')!;
    al.fleet = [makePlane(prop.id), makePlane(turbo.id), makePlane(jet.id)];
    checkBadges(g, al);
    expect(has('full-spectrum')).toBe(true);
  });

  it('Takeover lands after an acquisition is recorded', () => {
    checkBadges(g, al);
    expect(has('first-merger')).toBe(false);
    al.acquisitions = 1;
    checkBadges(g, al);
    expect(has('first-merger')).toBe(true);
  });

  it('Top Dog needs the highest net worth among at least one rival', () => {
    al.cash = 50_000_000; // solo game: no rival to beat, so not yet
    checkBadges(g, al);
    expect(has('top-dog')).toBe(false);
    const rival = { ...al, id: 'r', ai: undefined, cash: 5_000_000, badges: [] } as Airline;
    g.airlines.push(rival);
    checkBadges(g, al);
    expect(has('top-dog')).toBe(true);
  });

  it('net-worth milestones land at their thresholds', () => {
    al.cash = 100_000_000;
    checkBadges(g, al);
    expect(has('worth-100m')).toBe(true);
    expect(has('worth-1b')).toBe(false);
    al.cash = 1_000_000_000;
    checkBadges(g, al);
    expect(has('worth-1b')).toBe(true);
  });

  it('The Long Haul lands after 20 years of flying', () => {
    g.day = 20 * 365 - 1;
    checkBadges(g, al);
    expect(has('long-haul')).toBe(false);
    g.day = 20 * 365;
    checkBadges(g, al);
    expect(has('long-haul')).toBe(true);
  });

  it('never awards the same badge twice', () => {
    al.rights = ['crw', 'lhr'];
    checkBadges(g, al);
    const count = al.badges.length;
    const newly = checkBadges(g, al);
    expect(newly).toEqual([]);
    expect(al.badges.length).toBe(count);
  });
});
