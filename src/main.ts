import './ui/styles.css';
import type { Airport, GameState } from './game/types';
import {
  advanceDay,
  airportById,
  assignPlane,
  borrow,
  buyPlane,
  closeRoute,
  creditLimit,
  evaluateNetwork,
  evaluateRoute,
  interestRate,
  money,
  newGame,
  openRoute,
  pairDemand,
  planesOnRoute,
  repay,
  routeDistance,
  routeLabel,
  routeMaxLeg,
  setFareFactor,
  typeById,
  weeklyTotals,
  weekNumber,
} from './game/engine';
import { distanceKm } from './game/geo';

const game: GameState = newGame();
(window as unknown as { game: GameState }).game = game;
if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV) {
  (window as unknown as { dbg: unknown }).dbg = {
    game,
    openRoute: (...stops: string[]) => (openRoute(game, stops), render()),
    buyPlane: (t: string) => (buyPlane(game, t), render()),
    assignPlane: (p: string, r: string | null) => (assignPlane(game, p, r), render()),
    advanceDay: () => (advanceDay(game), render()),
    borrow: (n: number) => (borrow(game, n), render()),
    repay: (n: number) => (repay(game, n), render()),
    select: (...ids: string[]) => {
      selected = ids;
      render();
    },
    screenOf: (id: string) =>
      airportScreen(id, canvas.clientWidth, canvas.clientHeight),
    evaluate: (r: string) =>
      evaluateRoute(game, game.routes.find((x) => x.id === r)!),
  };
}

/** Ordered airports the player has clicked to stage a new (possibly multi-stop) route. */
let selected: string[] = [];

// Real-time clock state.
let playing = false;
let speed = 1;
let lastTs = 0;
let dayAccumulator = 0;
const DAY_MS = 900;
const START_EPOCH = Date.UTC(2000, 0, 1);
const HOURS_TO_SECONDS = 5;

/** Per-plane animation: t = 0..1 along its route path, dir = travel direction. */
const anim = new Map<string, { t: number; dir: 1 | -1 }>();

const canvas = document.getElementById('map') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const hud = document.getElementById('hud')!;
const sidebar = document.getElementById('sidebar')!;
const logEl = document.getElementById('log')!;
const playBtn = document.getElementById('play') as HTMLButtonElement;

// ---- Geographic projection ------------------------------------------------

const lats = game.airports.map((a) => a.lat);
const lons = game.airports.map((a) => a.lon);
const bounds = {
  minLat: Math.min(...lats),
  maxLat: Math.max(...lats),
  minLon: Math.min(...lons),
  maxLon: Math.max(...lons),
};
const lonScale = Math.cos((((bounds.minLat + bounds.maxLat) / 2) * Math.PI) / 180);
const MAP_PAD = 0.12;

function projectPoint(lat: number, lon: number, w: number, h: number) {
  const dataW = (bounds.maxLon - bounds.minLon) * lonScale;
  const dataH = bounds.maxLat - bounds.minLat;
  const availW = w * (1 - 2 * MAP_PAD);
  const availH = h * (1 - 2 * MAP_PAD);
  const scale = Math.min(availW / dataW, availH / dataH);
  const offX = (w - dataW * scale) / 2;
  const offY = (h - dataH * scale) / 2;
  return {
    x: offX + (lon - bounds.minLon) * lonScale * scale,
    y: offY + (bounds.maxLat - lat) * scale,
  };
}

const airportScreen = (id: string, w: number, h: number) => {
  const a = airportById(game, id);
  return projectPoint(a.lat, a.lon, w, h);
};

// ---- Demand signal (airport coloring) -------------------------------------

/** Latent weekly demand summed from each airport to every other. */
const airportPotential = new Map<string, number>();
let maxPotential = 0;
for (const a of game.airports) {
  let total = 0;
  for (const b of game.airports) if (a.id !== b.id) total += pairDemand(a, b);
  airportPotential.set(a.id, total);
  maxPotential = Math.max(maxPotential, total);
}
const MAX_PAIR_DEMAND = Math.max(...game.airports.map((a) => a.size)) ** 2 * 90;

