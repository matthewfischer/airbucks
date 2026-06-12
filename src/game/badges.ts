import type { Airline, Continent, GameState } from './types';
import { CONTINENTS, continentOf } from './data';
import { currentYear, reputation, typeById, weeklyTotals } from './engine';

export type BadgeGroup = 'Exploration' | 'Network' | 'Fleet' | 'Milestones';

export interface BadgeDef {
  id: string;
  name: string;
  icon: string;
  group: BadgeGroup;
  /** How to earn it — shown as the locked hint and the earned subtitle. */
  hint: string;
  /** True once the airline has met the condition. */
  earned: (g: GameState, al: Airline) => boolean;
  /** Optional countable progress for the locked state (e.g. 18 / 25). */
  progress?: (g: GameState, al: Airline) => { have: number; need: number };
}

/** Continents the airline has reached (always includes its home continent). */
function reachedContinents(al: Airline): Set<Continent> {
  const s = new Set<Continent>();
  for (const id of al.rights) s.add(continentOf(id));
  return s;
}

/** How many routes pass through the single busiest airport. */
function busiestHub(al: Airline): number {
  const counts = new Map<string, number>();
  for (const r of al.routes)
    for (const id of new Set(r.stops))
      counts.set(id, (counts.get(id) ?? 0) + 1);
  return counts.size ? Math.max(...counts.values()) : 0;
}

/** Average age (years) of the fleet at the current date; 0 for an empty fleet. */
function avgFleetAge(g: GameState, al: Airline): number {
  if (!al.fleet.length) return 0;
  const year = currentYear(g);
  const total = al.fleet.reduce((s, p) => s + (year - typeById(g, p.typeId).introduced), 0);
  return total / al.fleet.length;
}

const reaches = (c: Continent) => (_g: GameState, al: Airline) => reachedContinents(al).has(c);
const network =
  (need: number): Pick<BadgeDef, 'earned' | 'progress'> => ({
    earned: (_g, al) => reputation(al) >= need,
    progress: (_g, al) => ({ have: reputation(al), need }),
  });
const fleetSize =
  (need: number): Pick<BadgeDef, 'earned' | 'progress'> => ({
    earned: (_g, al) => al.fleet.length >= need,
    progress: (_g, al) => ({ have: al.fleet.length, need }),
  });

export const BADGES: BadgeDef[] = [
  // ---- Exploration --------------------------------------------------------
  { id: 'reach-eu', name: 'Old World', icon: '🌍', group: 'Exploration',
    hint: 'Reach Europe', earned: reaches('Europe') },
  { id: 'reach-as', name: 'Far East', icon: '🏯', group: 'Exploration',
    hint: 'Reach Asia', earned: reaches('Asia') },
  { id: 'reach-af', name: 'Safari', icon: '🦁', group: 'Exploration',
    hint: 'Reach Africa', earned: reaches('Africa') },
  { id: 'reach-sa', name: 'Southern Cross', icon: '✨', group: 'Exploration',
    hint: 'Reach South America', earned: reaches('South America') },
  { id: 'reach-oc', name: 'Down Under', icon: '🦘', group: 'Exploration',
    hint: 'Reach Oceania', earned: reaches('Oceania') },
  { id: 'globetrotter', name: 'Globetrotter', icon: '🧭', group: 'Exploration',
    hint: 'Hold rights on all six continents',
    earned: (_g, al) => reachedContinents(al).size >= CONTINENTS.length,
    progress: (_g, al) => ({ have: reachedContinents(al).size, need: CONTINENTS.length }) },

  // ---- Network ------------------------------------------------------------
  { id: 'net-5', name: 'Taking Off', icon: '🛫', group: 'Network',
    hint: '5 airports', ...network(5) },
  { id: 'net-10', name: 'Regional', icon: '✈', group: 'Network',
    hint: '10 airports', ...network(10) },
  { id: 'net-25', name: 'National Carrier', icon: '🛩', group: 'Network',
    hint: '25 airports', ...network(25) },
  { id: 'net-50', name: 'Global Network', icon: '🌐', group: 'Network',
    hint: '50 airports', ...network(50) },
  { id: 'hub', name: 'Hub & Spoke', icon: '🕸', group: 'Network',
    hint: '6 routes through one airport',
    earned: (_g, al) => busiestHub(al) >= 6,
    progress: (_g, al) => ({ have: busiestHub(al), need: 6 }) },

  // ---- Fleet --------------------------------------------------------------
  { id: 'fleet-1', name: 'First Wings', icon: '🛬', group: 'Fleet',
    hint: 'Buy your first plane', ...fleetSize(1) },
  { id: 'fleet-10', name: 'Fleet of Ten', icon: '🛫', group: 'Fleet',
    hint: '10 aircraft', ...fleetSize(10) },
  { id: 'fleet-25', name: 'Big Iron', icon: '🛩', group: 'Fleet',
    hint: '25 aircraft', ...fleetSize(25) },
  { id: 'all-jet', name: 'Jet Age', icon: '🚀', group: 'Fleet',
    hint: 'An all-jet fleet of 5 or more',
    earned: (g, al) =>
      al.fleet.length >= 5 && al.fleet.every((p) => typeById(g, p.typeId).propulsion === 'jet') },
  { id: 'young-fleet', name: 'Cutting Edge', icon: '⚡', group: 'Fleet',
    hint: 'Average fleet age under 3 years',
    earned: (g, al) => al.fleet.length >= 3 && avgFleetAge(g, al) < 3 },

  // ---- Milestones ---------------------------------------------------------
  { id: 'in-the-black', name: 'In the Black', icon: '💰', group: 'Milestones',
    hint: 'Turn a weekly profit', earned: (g, al) => weeklyTotals(g, al).net > 0 },
  { id: 'debt-free', name: 'Debt Free', icon: '🏦', group: 'Milestones',
    hint: 'Clear all debt after borrowing',
    earned: (_g, al) => al.debt === 0 && al.history.some((h) => h.debt > 0) },
  { id: 'long-haul', name: 'The Long Haul', icon: '⏳', group: 'Milestones',
    hint: 'Fly for 20 years',
    earned: (g) => g.day >= 20 * 365,
    progress: (g) => ({ have: Math.floor(g.day / 365), need: 20 }) },
];

const BADGE_BY_ID = new Map(BADGES.map((b) => [b.id, b]));
export const badgeById = (id: string): BadgeDef | undefined => BADGE_BY_ID.get(id);
export const BADGE_IDS = new Set(BADGES.map((b) => b.id));

/**
 * Award any newly-earned badges, recording the day and logging each one.
 * Returns the ids awarded this call (empty if none). Idempotent: a badge is
 * only ever earned once.
 */
export function checkBadges(g: GameState, al: Airline): string[] {
  const have = new Set(al.badges.map((b) => b.id));
  const newly: string[] = [];
  for (const b of BADGES) {
    if (have.has(b.id) || !b.earned(g, al)) continue;
    al.badges.push({ id: b.id, day: g.day });
    al.log.unshift(`🏆 Badge earned: ${b.name} — ${b.hint}.`);
    newly.push(b.id);
  }
  return newly;
}
