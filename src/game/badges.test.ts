import { beforeEach, describe, expect, it } from 'vitest';
import type { GameState, Plane } from './types';
import { AIRCRAFT_TYPES } from './data';
import { continentOf } from './data';
import { currentYear, newGame } from './engine';
import { BADGES, badgeById, checkBadges } from './badges';

let g: GameState;
beforeEach(() => {
  g = newGame('crw');
});

const has = (id: string) => g.badges.some((b) => b.id === id);
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
    checkBadges(g);
    expect(g.badges).toEqual([]);
  });

  it('awards an exploration badge the day a continent is reached, and records the day', () => {
    g.day = 1234;
    g.rights = ['crw', 'lhr'];
    const newly = checkBadges(g);
    expect(newly).toContain('reach-eu');
    expect(badgeById('reach-eu')!.name).toBe('Old World');
    expect(g.badges.find((b) => b.id === 'reach-eu')!.day).toBe(1234);
  });

  it('Globetrotter needs all six continents at once', () => {
    g.rights = ['crw', 'lhr', 'nrt', 'jnb', 'gru']; // missing Oceania
    checkBadges(g);
    expect(has('globetrotter')).toBe(false);
    g.rights.push('syd');
    checkBadges(g);
    expect(has('globetrotter')).toBe(true);
  });

  it('awards network badges at their thresholds', () => {
    g.rights = ['crw', 'clt', 'dca', 'pit', 'cle', 'cvg', 'cmh', 'ric', 'sdf', 'tys'];
    checkBadges(g);
    expect(has('net-5')).toBe(true);
    expect(has('net-10')).toBe(true);
    expect(has('net-25')).toBe(false);
  });

  it('awards fleet-size and all-jet badges', () => {
    const jet = AIRCRAFT_TYPES.find((t) => t.propulsion === 'jet')!;
    g.fleet = Array.from({ length: 5 }, () => makePlane(jet.id));
    checkBadges(g);
    expect(has('fleet-1')).toBe(true);
    expect(has('all-jet')).toBe(true);
    // A single prop in the mix breaks the all-jet streak (but it's already earned).
    const prop = AIRCRAFT_TYPES.find((t) => t.propulsion !== 'jet');
    if (prop) {
      const fresh = newGame('crw');
      fresh.fleet = [makePlane(jet.id), makePlane(jet.id), makePlane(jet.id),
        makePlane(jet.id), makePlane(prop.id)];
      checkBadges(fresh);
      expect(fresh.badges.some((b) => b.id === 'all-jet')).toBe(false);
    }
  });

  it('Cutting Edge needs a young fleet of at least three', () => {
    const newest = [...AIRCRAFT_TYPES].sort((a, b) => b.introduced - a.introduced)[0];
    g.day = 0;
    const startYear = currentYear(g);
    g.day = (newest.introduced - startYear) * 365 + 30; // ~the year it entered service
    g.fleet = Array.from({ length: 3 }, () => makePlane(newest.id));
    checkBadges(g);
    expect(has('young-fleet')).toBe(true);
  });

  it('Debt Free needs a history of debt, then a zero balance', () => {
    g.debt = 0;
    checkBadges(g);
    expect(has('debt-free')).toBe(false); // never borrowed
    g.history.push({ ...g.history[0], debt: 5_000_000 });
    checkBadges(g);
    expect(has('debt-free')).toBe(true);
  });

  it('The Long Haul lands after 20 years of flying', () => {
    g.day = 20 * 365 - 1;
    checkBadges(g);
    expect(has('long-haul')).toBe(false);
    g.day = 20 * 365;
    checkBadges(g);
    expect(has('long-haul')).toBe(true);
  });

  it('never awards the same badge twice', () => {
    g.rights = ['crw', 'lhr'];
    checkBadges(g);
    const count = g.badges.length;
    const newly = checkBadges(g);
    expect(newly).toEqual([]);
    expect(g.badges.length).toBe(count);
  });
});
