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

const startCount = g.airlines.length - 1;

function standings(year: number): void {
  const alive = g.airlines.length - 1;
  const onBlock = g.airlines.filter((al) => al.forSale).length;
  console.log(
    `==== ${1950 + year}  (${alive}/${startCount} airlines` +
      (onBlock ? `, ${onBlock} for sale` : '') + ') ' + '='.repeat(72),
  );
  console.log(
    pad('airline', 26) + pad('personality', 14) + pad('home', 6) +
    num('cities', 7) + num('routes', 7) + num('multi', 7) + num('planes', 7) +
    num('cash', 10) + num('debt', 9) + num('equity', 10) + num('net/wk', 10),
  );
  const rows = g.airlines
    .slice(1)
    .sort((a, b) => equity(g, b) - equity(g, a));
  for (const al of rows) {
    const w = weeklyTotals(g, al);
    const multi = al.routes.filter((r) => r.stops.length >= 3).length;
    console.log(
      pad(al.name + (al.forSale ? ' ⚠' : ''), 26) +
      pad(al.ai?.personality ?? '-', 14) +
      pad(al.homeId.toUpperCase(), 6) +
      num(String(al.rights.length), 7) +
      num(String(al.routes.length), 7) +
      num(String(multi), 7) +
      num(String(al.fleet.length), 7) +
      num(money(al.cash), 10) +
      num(money(al.debt), 9) +
      num(money(equity(g, al)), 10) +
      num((w.net >= 0 ? '+' : '') + money(w.net), 10),
    );
  }
  console.log();
}

// Stream consolidation events (distress / acquisition / bankruptcy) as they
// happen, year-stamped, so a long run is legible live and killable early.
const isEvent = (l: string) => /distress|acquired|took over|bankrupt/i.test(l);
let printedEvents = 0;
function flushEvents(year: number): void {
  const events = g.airlines[0].log.filter(isEvent).reverse(); // oldest-first
  for (const line of events.slice(printedEvents)) console.log(`  ${1950 + year}  ${line}`);
  printedEvents = events.length;
}

const start = Date.now();
for (let y = 1; y <= Number(years); y++) {
  for (let d = 0; d < 365; d++) {
    advanceDay(g);
    runAI(g);
  }
  flushEvents(y);
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

// Route structure: are AIs flying more than point-to-point? Histogram of stop
// counts across every live AI route, with the multi-stop (≥3) share.
const hist = new Map<number, number>();
let totalRoutes = 0;
for (const al of g.airlines.slice(1)) {
  for (const r of al.routes) {
    hist.set(r.stops.length, (hist.get(r.stops.length) ?? 0) + 1);
    totalRoutes++;
  }
}
const multiRoutes = [...hist].filter(([n]) => n >= 3).reduce((s, [, c]) => s + c, 0);
console.log('\nRoute structure (all live AIs):');
if (totalRoutes === 0) {
  console.log('  no routes');
} else {
  for (const n of [...hist.keys()].sort((a, b) => a - b)) {
    const c = hist.get(n)!;
    const label = n === 2 ? 'point-to-point' : `${n}-stop`;
    console.log(`  ${pad(label, 16)} ${num(String(c), 5)}  (${((c / totalRoutes) * 100).toFixed(0)}%)`);
  }
  console.log(`  ${pad('→ multi-stop', 16)} ${num(String(multiRoutes), 5)}  (${((multiRoutes / totalRoutes) * 100).toFixed(0)}% of ${totalRoutes} routes)`);
}

// Network connectivity: the real "more than point-to-point" test. Point-to-point
// spokes through a hub still carry connecting passengers (the engine routes them
// across separate routes), so a high connecting share means an integrated hub
// network — not isolated city-pairs — even when few routes are literally multi-stop.
let pax = 0;
let connecting = 0;
for (const al of g.airlines.slice(1)) {
  const net = evaluateNetwork(g, al);
  pax += net.passengers;
  connecting += net.connectingPassengers;
}
console.log('\nNetwork connectivity (all live AIs):');
console.log(
  pax > 0
    ? `  ${num(String(Math.round(connecting)), 8)} / ${Math.round(pax)} pax connect through a hub  (${((connecting / pax) * 100).toFixed(0)}%)`
    : '  no passengers',
);

// Surface anything that exploded.
for (const al of g.airlines) {
  const assets = airlineAssets(g, al);
  const net = evaluateNetwork(g, al);
  if (!Number.isFinite(assets) || !Number.isFinite(net.revenue)) {
    console.error(`NON-FINITE STATE: ${al.name}`);
    process.exitCode = 1;
  }
}
