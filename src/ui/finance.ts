import type { GameState } from '../game/types';
import {
  depositRate,
  financeMetrics,
  interestRate,
  player,
  money,
  profitMargin,
  returnOnCapital,
} from '../game/engine';

const ACCENT = '#3fd0c9';
const ACCENT_2 = '#f5a623';
const GOOD = '#4ade80';
const WARN = '#fbbf24';
const BAD = '#f87171';

interface Series {
  label: string;
  color: string;
  values: number[];
}

const pct = (v: number): string => `${(v * 100).toFixed(0)}%`;
const rate = (v: number): string => `${(v * 100).toFixed(1)}%`;
const signed = (v: number, fmt: (n: number) => string): string =>
  `${v >= 0 ? '+' : ''}${fmt(v)}`;
const goodBad = (v: number): string => (v >= 0 ? 'good' : 'bad');

/** Render the whole finance page into the given element. */
export function renderFinance(g: GameState, el: HTMLElement): void {
  const al = player(g);
  const m = financeMetrics(g, al);
  const kpis = `
    <div class="kpi-grid">
      ${kpi('Cash', money(m.cash), goodBad(m.cash))}
      ${kpi('Net worth', money(m.equity), goodBad(m.equity), 'cash + fleet − debt')}
      ${kpi('Debt', money(m.debt))}
      ${kpi('Net / wk', signed(m.net, money), goodBad(m.net))}
      ${kpi('Profit margin', pct(m.margin), goodBad(m.margin), 'net ÷ revenue')}
      ${kpi('Return on capital', pct(m.roc), goodBad(m.roc), 'annualized')}
      ${kpi('Loan rate', rate(interestRate(g, al)), '', 'on debt, annual')}
      ${kpi('Deposit rate', rate(depositRate(g)), '', 'on cash, annual')}
    </div>`;

  const h = al.history;
  if (h.length < 2) {
    el.innerHTML = `<h2 class="fin-title">Finance</h2>${kpis}
      <div class="fin-empty">Press ▶ Play to run the airline — weekly results will chart here as they accumulate.</div>`;
    return;
  }

  const days = h.map((s) => s.day);
  const cashDebt = chartCard('Cash & debt', days, [
    { label: 'Cash', color: ACCENT, values: h.map((s) => s.cash) },
    { label: 'Debt', color: BAD, values: h.map((s) => s.debt) },
  ], money, true);

  const revCost = chartCard('Revenue, cost & profit (weekly)', days, [
    { label: 'Revenue', color: ACCENT, values: h.map((s) => s.revenue) },
    { label: 'Cost', color: WARN, values: h.map((s) => s.cost) },
    { label: 'Net profit', color: GOOD, values: h.map((s) => s.net) },
  ], money, true);

  const margins = chartCard('Profit margin & return on capital', days, [
    { label: 'Profit margin', color: ACCENT, values: h.map((s) => profitMargin(s.revenue, s.net)) },
    {
      label: 'Return on capital',
      color: ACCENT_2,
      values: h.map((s) => returnOnCapital(Math.max(0, s.cash) + s.fleetValue, s.net)),
    },
  ], pct, true);

  const netWorth = chartCard('Net worth (cash + fleet − debt)', days, [
    { label: 'Net worth', color: GOOD, values: h.map((s) => s.cash + s.fleetValue - s.debt) },
  ], money, true);

  // Effective annual rates the airline actually paid/earned each week, recovered
  // from the stored interest figures (0 in weeks with no debt / no cash).
  const annual = (weekly: number, principal: number): number =>
    principal > 0 ? (weekly * 365) / 7 / principal : 0;
  const rates = chartCard('Interest rates (annualized)', days, [
    { label: 'Loan rate', color: BAD, values: h.map((s) => annual(s.interest, s.debt)) },
    { label: 'Deposit rate', color: GOOD, values: h.map((s) => annual(s.interestEarned, Math.max(0, s.cash))) },
  ], rate, true);

  el.innerHTML = `<h2 class="fin-title">Finance</h2>${kpis}
    <div class="chart-grid">${cashDebt}${revCost}${margins}${rates}${netWorth}</div>`;
}

