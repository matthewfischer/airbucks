import type { Airline, GameState } from '../game/types';
import { airportById, equity, money, player, weeklyTotals } from '../game/engine';
import { buyoutPrice } from '../game/distress';
import {
  acquireCooldownLeft,
  affordableForce,
  canAcquire,
  controlCost,
  costToAccumulate,
  hasControl,
  largestRivalStake,
  publicFloat,
  retainedShares,
  sharePriceBase,
  sharesOwned,
  takeoverCost,
} from '../game/shares';

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

/** Ordinal rank label: 1 -> "1st", 2 -> "2nd", 11 -> "11th", 23 -> "23rd". */
export function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  const suffix = ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
  return `${n}${suffix}`;
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

/** Block size for share trades (each share = 1% of the airline). */
const BLOCK = 10;

/** Fire-sale block for a distressed rival: instant buyout at the cheap sticker. */
function fireSaleBlock(g: GameState, al: Airline): string {
  const price = buyoutPrice(g, al);
  // A fire-sale is buyable even mid-integration — a time-limited rescue grab.
  const afford = player(g).cash >= price;
  const debtRow = al.debt > 0
    ? `<div class="comp-sale-row"><span class="muted">You assume</span><span class="bad">${money(al.debt)} debt ⚠</span></div>`
    : '';
  const label = afford ? `Buy · ${money(price)}` : `Need ${money(price)}`;
  return `<div class="comp-sale">
    <div class="comp-sale-row"><span class="muted">Asking</span><span>${money(price)}</span></div>
    ${debtRow}
    <button class="comp-buy ${afford ? 'primary' : ''}" data-act="buy-airline" data-airline="${al.id}" ${afford ? '' : 'disabled'}>
      ${label}
    </button>
  </div>`;
}

/** Share-market block on a healthy rival: your stake, the float, and buy / sell /
 *  take-over controls priced on its growth-aware valuation. */
function shareBlock(g: GameState, al: Airline): string {
  const you = player(g);
  const owned = sharesOwned(al, you.id);
  const float = publicFloat(al);
  const perShare = Math.round(sharePriceBase(g, al));
  const control = hasControl(al, you.id);

  const stakeRow = `<div class="comp-sale-row"><span class="muted">Your stake</span>
    <span>${owned}% · ${money(owned * perShare)}</span></div>`;
  const floatRow = `<div class="comp-sale-row"><span class="muted">Float · price</span>
    <span>${float}% open · ${money(perShare)}/%</span></div>`;

  // Buy from the open float (clamped to what's available).
  const buyN = Math.min(BLOCK, float);
  const buyCost = buyN > 0 ? costToAccumulate(g, al, owned, buyN) : 0;
  const canBuy = buyN > 0 && you.cash >= buyCost;
  const buyBtn = `<button class="comp-share-btn ${canBuy ? 'primary' : ''}" data-act="buy-shares" data-airline="${al.id}" ${canBuy ? '' : 'disabled'}>
    ${float === 0 ? 'No float' : `Buy ${buyN}% · ${money(buyCost)}`}</button>`;

  // Sell your stake back to the float.
  const sellBtn = owned > 0
    ? `<button class="comp-share-btn" data-act="sell-shares" data-airline="${al.id}">Sell ${Math.min(BLOCK, owned)}%</button>`
    : '';

  // Hostile takeover: reach control (forcing retained shares), then squeeze out.
  // Blocked while still digesting a recent acquisition (integration cooldown).
  const cooling = !canAcquire(g, you);
  const overCost = control ? controlCost(g, you, al) : takeoverCost(g, you, al);
  const overReady = you.cash >= overCost && !cooling;
  const overLabel = cooling
    ? `Integrating · ${Math.ceil(acquireCooldownLeft(g, you) / 30)}mo`
    : `${control ? 'Squeeze out' : 'Take over'} · ${money(overCost)}`;
  const overBtn = `<button class="comp-share-btn ${overReady ? 'danger' : ''}" data-act="takeover" data-airline="${al.id}" ${overReady ? '' : 'disabled'} title="Reach >50% then absorb ${al.name}">
    ${overLabel}</button>`;

  // Progress toward control.
  const pct = Math.min(100, Math.round((owned / 51) * 100));
  const progress = `<div class="comp-share-progress" title="${owned}% of the 51% needed for control">
    <div class="comp-share-fill" style="width:${pct}%"></div></div>`;

  return `<div class="comp-sale">
    ${stakeRow}${floatRow}${progress}
    <div class="comp-share-row">${buyBtn}${sellBtn}${overBtn}</div>
  </div>`;
}

/** Your own card's share status: founder stake, issued float, raid warning, and
 *  issue / buy-back controls. */
