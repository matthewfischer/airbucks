import type { GameState } from '../game/types';
import { BADGES, type BadgeGroup } from '../game/badges';
import { player, START_EPOCH } from '../game/engine';

const GROUP_ORDER: BadgeGroup[] = ['Exploration', 'Network', 'Fleet', 'Rivalry', 'Milestones'];

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
    const cards = BADGES.filter((b) => b.group === group)
      .map((b) => {
        const day = earned.get(b.id);
        if (day !== undefined) {
          return `<div class="badge-card earned">
            <span class="badge-icon">${b.icon}</span>
            <strong class="badge-name">${b.name}</strong>
            <span class="badge-hint">${b.hint}</span>
            <span class="badge-tag good">${earnedDate(day)}</span>
          </div>`;
        }
        const p = b.progress?.(g, al);
        const tag = p ? `${p.have} / ${p.need}` : 'Locked';
        return `<div class="badge-card locked">
          <span class="badge-icon">${b.icon}</span>
          <strong class="badge-name">${b.name}</strong>
          <span class="badge-hint">${b.hint}</span>
          <span class="badge-tag muted">${tag}</span>
        </div>`;
      })
      .join('');
    return `<section class="badge-group"><h3>${group}</h3><div class="badge-grid">${cards}</div></section>`;
  }).join('');

  el.innerHTML = `
    <div class="awards-head">
      <h2>Awards</h2>
      <span class="awards-count">${earned.size} / ${total} earned</span>
    </div>
    ${groups}`;
}
