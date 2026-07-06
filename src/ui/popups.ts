import type { Airline, TakeoverEvent } from '../game/types';
import { airportById, money, nearestHeldAirport } from '../game/engine';
import { distanceKm } from '../game/geo';
import { badgeById } from '../game/badges';
import { bus, game, me, spectating, ui } from './app';
import { monthYear } from './format';

// The pause-and-announce popups (slot granted / airline in distress / rival
// takeover / award earned). Each keeps a seen-set or drains an event queue so
// an event only pops once, and simultaneous events show one at a time: slots
// first, then distress, then takeovers, then badges.

// ---- "Landing rights granted" popup ----------------------------------------

/** Rights we've already announced — anything new triggers the slot-granted popup. */
let knownRights = new Set(me().rights);
/** Airports whose popups are waiting behind the one on screen. */
const slotQueue: string[] = [];

const slotGrantedEl = document.getElementById('slot-granted')!;
const slotPhotoEl = document.getElementById('slot-photo') as HTMLImageElement;
const slotCityEl = document.getElementById('slot-city')!;
const slotStatsEl = document.getElementById('slot-stats')!;
const slotCreditEl = document.getElementById('slot-credit')!;
/** Airport currently shown in the popup. */
let slotShownId: string | null = null;

// The photo (a public-domain vintage postcard bundled per city) only appears
// once it actually loads; cities without one just show the text card.
slotPhotoEl.addEventListener('load', () => {
  slotPhotoEl.classList.remove('hidden');
  slotCreditEl.classList.remove('hidden');
});
slotPhotoEl.addEventListener('error', () => {
  slotPhotoEl.classList.add('hidden');
  slotCreditEl.classList.add('hidden');
});

function showSlotGranted(airportId: string) {
  const ap = airportById(game, airportId);
  slotShownId = airportId;
  slotPhotoEl.classList.add('hidden');
  slotCreditEl.classList.add('hidden');
  slotPhotoEl.src = `/postcards/${ap.id}.jpg`;
  slotCityEl.textContent = `${ap.city} (${ap.code})`;
  const near = nearestHeldAirport(game, me(), ap);
  const parts = [
    `Market ${'★'.repeat(ap.size)}`,
    `${(ap.population / 1_000_000).toFixed(1)}M metro`,
  ];
  if (near) parts.push(`${Math.round(distanceKm(ap, near)).toLocaleString()} km from ${near.code}`);
  slotStatsEl.textContent = parts.join(' · ');
  slotGrantedEl.classList.remove('hidden');
}

/** Close the popup; if more grants are queued behind it, show the next one. */
function hideSlotGranted() {
  slotShownId = null;
  slotGrantedEl.classList.add('hidden');
  const next = slotQueue.shift();
  if (next) showSlotGranted(next);
  else pumpDistress(); // a distress listing may have been deferred behind this
}

/** Pause and pop up a card for any airport whose rights just arrived. */
export function announceNewRights() {
  const fresh = me().rights.filter((id) => !knownRights.has(id));
  knownRights = new Set(me().rights);
  if (spectating()) return; // watch-only: the AI won these; no popup
  if (!fresh.length) return;
  bus.setPlaying(false);
  if (slotShownId === null) showSlotGranted(fresh.shift()!);
  slotQueue.push(...fresh);
}

/** Mark all current rights as seen without announcing — for a bulk inheritance
 *  (buying a rival) that shouldn't fire a postcard per city. */
export function syncKnownRights() {
  knownRights = new Set(me().rights);
}

document.getElementById('slot-later')!.addEventListener('click', hideSlotGranted);
slotGrantedEl.addEventListener('click', (e) => {
  if (e.target === slotGrantedEl) hideSlotGranted();
});
document.getElementById('slot-plan')!.addEventListener('click', () => {
  const id = slotShownId;
  hideSlotGranted();
  if (!id) return;
  bus.setView('map');
  ui.selected = [id];
  bus.render();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !slotGrantedEl.classList.contains('hidden')) hideSlotGranted();
});

// ---- "Airline in distress" popup -------------------------------------------