const HEAT: [number, [number, number, number]][] = [
  [0.0, [51, 83, 107]],
  [0.4, [63, 208, 201]],
  [0.7, [245, 166, 35]],
  [1.0, [255, 107, 107]],
];

function heat(v: number): string {
  v = Math.max(0, Math.min(1, v));
  for (let i = 0; i < HEAT.length - 1; i++) {
    const [p0, c0] = HEAT[i];
    const [p1, c1] = HEAT[i + 1];
    if (v <= p1) {
      const f = (v - p0) / (p1 - p0);
      const c = c0.map((x, j) => Math.round(x + (c1[j] - x) * f));
      return `rgb(${c[0]},${c[1]},${c[2]})`;
    }
  }
  return `rgb(${HEAT[HEAT.length - 1][1].join(',')})`;
}

/** Demand-signal value (0..1) for an airport, given the current selection. */
function demandValue(ap: Airport): number | null {
  if (selected.length > 0) {
    const last = airportById(game, selected[selected.length - 1]);
    if (ap.id === last.id) return null; // the path's current endpoint
    return pairDemand(last, ap) / MAX_PAIR_DEMAND;
  }
  return (airportPotential.get(ap.id) ?? 0) / maxPotential;
}

const formatPax = (n: number) =>
  n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n)}`;

// ---- Real US map geometry -------------------------------------------------

let stateRings: [number, number][][] = [];

async function loadMap() {
  try {
    const res = await fetch('./us-states.json');
    const gj = (await res.json()) as {
      features: { geometry: { type: string; coordinates: unknown } }[];
    };
    const rings: [number, number][][] = [];
    for (const f of gj.features) {
      const g = f.geometry;
      if (g.type === 'Polygon') {
        for (const ring of g.coordinates as [number, number][][]) rings.push(ring);
      } else if (g.type === 'MultiPolygon') {
        for (const poly of g.coordinates as [number, number][][][])
          for (const ring of poly) rings.push(ring);
      }
    }
    stateRings = rings;
    invalidateBaseMap();
  } catch {
    // Leave stateRings empty; drawBase falls back to a grid.
  }
}

// ---- Cached base map ------------------------------------------------------

let baseCanvas: HTMLCanvasElement | null = null;
let baseKey = '';
const invalidateBaseMap = () => (baseKey = '');

function ensureBaseMap(w: number, h: number, dpr: number): HTMLCanvasElement {
  const key = `${w}x${h}@${dpr}#${stateRings.length}`;
  if (key === baseKey && baseCanvas) return baseCanvas;
  baseKey = key;
  const c = baseCanvas ?? document.createElement('canvas');
  baseCanvas = c;
  c.width = Math.round(w * dpr);
  c.height = Math.round(h * dpr);
  const b = c.getContext('2d')!;
  b.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawBase(b, w, h);
  return c;
}

function drawBase(b: CanvasRenderingContext2D, w: number, h: number) {
  const grad = b.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, '#0c1d33');
  grad.addColorStop(1, '#0a1626');
  b.fillStyle = grad;
  b.fillRect(0, 0, w, h);

  if (stateRings.length) {
    b.lineJoin = 'round';
    b.fillStyle = '#16314c';
    b.strokeStyle = '#28537d';
    b.lineWidth = 1;
    for (const ring of stateRings) {
      b.beginPath();
      for (let i = 0; i < ring.length; i++) {
        const p = projectPoint(ring[i][1], ring[i][0], w, h);
        if (i === 0) b.moveTo(p.x, p.y);
        else b.lineTo(p.x, p.y);
      }
      b.closePath();
      b.fill();
      b.stroke();
    }
  } else {
    b.strokeStyle = '#15263c';
    b.lineWidth = 1;
    for (let i = 1; i < 12; i++) {
      const x = (i / 12) * w;
      b.beginPath();
      b.moveTo(x, 0);
      b.lineTo(x, h);
      b.stroke();
    }
    for (let i = 1; i < 6; i++) {
      const y = (i / 6) * h;
      b.beginPath();
      b.moveTo(0, y);
      b.lineTo(w, y);
      b.stroke();
    }
  }
}

