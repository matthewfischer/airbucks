import { describe, expect, it } from 'vitest';
import { AIRPORTS, AIRCRAFT_TYPES, LEGACY_TYPE_IDS } from './data';
import { distanceKm } from './geo';

describe('airport data', () => {
  it('has unique ids and codes', () => {
    const ids = AIRPORTS.map((a) => a.id);
    const codes = AIRPORTS.map((a) => a.code);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('uses lowercase ids matching the IATA code', () => {
    for (const a of AIRPORTS) expect(a.id).toBe(a.code.toLowerCase());
  });

  it('keeps every airport within valid world coordinate bounds', () => {
    for (const a of AIRPORTS) {
      expect(a.lat, a.code).toBeGreaterThanOrEqual(-90);
      expect(a.lat, a.code).toBeLessThanOrEqual(90);
      expect(a.lon, a.code).toBeGreaterThanOrEqual(-180);
      expect(a.lon, a.code).toBeLessThanOrEqual(180);
    }
  });

  it('has sane sizes and populations', () => {
    for (const a of AIRPORTS) {
      expect(Number.isInteger(a.size), a.code).toBe(true);
      expect(a.size, a.code).toBeGreaterThanOrEqual(1);
      expect(a.size, a.code).toBeLessThanOrEqual(6);
      expect(a.population, a.code).toBeGreaterThan(0);
    }
  });

  it('covers Canada, Mexico, Central America, and the Caribbean', () => {
    const ids = new Set(AIRPORTS.map((a) => a.id));
    for (const id of ['yyz', 'yvr', 'mex', 'cun', 'pty', 'sju', 'hav', 'bgi', 'anc', 'hnl'])
      expect(ids.has(id), id).toBe(true);
  });

  it('covers the rest of the world (every populated continent)', () => {
    const ids = new Set(AIRPORTS.map((a) => a.id));
    // Europe, Middle East, Africa, Asia, Oceania, South America.
    for (const id of ['lhr', 'cdg', 'ist', 'dxb', 'cai', 'jnb', 'del', 'nrt', 'syd', 'gru'])
      expect(ids.has(id), id).toBe(true);
  });

  it('has ocean bridge airports for the pre-jet era as tiny markets', () => {
    const byId = new Map(AIRPORTS.map((a) => [a.id, a]));
    // Pure refuel stops: no market of their own (Reykjavík/Guam are slightly
    // bigger as real towns, so they're checked only for existence below).
    for (const id of ['yqx', 'snn', 'goh', 'mdy', 'awk']) {
      const a = byId.get(id);
      expect(a, id).toBeDefined();
      expect(a!.size, id).toBe(1); // refuel stops, not destinations
    }
    // Every Atlantic and Pacific bridge exists.
    for (const id of ['kef', 'pdl', 'gum', 'nan', 'ppg'])
      expect(byId.has(id), id).toBe(true);
  });

  it('chains short bridge legs across the Atlantic within early-prop range', () => {
    const byId = new Map(AIRPORTS.map((a) => [a.id, a]));
    const hop = (x: string, y: string) => distanceKm(byId.get(x)!, byId.get(y)!);
    // JFK→Gander→Keflavik→Shannon: every leg flyable by a DC-4 (4000 km range).
    for (const [x, y] of [['jfk', 'yqx'], ['yqx', 'kef'], ['kef', 'snn']])
      expect(hop(x, y), `${x}->${y}`).toBeLessThan(4000);
    // The nonstop JFK→London it replaces is out of early-prop reach.
    expect(hop('jfk', 'lhr')).toBeGreaterThan(4000);
  });
});

describe('aircraft data', () => {
  it('has unique ids', () => {
    const ids = AIRCRAFT_TYPES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has sane real-world specs', () => {
    for (const t of AIRCRAFT_TYPES) {
      expect(['prop', 'turboprop', 'jet']).toContain(t.propulsion);
      expect(t.introduced, t.id).toBeGreaterThanOrEqual(1930);
      expect(t.introduced, t.id).toBeLessThanOrEqual(2026);
      expect(t.capacity, t.id).toBeGreaterThan(0);
      expect(t.range, t.id).toBeGreaterThan(0);
      // Jets cruise faster than turboprops, which beat pistons.
      if (t.propulsion === 'jet') expect(t.speed, t.id).toBeGreaterThan(700);
      else expect(t.speed, t.id).toBeLessThan(700);
      expect(t.price, t.id).toBeGreaterThan(0);
      expect(t.costPerKm, t.id).toBeGreaterThan(0);
      expect(t.weeklyUpkeep, t.id).toBeGreaterThan(0);
    }
  });

  it('is ordered by price (the buy menu ladder)', () => {
    for (let i = 1; i < AIRCRAFT_TYPES.length; i++)
      expect(AIRCRAFT_TYPES[i].price).toBeGreaterThanOrEqual(AIRCRAFT_TYPES[i - 1].price);
  });

  it('maps every legacy id to a current type', () => {
    const ids = new Set(AIRCRAFT_TYPES.map((t) => t.id));
    for (const [oldId, newId] of Object.entries(LEGACY_TYPE_IDS)) {
      expect(ids.has(oldId), oldId).toBe(false);
      expect(ids.has(newId), newId).toBe(true);
    }
  });
});