/** AI airlines already announced as for-sale, so a listing only pops once. */
let knownForSale = new Set(game.airlines.filter((a) => a.forSale).map((a) => a.id));
/** Distressed airlines waiting behind the popup on screen. */
const distressQueue: string[] = [];

const distressEl = document.getElementById('distress')!;
const distressNameEl = document.getElementById('distress-name')!;
const distressStatsEl = document.getElementById('distress-stats')!;
/** Airline currently shown in the popup. */
let distressShownId: string | null = null;

function showDistress(al: Airline) {
  distressShownId = al.id;
  distressNameEl.textContent = al.name;
  const fs = al.forSale!;
  const debtNote = al.debt > 0 ? `, assumes ${money(al.debt)} debt` : '';
  distressStatsEl.textContent =
    `Up for sale at ${money(fs.price)}${debtNote} · ` +
    `liquidates ${monthYear(fs.deadlineDay)} if no buyer.`;
  distressEl.classList.remove('hidden');
}

/** Close the popup and show the next queued listing, if any. */
function hideDistress() {
  distressShownId = null;
  distressEl.classList.add('hidden');
  pumpDistress();
}

/** Show the next queued listing — unless a slot popup is up; defer to it. */
function pumpDistress() {
  if (distressShownId || slotShownId) return;
  let id = distressQueue.shift();
  // Skip any that were acquired or liquidated before we got to them.
  while (id && !game.airlines.some((a) => a.id === id && a.forSale)) {
    id = distressQueue.shift();
  }
  if (!id) {
    pumpTakeovers(); // nothing left to list — let a queued takeover through
    return;
  }
  bus.setPlaying(false);
  showDistress(game.airlines.find((a) => a.id === id)!);
}

/** Pause and pop up a card for any AI airline that just entered distress. */
export function announceDistress() {
  // Watch-only: don't interrupt an unattended sim; the Competitors panel and
  // news feed still surface failing rivals.
  if (spectating()) {
    for (const al of game.airlines) if (al.ai && al.forSale) knownForSale.add(al.id);
    return;
  }
  for (const al of game.airlines) {
    if (al.ai && al.forSale && !knownForSale.has(al.id)) {
      knownForSale.add(al.id);
      distressQueue.push(al.id);
    }
  }
  pumpDistress();
}

document.getElementById('distress-later')!.addEventListener('click', hideDistress);
distressEl.addEventListener('click', (e) => {
  if (e.target === distressEl) hideDistress();
});
document.getElementById('distress-view')!.addEventListener('click', () => {
  hideDistress();
  bus.setView('competitors');
});

// ---- "Rival takeover" popup -------------------------------------------------

/** Takeover deals waiting behind the popup on screen. */
const takeoverQueue: TakeoverEvent[] = [];

const takeoverEl = document.getElementById('takeover')!;
const takeoverNameEl = document.getElementById('takeover-name')!;
const takeoverStatsEl = document.getElementById('takeover-stats')!;
/** Whether the takeover popup is on screen. */
let takeoverShown = false;

function showTakeover(t: TakeoverEvent) {
  takeoverShown = true;
  takeoverNameEl.textContent = `${t.buyer} acquired ${t.target}`;
  const debtNote = t.debt > 0 ? ` · assumes ${money(t.debt)} debt` : '';
  takeoverStatsEl.innerHTML =
    `Deal: ${money(t.price)}${debtNote}<br>` +
    `Absorbed: ${t.cities} cities · ${t.planes} planes · ${t.routes} routes<br>` +
    `${t.buyer} now: ${t.newCities} cities · ${t.newPlanes} planes · ${t.newRoutes} routes`;
  takeoverEl.classList.remove('hidden');
}

/** Close the popup and show the next queued deal, if any. */
function hideTakeover() {
  takeoverShown = false;
  takeoverEl.classList.add('hidden');
  pumpTakeovers();
}

/** Show the next queued deal — unless a slot or distress popup is up; defer. */
function pumpTakeovers() {
  if (takeoverShown || slotShownId || distressShownId) return;
  const t = takeoverQueue.shift();
  if (!t) {
    pumpBadges(); // nothing left to announce — let any queued award through
    return;
  }
  bus.setPlaying(false);
  showTakeover(t);
}