// ---- Foreground map -------------------------------------------------------

const pathPoints = (stops: string[], w: number, h: number) =>
  stops.map((id) => airportScreen(id, w, h));

/** Position + heading at fraction t (0..1) along a screen-space polyline. */
function posAlongPath(points: { x: number; y: number }[], t: number) {
  const segs: number[] = [];
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const len = Math.hypot(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y);
    segs.push(len);
    total += len;
  }
  if (total === 0) return { x: points[0].x, y: points[0].y, angle: 0 };
  let dist = t * total;
  for (let i = 0; i < segs.length; i++) {
    if (dist <= segs[i] || i === segs.length - 1) {
      const f = segs[i] ? dist / segs[i] : 0;
      const a = points[i];
      const b = points[i + 1];
      return {
        x: a.x + (b.x - a.x) * f,
        y: a.y + (b.y - a.y) * f,
        angle: Math.atan2(b.y - a.y, b.x - a.x),
      };
    }
    dist -= segs[i];
  }
  return { x: points[0].x, y: points[0].y, angle: 0 };
}

function drawMap() {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(ensureBaseMap(w, h, dpr), 0, 0, w, h);

  // Routes (multi-leg polylines).
  const net = evaluateNetwork(game);
  for (const route of game.routes) {
    const pts = pathPoints(route.stops, w, h);
    const res = net.routes.get(route.id)!;
    const hasPlanes = planesOnRoute(game, route.id).length > 0;
    ctx.strokeStyle = !hasPlanes
      ? '#3a5675'
      : res.profit >= 0
        ? 'rgba(74,222,128,0.8)'
        : 'rgba(248,113,113,0.8)';
    ctx.lineWidth = 2;
    ctx.setLineDash(hasPlanes ? [] : [5, 5]);
    ctx.beginPath();
    pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Moving plane sprites.
  for (const plane of game.fleet) {
    if (!plane.routeId) continue;
    const route = game.routes.find((r) => r.id === plane.routeId);
    if (!route) continue;
    const pts = pathPoints(route.stops, w, h);
    const a = planeAnim(plane.id);
    const pos = posAlongPath(pts, a.t);
    drawPlaneSprite(pos.x, pos.y, pos.angle + (a.dir === -1 ? Math.PI : 0), plane.typeId);
  }

  // Staged selection path.
  if (selected.length >= 2) {
    const pts = pathPoints(selected, w, h);
    ctx.strokeStyle = 'rgba(245,166,35,0.9)';
    ctx.lineWidth = 2;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Airports, colored by the demand signal.
  for (const ap of game.airports) {
    const p = airportScreen(ap.id, w, h);
    const positions = selected.flatMap((s, i) => (s === ap.id ? [i + 1] : []));
    const isStop = positions.length > 0;
    const v = demandValue(ap);
    const r = 5 + ap.size;

    if (ap.home) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, r + 5, 0, Math.PI * 2);
      ctx.strokeStyle = '#f5a623';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = v === null ? '#f5a623' : heat(v);
    ctx.fill();
    ctx.lineWidth = isStop ? 3 : 2;
    ctx.strokeStyle = isStop ? '#ffffff' : '#0b1622';
    ctx.stroke();

    ctx.fillStyle = '#e8eef6';
    ctx.font = 'bold 13px system-ui';
    ctx.fillText(ap.code + (ap.home ? ' ★' : ''), p.x + 10, p.y + 4);
    ctx.fillStyle = '#93a7c0';
    ctx.font = '11px system-ui';
    ctx.fillText(ap.city, p.x + 10, p.y + 18);

    // When staging a route, label prospective leg demand from the path's end.
    if (selected.length > 0 && v !== null) {
      ctx.fillStyle = heat(v);
      ctx.font = 'bold 11px system-ui';
      ctx.fillText(`${formatPax(v * MAX_PAIR_DEMAND)}/wk`, p.x + 10, p.y + 31);
    }
    // Order badge for staged stops (lists every position if revisited).
    if (isStop) {
      const text = positions.join(',');
      ctx.font = 'bold 11px system-ui';
      const bw = Math.max(16, ctx.measureText(text).width + 8);
      const bx = p.x - r - 2 - bw / 2;
      const by = p.y - r - 4;
      ctx.fillStyle = '#f5a623';
      ctx.beginPath();
      ctx.roundRect(bx - bw / 2, by - 8, bw, 16, 8);
      ctx.fill();
      ctx.fillStyle = '#2a1c02';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, bx, by);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
    }
  }

  drawLegend(w, h);
}

