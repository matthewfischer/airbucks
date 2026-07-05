import type { AircraftType, Route } from '../game/types';
import {
  airlineAssets,
  airportById,
  assignPlane,
  availableTypes,
  borrow,
  buyPlane,
  cashInterestWeekly,
  closeRoute,
  concurrentCap,
  creditLimit,
  currentYear,
  depositRate,
  evaluateNetwork,
  holdsRights,
  interestRate,
  MAX_ROUTE_LEGS,
  money,
  openRoute,
  planeResaleValue,
  planesOnRoute,
  priceLevel,
  regionalBonusAvailable,
  repay,
  reputation,
  requiredReputation,
  rightsAvailable,
  routeDistance,
  routeLabel,
  routeMaxLeg,
  sellPlane,
  setFareFactor,
  shortPlaneName,
  typeAvailable,
  typeById,
  upgradeRoute,
  upgradeRouteQuote,
} from '../game/engine';
import { distanceKm } from '../game/geo';
import { bus, flash, game, pl, spectating, ui } from './app';
import { monthYear } from './format';

// The action sidebar: New Route / Landing Rights / Buy Aircraft / Bank /
// Routes / Fleet cards, the news log, and the route-upgrade dialog.

export const sidebarEl = document.getElementById('sidebar')!;
const logEl = document.getElementById('log')!;

/** Aircraft type whose Buy button is mid "✓ Added" confirmation flash, if any. */
let justBoughtType: string | null = null;
let boughtTimer: ReturnType<typeof setTimeout> | null = null;

/** Drop transient button state (the "✓ Added" flash) — after a reset or load. */
export function resetSidebarState() {
  justBoughtType = null;
}

// Cards the player has collapsed. Persists across re-renders so a game tick
// doesn't pop a card back open.
const collapsedCards = new Set<string>();

// How the Routes card is sorted. null key = creation order (the default until
// the player clicks a header). Persists across re-renders.
type RouteSortKey = 'name' | 'profit' | 'load';
let routeSort: { key: RouteSortKey | null; dir: 'asc' | 'desc' } = { key: null, dir: 'desc' };

/** A titled card whose body collapses when its header is clicked. */
function collapsibleCard(id: string, title: string, body: string): string {
  const open = !collapsedCards.has(id);
  return `<div class="card">
    <h3 class="card-head" data-act="toggle-card" data-card="${id}">
      <span class="chev">${open ? '▾' : '▸'}</span>${title}</h3>
    ${open ? body : ''}</div>`;
}

export function renderSidebar() {
  sidebarEl.innerHTML =
    newRouteCard() + rightsCard() + buyCard() + bankCard() + routesCard() + fleetCard();
}

export function renderLog() {
  logEl.innerHTML = pl().log
    .slice(0, 20)
    .map((e) => `<div class="entry">${e}</div>`)
    .join('');
}

/** Distance of the staged path through the currently selected airports. */
function stagedDistance(): number {
  let d = 0;
  for (let i = 1; i < ui.selected.length; i++)
    d += distanceKm(airportById(game, ui.selected[i - 1]), airportById(game, ui.selected[i]));
  return d;
}

function newRouteCard(): string {
  const names = ui.selected.map((id) => airportById(game, id).code).join(' → ');
  let info: string;
  let canOpen = false;
  if (ui.selected.length >= 2) {
    const legs = ui.selected.length - 1;
    const more =
      legs >= MAX_ROUTE_LEGS
        ? `at the ${MAX_ROUTE_LEGS}-leg limit`
        : 'click more stops (you can revisit a hub)';
    info = `<div class="row"><strong>${names}</strong><span class="pill">${stagedDistance().toLocaleString()} km</span></div>
      <div class="tiny">${legs} leg${legs === 1 ? '' : 's'} · ${more}</div>`;
    canOpen = true;
  } else if (ui.selected.length === 1) {
    info = `<div class="muted">Start: <strong>${names}</strong>. Click the next stop.</div>`;
  } else {
    info =
      '<div class="muted">Click airports in order to chain stops — revisit an airport for hub-and-spoke. Brighter dots = more demand.</div>';
  }
  return `<div class="card"><h3>New Route</h3>${info}
    <div class="row" style="margin-top:10px; gap:8px">
      <button data-act="undo-sel" ${ui.selected.length ? '' : 'disabled'}>↶ Undo</button>
      <button data-act="clear-sel" ${ui.selected.length ? '' : 'disabled'}>Clear</button>
      <button class="primary" data-act="open-route" ${canOpen ? '' : 'disabled'}>Open Route</button>
    </div></div>`;
}

