import type { Airport } from '../game/types';
import {
  airportById,
  airportSlotsTotal,
  airportSlotsUsed,
  distanceFactor,
  firstSlotInstant,
  gateFee,
  holdsRights,
  isEasySlot,
  money,
  nearestHeldAirport,
  negotiationCapFor,
  negotiationDays,
  negotiationFor,
  pairDemand,
  reputation,
  requiredReputation,
  rightsAvailable,
  rightsFee,
  sellRefund,
  sellSlot,
  startNegotiation,
} from '../game/engine';
import { distanceKm } from '../game/geo';
import { bus, flash, game, pl, spectating, ui } from './app';
import { formatPop, monthYear } from './format';
import { announceNewRights } from './popups';

// The airport popover: info + acquire/sell-slot actions, floated over the map.

const mapWrap = document.getElementById('map-wrap')!;
const popover = document.createElement('div');
popover.id = 'airport-pop';
popover.style.display = 'none';
mapWrap.appendChild(popover);

/** Airport currently shown in the popover, if any. */
let popAirport: string | null = null;
let hidePopoverTimer: ReturnType<typeof setTimeout> | null = null;
let showPopoverTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Weekly O&D passenger pool this airport would exchange with the airports you
 * already serve — i.e. how much traffic acquiring it would feed your network.
 */
function networkDemand(ap: Airport): number {
  let total = 0;
  for (const other of game.airports) {
    if (other.id === ap.id || !holdsRights(pl(), other.id)) continue;
    total += pairDemand(ap, other) * distanceFactor(distanceKm(ap, other));
  }
  return total;
}

export function hideAirportPopover() {
  if (hidePopoverTimer) { clearTimeout(hidePopoverTimer); hidePopoverTimer = null; }
  if (showPopoverTimer) { clearTimeout(showPopoverTimer); showPopoverTimer = null; }
  popAirport = null;
  ui.lastHoveredAirport = null;
  popover.style.display = 'none';
}

/** Debounced hover from the map: open after a beat on an airport (so sweeping
 *  the mouse doesn't flash a popover per airport), linger briefly off one (so
 *  the user can move from the dot to the popover). */
export function hoverAirport(found: Airport | null, px: number, py: number) {
  if (showPopoverTimer) { clearTimeout(showPopoverTimer); showPopoverTimer = null; }
  if (found) {
    showPopoverTimer = setTimeout(() => {
      showPopoverTimer = null;
      showAirportInfo(found, px, py);
    }, 150);
  } else {
    hidePopoverTimer = setTimeout(() => { hideAirportPopover(); }, 120);
  }
}