function drawLegend(_w: number, h: number) {
  const x = 14;
  const y = h - 30;
  const barW = 120;
  const barH = 8;
  for (let i = 0; i <= barW; i++) {
    ctx.fillStyle = heat(i / barW);
    ctx.fillRect(x + i, y, 1, barH);
  }
  ctx.fillStyle = '#93a7c0';
  ctx.font = '10px system-ui';
  const label =
    selected.length > 0 ? 'Leg demand from path end' : 'Airport market potential';
  ctx.fillText(label, x, y - 5);
  ctx.fillText('low', x, y + barH + 11);
  ctx.fillText('high', x + barW - 18, y + barH + 11);
}

// Per-type sprite styling: color (the clearest cue at small size) + scale,
// plus a distinct silhouette — turboprops fly straight wings, jets are swept.
const PLANE_STYLE: Record<string, { color: string; scale: number }> = {
  turboprop: { color: '#f5a623', scale: 1.7 },
  regionaljet: { color: '#3fd0c9', scale: 2.0 },
  cityjet: { color: '#f4f8ff', scale: 2.6 },
};

function drawPlaneSprite(x: number, y: number, angle: number, typeId: string) {
  const style = PLANE_STYLE[typeId] ?? { color: '#f4f8ff', scale: 1 };
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.scale(style.scale, style.scale);
  ctx.fillStyle = style.color;
  ctx.strokeStyle = '#0b1622';
  ctx.lineWidth = 1 / style.scale; // keep the outline ~1px regardless of scale
  ctx.beginPath();
  if (typeId === 'turboprop') {
    // Straight-wing prop silhouette (wings perpendicular to the fuselage).
    ctx.moveTo(6, 0);
    ctx.lineTo(0.5, -1);
    ctx.lineTo(0.5, -5.5);
    ctx.lineTo(-1, -5.5);
    ctx.lineTo(-1, -1.2);
    ctx.lineTo(-4.5, -1.2);
    ctx.lineTo(-5.5, 0);
    ctx.lineTo(-4.5, 1.2);
    ctx.lineTo(-1, 1.2);
    ctx.lineTo(-1, 5.5);
    ctx.lineTo(0.5, 5.5);
    ctx.lineTo(0.5, 1);
  } else {
    // Swept-wing jet dart.
    ctx.moveTo(7, 0);
    ctx.lineTo(-5, 5);
    ctx.lineTo(-2, 0);
    ctx.lineTo(-5, -5);
  }
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  // City jet gets a little tail fin so the biggest plane reads distinctly.
  if (typeId === 'cityjet') {
    ctx.beginPath();
    ctx.moveTo(-4, 0);
    ctx.lineTo(-7, 2.2);
    ctx.lineTo(-5.5, 0);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

function planeAnim(planeId: string) {
  let a = anim.get(planeId);
  if (!a) {
    a = { t: Math.random(), dir: Math.random() < 0.5 ? 1 : -1 };
    anim.set(planeId, a);
  }
  return a;
}

function updateAnimations(dt: number) {
  for (const plane of game.fleet) {
    if (!plane.routeId) continue;
    const route = game.routes.find((r) => r.id === plane.routeId);
    if (!route) continue;
    const type = typeById(game, plane.typeId);
    const flightHours = routeDistance(game, route) / type.speed;
    const traversalSec = Math.max(0.6, flightHours * HOURS_TO_SECONDS);
    const a = planeAnim(plane.id);
    a.t += a.dir * ((dt * speed) / 1000 / traversalSec);
    if (a.t >= 1) {
      a.t = 1;
      a.dir = -1;
    } else if (a.t <= 0) {
      a.t = 0;
      a.dir = 1;
    }
  }
}

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  invalidateBaseMap();
  drawMap();
}

canvas.addEventListener('click', (e) => {
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  for (const ap of game.airports) {
    const p = airportScreen(ap.id, w, h);
    if (Math.hypot(p.x - mx, p.y - my) <= 14) {
      addStop(ap.id);
      return;
    }
  }
});

/** Append a stop to the staged path, allowing revisits (hub-and-spoke). */
function addStop(id: string) {
  // Ignore a double-click on the current endpoint (no zero-length leg).
  if (selected.length && selected[selected.length - 1] === id) return;
  selected = [...selected, id];
  render();
}

// ---- HUD + sidebar --------------------------------------------------------

function dateStr(): string {
  return new Date(START_EPOCH + game.day * 86_400_000).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function render() {
  renderHud();
  renderSidebar();
  renderLog();
  drawMap();
}

function renderHud() {
  const cashClass = game.cash >= 0 ? 'good' : 'bad';
  const net = weeklyTotals(game).net;
  const netClass = net >= 0 ? 'good' : 'bad';
  hud.innerHTML = `
    <div class="stat"><span class="label">Date</span><span class="value">${dateStr()}</span></div>
    <div class="stat"><span class="label">Cash</span><span class="value ${cashClass}">${money(game.cash)}</span></div>
    <div class="stat"><span class="label">Net / wk</span><span class="value ${netClass}">${net >= 0 ? '+' : ''}${money(net)}</span></div>
    <div class="stat"><span class="label">Debt</span><span class="value">${money(game.debt)}</span></div>
    <div class="stat"><span class="label">Fleet</span><span class="value">${game.fleet.length}</span></div>
    <div class="stat"><span class="label">Routes</span><span class="value">${game.routes.length}</span></div>
  `;
}

function renderSidebar() {
  sidebar.innerHTML =
    newRouteCard() + buyCard() + bankCard() + routesCard() + fleetCard();
}

/** Distance of the staged path through the currently selected airports. */
function stagedDistance(): number {
  let d = 0;
  for (let i = 1; i < selected.length; i++)
    d += distanceKm(airportById(game, selected[i - 1]), airportById(game, selected[i]));
  return d;
}

function newRouteCard(): string {
  const names = selected.map((id) => airportById(game, id).code).join(' → ');
  let info: string;
  let canOpen = false;
  if (selected.length >= 2) {
    info = `<div class="row"><strong>${names}</strong><span class="pill">${stagedDistance().toLocaleString()} km</span></div>
      <div class="tiny">${selected.length - 1} leg${selected.length - 1 === 1 ? '' : 's'} · click more stops (you can revisit a hub)</div>`;
    canOpen = true;
  } else if (selected.length === 1) {
    info = `<div class="muted">Start: <strong>${names}</strong>. Click the next stop.</div>`;
  } else {
    info =
      '<div class="muted">Click airports in order to chain stops — revisit an airport for hub-and-spoke. Brighter dots = more demand.</div>';
  }
  return `<div class="card"><h3>New Route</h3>${info}
    <div class="row" style="margin-top:10px; gap:8px">
      <button data-act="undo-sel" ${selected.length ? '' : 'disabled'}>↶ Undo</button>
      <button data-act="clear-sel" ${selected.length ? '' : 'disabled'}>Clear</button>
      <button class="primary" data-act="open-route" ${canOpen ? '' : 'disabled'}>Open Route</button>
    </div></div>`;
}

function buyCard(): string {
  const rows = game.aircraftTypes
    .map((t) => {
      const afford = game.cash >= t.price;
      const label = afford ? `Buy · ${money(t.price)}` : `Need ${money(t.price)}`;
      return `<div class="plane-line">
        <div class="row"><strong>${t.name}</strong>
          <button class="${afford ? 'primary' : ''}" data-act="buy" data-type="${t.id}" ${afford ? '' : 'disabled'}>${label}</button></div>
        <div class="type-stats">${t.capacity} seats · ${t.range.toLocaleString()} km range · ${t.speed} km/h · $${t.costPerKm}/km · ${money(t.weeklyUpkeep)}/wk upkeep</div>
      </div>`;
    })
    .join('');
  return `<div class="card"><h3>Buy Aircraft</h3>${rows}</div>`;
}

function bankCard(): string {
  const limit = creditLimit(game);
  const credit = Math.max(0, limit - game.debt);
  const rate = interestRate(game);
  const weeklyInterest = game.debt * rate * (7 / 365);
  // Right-size the buttons so the label matches what actually happens.
  const borrowAmt = Math.min(5_000_000, credit);
  const repayAmt = Math.min(game.cash < 5_000_000 ? 1_000_000 : 5_000_000, game.debt);
  return `<div class="card"><h3>Bank</h3>
    <div class="row"><span class="muted">Debt</span><strong>${money(game.debt)}</strong></div>
    <div class="row"><span class="muted">Credit line</span><span>${money(credit)} of ${money(limit)}</span></div>
    <div class="row"><span class="muted">Rate</span><span>${(rate * 100).toFixed(1)}%/yr · <span class="bad">-${money(weeklyInterest)}/wk</span></span></div>
    <div class="row" style="margin-top:10px">
      <button data-act="borrow" data-amt="${borrowAmt}" ${credit > 0 ? '' : 'disabled'}>Borrow ${money(borrowAmt)}</button>
      <button data-act="repay" data-amt="${repayAmt}" ${game.debt > 0 && game.cash > 0 ? '' : 'disabled'}>Repay ${money(repayAmt)}</button>
    </div></div>`;
}

function routesCard(): string {
  if (game.routes.length === 0)
    return `<div class="card"><h3>Routes</h3><div class="muted">No routes yet.</div></div>`;
  const net = evaluateNetwork(game);
  const rows = game.routes
    .map((r) => {
      const dist = routeDistance(game, r);
      const res = net.routes.get(r.id)!;
      const n = planesOnRoute(game, r.id).length;
      const load = Math.round(res.loadFactor * 100);
      const cls = res.profit >= 0 ? 'good' : 'bad';
      const prem = Math.round((res.speedPremium - 1) * 100);
      const premTag =
        n > 0 && prem !== 0
          ? ` · <span class="${prem > 0 ? 'good' : 'bad'}">⚡${prem > 0 ? '+' : ''}${prem}% fare</span>`
          : '';
      return `<div class="route-line">
        <div class="row"><strong>${routeLabel(game, r)}</strong>
          <span class="row" style="gap:6px"><span class="pill ${cls}">${res.profit >= 0 ? '+' : ''}${money(res.profit)}/wk</span>
          <button class="close-x" data-act="close-route" data-route="${r.id}" title="Close route">✕</button></span></div>
        <div class="tiny">${dist.toLocaleString()} km · ${r.stops.length - 1} legs · ${n} plane${n === 1 ? '' : 's'} · ${Math.round(res.passengers).toLocaleString()} pax/wk · ${load}% load${premTag}${
          res.connectingPassengers >= 1
            ? ` · <span class="good">${Math.round(res.connectingPassengers).toLocaleString()} connecting</span>`
            : ''
        }</div>
        <div class="row" style="margin-top:6px">
          <span class="muted">Fare <input type="number" min="20" max="300" step="5" value="${Math.round(r.fareFactor * 100)}" data-act="fare" data-route="${r.id}">%</span>
        </div>
      </div>`;
    })
    .join('');
  return `<div class="card"><h3>Routes</h3>${rows}</div>`;
}

function fleetCard(): string {
  if (game.fleet.length === 0)
    return `<div class="card"><h3>Fleet</h3><div class="muted">No aircraft. Buy one above.</div></div>`;
  const rows = game.fleet
    .map((plane) => {
      const t = typeById(game, plane.typeId);
      const options = [`<option value="">Hangar (idle)</option>`]
        .concat(
          game.routes.map((r) => {
            const tooFar = t.range < routeMaxLeg(game, r);
            const sel = plane.routeId === r.id ? 'selected' : '';
            return `<option value="${r.id}" ${sel} ${tooFar ? 'disabled' : ''}>${routeLabel(game, r)}${tooFar ? ' (out of range)' : ''}</option>`;
          }),
        )
        .join('');
      return `<div class="plane-line">
        <div class="row"><strong>${t.name.split(' (')[0]}</strong>
          <select data-act="assign" data-plane="${plane.id}">${options}</select></div>
      </div>`;
    })
    .join('');
  return `<div class="card"><h3>Fleet (${game.fleet.length})</h3>${rows}</div>`;
}

function renderLog() {
  logEl.innerHTML = game.log
    .slice(0, 20)
    .map((e) => `<div class="entry">${e}</div>`)
    .join('');
}

// ---- Event delegation -----------------------------------------------------

function flash(message: string | null) {
  if (message) {
    game.log.unshift(`⚠ ${message}`);
    render();
  }
}

sidebar.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
  if (!btn) return;
  switch (btn.dataset.act) {
    case 'undo-sel':
      selected = selected.slice(0, -1);
      render();
      break;
    case 'clear-sel':
      selected = [];
      render();
      break;
    case 'open-route': {
      const err = openRoute(game, selected);
      if (err) flash(err);
      else {
        selected = [];
        render();
      }
      break;
    }
    case 'buy':
      flash(buyPlane(game, btn.dataset.type!));
      render();
      break;
    case 'borrow':
      borrow(game, Number(btn.dataset.amt));
      render();
      break;
    case 'repay':
      repay(game, Number(btn.dataset.amt));
      render();
      break;
    case 'close-route':
      closeRoute(game, btn.dataset.route!);
      render();
      break;
  }
});

