export interface Airport {
  id: string;
  /** IATA-style code shown on the map */
  code: string;
  city: string;
  lat: number;
  lon: number;
  /** Relative market size, 1 (small) .. 5 (huge). Drives passenger demand. */
  size: number;
  /** Metro-area population (people). Shown as context; demand is driven by size. */
  population: number;
}

export type Propulsion = 'prop' | 'turboprop' | 'jet';

export interface AircraftType {
  id: string;
  name: string;
  propulsion: Propulsion;
  /** Year the type entered service. */
  introduced: number;
  /** Seats per flight. */
  capacity: number;
  /** Maximum non-stop distance in km. */
  range: number;
  /** Cruise speed in km/h, used to figure how many trips fit in a week. */
  speed: number;
  /** Purchase price in dollars. */
  price: number;
  /** Direct operating cost per km flown (fuel, crew, fees). */
  costPerKm: number;
  /** Fixed weekly upkeep regardless of flying (maintenance, parking). */
  weeklyUpkeep: number;
}

export interface Plane {
  id: string;
  typeId: string;
  /** Route this plane is assigned to, or null if idle in the hangar. */
  routeId: string | null;
  /** Total km flown over the plane's lifetime — drives resale depreciation. */
  kmFlown: number;
}

export interface Route {
  id: string;
  /** Ordered airport ids (length ≥ 2). The plane flies the path out and back. */
  stops: string[];
  /** Fare level as a multiple of each leg's distance-based reference fare. */
  fareFactor: number;
}

/** A weekly financial snapshot, recorded over the life of the airline. */
export interface FinanceSnapshot {
  /** Simulated day this snapshot was taken (week = day / 7). */
  day: number;
  cash: number;
  debt: number;
  /** Depreciated book value of the whole fleet at the time. */
  fleetValue: number;
  /** Weekly run-rate figures captured at this point. */
  revenue: number;
  cost: number;
  interest: number;
  interestEarned: number;
  net: number;
  pax: number;
}

export type Continent =
  | 'North America'
  | 'Europe'
  | 'Asia'
  | 'Africa'
  | 'South America'
  | 'Oceania';

/** A badge the airline has earned, with the day it was awarded. */
export interface EarnedBadge {
  id: string;
  day: number;
}

/** A slot application in progress: a fee is paid up front, rights land on `opensDay`. */
export interface Negotiation {
  airportId: string;
  /** Day the slot opens and the airport moves into `rights`. */
  opensDay: number;
  /** Fee already paid when the application was filed. */
  fee: number;
}

/** Brain state for a computer-controlled airline. Absent on the player. */
export interface AiState {
  /** Personality id (see PERSONALITIES in ai.ts) — fixed at creation. */
  personality: string;
  /** Next simulated day this airline will take a decision pass. */
  nextDecisionDay: number;
}

/** A distressed airline listed for sale: buyable until the deadline, then liquidated. */
export interface ForSale {
  /** Day the airline was listed. */
  listedDay: number;
  /** Day it liquidates if still unsold. */
  deadlineDay: number;
  /** Sticker price to acquire it (the buyer also assumes its debt). */
  price: number;
}

/** One carrier — the player or a computer opponent. */
export interface Airline {
  id: string;
  name: string;
  /** Map color for this airline's routes and planes. */
  color: string;
  /** AI brain; the player airline has none. */
  ai?: AiState;
  cash: number;
  /** Outstanding loan principal. */
  debt: number;
  /** IATA id of the airline's home airport. */
  homeId: string;
  /** Airport ids where the airline holds landing rights (can operate). */
  rights: string[];
  /** Slot applications in progress, not yet granted. */
  negotiations: Negotiation[];
  /** Badges earned, oldest-first. */
  badges: EarnedBadge[];
  fleet: Plane[];
  routes: Route[];
  /** Newest-first list of human-readable events. */
  log: string[];
  /** Oldest-first weekly financial snapshots, for the finance page. */
  history: FinanceSnapshot[];
  /** Day cash first went negative in the current streak (distress tracking). */
  cashNegSince?: number;
  /** Day equity first went negative in the current streak. */
  equityNegSince?: number;
  /** Distress listing, when the airline is up for sale. */
  forSale?: ForSale;
  /** Rival airlines absorbed via acquisition (for the Takeover badge). */
  acquisitions?: number;
  /** Cap table: ownerId → share count out of 100. Owners are this airline's own
   *  id (retained), `'public'` (the open float), or another airline's id (a
   *  strategic stake). Absent ⇒ 100% self-held. See shares.ts. */
  shares?: Record<string, number>;
}

export interface GameState {
  /** Simulated days elapsed since the start date. */
  day: number;
  /** Deterministic RNG state (mulberry32) — advanced by rand(), persisted. */
  rngState: number;
  /** Next plane/route id to mint — per-game so identical seeds replay identically. */
  nextId: number;
  airports: Airport[];
  aircraftTypes: AircraftType[];
  /** All carriers. The player is always airlines[0]. */
  airlines: Airline[];
}