const PROPULSION_LABEL = { prop: 'Piston', turboprop: 'Turboprop', jet: 'Jet' };

function buyCard(): string {
  // Operating costs are quoted in current-era dollars, matching what the
  // finance and route panels actually charge.
  const lvl = priceLevel(game);
  const rows = game.aircraftTypes
    .filter((t) => typeAvailable(game, t))
    .map((t) => {
      const afford = pl().cash >= t.price;
      // Briefly confirm a just-bought type so the click visibly "lands".
      const justBought = t.id === justBoughtType;
      const label = justBought ? '✓ Added' : afford ? `Buy · ${money(t.price)}` : `Need ${money(t.price)}`;
      const cls = justBought ? 'primary bought' : afford ? 'primary' : '';
      const owned = pl().fleet.filter((p) => p.typeId === t.id).length;
      const perKm = (t.costPerKm * lvl).toFixed(1);
      const upkeep = money(Math.round(t.weeklyUpkeep * lvl));
      return `<div class="plane-line">
        <div class="row"><strong>${t.name}</strong>
          <button class="${cls}" data-act="buy" data-type="${t.id}" ${afford ? '' : 'disabled'}>${label}</button></div>
        <div class="type-stats">${PROPULSION_LABEL[t.propulsion]} · ${t.introduced} · ${t.capacity} seats · ${t.range.toLocaleString()} km range · ${t.speed} km/h · $${perKm}/km · ${upkeep}/wk upkeep · <span class="owned">${owned} owned</span></div>
      </div>`;
    })
    .join('');
  // Tease the next type to enter service so progression is visible.
  const year = currentYear(game);
  const upcoming = game.aircraftTypes
    .filter((t) => t.introduced > year)
    .sort((a, b) => a.introduced - b.introduced)[0];
  const teaser = upcoming
    ? `<div class="tiny muted" style="margin-top:10px">Coming in ${upcoming.introduced}: ${upcoming.name}</div>`
    : '';
  return collapsibleCard('buy', 'Buy Aircraft', rows + teaser);
}

function rightsCard(): string {
  const rep = reputation(pl());
  const notHeld = game.airports.filter((a) => !holdsRights(pl(), a.id));
  const available = notHeld.filter((a) => rightsAvailable(game, pl(), a.id));
  const locked = notHeld.filter((a) => !rightsAvailable(game, pl(), a.id));

  let next: string;
  if (available.length) {
    next = '';
  } else if (locked.length) {
    const a = [...locked].sort((x, y) => requiredReputation(x) - requiredReputation(y))[0];
    next = `<div class="tiny muted">Next unlock: <strong>${a.code}</strong> at a ${requiredReputation(a)}-airport network.</div>`;
  } else {
    next = `<div class="tiny good">You hold rights everywhere.</div>`;
  }

  const lockedNote = locked.length ? ` <span class="muted">· 🔒 ${locked.length} still locked.</span>` : '';
  const cap = concurrentCap(pl());
  const negs = pl().negotiations.length;
  const negRows = pl().negotiations
    .slice()
    .sort((a, b) => a.opensDay - b.opensDay)
    .map((n) => {
      const a = airportById(game, n.airportId);
      return `<div class="row"><span class="muted">${a.code}</span><span class="tiny good">opens ${monthYear(n.opensDay)}</span></div>`;
    })
    .join('');
  const negBlock = `
    <div class="row" style="margin-top:6px"><span class="muted">Negotiations</span><strong>${negs} in progress</strong></div>
    <div class="tiny muted">${cap} at a time${regionalBonusAvailable(pl()) ? ' (+1 for a quick regional slot)' : ''}</div>${negRows}`;
  const body = `
    <div class="row"><span class="muted">Network</span><strong>${rep} airport${rep === 1 ? '' : 's'}${lockedNote}</strong></div>
    ${negBlock}
    ${next}`;
  return collapsibleCard('rights', 'Landing Rights', body);
}

