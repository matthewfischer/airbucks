/**
 * Diagnose a played game: load a save and compare the player against every
 * rival — standings, per-route economics (load factor + weekly profit), fleet
 * mix, and a yearly equity/net trajectory. Reads the same JSON the game keeps
 * in localStorage under 'airbucks-save'.
 *
 * Dump the save to a file from the game's devtools console, then run:
 *
 *   copy(localStorage['airbucks-save'])   // in the browser console
 *   # paste into save.json, then:
 *   npm run analyze save.json
 *
 * Defaults to ./save.json if no path is given.
 */
import {
  airportById,
  equity,
  evaluateNetwork,
  fleetValue,
  money,
  newGame,
  typeById,
  weeklyTotals,
} from '../src/game/engine';
import { applySave, deserialize } from '../src/game/persist';
import type { Airline, GameState } from '../src/game/types';
import { readFileSync } from 'node:fs';

const BASE_YEAR = 1950;

const path = process.argv[2] ?? 'save.json';
let json: string;
try {
  json = readFileSync(path, 'utf8');
} catch {
  console.error(`Could not read save file: ${path}`);
  console.error('Dump it first:  copy(localStorage["airbucks-save"])  in the game console.');
  process.exit(1);
}

const save = deserialize(json);
if (!save) {
  console.error('Save did not parse / version mismatch. Is this an airbucks-save JSON?');
  process.exit(1);
}

const g: GameState = newGame(save.airlines[0]?.homeId ?? 'crw');
applySave(g, save);

const pad = (s: string, n: number) => s.padEnd(n);
const num = (s: string, n: number) => s.padStart(n);
const pct = (x: number) => (x * 100).toFixed(0) + '%';
const year = BASE_YEAR + g.day / 365;
const code = (id: string) => airportById(g, id).code;

const player = g.airlines[0];
const rivals = g.airlines.slice(1);

console.log(
  `Save: day ${g.day} (~${year.toFixed(1)}), ${g.airlines.length} airlines ` +
    `(${rivals.length} rivals)\n`,
);

// ---- Standings: player first, rivals by equity ----------------------------
function row(al: Airline, tag: string): string {
  const w = weeklyTotals(g, al);
  const idle = al.fleet.filter((p) => p.routeId === null).length;
  return (
    pad(tag, 3) +
    pad(al.name, 22) +
    pad(al.ai?.personality ?? 'PLAYER', 12) +
    pad(code(al.homeId), 5) +
    num(String(al.rights.length), 6) +
    num(String(al.routes.length), 6) +
    num(`${al.fleet.length}${idle ? `(${idle}i)` : ''}`, 8) +
    num(money(al.cash), 11) +
    num(money(al.debt), 10) +
    num(money(equity(g, al)), 11) +
    num((w.net >= 0 ? '+' : '') + money(w.net), 11)
  );
}

console.log('=== STANDINGS ' + '='.repeat(76));
console.log(
  pad('', 3) + pad('airline', 22) + pad('personality', 12) + pad('home', 5) +
    num('cities', 6) + num('routes', 6) + num('planes', 8) +
    num('cash', 11) + num('debt', 10) + num('equity', 11) + num('net/wk', 11),
);
const sorted = [...rivals].sort((a, b) => equity(g, b) - equity(g, a));
console.log(row(player, '>>>'));
sorted.forEach((al, i) => console.log(row(al, String(i + 1))));

const playerEq = equity(g, player);
const bestRival = sorted[0];
if (bestRival) {
  const gap = playerEq - equity(g, bestRival);
  console.log(
    `\nPlayer vs best rival (${bestRival.name}): ` +
      `${gap >= 0 ? 'ahead' : 'behind'} by ${money(Math.abs(gap))} equity`,
  );
}

// ---- Per-route economics for one airline ----------------------------------
function routes(al: Airline): void {
  const net = evaluateNetwork(g, al);
  console.log(
    `\n--- ${al.name} (${al.ai?.personality ?? 'PLAYER'}) — ` +
      `rev ${money(net.revenue)}/wk, cost ${money(net.cost)}/wk, ` +
      `profit ${money(net.profit)}/wk, ${Math.round(net.passengers)} pax/wk`,
  );
  // Fleet mix.
  const byType = new Map<string, number>();
  for (const p of al.fleet) byType.set(p.typeId, (byType.get(p.typeId) ?? 0) + 1);
  const mix = [...byType]
    .map(([t, n]) => `${n}x ${typeById(g, t).name}`)
    .join(', ');
  console.log(`    fleet: ${mix || '(none)'}  value ${money(fleetValue(g, al))}`);
  if (!al.routes.length) {
    console.log('    (no routes)');
    return;
  }
  const rows = al.routes
    .map((r) => ({ r, s: net.routes.get(r.id) }))
    .sort((a, b) => (b.s?.profit ?? 0) - (a.s?.profit ?? 0));
  console.log(
    '    ' + pad('route', 26) + num('fare', 6) + num('load', 7) +
      num('pax/wk', 8) + num('profit/wk', 12),
  );
  for (const { r, s } of rows) {
    const label = r.stops.map(code).join('→');
    console.log(
      '    ' +
        pad(label, 26) +
        num(r.fareFactor.toFixed(2), 6) +
        num(s ? pct(s.loadFactor) : '-', 7) +
        num(s ? String(Math.round(s.passengers)) : '-', 8) +
        num(s ? (s.profit >= 0 ? '+' : '') + money(s.profit) : '-', 12),
    );
  }
}

console.log('\n=== ROUTES ' + '='.repeat(79));
routes(player);
// Show the strongest rivals so the contrast is visible without flooding output.
for (const al of sorted.slice(0, 3)) routes(al);

// ---- Yearly trajectory from weekly history --------------------------------
function trajectory(al: Airline): void {
  if (!al.history.length) return;
  console.log(`\n--- ${al.name} trajectory`);
  console.log(
    '    ' + pad('year', 7) + num('cash', 11) + num('debt', 10) +
      num('rev/wk', 10) + num('net/wk', 10) + num('pax/wk', 9),
  );
  let nextYear = 0;
  for (const h of al.history) {
    const yr = h.day / 365;
    if (yr < nextYear) continue;
    nextYear = Math.floor(yr) + 1;
    console.log(
      '    ' +
        pad((BASE_YEAR + yr).toFixed(0), 7) +
        num(money(h.cash), 11) +
        num(money(h.debt), 10) +
        num(money(h.revenue), 10) +
        num((h.net >= 0 ? '+' : '') + money(h.net), 10) +
        num(String(Math.round(h.pax)), 9),
    );
  }
}

console.log('\n=== TRAJECTORY ' + '='.repeat(75));
trajectory(player);
if (bestRival) trajectory(bestRival);
