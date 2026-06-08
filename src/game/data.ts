import type { Airport, AircraftType } from './types';

// A regional network centered on Charleston, WV (CRW), the player's home base.
export const AIRPORTS: Airport[] = [
  { id: 'crw', code: 'CRW', city: 'Charleston, WV', lat: 38.37, lon: -81.59, size: 1, home: true },
  { id: 'clt', code: 'CLT', city: 'Charlotte', lat: 35.21, lon: -80.94, size: 5 },
  { id: 'dca', code: 'DCA', city: 'Washington', lat: 38.85, lon: -77.04, size: 5 },
  { id: 'pit', code: 'PIT', city: 'Pittsburgh', lat: 40.49, lon: -80.23, size: 3 },
  { id: 'cle', code: 'CLE', city: 'Cleveland', lat: 41.41, lon: -81.85, size: 3 },
  { id: 'cvg', code: 'CVG', city: 'Cincinnati', lat: 39.05, lon: -84.67, size: 3 },
  { id: 'cmh', code: 'CMH', city: 'Columbus', lat: 40.0, lon: -82.89, size: 3 },
  { id: 'ric', code: 'RIC', city: 'Richmond', lat: 37.51, lon: -77.32, size: 2 },
  { id: 'roa', code: 'ROA', city: 'Roanoke', lat: 37.32, lon: -79.97, size: 1 },
];

// A right-sized regional fleet: short hops, modest seat counts.
export const AIRCRAFT_TYPES: AircraftType[] = [
  {
    id: 'turboprop',
    name: 'Dash 50 (Turboprop)',
    capacity: 50,
    range: 1500,
    speed: 540,
    price: 8_000_000,
    costPerKm: 4,
    weeklyUpkeep: 15_000,
  },
  {
    id: 'regionaljet',
    name: 'RegionJet 76',
    capacity: 76,
    range: 3500,
    speed: 800,
    price: 30_000_000,
    costPerKm: 6,
    weeklyUpkeep: 30_000,
  },
  {
    id: 'cityjet',
    name: 'CityJet 130',
    capacity: 130,
    range: 5000,
    speed: 830,
    price: 60_000_000,
    costPerKm: 8,
    weeklyUpkeep: 50_000,
  },
];

export const STARTING_CASH = 40_000_000;