function kpi(label: string, value: string, cls = '', sub = ''): string {
  return `<div class="kpi">
    <div class="k-label">${label}</div>
    <div class="k-value ${cls}">${value}</div>
    ${sub ? `<div class="k-sub">${sub}</div>` : ''}
  </div>`;
}

// ---- SVG line charts ------------------------------------------------------

const VB_W = 600;
const VB_H = 240;
const PAD_L = 64;
const PAD_R = 14;
const PAD_T = 12;
const PAD_B = 26;
const PLOT_W = VB_W - PAD_L - PAD_R;
const PLOT_H = VB_H - PAD_T - PAD_B;

function chartCard(
  title: string,
  days: number[],
  series: Series[],
  fmt: (n: number) => string,
  includeZero: boolean,
): string {
  const legend = series
    .map(
      (s) =>
        `<span class="lg"><span class="sw" style="background:${s.color}"></span>${s.label}</span>`,
    )
    .join('');
  return `<div class="chart-card">
    <h4>${title}</h4>
    <div class="chart-legend">${legend}</div>
    ${lineChart(days, series, fmt, includeZero)}
  </div>`;
}

function niceTicks(min: number, max: number, count: number): number[] {
  if (min === max) {
    const pad = Math.abs(min) || 1;
    min -= pad;
    max += pad;
  }
  const span = max - min;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const start = Math.floor(min / step) * step;
  const ticks: number[] = [];
  for (let t = start; t <= max + step * 0.5; t += step) ticks.push(t);
  return ticks;
}

function lineChart(
  days: number[],
  series: Series[],
  fmt: (n: number) => string,
  includeZero: boolean,
): string {
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of series)
    for (const v of s.values) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  if (includeZero) {
    lo = Math.min(lo, 0);
    hi = Math.max(hi, 0);
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    lo = 0;
    hi = 1;
  }
  const ticks = niceTicks(lo, hi, 4);
  const yLo = Math.min(lo, ticks[0]);
  const yHi = Math.max(hi, ticks[ticks.length - 1]);
  const span = yHi - yLo || 1;

  const n = days.length;
  const x = (i: number) => PAD_L + (n <= 1 ? 0 : (i / (n - 1)) * PLOT_W);
  const y = (v: number) => PAD_T + PLOT_H - ((v - yLo) / span) * PLOT_H;

  // Horizontal gridlines + y labels.
  let grid = '';
  for (const t of ticks) {
    const yy = y(t);
    const isZero = Math.abs(t) < span * 1e-9;
    grid += `<line class="${isZero ? 'zero-line' : 'grid-line'}" x1="${PAD_L}" y1="${yy.toFixed(1)}" x2="${PAD_L + PLOT_W}" y2="${yy.toFixed(1)}" />`;
    grid += `<text class="axis-label" x="${PAD_L - 8}" y="${(yy + 3).toFixed(1)}" text-anchor="end">${fmt(t)}</text>`;
  }

  // X labels: a handful of evenly spaced week markers.
  const labelCount = Math.min(5, n);
  let xlabels = '';
  for (let k = 0; k < labelCount; k++) {
    const i = labelCount === 1 ? 0 : Math.round((k / (labelCount - 1)) * (n - 1));
    const wk = Math.floor(days[i] / 7);
    const anchor = k === 0 ? 'start' : k === labelCount - 1 ? 'end' : 'middle';
    xlabels += `<text class="axis-label" x="${x(i).toFixed(1)}" y="${VB_H - 8}" text-anchor="${anchor}">wk ${wk}</text>`;
  }

  // Series polylines.
  const paths = series
    .map((s) => {
      const d = s.values
        .map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`)
        .join(' ');
      return `<path class="series" stroke="${s.color}" d="${d}" />`;
    })
    .join('');

  return `<svg viewBox="0 0 ${VB_W} ${VB_H}" role="img">${grid}${paths}${xlabels}</svg>`;
}