sidebar.addEventListener('change', (e) => {
  const el = e.target as HTMLElement;
  if (el.dataset.act === 'assign') {
    const sel = el as unknown as HTMLSelectElement;
    flash(assignPlane(game, el.dataset.plane!, sel.value || null));
    render();
  } else if (el.dataset.act === 'fare') {
    const input = el as unknown as HTMLInputElement;
    setFareFactor(game, el.dataset.route!, Number(input.value) / 100);
    render();
  }
});

// ---- Transport controls + real-time loop ----------------------------------

playBtn.addEventListener('click', () => {
  playing = !playing;
  lastTs = 0;
  playBtn.textContent = playing ? '⏸ Pause' : '▶ Play';
  playBtn.classList.toggle('paused', playing);
});

document.getElementById('speeds')!.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('[data-speed]') as HTMLElement | null;
  if (!btn) return;
  speed = Number(btn.dataset.speed);
  document
    .querySelectorAll('#speeds .speed')
    .forEach((b) => b.classList.toggle('active', b === btn));
});

function logWeekly() {
  const w = weeklyTotals(game);
  game.log.unshift(
    `Week ${weekNumber(game) - 1}: ${Math.round(w.pax).toLocaleString()} pax · ` +
      `rev ${money(w.revenue)} · cost ${money(w.cost)} · ` +
      `int ${money(w.interest)} · net ${w.net >= 0 ? '+' : ''}${money(w.net)}.`,
  );
  renderLog();
}

function frame(ts: number) {
  const dt = lastTs ? ts - lastTs : 0;
  lastTs = ts;
  if (playing) {
    dayAccumulator += (dt * speed) / DAY_MS;
    while (dayAccumulator >= 1) {
      dayAccumulator -= 1;
      advanceDay(game);
      if (game.day % 7 === 0) logWeekly();
    }
    updateAnimations(dt);
  }
  renderHud();
  drawMap();
  requestAnimationFrame(frame);
}

window.addEventListener('resize', resizeCanvas);

loadMap();
resizeCanvas();
render();
requestAnimationFrame(frame);
