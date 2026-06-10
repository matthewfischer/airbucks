import { describe, expect, it } from 'vitest';
import { AIRPORTS, AIRCRAFT_TYPES, LEGACY_TYPE_IDS } from './data';

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

  it('keeps every airport within North America / Caribbean / Pacific bounds', () => {
    for (const a of AIRPORTS) {
      expect(a.lat, a.code).toBeGreaterThan(8);
      expect(a.lat, a.code).toBeLessThan(70);
      expect(a.lon, a.code).toBeGreaterThan(-165);
      expect(a.lon, a.code).toBeLessThan(-55);
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
