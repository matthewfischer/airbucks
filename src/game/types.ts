export interface Airport {
  id: string;
  /** IATA-style code shown on the map */
  code: string;
  city: string;
  lat: number;
  lon: number;
  /** Relative market size, 1 (small) .. 5 (huge). Drives passenger demand. */
  size: number;
  /** True for the player's home base. */
  home?: boolean;
  /** True for big out-of-region national hubs (drawn as edge "gateways"). */
  national?: boolean;
}

export interface AircraftType {
  id: string;
  name: string;
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
}

export interface Route {
  id: string;
  /** Ordered airport ids (length ≥ 2). The plane flies the path out and back. */
  stops: string[];
  /** Fare level as a multiple of each leg's distance-based reference fare. */
  fareFactor: number;
}

export interface GameState {
  /** Simulated days elapsed since the start date. */
  day: number;
  cash: number;
  /** Outstanding loan principal. */
  debt: number;
  airports: Airport[];
  aircraftTypes: AircraftType[];
  fleet: Plane[];
  routes: Route[];
  /** Newest-first list of human-readable events. */
  log: string[];
}
