import './ui/styles.css';
import type { GameState } from './game/types';
import {
  advanceDay,
  assignPlane,
  borrow,
  buyPlane,
  declineAlliance,
  evaluateRoute,
  leaveAlliance,
  money,
  openRoute,
  proposeAlliance,
  recordFinanceSnapshot,
  repay,
  weeklyTotals,
} from './game/engine';
import { acceptAllianceFinanced, runAI } from './game/ai';
import { acquire, buyoutPrice } from './game/distress';
import {
  affordableForce,
  buyBack,
  buyShares,
  forceBuy,
  issueShares,
  sellShares,
  takeover,
  takeoverCost,
} from './game/shares';
import { applySave, deserialize, serialize } from './game/persist';
import { renderFinance } from './ui/finance';
import { renderCompetitors } from './ui/competitors';
import { renderAwards } from './ui/awards';
import { bus, flash, game, me, pl, spectating, ui, type View } from './ui/app';
import { dateStr } from './ui/format';
import {
  clearAnimations,
  drawMap,
  loadMap,
  resizeCanvas,
  screenOf,
  updateAnimations,
  zoomToAirport,
} from './ui/map';
import { renderLog, renderSidebar, resetSidebarState, sidebarEl } from './ui/sidebar';
import {
  announceBadges,
  announceDistress,
  announceNewRights,
  resetAnnouncements,
  syncKnownRights,
} from './ui/popups';
import { showHomeSelect, startGameAt } from './ui/setup';
import { checkDefeat, checkWin, resetEndgame } from './ui/endgame';

// main.ts is the wiring hub: the render root, the view tabs, the real-time
// clock, save/load, and the Competitors-tab actions. Everything drawn or
// popped up lives in the ui/ modules.

(window as unknown as { game: GameState }).game = game;
if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV) {
  (window as unknown as { dbg: unknown }).dbg = {
    game,
    openRoute: (...stops: string[]) => (openRoute(game, pl(), stops), render()),
    buyPlane: (t: string) => (buyPlane(game, pl(), t), render()),
    assignPlane: (p: string, r: string | null) => (assignPlane(game, pl(), p, r), render()),
    advanceDay: () => (advanceDay(game), runAI(game), render()),
    borrow: (n: number) => (borrow(game, pl(), n), render()),
    repay: (n: number) => (repay(game, pl(), n), render()),
    select: (...ids: string[]) => {
      ui.selected = ids;
      render();
    },
    screenOf,
    evaluate: (r: string) =>
      evaluateRoute(game, pl(), pl().routes.find((x) => x.id === r)!),
  };
}

const hud = document.getElementById('hud')!;
const playBtn = document.getElementById('play') as HTMLButtonElement;
const stageEl = document.getElementById('stage')!;
const financeEl = document.getElementById('finance')!;
const competitorsEl = document.getElementById('competitors')!;
const awardsEl = document.getElementById('awards')!;

// Real-time clock state.
let playing = false;
let speed = 1;
let lastTs = 0;
let dayAccumulator = 0;
const DAY_MS = 900;

// ---- Views + render root ----------------------------------------------------

let currentView: View = 'map';

function setView(view: View) {
  currentView = view;
  stageEl.classList.toggle('hidden', view !== 'map');
  financeEl.classList.toggle('hidden', view !== 'finance');
  competitorsEl.classList.toggle('hidden', view !== 'competitors');
  awardsEl.classList.toggle('hidden', view !== 'awards');
  document
    .querySelectorAll('#views-nav .view-tab')
    .forEach((b) => b.classList.toggle('active', (b as HTMLElement).dataset.view === view));
  if (view === 'finance') renderFinance(game, financeEl);
  else if (view === 'competitors') renderCompetitors(game, competitorsEl, ui.watchedId);
  else if (view === 'awards') renderAwards(game, awardsEl);
  else resizeCanvas(); // map was hidden (zero-size); re-fit now that it's visible
}

document.getElementById('views-nav')!.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('[data-view]') as HTMLElement | null;
  if (btn) setView(btn.dataset.view as View);
});

function render() {
  document.body.classList.toggle('spectating', spectating());
  renderHud();
  renderSidebar();
  renderLog();
  drawMap();
  if (currentView === 'finance') renderFinance(game, financeEl);
  else if (currentView === 'competitors') renderCompetitors(game, competitorsEl, ui.watchedId);
  else if (currentView === 'awards') renderAwards(game, awardsEl);
}