function bankCard(): string {
  const limit = creditLimit(game, pl());
  const credit = Math.max(0, limit - pl().debt);
  const rate = interestRate(game, pl());
  const weeklyInterest = pl().debt * rate * (7 / 365);
  const earnRate = depositRate(game);
  const weeklyEarned = cashInterestWeekly(game, pl());
  // Leverage vs. the 60% loan-to-value ceiling, so a maxed-out line is legible.
  const assets = airlineAssets(game, pl());
  const leverage = assets > 0 ? pl().debt / assets : 0;
  const maxedByLtv = credit === 0 && leverage >= 0.59;
  // Right-size the buttons so the label matches what actually happens.
  const borrowAmt = Math.min(5_000_000, credit);
  const repayAmt = Math.min(pl().cash < 5_000_000 ? 1_000_000 : 5_000_000, pl().debt, Math.max(0, pl().cash));
  return `<div class="card"><h3>Bank</h3>
    <div class="row"><span class="muted">Debt</span><strong>${money(pl().debt)}</strong></div>
    <div class="row"><span class="muted">Credit line</span><span>${money(credit)} of ${money(limit)}</span></div>
    <div class="row"><span class="muted">Leverage</span><span>${(leverage * 100).toFixed(0)}% of 60% max${maxedByLtv ? ' · <span class="bad">repay or grow assets to borrow</span>' : ''}</span></div>
    <div class="row"><span class="muted">Rate</span><span>${(rate * 100).toFixed(1)}%/yr · <span class="bad">-${money(weeklyInterest)}/wk</span></span></div>
    <div class="row"><span class="muted">Cash earns</span><span>${(earnRate * 100).toFixed(1)}%/yr · <span class="good">+${money(weeklyEarned)}/wk</span></span></div>
    <div class="row" style="margin-top:10px">
      <button data-act="borrow" data-amt="${borrowAmt}" ${credit > 0 ? '' : 'disabled'}>Borrow ${money(borrowAmt)}</button>
      <button data-act="repay" data-amt="${repayAmt}" ${pl().debt > 0 && pl().cash > 0 ? '' : 'disabled'}>Repay ${money(repayAmt)}</button>
    </div></div>`;
}

