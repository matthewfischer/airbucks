import { DEFAULT_FLOAT, money, newGame, startingCash } from '../game/engine';
import { addAiAirlines, makeAiControlled, MAX_AI_AIRLINES } from '../game/ai';
import { bus, game, pl, ui } from './app';
import { clearMapCursor, resetView, zoomToAirport } from './map';
import { hideAirportPopover } from './popover';
import { sidebarEl } from './sidebar';

// The launch screen: Play/Watch mode, rival count, launch float, and the
// pick-your-home-airport flow that starts a fresh game.

const homeSelectEl = document.getElementById('home-select')!;
const aiCountEl = document.getElementById('ai-count')!;
const modePlayBtn = document.getElementById('mode-play')!;
const modeWatchBtn = document.getElementById('mode-watch')!;
const homeTitleEl = homeSelectEl.querySelector('.home-title')!;

/** Whether the next new game starts as a watch-only sim. Session-remembered. */
let spectate = false;
/** Reflect Play/Watch mode: swap the title and hide the player-only Float row. */
function applySetupMode() {
  modePlayBtn.classList.toggle('active', !spectate);
  modeWatchBtn.classList.toggle('active', spectate);
  homeSelectEl.classList.toggle('watch', spectate);
  homeTitleEl.textContent = spectate ? '🤖 Click a city to start the sim' : '✈ Choose Your Home Airport to Start';
}
modePlayBtn.addEventListener('click', () => { spectate = false; applySetupMode(); });
modeWatchBtn.addEventListener('click', () => { spectate = true; applySetupMode(); });
applySetupMode();

/** Competitor count for the next new game. Remembered for the session. */
let chosenAiCount = 8;
for (let n = 0; n <= MAX_AI_AIRLINES; n++) {
  const btn = document.createElement('button');
  btn.textContent = String(n);
  btn.classList.toggle('active', n === chosenAiCount);
  btn.addEventListener('click', () => {
    chosenAiCount = n;
    aiCountEl.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
  });
  aiCountEl.appendChild(btn);
}

/** Fraction of the airline floated to the public at launch. More float dilutes
 *  you but raises more starting cash. Remembered for the session. */
let chosenFloat = DEFAULT_FLOAT;
const floatPctEl = document.getElementById('float-pct')!;
const floatReadoutEl = document.getElementById('float-readout')!;
const FLOAT_CHOICES = [0, 0.1, 0.2, 0.3, 0.4];
function updateFloatReadout() {
  const founder = Math.round((1 - chosenFloat) * 100);
  floatReadoutEl.textContent = `Founder ${founder}% · Start cash ${money(startingCash(chosenFloat))}`;
}
for (const f of FLOAT_CHOICES) {
  const btn = document.createElement('button');
  btn.textContent = `${Math.round(f * 100)}%`;
  btn.classList.toggle('active', f === chosenFloat);
  btn.addEventListener('click', () => {
    chosenFloat = f;
    floatPctEl.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
    updateFloatReadout();
  });
  floatPctEl.appendChild(btn);
}
updateFloatReadout();

/** Enter map home-selection mode: show the world and the picker banner. */
export function showHomeSelect() {
  ui.homeSelecting = true;
  ui.lastHoveredAirport = null;
  hideAirportPopover();
  sidebarEl.classList.add('hidden'); // no airline yet — keep the map clean
  homeSelectEl.classList.remove('hidden');
  resetView(); // fit the whole globe so every eligible city is in view
}

/** Start a fresh game from the clicked home airport, leaving selection mode. */
export function startGameAt(homeId: string) {
  ui.homeSelecting = false;
  clearMapCursor();
  homeSelectEl.classList.add('hidden');
  sidebarEl.classList.remove('hidden');
  Object.assign(game, newGame(homeId, undefined, chosenFloat));
  delete game.defeat; // newGame has no defeat; Object.assign won't clear a stale one
  addAiAirlines(game, chosenAiCount);
  if (spectate) makeAiControlled(game, pl()); // watch-only: AI drives airlines[0] too
  if (chosenAiCount > 0) {
    pl().log.unshift(
      `${chosenAiCount} rival airline${chosenAiCount === 1 ? ' is' : 's are'} setting up: ` +
        game.airlines.slice(1).map((a) => `${a.name} (${a.homeId.toUpperCase()})`).join(', ') + '.',
    );
  }
  bus.afterStateSwap();
  bus.render();
  zoomToAirport(homeId);
}
