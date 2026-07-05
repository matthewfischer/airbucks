import { START_EPOCH } from '../game/engine';
import { game } from './app';

/** The current in-game date, e.g. "Aug 12, 1985". */
export function dateStr(): string {
  return new Date(START_EPOCH + game.day * 86_400_000).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/** Month + year label for an arbitrary simulated day, e.g. "Aug 1985". */
export function monthYear(day: number): string {
  return new Date(START_EPOCH + day * 86_400_000).toLocaleDateString('en-US', {
    month: 'short',
    year: 'numeric',
  });
}

export const formatPax = (n: number) =>
  n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n)}`;

export const formatPop = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}K`;

export const km = (n: number) => `${Math.round(n).toLocaleString()} km`;