function selfShareBlock(g: GameState): string {
  const al = player(g);
  const retained = retainedShares(al);
  const float = publicFloat(al);
  const perShare = Math.round(sharePriceBase(g, al));

  const rival = largestRivalStake(al);
  const rivalName = rival ? g.airlines.find((a) => a.id === rival.ownerId)?.name ?? 'A rival' : '';
  const raidRow = rival
    ? `<div class="comp-sale-row"><span class="bad">⚠ ${rivalName}</span><span class="bad">holds ${rival.shares}% of you</span></div>`
    : '';

  // Reclaim shares a rival holds via a forced tender at the control price —
  // available whenever a rival holds any of your stock (held shares can't be
  // bought off the open float). It reads as "defense" during a live >50% siege
  // and a plain (pricey) buy-back otherwise.
  let siegeRow = '';
  let forceBtn = '';
  if (rival) {
    if (g.raid) {
      const raider = g.airlines.find((a) => a.id === g.raid!.raiderId);
      const daysLeft = Math.max(0, g.raid.deadlineDay - g.day);
      siegeRow = `<div class="comp-sale-row"><span class="bad">🏴 ${
        raider?.name ?? 'A rival'
      } controls you</span><span class="bad">${Math.ceil(daysLeft / 30)}mo to defend</span></div>`;
    }
    const def = affordableForce(g, al, al, BLOCK);
    const label = g.raid ? 'Defend' : 'Buy back held';
    const title = g.raid
      ? 'Buy your shares back from the raider to break their control'
      : `Force ${rivalName} to sell shares back at a premium`;
    forceBtn = def.count > 0
      ? `<button class="comp-share-btn primary" data-act="defend" title="${title}">
          ${label} ${def.count}% · ${money(def.cost)}</button>`
      : `<button class="comp-share-btn" disabled>Can't afford ${g.raid ? 'defense' : 'buyback'}</button>`;
  }

  const issueN = Math.min(BLOCK, retained - 1); // keep at least 1% so you still exist
  const issueBtn = issueN > 0
    ? `<button class="comp-share-btn" data-act="issue-shares" title="Sell ${issueN}% of yourself to the public for cash">
        Issue ${issueN}% · +${money(issueN * perShare)}</button>`
    : '';

  const backN = Math.min(BLOCK, float);
  const backCost = backN > 0 ? costToAccumulate(g, al, retained, backN) : 0;
  const canBack = backN > 0 && al.cash >= backCost;
  const backBtn = float > 0
    ? `<button class="comp-share-btn ${canBack ? 'primary' : ''}" data-act="buy-back" ${canBack ? '' : 'disabled'} title="Repurchase float to re-secure your majority">
        Buy back ${backN}% · ${money(backCost)}</button>`
    : '';

  if (!issueBtn && !backBtn && !rival) return '';
  return `<div class="comp-sale">
    <div class="comp-sale-row"><span class="muted">You hold</span><span>${retained}%${float ? ` · ${float}% floated` : ''}</span></div>
    ${raidRow}${siegeRow}
    <div class="comp-share-row">${forceBtn}${issueBtn}${backBtn}</div>
  </div>`;
}

function card(g: GameState, al: Airline, rank: number, you = false, watching = false): string {
  const home = airportById(g, al.homeId);
  const cls = (you ? ' you' : al.forSale ? ' for-sale' : '') + (watching ? ' watching' : '');
  const flag = watching
    ? '<span class="comp-watch-tag">👁 Watching</span>'
    : you
    ? '<span class="comp-you-tag">You</span>'
    : al.forSale ? '<span class="comp-flag">⚠ FOR SALE</span>' : '';
  const rankCls = rank === 1 ? ' first' : '';
  const action = you ? selfShareBlock(g) : al.forSale ? fireSaleBlock(g, al) : shareBlock(g, al);
  return `<div class="comp-card${cls}" data-act="show-airline" data-airline="${al.id}" title="Show ${home.city} on the map">
    <div class="comp-head">
      <span class="comp-rank${rankCls}">${ordinal(rank)}</span>
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
    ${action}
  </div>`;
}

/** Render the Competitors standings: a "you" strip plus a card per rival. */
export function renderCompetitors(g: GameState, el: HTMLElement, watchedId?: string): void {
  const you = player(g);
  const rivals = g.airlines.slice(1);
  const forSale = rivals.filter((a) => a.forSale).length;
  // In a watch-only sim, every card is a "follow this airline" target.
  const spectating = !!you.ai;
  const watchHint = spectating
    ? '<span class="muted">watch-only · click a card to follow that airline</span>'
    : `<span class="muted">${rivals.length} rival${rivals.length === 1 ? '' : 's'}${forSale ? ` · ${forSale} for sale` : ''}</span>`;

  const head = `<div class="comp-head-row">
    <h2>Competitors</h2>
    ${watchHint}
  </div>`;

  if (rivals.length === 0) {
    el.innerHTML = `${head}<div class="comp-grid">${card(g, you, 1, true, spectating && you.id === watchedId)}</div>
      <div class="fin-empty">A solo game — no competitors. Start a new game and add rivals on the setup screen.</div>`;
    return;
  }

  // Every airline, the player included, ranked by net worth (highest first).
  const cards = [...g.airlines]
    .sort((a, b) => equity(g, b) - equity(g, a))
    .map((al, i) => card(g, al, i + 1, al === you, spectating && al.id === watchedId))
    .join('');

  el.innerHTML = `${head}<div class="comp-grid">${cards}</div>`;
}
