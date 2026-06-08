import { describe, expect, it } from 'vitest';
import { distanceKm, project } from './geo';
import type { Airport } from './types';

const ap = (lat: number, lon: number): Airport => ({
  id: 'x',
  code: 'X',
  city: 'X',
  lat,
  lon,
  size: 1,
  population: 100_000,
});

describe('distanceKm', () => {
  it('is zero between a point and itself', () => {
    expect(distanceKm(ap(38, -81), ap(38, -81))).toBe(0);
  });

  it('is symmetric', () => {
    const a = ap(38.37, -81.59);
    const b = ap(35.21, -80.94);
    expect(distanceKm(a, b)).toBe(distanceKm(b, a));
  });

  it('matches a known great-circle distance (CRW→CLT ≈ 356 km)', () => {
    const d = distanceKm(ap(38.37, -81.59), ap(35.21, -80.94));
    expect(d).toBeGreaterThan(345);
    expect(d).toBeLessThan(365);
  });

  it('grows with separation', () => {
    const near = distanceKm(ap(38, -81), ap(39, -81));
    const far = distanceKm(ap(38, -81), ap(45, -81));
    expect(far).toBeGreaterThan(near);
  });
});

describe('project', () => {
  it('maps the pole/antimeridian corners to canvas corners', () => {
    expect(project(90, -180, 100, 50)).toEqual({ x: 0, y: 0 });
    expect(project(-90, 180, 100, 50)).toEqual({ x: 100, y: 50 });
  });

  it('places the equator/prime-meridian at the canvas center', () => {
    expect(project(0, 0, 100, 50)).toEqual({ x: 50, y: 25 });
  });
});