/** Pause and pop up a card for any AI acquisition the engine queued. */
export function announceTakeovers() {
  const events = game.takeovers;
  if (!events?.length) return;
  game.takeovers = undefined; // drained — an event announces once
  // Watch-only: don't interrupt an unattended sim; the news feed covers it.
  if (spectating()) return;
  takeoverQueue.push(...events);
  pumpTakeovers();
}

document.getElementById('takeover-later')!.addEventListener('click', hideTakeover);
takeoverEl.addEventListener('click', (e) => {
  if (e.target === takeoverEl) hideTakeover();
});
document.getElementById('takeover-view')!.addEventListener('click', () => {
  hideTakeover();
  bus.setView('competitors');
});

// ---- "Award earned" popup --------------------------------------------------

/** Badges we've already celebrated — anything new triggers the award popup. */
let knownBadges = new Set(me().badges.map((b) => b.id));
/** Badge ids waiting behind the award popup on screen. */
const badgeQueue: string[] = [];

const badgeEarnedEl = document.getElementById('badge-earned')!;
const badgeIconEl = document.getElementById('badge-earned-icon')!;
const badgeNameEl = document.getElementById('badge-earned-name')!;
const badgeHintEl = document.getElementById('badge-earned-hint')!;
/** Badge currently shown in the popup. */
let badgeShownId: string | null = null;

function showBadgeEarned(id: string) {
  const b = badgeById(id);
  if (!b) return;
  badgeShownId = id;
  badgeIconEl.textContent = b.icon;
  badgeNameEl.textContent = b.name;
  badgeHintEl.textContent = b.hint;
  badgeEarnedEl.classList.remove('hidden');
}

/** Close the popup; if more awards are queued behind it, show the next one. */
function hideBadgeEarned() {
  badgeShownId = null;
  badgeEarnedEl.classList.add('hidden');
  pumpBadges();
}

/** Show the next queued award — unless a slot or distress popup is up; defer. */
function pumpBadges() {
  if (badgeShownId || slotShownId || distressShownId || takeoverShown) return;
  const id = badgeQueue.shift();
  if (!id) return;
  bus.setPlaying(false);
  showBadgeEarned(id);
}

/** Queue a card for any badge the player just earned, then show it. */
export function announceBadges() {
  // Watch-only: the AI earns these; don't pause the sim with a popup. Keep the
  // seen-set current so nothing floods if control ever returns.
  if (spectating()) {
    knownBadges = new Set(me().badges.map((b) => b.id));
    return;
  }
  for (const b of me().badges) {
    if (!knownBadges.has(b.id)) badgeQueue.push(b.id);
  }
  knownBadges = new Set(me().badges.map((b) => b.id));
  pumpBadges();
}

document.getElementById('badge-earned-later')!.addEventListener('click', hideBadgeEarned);
badgeEarnedEl.addEventListener('click', (e) => {
  if (e.target === badgeEarnedEl) hideBadgeEarned();
});
document.getElementById('badge-earned-view')!.addEventListener('click', () => {
  hideBadgeEarned();
  bus.setView('awards');
});

/** Reset every seen-set and queue to the (just-swapped) game state, and hide
 *  anything on screen. Called after a new game or a load. */
export function resetAnnouncements() {
  knownRights = new Set(me().rights);
  slotQueue.length = 0;
  slotShownId = null;
  slotGrantedEl.classList.add('hidden');
  knownForSale = new Set(game.airlines.filter((a) => a.forSale).map((a) => a.id));
  distressQueue.length = 0;
  distressShownId = null;
  distressEl.classList.add('hidden');
  takeoverQueue.length = 0;
  takeoverShown = false;
  takeoverEl.classList.add('hidden');
  knownBadges = new Set(me().badges.map((b) => b.id));
  badgeQueue.length = 0;
  badgeShownId = null;
  badgeEarnedEl.classList.add('hidden');
}