function routesCard(): string {
  if (pl().routes.length === 0)
    return collapsibleCard('routes', 'Routes', '<div class="muted">No routes yet.</div>');
  const net = evaluateNetwork(game, pl());
  const rows = sortedRoutes(net)
    .map((r) => {
      const dist = routeDistance(game, r);
      const res = net.routes.get(r.id)!;
      const n = planesOnRoute(pl(), r.id).length;
      const load = Math.round(res.loadFactor * 100);
      const loadCls = load >= 90 ? 'good' : load >= 75 ? 'warn' : 'bad';
      const cls = res.profit >= 0 ? 'good' : 'bad';
      const prem = Math.round((res.speedPremium - 1) * 100);
      const premTag =
        n > 0 && prem !== 0
          ? ` · <span class="${prem > 0 ? 'good' : 'bad'}">⚡${prem > 0 ? '+' : ''}${prem}% fare</span>`
          : '';
      return `<div class="route-line">
        <div class="row"><strong>${routeLabel(game, r)}</strong>
          <span class="row" style="gap:6px"><span class="pill ${cls}">${res.profit >= 0 ? '+' : ''}${money(res.profit)}/wk</span>
          <button class="close-x" data-act="close-route" data-route="${r.id}" title="Close route">✕</button></span></div>
        <div class="tiny">${dist.toLocaleString()} km · ${r.stops.length - 1} legs · ${n} plane${n === 1 ? '' : 's'}${n > 0 ? ` (${routePlanesLabel(r)})` : ''} · ${Math.round(res.passengers).toLocaleString()} pax/wk · <span class="${loadCls}">${load}% load</span>${premTag}${
          res.connectingPassengers >= 1
            ? ` · <span class="good">${Math.round(res.connectingPassengers).toLocaleString()} connecting</span>`
            : ''
        }</div>
        <div class="row" style="margin-top:6px">
          <span class="muted">Fare <input type="number" min="20" max="300" step="5" value="${Math.round(r.fareFactor * 100)}" data-act="fare" data-route="${r.id}">%</span>
          ${upgradeCandidates(r).length ? `<button class="upgrade-btn" data-act="open-upgrade" data-route="${r.id}">↑ Upgrade</button>` : ''}
        </div>
      </div>`;
    })
    .join('');
  return collapsibleCard('routes', `Routes (${pl().routes.length})`, routeSortBar() + rows);
}

/** Player routes ordered by the current sort (creation order until a header is clicked). */
function sortedRoutes(net: ReturnType<typeof evaluateNetwork>): Route[] {
  const routes = [...pl().routes];
  if (routeSort.key === null) return routes;
  const sign = routeSort.dir === 'asc' ? 1 : -1;
  const key = (r: Route): number | string => {
    const res = net.routes.get(r.id)!;
    if (routeSort.key === 'name') return routeLabel(game, r).toLowerCase();
    if (routeSort.key === 'load') return res.loadFactor;
    return res.profit; // 'profit'
  };
  return routes.sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (ka < kb) return -sign;
    if (ka > kb) return sign;
    return 0;
  });
}

/** Clickable sort headers for the Routes card. */
function routeSortBar(): string {
  const labels: Record<RouteSortKey, string> = { name: 'Name', profit: 'Profit', load: 'Load' };
  // "Created" reverts to the natural order routes were opened in (key === null).
  const createdActive = routeSort.key === null;
  const createdBtn = `<button class="sort-btn${createdActive ? ' active' : ''}" data-act="sort-routes" data-key="created" title="Original order, oldest first">Created</button>`;
  const btns = (['name', 'profit', 'load'] as RouteSortKey[])
    .map((k) => {
      const active = routeSort.key === k;
      const arrow = active ? (routeSort.dir === 'asc' ? ' ▴' : ' ▾') : '';
      return `<button class="sort-btn${active ? ' active' : ''}" data-act="sort-routes" data-key="${k}">${labels[k]}${arrow}</button>`;
    })
    .join('');
  return `<div class="route-sort tiny muted">Sort: ${createdBtn}${btns}</div>`;
}

/** What's flying a route: "DC-4" · "DC-4 ×2" · "DC-4, Viscount 800". */
function routePlanesLabel(r: Route): string {
  const counts = new Map<string, number>();
  for (const p of planesOnRoute(pl(), r.id)) {
    const name = shortPlaneName(typeById(game, p.typeId).name);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].map(([name, c]) => (c > 1 ? `${name} ×${c}` : name)).join(', ');
}

/** In-range types worth upgrading a route's fleet to — strictly pricier than what it flies. */
function upgradeCandidates(r: Route): AircraftType[] {
  const planes = planesOnRoute(pl(), r.id);
  if (planes.length === 0) return [];
  const longest = routeMaxLeg(game, r);
  const floor = Math.max(...planes.map((p) => typeById(game, p.typeId).price));
  return availableTypes(game).filter((t) => t.range >= longest && t.price > floor);
}

