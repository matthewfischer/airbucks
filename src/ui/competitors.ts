import type { Airline, GameState } from '../game/types';
import { airportById, equity, money, player, weeklyTotals } from '../game/engine';
import { buyoutPrice } from '../game/distress';

/** A vague health read — qualitative band + a 0..6 bar score. No exact books. */
function health(g: GameState, al: Airline): { label: string; score: number; cls: string } {
  if (al.forSale) return { label: 'For sale', score: 0, cls: 'bad' };
  const net = weeklyTotals(g, al).net;
  const eq = equity(g, al);
  if (eq <= 0 || net < 0) return { label: 'Struggling', score: 2, cls: 'warn' };
  // Return on equity tells thriving from merely stable, era-independently.
  const roe = (net * 52) / eq;
  return roe >= 0.15
    ? { label: 'Thriving', score: 6, cls: 'good' }
    : { label: 'Stable', score: 4, cls: 'good' };
}

/** Round to 2 significant figures, so a figure reads as an estimate not exact books. */
function approxMoney(n: number): string {
  if (n === 0) return money(0);
  const sign = n < 0 ? -1 : 1;
  const abs = Math.abs(n);
  const mag = 10 ** (Math.floor(Math.log10(abs)) - 1);
  return money(sign * Math.round(abs / mag) * mag);
}

/** Net-worth estimate + a profit/loss trend — substance without exact books.
 *  For your own card the books are exact, so skip the "~" estimate. */
function standingsBlock(g: GameState, al: Airline, you = false): string {
  const h = health(g, al);
  const net = weeklyTotals(g, al).net;
  const trend =
    net > 0
      ? '<span class="good">↗ profitable</span>'
      : net < 0
        ? '<span class="bad">↘ losing money</span>'
        : '<span class="muted">→ breaking even</span>';
  const worth = you ? money(equity(g, al)) : `~${approxMoney(equity(g, al))}`;
  return `<div class="comp-money">Net worth ${worth} · ${trend}</div>
    <div class="comp-health">
      <div class="health-bar"><div class="health-fill ${h.cls}" style="width:${(h.score / 6) * 100}%"></div></div>
      <span class="${h.cls}">${h.label}</span>
    </div>`;
}

/** Buy block on every card: price (fire-sale ask if distressed, else market),
 *  the debt you'd assume, and an inline Buy button. */
function buyBlock(g: GameState, al: Airline): string {
  const price = buyoutPrice(g, al);
  const afford = player(g).cash >= price;
  const priceLabel = al.forSale ? 'Asking' : 'Buy price';
  const debtRow = al.debt > 0
    ? `<div class="comp-sale-row"><span class="muted">You assume</span><span class="bad">${money(al.debt)} debt ⚠</span></div>`
    : '';
  return `<div class="comp-sale">
    <div class="comp-sale-row"><span class="muted">${priceLabel}</span><span>${money(price)}</span></div>
    ${debtRow}
    <button class="comp-buy ${afford ? 'primary' : ''}" data-act="buy-airline" data-airline="${al.id}" ${afford ? '' : 'disabled'}>
      ${afford ? `Buy · ${money(price)}` : `Need ${money(price)}`}
    </button>
  </div>`;
}

function card(g: GameState, al: Airline, you = false): string {
  const home = airportById(g, al.homeId);
  const cls = you ? ' you' : al.forSale ? ' for-sale' : '';
  const flag = you
    ? '<span class="comp-you-tag">You</span>'
    : al.forSale ? '<span class="comp-flag">⚠ FOR SALE</span>' : '';
  return `<div class="comp-card${cls}" data-act="show-airline" data-airline="${al.id}" title="Show ${home.city} on the map">
    <div class="comp-head">
      <span class="comp-dot" style="background:${al.color}"></span>
      <strong>${al.name}</strong>
      ${flag}
    </div>
    <div class="comp-home">${home.code} · ${home.city}</div>
    <div class="comp-stats">${al.rights.length} cities · ${al.routes.length} routes · ${al.fleet.length} planes</div>
    <div class="comp-sub">🏆 ${al.badges.length} award${al.badges.length === 1 ? '' : 's'}${
      al.negotiations.length
        ? ` · ✈ ${al.negotiations.length} in negotiation`
        : ''
    }</div>
    ${standingsBlock(g, al, you)}
    ${you ? '' : buyBlock(g, al)}
  </div>`;
}

/** Render the Competitors standings: a "you" strip plus a card per rival. */
export function renderCompetitors(g: GameState, el: HTMLElement): void {
  const you = player(g);
  const rivals = g.airlines.slice(1);
  const forSale = rivals.filter((a) => a.forSale).length;

  const head = `<div class="comp-head-row">
    <h2>Competitors</h2>
    <span class="muted">${rivals.length} rival${rivals.length === 1 ? '' : 's'}${forSale ? ` · ${forSale} for sale` : ''}</span>
  </div>`;

  if (rivals.length === 0) {
    el.innerHTML = `${head}<div class="comp-grid">${card(g, you, true)}</div>
      <div class="fin-empty">A solo game — no competitors. Start a new game and add rivals on the setup screen.</div>`;
    return;
  }

  // Your card pinned first, then rivals ranked by network reach (cities).
  const cards =
    card(g, you, true) +
    [...rivals]
      .sort((a, b) => b.rights.length - a.rights.length)
      .map((al) => card(g, al))
      .join('');

  el.innerHTML = `${head}<div class="comp-grid">${cards}</div>`;
}
