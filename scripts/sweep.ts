/**
 * Multi-seed balance sweep for the share market. Runs an AI-only game per seed
 * and prints a compact line — how far the field consolidates, when, and how
 * dominant the winner gets — so we can judge whether share-based takeovers
 * produce healthy dynamics (not instant monopoly, not zero consolidation).
 *
 *   npm run sweep                 # seeds 1..20, 4 AIs, 15 years
 *   npm run sweep -- 30 4 20      # seeds 1..30, 4 AIs, 20 years
 *
 * Writes results to scripts/sweep-results.txt (appended as each seed finishes,
 * so a partial run survives an early exit) and echoes to stdout.
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { addAiAirlines, runAI } from '../src/game/ai';
import { advanceDay, equity, money, newGame } from '../src/game/engine';

const [seedsArg = '20', aiArg = '4', yearsArg = '15'] = process.argv.slice(2);
const SEEDS = Number(seedsArg);
const AIS = Number(aiArg);
const YEARS = Number(yearsArg);

const OUT = 'scripts/sweep-results.txt';
const pad = (s: string, n: number) => s.padEnd(n);
const num = (s: string, n: number) => s.padStart(n);

const header =
  `Share-market sweep — ${AIS} AIs, ${YEARS} years, seeds 1..${SEEDS}\n` +
  pad('seed', 6) + num('alive', 7) + num('1stTO', 7) + num('takeovers', 11) +
  num('bankrupt', 10) + num('topEq', 11) + num('domin%', 8);
writeFileSync(OUT, header + '\n');
console.log(header);

const emit = (line: string) => {
  console.log(line);
  appendFileSync(OUT, line + '\n');
};

const start = Date.now();
const aliveCounts: number[] = [];
for (let seed = 1; seed <= SEEDS; seed++) {
  const g = newGame('crw', seed);
  addAiAirlines(g, AIS);
  const startCount = g.airlines.length - 1;
  let firstTO = 0;
  for (let y = 1; y <= YEARS; y++) {
    for (let d = 0; d < 365; d++) {
      advanceDay(g);
      runAI(g);
    }
    if (!firstTO && g.airlines.length - 1 < startCount) firstTO = y;
  }
  const alive = g.airlines.length - 1;
  const log = g.airlines[0].log;
  const takeovers = log.filter((l) => /took over|acquired/i.test(l)).length;
  const bankrupt = log.filter((l) => /bankrupt/i.test(l)).length;
  const eqs = g.airlines.slice(1).map((al) => equity(g, al));
  const topEq = eqs.length ? Math.max(...eqs) : 0;
  const totalEq = eqs.reduce((a, b) => a + Math.max(0, b), 0);
  const dominance = totalEq > 0 ? Math.round((topEq / totalEq) * 100) : 0;
  aliveCounts.push(alive);
  emit(
    pad(String(seed), 6) +
    num(`${alive}/${startCount}`, 7) +
    num(firstTO ? String(1950 + firstTO) : '—', 7) +
    num(String(takeovers), 11) +
    num(String(bankrupt), 10) +
    num(money(topEq), 11) +
    num(`${dominance}%`, 8),
  );
}

const avgAlive = aliveCounts.reduce((a, b) => a + b, 0) / aliveCounts.length;
const monopolies = aliveCounts.filter((n) => n <= 1).length;
emit(
  `\navg survivors ${avgAlive.toFixed(1)}/${AIS}` +
  ` · monopolies ${monopolies}/${SEEDS}` +
  ` · ${((Date.now() - start) / 1000).toFixed(0)}s`,
);