function fleetCard(): string {
  if (pl().fleet.length === 0)
    return collapsibleCard('fleet', 'Fleet', '<div class="muted">No aircraft. Buy one above.</div>');
  const rows = pl().fleet
    .map((plane) => {
      const t = typeById(game, plane.typeId);
      const options = [`<option value="">Hangar (idle)</option>`]
        .concat(
          pl().routes.map((r) => {
            const tooFar = t.range < routeMaxLeg(game, r);
            const sel = plane.routeId === r.id ? 'selected' : '';
            return `<option value="${r.id}" ${sel} ${tooFar ? 'disabled' : ''}>${routeLabel(game, r)}${tooFar ? ' (out of range)' : ''}</option>`;
          }),
        )
        .join('');
      const resale = planeResaleValue(game, plane);
      // Upgrade is a route-wide swap; surface it here on an assigned plane whose
      // route has a better type available, opening the same route-upgrade dialog.
      const route = plane.routeId ? pl().routes.find((r) => r.id === plane.routeId) : undefined;
      const canUpgrade = route && upgradeCandidates(route).length > 0;
      return `<div class="plane-line">
        <div class="row"><strong>${t.name.split(' (')[0]}</strong>
          <span class="row" style="gap:6px">${
            canUpgrade
              ? `<button class="upgrade-btn" data-act="open-upgrade" data-route="${route!.id}" title="Upgrade this route's fleet">↑ Upgrade</button>`
              : ''
          }<button class="close-x" data-act="sell-plane" data-plane="${plane.id}" title="Sell for ${money(resale)}">Sell ${money(resale)}</button></span></div>
        <select style="width:100%;margin-top:4px" data-act="assign" data-plane="${plane.id}">${options}</select>
      </div>`;
    })
    .join('');
  return collapsibleCard('fleet', `Fleet (${pl().fleet.length})`, rows);
}

// ---- Event delegation -------------------------------------------------------

sidebarEl.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
  if (!btn) return;
  // Watch-only: the AI owns the airline. Allow view-only acts, block moves.
  if (spectating() && btn.dataset.act !== 'toggle-card' && btn.dataset.act !== 'sort-routes') return;
  switch (btn.dataset.act) {
    case 'undo-sel':
      ui.selected = ui.selected.slice(0, -1);
      bus.render();
      break;
    case 'clear-sel':
      ui.selected = [];
      bus.render();
      break;
    case 'open-route': {
      const err = openRoute(game, pl(), ui.selected);
      if (err) flash(err);
      else {
        ui.selected = [];
        bus.render();
      }
      break;
    }
    case 'buy': {
      const err = buyPlane(game, pl(), btn.dataset.type!);
      if (err) {
        flash(err);
      } else {
        // Flash a "✓ Added" confirmation on the button, then revert.
        justBoughtType = btn.dataset.type!;
        if (boughtTimer) clearTimeout(boughtTimer);
        boughtTimer = setTimeout(() => {
          justBoughtType = null;
          renderSidebar();
        }, 850);
      }
      bus.render();
      break;
    }
    case 'borrow':
      borrow(game, pl(), Number(btn.dataset.amt));
      bus.render();
      break;
    case 'repay':
      repay(game, pl(), Number(btn.dataset.amt));
      bus.render();
      break;
    case 'toggle-card': {
      const id = btn.dataset.card!;
      if (collapsedCards.has(id)) collapsedCards.delete(id);
      else collapsedCards.add(id);
      renderSidebar();
      break;
    }
    case 'sort-routes': {
      const key = btn.dataset.key!;
      if (key === 'created') {
        // Revert to the original creation order (unsorted).
        routeSort = { key: null, dir: 'desc' };
      } else if (routeSort.key === key) {
        routeSort.dir = routeSort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        // Sensible default direction per key: A→Z for names, biggest-first for numbers.
        routeSort = { key: key as RouteSortKey, dir: key === 'name' ? 'asc' : 'desc' };
      }
      renderSidebar();
      break;
    }
    case 'close-route':
      closeRoute(game, pl(), btn.dataset.route!);
      bus.render();
      break;
    case 'sell-plane':
      flash(sellPlane(game, pl(), btn.dataset.plane!));
      bus.render();
      break;
    case 'open-upgrade':
      showUpgradeSelect(btn.dataset.route!);
      break;
  }
});

