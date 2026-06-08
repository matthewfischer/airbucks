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
  { id: 'lex', code: 'LEX', city: 'Lexington', lat: 38.04, lon: -84.61, size: 2 },
  { id: 'sdf', code: 'SDF', city: 'Louisville', lat: 38.17, lon: -85.74, size: 3 },
  { id: 'tys', code: 'TYS', city: 'Knoxville', lat: 35.81, lon: -83.99, size: 2 },
  { id: 'gso', code: 'GSO', city: 'Greensboro', lat: 36.1, lon: -79.94, size: 2 },
  { id: 'rdu', code: 'RDU', city: 'Raleigh-Durham', lat: 35.88, lon: -78.79, size: 4 },
  { id: 'orf', code: 'ORF', city: 'Norfolk', lat: 36.89, lon: -76.2, size: 2 },
  { id: 'bwi', code: 'BWI', city: 'Baltimore', lat: 39.18, lon: -76.67, size: 4 },
  { id: 'phl', code: 'PHL', city: 'Philadelphia', lat: 39.87, lon: -75.24, size: 5 },
  { id: 'ind', code: 'IND', city: 'Indianapolis', lat: 39.72, lon: -86.29, size: 4 },
  { id: 'dtw', code: 'DTW', city: 'Detroit', lat: 42.21, lon: -83.35, size: 4 },
  { id: 'bna', code: 'BNA', city: 'Nashville', lat: 36.13, lon: -86.68, size: 4 },
  { id: 'buf', code: 'BUF', city: 'Buffalo', lat: 42.94, lon: -78.73, size: 3 },
  { id: 'avl', code: 'AVL', city: 'Asheville', lat: 35.43, lon: -82.54, size: 2 },
  // National gateways — big out-of-region hubs the regional network feeds into.
  { id: 'bos', code: 'BOS', city: 'Boston', lat: 42.36, lon: -71.01, size: 5, national: true },
  { id: 'jfk', code: 'JFK', city: 'New York', lat: 40.64, lon: -73.78, size: 6, national: true },
  { id: 'atl', code: 'ATL', city: 'Atlanta', lat: 33.64, lon: -84.43, size: 6, national: true },
  { id: 'mia', code: 'MIA', city: 'Miami', lat: 25.79, lon: -80.29, size: 5, national: true },
  { id: 'ord', code: 'ORD', city: 'Chicago', lat: 41.98, lon: -87.9, size: 6, national: true },
  { id: 'den', code: 'DEN', city: 'Denver', lat: 39.86, lon: -104.67, size: 4, national: true },
  { id: 'lax', code: 'LAX', city: 'Los Angeles', lat: 33.94, lon: -118.41, size: 6, national: true },
  { id: 'dfw', code: 'DFW', city: 'Dallas', lat: 32.9, lon: -97.04, size: 5, national: true },
  { id: 'sfo', code: 'SFO', city: 'San Francisco', lat: 37.62, lon: -122.38, size: 6, national: true },
  { id: 'sea', code: 'SEA', city: 'Seattle', lat: 47.45, lon: -122.31, size: 5, national: true },
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
