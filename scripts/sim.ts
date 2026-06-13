/**
 * Headless AI-vs-AI balance harness: run N computer airlines for Y game-years
 * and print yearly standings. No player, no UI — pure engine.
 *
 *   npm run sim                  # 8 AIs, 30 years, seed 1
 *   npm run sim -- 6 40 123      # 6 AIs, 40 years, seed 123
 */
import { addAiAirlines, PERSONALITIES, runAI } from '../src/game/ai';
import {
  advanceDay,
  airlineAssets,
  equity,
  evaluateNetwork,
  money,
  newGame,
  weeklyTotals,
} from '../src/game/engine';
import type { GameState } from '../src/game/types';

const [aiCount = '8', years = '30', seed = '1'] = process.argv.slice(2);

const g: GameState = newGame('crw', Number(seed));
addAiAirlines(g, Number(aiCount));
console.log(`Simulating ${g.airlines.length - 1} AI airlines, ${years} years, seed ${seed}\n`);

const pad = (s: string, n: number) => s.padEnd(n);
const num = (s: string, n: number) => s.padStart(n);

function standings(year: number): void {
  console.log(`==== ${1950 + year} ` + '='.repeat(96));
  console.log(
    pad('airline', 26) + pad('personality', 14) + pad('home', 6) +
    num('cities', 7) + num('routes', 7) + num('planes', 7) +
    num('cash', 10) + num('debt', 9) + num('equity', 10) + num('net/wk', 10),
  );
  const rows = g.airlines
    .slice(1)
    .sort((a, b) => equity(g, b) - equity(g, a));
  for (const al of rows) {
    const w = weeklyTotals(g, al);
    console.log(
      pad(al.name, 26) +
      pad(al.ai?.personality ?? '-', 14) +
      pad(al.homeId.toUpperCase(), 6) +
      num(String(al.rights.length), 7) +
      num(String(al.routes.length), 7) +
      num(String(al.fleet.length), 7) +
      num(money(al.cash), 10) +
      num(money(al.debt), 9) +
      num(money(equity(g, al)), 10) +
      num((w.net >= 0 ? '+' : '') + money(w.net), 10),
    );
  }
  console.log();
}

const start = Date.now();
for (let y = 1; y <= Number(years); y++) {
  for (let d = 0; d < 365; d++) {
    advanceDay(g);
    runAI(g);
  }
  if (y % 5 === 0 || y === 1) standings(y);
}
console.log(`(${((Date.now() - start) / 1000).toFixed(1)}s simulated wall time)`);

// Quick personality scoreboard across the final year.
console.log('Final equity by personality:');
for (const p of PERSONALITIES) {
  const own = g.airlines.slice(1).filter((al) => al.ai?.personality === p.id);
  if (!own.length) continue;
  const eq = own.map((al) => equity(g, al));
  console.log(`  ${pad(p.id, 14)} ${own.length}x  avg ${money(eq.reduce((a, b) => a + b, 0) / own.length)}`);
}

// Surface anything that exploded.
for (const al of g.airlines) {
  const assets = airlineAssets(g, al);
  const net = evaluateNetwork(g, al);
  if (!Number.isFinite(assets) || !Number.isFinite(net.revenue)) {
    console.error(`NON-FINITE STATE: ${al.name}`);
    process.exitCode = 1;
  }
}