function renderHud() {
  const cashClass = pl().cash >= 0 ? 'good' : 'bad';
  const net = weeklyTotals(game, pl()).net;
  const netClass = net >= 0 ? 'good' : 'bad';
  hud.innerHTML = `
    <div class="stat"><span class="label">Date</span><span class="value">${dateStr()}</span></div>
    <div class="stat"><span class="label">Cash</span><span class="value ${cashClass}">${money(pl().cash)}</span></div>
    <div class="stat"><span class="label">Net / wk</span><span class="value ${netClass}">${net >= 0 ? '+' : ''}${money(net)}</span></div>
    <div class="stat"><span class="label">Debt</span><span class="value">${money(pl().debt)}</span></div>
    <div class="stat"><span class="label">Fleet</span><span class="value">${pl().fleet.length}</span></div>
    <div class="stat"><span class="label">Routes</span><span class="value">${pl().routes.length}</span></div>
    ${spectating() ? `<div class="stat spectate-badge"><span class="label">🤖 Watching</span><span class="value">${pl().name}</span></div>` : ''}
  `;
}

// ---- Competitors-tab actions --------------------------------------------------

// Buy a rival off the Competitors tab — distressed (fire-sale) or healthy
// (market price). The acquisition logs to the player's news feed; sync
// knownRights so the bulk of inherited cities doesn't fire a postcard per city.
competitorsEl.addEventListener('click', (e) => {
  // Watch-only: the AI runs its own acquisitions, so the only interaction here is
  // picking which airline the views follow. Click any card (yours included).
  if (spectating()) {
    const cardEl = (e.target as HTMLElement).closest('[data-act="show-airline"]') as HTMLElement | null;
    const al = cardEl && game.airlines.find((a) => a.id === cardEl.dataset.airline);
    if (al) {
      ui.watchedId = al.id;
      setView('map');
      zoomToAirport(al.homeId, 8);
      render();
    }
    return;
  }
  const actEl = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
  const act = actEl?.dataset.act;
  const findTarget = () => game.airlines.find((a) => a.id === actEl!.dataset.airline);

  // Fire-sale instant buyout of a distressed rival — allowed even mid-integration
  // (a time-limited rescue grab; only healthy takeovers wait out the cooldown).
  if (act === 'buy-airline') {
    const target = findTarget();
    if (!target || target === pl() || pl().cash < buyoutPrice(game, target)) return;
    acquire(game, pl(), target);
    syncKnownRights();
    render();
    return;
  }
  // Share-market moves on a rival.
  if (act === 'buy-shares' || act === 'sell-shares' || act === 'takeover') {
    const target = findTarget();
    if (!target || target === pl()) return;
    if (act === 'buy-shares') {
      buyShares(game, pl(), target, 10);
    } else if (act === 'sell-shares') {
      sellShares(game, pl(), target, 10);
    } else {
      const cost = takeoverCost(game, pl(), target);
      if (!confirm(`Take over ${target.name} for about ${money(cost)}? You'll reach control and absorb it.`)) return;
      if (pl().cash < cost) return;
      takeover(game, pl(), target);
      syncKnownRights();
    }
    render();
    return;
  }
  // Alliance moves. Propose/accept/decline/cancel target a rival; leave is self.
  if (act === 'leave-alliance') {
    leaveAlliance(game, pl());
    render();
    return;
  }
  if (
    act === 'propose-alliance' ||
    act === 'accept-alliance' ||
    act === 'decline-alliance' ||
    act === 'cancel-alliance'
  ) {
    const target = findTarget();
    if (!target || target === pl()) return;
    if (act === 'propose-alliance') proposeAlliance(game, pl(), target);
    else if (act === 'accept-alliance') {
      // Finances the AI proposer's half (you pay cash); surfaces any reason it
      // can't be done instead of failing silently.
      const err = acceptAllianceFinanced(game, target, pl());
      if (err) flash(err);
    } else if (act === 'decline-alliance') declineAlliance(game, target, pl());
    else declineAlliance(game, pl(), target); // cancel your own outgoing offer
    render();
    return;
  }
  // Issue / buy back your own shares.
  if (act === 'issue-shares') {
    issueShares(game, pl(), 10);
    render();
    return;
  }
  if (act === 'buy-back') {
    buyBack(game, pl(), 10);
    render();
    return;
  }
  // Defensive buyback: claw your own shares back from a controlling raider at the
  // control price (only as many as cash on hand covers).
  if (act === 'defend') {
    const { count } = affordableForce(game, pl(), pl(), 10);
    if (count > 0) forceBuy(game, pl(), pl(), count);
    render();
    return;
  }
  // Click anywhere else on a rival's card: jump to the map at their home.
  const cardEl = (e.target as HTMLElement).closest('[data-act="show-airline"]') as HTMLElement | null;
  if (!cardEl) return;
  const al = game.airlines.find((a) => a.id === cardEl.dataset.airline);
  if (!al) return;
  setView('map');
  zoomToAirport(al.homeId, 8); // pan and zoom in some, tighter than the default fit
});

