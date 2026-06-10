import { describe, expect, it } from 'vitest';
import { AIRPORTS, AIRCRAFT_TYPES } from './data';

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

  it('keeps every airport within North America / Caribbean bounds', () => {
    for (const a of AIRPORTS) {
      expect(a.lat, a.code).toBeGreaterThan(8);
      expect(a.lat, a.code).toBeLessThan(60);
      expect(a.lon, a.code).toBeGreaterThan(-130);
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
    for (const id of ['yyz', 'yvr', 'mex', 'cun', 'pty', 'sju', 'hav', 'bgi'])
      expect(ids.has(id), id).toBe(true);
  });
});

describe('aircraft data', () => {
  it('has unique ids', () => {
    const ids = AIRCRAFT_TYPES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