/** Show airport info popover for any airport state (held, acquirable, locked). */
export function showAirportInfo(ap: Airport, px: number, py: number) {
  if (hidePopoverTimer) { clearTimeout(hidePopoverTimer); hidePopoverTimer = null; }
  if (showPopoverTimer) { clearTimeout(showPopoverTimer); showPopoverTimer = null; }
  popAirport = ap.id;
  const held = holdsRights(pl(), ap.id);
  const acquirable = !held && rightsAvailable(game, pl(), ap.id);
  const fee = rightsFee(game, ap);
  const afford = pl().cash >= fee;
  const demand = Math.round(networkDemand(ap));
  const tier = '●'.repeat(ap.size) + '○'.repeat(Math.max(0, 6 - ap.size));

  const slotsUsed = airportSlotsUsed(game, ap.id);
  const slotsTotal = airportSlotsTotal(ap);
  const slotsFull = slotsUsed >= slotsTotal;

  // Distance: from the measuring pin, else the route being built, else the
  // nearest held airport.
  let distRow = '';
  const pin =
    ui.measureFrom && ui.measureFrom !== ap.id ? airportById(game, ui.measureFrom) : null;
  const pathEnd = ui.selected.length
    ? airportById(game, ui.selected[ui.selected.length - 1])
    : null;
  if (pin) {
    distRow = `<div class="pop-row"><span class="muted">From ${pin.code} (pinned)</span><span>${distanceKm(pin, ap).toLocaleString()} km</span></div>`;
  } else if (pathEnd && pathEnd.id !== ap.id) {
    distRow = `<div class="pop-row"><span class="muted">From ${pathEnd.code} (path end)</span><span>${distanceKm(pathEnd, ap).toLocaleString()} km</span></div>`;
  } else if (!pathEnd) {
    const near = nearestHeldAirport(game, pl(), ap);
    if (near)
      distRow = `<div class="pop-row"><span class="muted">From ${near.code} (your nearest)</span><span>${distanceKm(near, ap).toLocaleString()} km</span></div>`;
  }

  const pending = negotiationFor(pl(), ap.id);
  const cap = negotiationCapFor(game, pl(), ap);
  const atCap = pl().negotiations.length >= cap;

  let extra = '';
  if (held) {
    const routesHere = pl().routes.filter((r) => r.stops.includes(ap.id)).length;
    const planesHere = pl().fleet.filter((p) => {
      const r = pl().routes.find((r) => r.id === p.routeId);
      return r?.stops.includes(ap.id);
    }).length;
    const isHome = ap.id === pl().homeId;
    const refund = sellRefund(game, ap);
    extra = `
      <div class="pop-row"><span class="muted">Your operation</span><span>${routesHere} route${routesHere !== 1 ? 's' : ''} · ${planesHere} plane${planesHere !== 1 ? 's' : ''}</span></div>
      ${isHome
        ? '<div class="pop-row"><span class="muted">Gate fee</span><span class="good">home — free</span></div>'
        : `<div class="pop-row"><span class="muted">Gate fee</span><span>${money(gateFee(game, ap))}/yr</span></div>`}
      ${isHome
        ? ''
        : routesHere > 0
          ? `<div class="tiny muted" style="margin-top:6px">Close its ${routesHere} route${routesHere !== 1 ? 's' : ''} to sell this slot.</div>`
          : `<button class="pop-buy" data-pop="sell">Sell slot · +${money(refund)}</button>`}`;
  } else if (pending) {
    extra = `<div class="pop-row"><span class="muted">Slot application</span><span class="good">opens ${monthYear(pending.opensDay)}</span></div>`;
  } else if (slotsFull) {
    extra = `<div class="tiny muted" style="margin-top:6px">No slots available (${slotsUsed}/${slotsTotal} taken)</div>`;
  } else if (acquirable) {
    const instant = firstSlotInstant(pl());
    const months = Math.round(negotiationDays(ap) / 30);
    const easy = isEasySlot(game, pl(), ap);
    const blocked = !afford || atCap;
    const label = !afford
      ? `Need ${money(fee)}`
      : atCap
        ? `Limit reached (${pl().negotiations.length}/${cap})`
        : instant
          ? `Acquire slot · ${money(fee)}`
          : `Apply for slot · ${money(fee)}`;
    const timing = instant
      ? `<span class="good">opens immediately (first slot)</span>`
      : `~${months} mo${easy ? ' · quick regional' : ''} · ${pl().negotiations.length}/${cap} open`;
    extra = `
      <div class="pop-row"><span class="muted">Slot fee</span><span class="${afford ? '' : 'bad'}">${money(fee)}</span></div>
      <div class="pop-row"><span class="muted">Negotiation</span><span>${timing}</span></div>
      <button class="pop-buy ${blocked ? '' : 'primary'}" data-pop="buy" ${blocked ? 'disabled' : ''}>${label}</button>`;
  } else {
    const need = requiredReputation(ap);
    extra = `<div class="tiny muted" style="margin-top:6px">Locked — needs a ${need}-airport network (you have ${reputation(pl())})</div>`;
  }

  popover.innerHTML = `
    <div class="pop-head">
      <span><strong>${ap.code}</strong> · ${ap.city}${held ? ' <span class="good">✓</span>' : ''}</span>
      <button class="pop-x" data-pop="close" title="Close">✕</button>
    </div>
    <div class="pop-row"><span class="muted">Population</span><span>${formatPop(ap.population)}</span></div>
    <div class="pop-row"><span class="muted">Market tier</span><span class="tier">${tier}</span></div>
    <div class="pop-row"><span class="muted">Airline slots</span><span class="${slotsFull && !held ? 'bad' : ''}">${slotsUsed} / ${slotsTotal}</span></div>
    ${distRow}
    <div class="pop-row"><span class="muted">Demand to your network</span><span>${demand.toLocaleString()}/wk</span></div>
    ${extra}
    <div class="tiny muted" style="margin-top:6px">⇧-click ${ui.measureFrom === ap.id ? 'to unpin' : 'to measure from here'}</div>`;

  popover.style.display = 'block';
  const wrapW = mapWrap.clientWidth;
  const wrapH = mapWrap.clientHeight;
  const pw = popover.offsetWidth;
  const ph = popover.offsetHeight;
  let x = px + 18;
  if (x + pw > wrapW - 8) x = px - 18 - pw;
  x = Math.max(8, Math.min(x, wrapW - pw - 8));
  let y = py - ph / 2;
  y = Math.max(8, Math.min(y, wrapH - ph - 8));
  popover.style.left = `${x}px`;
  popover.style.top = `${y}px`;
}

// Keep the popover alive while the mouse is over it (so the user can click Acquire).
popover.addEventListener('mouseenter', () => {
  if (hidePopoverTimer) { clearTimeout(hidePopoverTimer); hidePopoverTimer = null; }
});
popover.addEventListener('mouseleave', () => { hideAirportPopover(); });

popover.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('[data-pop]') as HTMLElement | null;
  if (!btn) return;
  if (btn.dataset.pop === 'close') {
    hideAirportPopover();
  } else if (spectating()) {
    return; // watch-only: the AI buys and sells its own slots
  } else if (btn.dataset.pop === 'buy' && popAirport) {
    flash(startNegotiation(game, pl(), popAirport));
    hideAirportPopover();
    bus.render();
    announceNewRights(); // the very first slot is granted instantly
  } else if (btn.dataset.pop === 'sell' && popAirport) {
    flash(sellSlot(game, pl(), popAirport));
    hideAirportPopover();
    bus.render();
  }
});