// ---- Transport controls + real-time loop ----------------------------------

function setPlaying(v: boolean) {
  playing = v;
  lastTs = 0;
  playBtn.textContent = playing ? '⏸ Pause' : '▶ Play';
  playBtn.classList.toggle('paused', playing);
}

playBtn.addEventListener('click', () => setPlaying(!playing));

document.getElementById('speeds')!.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('[data-speed]') as HTMLElement | null;
  if (!btn) return;
  speed = Number(btn.dataset.speed);
  document
    .querySelectorAll('#speeds .speed')
    .forEach((b) => b.classList.toggle('active', b === btn));
});

// ---- New game / save / load -------------------------------------------------

const SAVE_KEY = 'airbucks-save';

/** Shared cleanup after the game state is swapped out (reset or load). */
function afterStateSwap() {
  game.humanControlled = true; // persists nothing — the app always drives airlines[0]
  ui.watchedId = me().id; // a fresh game/load always starts focused on you
  ui.selected = [];
  clearAnimations();
  setPlaying(false);
  dayAccumulator = 0;
  resetAnnouncements();
  resetSidebarState();
  resetEndgame();
}

/** Reset to a fresh airline — shows home airport selection first. */
function resetGame() {
  afterStateSwap();
  showHomeSelect();
}

function saveGame(announce = false) {
  try {
    localStorage.setItem(SAVE_KEY, serialize(game));
    if (announce) {
      pl().log.unshift('Game saved.');
      renderLog();
    }
  } catch {
    // localStorage unavailable / full — ignore.
  }
}

/** Load the last save into the live game. Returns false if there's nothing valid. */
function loadGame(): boolean {
  const json = localStorage.getItem(SAVE_KEY);
  if (!json) return false;
  const data = deserialize(json);
  if (!data) return false;
  applySave(game, data);
  afterStateSwap();
  return true;
}

document.getElementById('new-game')!.addEventListener('click', () => {
  if (confirm('Start a new game? This wipes your current airline.')) resetGame();
});

document.getElementById('save-game')!.addEventListener('click', () => saveGame(true));

document.getElementById('load-game')!.addEventListener('click', () => {
  if (loadGame()) {
    pl().log.unshift('Game loaded.');
    render();
  } else {
    flash('No saved game found.');
  }
});

// ---- Frame loop ---------------------------------------------------------------

function frame(ts: number) {
  const dt = lastTs ? ts - lastTs : 0;
  lastTs = ts;
  let sidebarDirty = false;
  if (playing) {
    dayAccumulator += (dt * speed) / DAY_MS;
    while (dayAccumulator >= 1) {
      dayAccumulator -= 1;
      advanceDay(game);
      runAI(game);
      sidebarDirty = true;
      if (game.day % 7 === 0) {
        if (!spectating()) recordFinanceSnapshot(game, me()); // runAI records the AI-run player itself
      }
      if (game.defeat) break; // game over — a rival bought us out
    }
    if (sidebarDirty) {
      announceNewRights();
      announceDistress();
      announceBadges();
    }
    updateAnimations(dt, speed);
  }
  checkWin();
  checkDefeat();
  renderHud();
  if (sidebarDirty) renderLog(); // news written during ticks (AI declines, openings, …)
  if (sidebarDirty && !sidebarEl.contains(document.activeElement)) renderSidebar();
  if (sidebarDirty && currentView === 'finance') renderFinance(game, financeEl);
  if (sidebarDirty && currentView === 'competitors') renderCompetitors(game, competitorsEl, ui.watchedId);
  if (sidebarDirty && currentView === 'awards') renderAwards(game, awardsEl);
  drawMap();
  requestAnimationFrame(frame);
}

// ---- Boot ----------------------------------------------------------------------

// Late-bind the orchestration hooks the ui/ modules call through.
bus.render = render;
bus.setView = setView;
bus.setPlaying = setPlaying;
bus.startGameAt = startGameAt;
bus.resetGame = resetGame;
bus.afterStateSwap = afterStateSwap;

// Persistence: resume the last session, autosave periodically, save on exit.
if (!loadGame()) showHomeSelect();
window.addEventListener('beforeunload', () => saveGame());
setInterval(() => saveGame(), 5000);

loadMap();
resizeCanvas();
render();
requestAnimationFrame(frame);
