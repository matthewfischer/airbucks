import type { GameState } from '../game/types';
import { BADGES, type BadgeGroup } from '../game/badges';
import { player, START_EPOCH } from '../game/engine';

const GROUP_ORDER: BadgeGroup[] = ['Exploration', 'Network', 'Fleet', 'Milestones'];

const earnedDate = (day: number): string =>
  new Date(START_EPOCH + day * 86_400_000).toLocaleDateString('en-US', {
    month: 'short',
    year: 'numeric',
  });

/** Render the trophy case: earned badges with dates, locked ones with progress. */
export function renderAwards(g: GameState, el: HTMLElement): void {
  const al = player(g);
  const earned = new Map(al.badges.map((b) => [b.id, b.day]));
  const total = BADGES.length;

  const groups = GROUP_ORDER.map((group) => {
    const rows = BADGES.filter((b) => b.group === group)
      .map((b) => {
        const day = earned.get(b.id);
        if (day !== undefined) {
          return `<div class="badge-row earned">
            <span class="badge-icon">${b.icon}</span>
            <span class="badge-body"><strong>${b.name}</strong><span class="badge-hint">${b.hint}</span></span>
            <span class="badge-date good">${earnedDate(day)}</span>
          </div>`;
        }
        const p = b.progress?.(g, al);
        const right = p ? `${p.have} / ${p.need}` : 'locked';
        return `<div class="badge-row locked">
          <span class="badge-icon">🔒</span>
          <span class="badge-body"><strong>${b.name}</strong><span class="badge-hint">${b.hint}</span></span>
          <span class="badge-date muted">${right}</span>
        </div>`;
      })
      .join('');
    return `<section class="badge-group"><h3>${group}</h3>${rows}</section>`;
  }).join('');

  el.innerHTML = `
    <div class="awards-head">
      <h2>Awards</h2>
      <span class="awards-count">${earned.size} / ${total} earned</span>
    </div>
    ${groups}`;
}
