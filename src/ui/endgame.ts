import { finalStats, financeMetrics, money } from '../game/engine';
import { bus, game, me } from './app';
import { dateStr, km } from './format';

// Victory and defeat screens, checked once per frame.

/** Win tracking: once the player has had rivals, being the last airline wins. */
let everHadRivals = false;
let winShown = false;
/** Defeat tracking: the game-over screen shows once when a raider takes you over. */
let defeatShown = false;

const winScreenEl = document.getElementById('win-screen')!;
const winSubEl = document.getElementById('win-sub')!;
const winStatsEl = document.getElementById('win-stats')!;
const defeatScreenEl = document.getElementById('defeat-screen')!;
const defeatSubEl = document.getElementById('defeat-sub')!;

/** Build the victory scorecard tiles from the player's final stats. */
function winStatsHtml(): string {
  const s = finalStats(game, me());
  const tiles: Array<[string, string]> = [];
  if (s.longestRoute)
    tiles.push(['Longest route', `${s.longestRoute.label}<br><small>${km(s.longestRoute.distanceKm)}</small>`]);
  tiles.push(['Passengers carried', Math.round(s.paxCarried).toLocaleString()]);
  tiles.push(['Peak net worth', money(s.peakNetWorth)]);
  tiles.push([
    'Fleet',
    s.flagship
      ? `${s.fleetSize} planes<br><small>flagship ${s.flagship.name} ×${s.flagship.count}</small>`
      : `${s.fleetSize} planes`,
  ]);
  tiles.push(['Network', `${s.routes} routes<br><small>${s.legs} legs</small>`]);
  tiles.push(['Rivals absorbed', `${s.rivalsAbsorbed}`]);
  tiles.push(['Awards earned', `${s.awards}`]);
  return tiles
    .map(([k, v]) => `<div class="win-stat"><div class="win-stat-k">${k}</div><div class="win-stat-v">${v}</div></div>`)
    .join('');
}

/** You win once every competitor is gone — but only if you ever had any. */
export function checkWin() {
  if (game.airlines.length > 1) {
    everHadRivals = true;
    return;
  }
  if (everHadRivals && !winShown) {
    winShown = true;
    showWin();
  }
}

function showWin() {
  bus.setPlaying(false);
  const m = financeMetrics(game, me());
  winSubEl.textContent =
    `${dateStr()} — every competitor has been bought out or driven under. ` +
    `Air Bucks stands alone with ${me().rights.length} cities and a net worth of ${money(m.equity)}.`;
  winStatsEl.innerHTML = winStatsHtml();
  winScreenEl.classList.remove('hidden');
}

document.getElementById('win-keep')!.addEventListener('click', () => {
  winScreenEl.classList.add('hidden'); // play on; winShown stays true so it won't nag
});
document.getElementById('win-quit')!.addEventListener('click', () => window.close());

/** Show the game-over screen once, the first frame after the player is acquired. */
export function checkDefeat() {
  if (game.defeat && !defeatShown) {
    defeatShown = true;
    showDefeat();
  }
}

function showDefeat() {
  bus.setPlaying(false);
  const raider = game.airlines.find((a) => a.id === game.defeat!.raiderId);
  defeatSubEl.textContent =
    `${dateStr()} — ${raider?.name ?? 'A rival'} bought a controlling stake in ` +
    `${me().name} and you failed to win it back in time. The crown has changed hands.`;
  defeatScreenEl.classList.remove('hidden');
}

document.getElementById('defeat-quit')!.addEventListener('click', () => window.close());
document.getElementById('defeat-restart')!.addEventListener('click', () => {
  defeatScreenEl.classList.add('hidden');
  bus.resetGame();
});

/** Forget the previous game's win/defeat and hide both screens — after a reset
 *  or load. */
export function resetEndgame() {
  everHadRivals = false;
  winShown = false;
  defeatShown = false;
  winScreenEl.classList.add('hidden');
  defeatScreenEl.classList.add('hidden');
}