sidebarEl.addEventListener('change', (e) => {
  if (spectating()) return; // watch-only: the AI manages assignments and fares
  const el = e.target as HTMLElement;
  if (el.dataset.act === 'assign') {
    const sel = el as unknown as HTMLSelectElement;
    flash(assignPlane(game, pl(), el.dataset.plane!, sel.value || null));
    bus.render();
  } else if (el.dataset.act === 'fare') {
    const input = el as unknown as HTMLInputElement;
    setFareFactor(pl(), el.dataset.route!, Number(input.value) / 100);
    bus.render();
  }
});

// ---- Route-upgrade dialog -----------------------------------------------------

const upgradeSelectEl = document.getElementById('upgrade-select')!;
const upgradeTitleEl = document.getElementById('upgrade-title')!;
const upgradeSubEl = document.getElementById('upgrade-sub')!;
const upgradeListEl = document.getElementById('upgrade-list')!;

const hideUpgradeSelect = () => upgradeSelectEl.classList.add('hidden');

/** Popup (starter-airport style) to swap a route's whole fleet to a newer type. */
function showUpgradeSelect(routeId: string) {
  const r = pl().routes.find((x) => x.id === routeId);
  if (!r) return;
  const candidates = upgradeCandidates(r);
  if (candidates.length === 0) return;
  const planes = planesOnRoute(pl(), r.id);
  // Describe what's flying the route now, e.g. "2 × Dash 8 Q400".
  const counts = new Map<string, number>();
  for (const p of planes) counts.set(p.typeId, (counts.get(p.typeId) ?? 0) + 1);
  const current = [...counts]
    .map(([id, n]) => `${n} × ${typeById(game, id).name.split(' (')[0]}`)
    .join(', ');

  upgradeTitleEl.textContent = `↑ Upgrade fleet · ${routeLabel(game, r)}`;
  upgradeSubEl.textContent = `Flying ${current} now. Picking a type sells the current plane${planes.length === 1 ? '' : 's'} and buys replacements in place — the route stays covered.`;
  upgradeListEl.innerHTML = '';
  for (const t of candidates) {
    const q = upgradeRouteQuote(game, pl(), r.id, t.id);
    const afford = pl().cash >= q.net;
    const delta = `${q.net >= 0 ? '+' : '−'}${money(Math.abs(q.net))}`;
    const netCls = q.net < 0 ? 'good' : afford ? '' : 'bad';
    const btn = document.createElement('button');
    btn.className = 'upgrade-opt';
    btn.disabled = !afford;
    btn.innerHTML =
      `<div class="up-top"><span class="up-name">${t.name.split(' (')[0]}</span>` +
      `<span class="up-stats">${t.capacity} seats · ${t.range.toLocaleString()} km · ${t.speed} km/h</span></div>` +
      `<div class="up-bot"><span class="up-calc">buy ${money(q.buyCost)} − sell ${money(q.resale)}</span>` +
      `<span class="up-net ${netCls}">${afford ? delta : `need ${money(q.net)}`}</span></div>`;
    btn.addEventListener('click', () => {
      hideUpgradeSelect();
      flash(upgradeRoute(game, pl(), r.id, t.id));
      bus.render();
    });
    upgradeListEl.appendChild(btn);
  }
  upgradeSelectEl.classList.remove('hidden');
}

// Dismiss the upgrade popup: Cancel button, backdrop click, or Escape.
document.getElementById('upgrade-cancel')!.addEventListener('click', hideUpgradeSelect);
upgradeSelectEl.addEventListener('click', (e) => {
  if (e.target === upgradeSelectEl) hideUpgradeSelect();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideUpgradeSelect();
});
