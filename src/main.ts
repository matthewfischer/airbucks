import './ui/styles.css';
import type { AircraftType, Airport, GameState, Route } from './game/types';
import {
  acquireRights,
  advanceDay,
  airportById,
  assignPlane,
  availableTypes,
  borrow,
  buyPlane,
  cashInterestWeekly,
  closeRoute,
  creditLimit,
  depositRate,
  distanceFactor,
  evaluateNetwork,
  evaluateRoute,
  holdsRights,
  interestRate,
  money,
  MAX_HOME_SIZE,
  nearestHeldAirport,
  newGame,
  openRoute,
  pairDemand,
  planesOnRoute,
  recordFinanceSnapshot,
  repay,
  reputation,
  requiredReputation,
  rightsAvailable,
  airportSlotsTotal,
  airportSlotsUsed,
  rightsFee,
  routeDistance,
  routeLabel,
  routeMaxLeg,
  planeResaleValue,
  sellPlane,
  setFareFactor,
  typeAvailable,
  typeById,
  upgradeRoute,
  upgradeRouteQuote,
  weeklyTotals,
  weekNumber,
  currentYear,
  START_EPOCH,
} from './game/engine';
import { distanceKm } from './game/geo';
import { applySave, deserialize, serialize } from './game/persist';
import { AIRPORTS } from './game/data';
import { renderFinance } from './ui/finance';

const game: GameState = newGame('crw');
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
const HOURS_TO_SECONDS = 5;

/** Per-plane animation: t = 0..1 along its route path, dir = travel direction. */
const anim = new Map<string, { t: number; dir: 1 | -1 }>();

const canvas = document.getElementById('map') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const hud = document.getElementById('hud')!;
const sidebar = document.getElementById('sidebar')!;
const logEl = document.getElementById('log')!;
const playBtn = document.getElementById('play') as HTMLButtonElement;
const stageEl = document.getElementById('stage')!;
const financeEl = document.getElementById('finance')!;

const mapWrap = document.getElementById('map-wrap')!;
const popover = document.createElement('div');
popover.id = 'airport-pop';
popover.style.display = 'none';
mapWrap.appendChild(popover);
/** Airport currently shown in the popover, if any. */
let popAirport: string | null = null;
/** Measuring pin (⇧-click any airport): popovers show distance from here. */
let measureFrom: string | null = null;

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

// Pan/zoom view applied on top of the fit-to-region projection.
const view = { scale: 1, offsetX: 0, offsetY: 0 };
const MIN_SCALE = 0.3;
const MAX_SCALE = 8;
const applyView = (p: { x: number; y: number }) => ({
  x: p.x * view.scale + view.offsetX,
  y: p.y * view.scale + view.offsetY,
});

const airportScreen = (id: string, w: number, h: number) => {
  const a = airportById(game, id);
  return applyView(projectPoint(a.lat, a.lon, w, h));
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

// ---- Real map geometry ----------------------------------------------------

let stateRings: [number, number][][] = [];

function geojsonRings(gj: {
  features: { geometry: { type: string; coordinates: unknown } }[];
}): [number, number][][] {
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
  return rings;
}

async function loadMap() {
  // US states plus the rest of North America & the Caribbean (country outlines).
  const results = await Promise.allSettled(
    ['./na-countries.json', './us-states.json'].map(async (url) => {
      const res = await fetch(url);
      return geojsonRings(await res.json());
    }),
  );
  stateRings = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  // If every fetch failed, stateRings stays empty and drawBase falls back to a grid.
  invalidateBaseMap();
}

// ---- Cached base map ------------------------------------------------------

let baseCanvas: HTMLCanvasElement | null = null;
let baseKey = '';
const invalidateBaseMap = () => (baseKey = '');

function ensureBaseMap(w: number, h: number, dpr: number): HTMLCanvasElement {
  const key = `${w}x${h}@${dpr}#${stateRings.length}~${view.scale.toFixed(3)}_${Math.round(view.offsetX)}_${Math.round(view.offsetY)}`;
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
        const p = applyView(projectPoint(ring[i][1], ring[i][0], w, h));
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
    const r = (5 + ap.size) * Math.max(0.2, Math.min(1.0, view.scale));
    // Three states: held (full), acquirable (dimmed + green "buy" ring you can
    // click on the map), and locked (faint, needs a bigger network).
    const held = holdsRights(game, ap.id);
    const acquirable = !held && rightsAvailable(game, ap.id);
    ctx.globalAlpha = held ? 1 : acquirable ? 0.7 : 0.28;

    if (ap.id === game.homeId) {
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
    if (acquirable) acquireRing(p.x, p.y, r + 3, false);

    // Hide labels for small airports when zoomed out; home always shows.
    const isHome = ap.id === game.homeId;
    const minScale = ap.size <= 1 ? 2.0 : ap.size <= 2 ? 1.4 : 0;
    const showLabel = isHome || view.scale >= minScale;

    if (showLabel) {
      ctx.fillStyle = '#e8eef6';
      ctx.font = 'bold 13px system-ui';
      ctx.fillText(ap.code + (isHome ? ' ★' : ''), p.x + 10, p.y + 4);
      ctx.fillStyle = '#93a7c0';
      ctx.font = '11px system-ui';
      ctx.fillText(ap.city, p.x + 10, p.y + 18);
    }

    // When staging a route, label prospective leg demand from the path's end.
    if (selected.length > 0 && v !== null) {
      ctx.fillStyle = heat(v);
      ctx.font = 'bold 11px system-ui';
      ctx.fillText(`${formatPax(v * MAX_PAIR_DEMAND)}/wk`, p.x + 10, p.y + 31);
    }
    drawOrderBadge(p.x, p.y, r, positions);
  }
  ctx.globalAlpha = 1;

  // Measuring pin: ring it and rule a line with km to the hovered airport.
  if (measureFrom) {
    const pin = airportById(game, measureFrom);
    const pp = airportScreen(pin.id, w, h);
    const r = (5 + pin.size) * Math.max(0.2, Math.min(1.0, view.scale));
    ctx.save();
    ctx.strokeStyle = '#5ac8fa';
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.arc(pp.x, pp.y, r + 6, 0, Math.PI * 2);
    ctx.stroke();
    if (lastHoveredAirport && lastHoveredAirport !== pin.id) {
      const other = airportById(game, lastHoveredAirport);
      const op = airportScreen(other.id, w, h);
      ctx.beginPath();
      ctx.moveTo(pp.x, pp.y);
      ctx.lineTo(op.x, op.y);
      ctx.stroke();
      ctx.setLineDash([]);
      const label = `${distanceKm(pin, other).toLocaleString()} km`;
      ctx.font = 'bold 12px system-ui';
      const tw = ctx.measureText(label).width;
      const lx = (pp.x + op.x) / 2;
      const ly = (pp.y + op.y) / 2;
      ctx.fillStyle = '#0b1622';
      ctx.beginPath();
      ctx.roundRect(lx - tw / 2 - 5, ly - 10, tw + 10, 20, 6);
      ctx.fill();
      ctx.fillStyle = '#5ac8fa';
      ctx.fillText(label, lx - tw / 2, ly + 4);
    }
    ctx.restore();
  }

  drawLegend(w, h);
}

/** Small gold badge listing a staged stop's position(s) on the route. */
/** A dashed green ring marking an airport whose rights you can buy by clicking it. */
function acquireRing(x: number, y: number, r: number, square: boolean) {
  ctx.save();
  ctx.globalAlpha = 0.95;
  ctx.setLineDash([3, 3]);
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#4ade80';
  ctx.beginPath();
  if (square) ctx.roundRect(x - r, y - r, r * 2, r * 2, 4);
  else ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function drawOrderBadge(px: number, py: number, r: number, positions: number[]) {
  if (positions.length === 0) return;
  const text = positions.join(',');
  ctx.font = 'bold 11px system-ui';
  const bw = Math.max(16, ctx.measureText(text).width + 8);
  const bx = px - r - 2 - bw / 2;
  const by = py - r - 4;
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

// Sprite styling derived from the aircraft's stats: scale tracks seat count,
// color marks the capacity tier (the clearest cue at small size), and the
// silhouette follows propulsion — props fly straight wings, jets are swept.
const TIER_COLORS: [number, string][] = [
  [230, '#ff8fa3'],
  [160, '#c084fc'],
  [100, '#f4f8ff'],
  [40, '#3fd0c9'],
  [0, '#f5a623'],
];

function drawPlaneSprite(x: number, y: number, angle: number, typeId: string) {
  const type = typeById(game, typeId);
  const scale = 1.25 + 0.009 * type.capacity;
  const color = TIER_COLORS.find(([min]) => type.capacity >= min)![1];
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.scale(scale, scale);
  ctx.fillStyle = color;
  ctx.strokeStyle = '#0b1622';
  ctx.lineWidth = 1 / scale; // keep the outline ~1px regardless of scale
  ctx.beginPath();
  if (type.propulsion !== 'jet') {
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
  // The bigger jets get a little tail fin so they read distinctly.
  if (type.propulsion === 'jet' && type.capacity >= 100) {
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

canvas.addEventListener('mousemove', (e) => {
  if (dragging) return;
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  let found: Airport | null = null;
  let foundPx = 0, foundPy = 0;
  for (const ap of game.airports) {
    const p = airportScreen(ap.id, w, h);
    if (Math.hypot(p.x - mx, p.y - my) <= 14) { found = ap; foundPx = p.x; foundPy = p.y; break; }
  }
  const foundId = found?.id ?? null;
  if (foundId === lastHoveredAirport) return;
  lastHoveredAirport = foundId;
  if (found) {
    showAirportInfo(found, foundPx, foundPy);
  } else {
    // Short delay so the user can move from the airport dot to the popover.
    hidePopoverTimer = setTimeout(() => { hideAirportPopover(); }, 120);
  }
});

canvas.addEventListener('click', (e) => {
  if (dragMoved) return; // a pan, not a click
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  for (const ap of game.airports) {
    const p = airportScreen(ap.id, w, h);
    if (Math.hypot(p.x - mx, p.y - my) <= 14) {
      if (e.shiftKey) {
        // Toggle the measuring pin — works on any airport, owned or not.
        measureFrom = measureFrom === ap.id ? null : ap.id;
        showAirportInfo(ap, p.x, p.y);
        drawMap();
        return;
      }
      if (holdsRights(game, ap.id)) {
        hideAirportPopover();
        addStop(ap.id);
      } else if (rightsAvailable(game, ap.id)) {
        showAirportInfo(ap, p.x, p.y);
      } else {
        hideAirportPopover();
        flash(`${ap.code} is locked — grow to a ${requiredReputation(ap)}-airport network to unlock it.`);
      }
      return;
    }
  }
  hideAirportPopover(); // clicked empty map
});

// ---- Pan & zoom -----------------------------------------------------------

const clampScale = (s: number) => Math.max(MIN_SCALE, Math.min(MAX_SCALE, s));

function resetView() {
  view.scale = 1;
  view.offsetX = 0;
  view.offsetY = 0;
  drawMap();
}

// Wheel zoom, keeping the point under the cursor fixed.
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  hideAirportPopover();
  const newScale = clampScale(view.scale * Math.exp(-e.deltaY * 0.005));
  const k = newScale / view.scale;
  view.offsetX = mx - (mx - view.offsetX) * k;
  view.offsetY = my - (my - view.offsetY) * k;
  view.scale = newScale;
  drawMap();
}, { passive: false });

// Drag to pan.
let dragging = false;
let dragMoved = false;
let dragStart = { x: 0, y: 0, ox: 0, oy: 0 };

canvas.addEventListener('mousedown', (e) => {
  dragging = true;
  dragMoved = false;
  dragStart = { x: e.clientX, y: e.clientY, ox: view.offsetX, oy: view.offsetY };
});

window.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  const dx = e.clientX - dragStart.x;
  const dy = e.clientY - dragStart.y;
  if (!dragMoved && Math.hypot(dx, dy) > 3) dragMoved = true;
  if (dragMoved) {
    hideAirportPopover();
    view.offsetX = dragStart.ox + dx;
    view.offsetY = dragStart.oy + dy;
    canvas.style.cursor = 'grabbing';
    drawMap();
  }
});

window.addEventListener('mouseup', () => {
  dragging = false;
  canvas.style.cursor = '';
});

canvas.addEventListener('dblclick', resetView);
document.getElementById('reset-view')!.addEventListener('click', resetView);

/** Append a stop to the staged path, allowing revisits (hub-and-spoke). */
function addStop(id: string) {
  // Ignore a double-click on the current endpoint (no zero-length leg).
  if (selected.length && selected[selected.length - 1] === id) return;
  selected = [...selected, id];
  render();
}

// ---- Airport popover (acquire rights from the map) ------------------------

const formatPop = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}K`;

/**
 * Weekly O&D passenger pool this airport would exchange with the airports you
 * already serve — i.e. how much traffic acquiring it would feed your network.
 */
function networkDemand(ap: Airport): number {
  let total = 0;
  for (const other of game.airports) {
    if (other.id === ap.id || !holdsRights(game, other.id)) continue;
    total += pairDemand(ap, other) * distanceFactor(distanceKm(ap, other));
  }
  return total;
}

let lastHoveredAirport: string | null = null;
let hidePopoverTimer: ReturnType<typeof setTimeout> | null = null;

function hideAirportPopover() {
  if (hidePopoverTimer) { clearTimeout(hidePopoverTimer); hidePopoverTimer = null; }
  popAirport = null;
  lastHoveredAirport = null;
  popover.style.display = 'none';
}

/** Show airport info popover for any airport state (held, acquirable, locked). */
function showAirportInfo(ap: Airport, px: number, py: number) {
  if (hidePopoverTimer) { clearTimeout(hidePopoverTimer); hidePopoverTimer = null; }
  popAirport = ap.id;
  const held = holdsRights(game, ap.id);
  const acquirable = !held && rightsAvailable(game, ap.id);
  const fee = rightsFee(game, ap);
  const afford = game.cash >= fee;
  const demand = Math.round(networkDemand(ap));
  const tier = '●'.repeat(ap.size) + '○'.repeat(Math.max(0, 6 - ap.size));

  const slotsUsed = airportSlotsUsed(game, ap.id);
  const slotsTotal = airportSlotsTotal(ap);
  const slotsFull = slotsUsed >= slotsTotal;

  // Distance: from the measuring pin, else the route being built, else the
  // nearest held airport.
  let distRow = '';
  const pin = measureFrom && measureFrom !== ap.id ? airportById(game, measureFrom) : null;
  const pathEnd = selected.length
    ? airportById(game, selected[selected.length - 1])
    : null;
  if (pin) {
    distRow = `<div class="pop-row"><span class="muted">From ${pin.code} (pinned)</span><span>${distanceKm(pin, ap).toLocaleString()} km</span></div>`;
  } else if (pathEnd && pathEnd.id !== ap.id) {
    distRow = `<div class="pop-row"><span class="muted">From ${pathEnd.code} (path end)</span><span>${distanceKm(pathEnd, ap).toLocaleString()} km</span></div>`;
  } else if (!pathEnd) {
    const near = nearestHeldAirport(game, ap);
    if (near)
      distRow = `<div class="pop-row"><span class="muted">From ${near.code} (your nearest)</span><span>${distanceKm(near, ap).toLocaleString()} km</span></div>`;
  }

  let extra = '';
  if (held) {
    const routesHere = game.routes.filter((r) => r.stops.includes(ap.id)).length;
    const planesHere = game.fleet.filter((p) => {
      const r = game.routes.find((r) => r.id === p.routeId);
      return r?.stops.includes(ap.id);
    }).length;
    extra = `<div class="pop-row"><span class="muted">Your operation</span><span>${routesHere} route${routesHere !== 1 ? 's' : ''} · ${planesHere} plane${planesHere !== 1 ? 's' : ''}</span></div>`;
  } else if (slotsFull) {
    extra = `<div class="tiny muted" style="margin-top:6px">No slots available (${slotsUsed}/${slotsTotal} taken)</div>`;
  } else if (acquirable) {
    extra = `
      <div class="pop-row"><span class="muted">Landing-rights fee</span><span class="${afford ? '' : 'bad'}">${money(fee)}</span></div>
      <button class="pop-buy ${afford ? 'primary' : ''}" data-pop="buy" ${afford ? '' : 'disabled'}>
        ${afford ? `Acquire · ${money(fee)}` : `Need ${money(fee)}`}</button>`;
  } else {
    const need = requiredReputation(ap);
    extra = `<div class="tiny muted" style="margin-top:6px">Locked — needs a ${need}-airport network (you have ${reputation(game)})</div>`;
  }

  popover.innerHTML = `
    <div class="pop-head">
      <span><strong>${ap.code}</strong> · ${ap.city}${held ? ' <span class="good">✓</span>' : ''}</span>
      <button class="pop-x" data-pop="close" title="Close">✕</button>
    </div>
    <div class="pop-row"><span class="muted">Population</span><span>${formatPop(ap.population)}</span></div>
    <div class="pop-row"><span class="muted">Market tier</span><span class="tier">${tier}</span></div>
    <div class="pop-row"><span class="muted">Airline slots</span><span class="${slotsFull && !held ? 'bad' : ''}">${slotsUsed} / ${slotsTotal}</span></div>
    ${distRow}
    <div class="pop-row"><span class="muted">Demand to your network</span><span>${demand.toLocaleString()}/wk</span></div>
    ${extra}
    <div class="tiny muted" style="margin-top:6px">⇧-click ${measureFrom === ap.id ? 'to unpin' : 'to measure from here'}</div>`;

  popover.style.display = 'block';
  const wrapW = mapWrap.clientWidth;
  const wrapH = mapWrap.clientHeight;
  const pw = popover.offsetWidth;
  const ph = popover.offsetHeight;
  let x = px + 18;
  if (x + pw > wrapW - 8) x = px - 18 - pw;
  x = Math.max(8, Math.min(x, wrapW - pw - 8));
  let y = py - ph / 2;
  y = Math.max(8, Math.min(y, wrapH - ph - 8));
  popover.style.left = `${x}px`;
  popover.style.top = `${y}px`;
}

// Keep the popover alive while the mouse is over it (so the user can click Acquire).
popover.addEventListener('mouseenter', () => {
  if (hidePopoverTimer) { clearTimeout(hidePopoverTimer); hidePopoverTimer = null; }
});
popover.addEventListener('mouseleave', () => { hideAirportPopover(); });

popover.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('[data-pop]') as HTMLElement | null;
  if (!btn) return;
  if (btn.dataset.pop === 'close') {
    hideAirportPopover();
  } else if (btn.dataset.pop === 'buy' && popAirport) {
    flash(acquireRights(game, popAirport));
    hideAirportPopover();
    render();
  }
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    hideAirportPopover();
    if (measureFrom) {
      measureFrom = null;
      drawMap();
    }
  }
});

// ---- HUD + sidebar --------------------------------------------------------

function dateStr(): string {
  return new Date(START_EPOCH + game.day * 86_400_000).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

type View = 'map' | 'finance';
let currentView: View = 'map';

function setView(view: View) {
  currentView = view;
  stageEl.classList.toggle('hidden', view !== 'map');
  financeEl.classList.toggle('hidden', view !== 'finance');
  document
    .querySelectorAll('#views-nav .view-tab')
    .forEach((b) => b.classList.toggle('active', (b as HTMLElement).dataset.view === view));
  if (view === 'finance') renderFinance(game, financeEl);
  else resizeCanvas(); // map was hidden (zero-size); re-fit now that it's visible
}

document.getElementById('views-nav')!.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('[data-view]') as HTMLElement | null;
  if (btn) setView(btn.dataset.view as View);
});

function render() {
  renderHud();
  renderSidebar();
  renderLog();
  drawMap();
  if (currentView === 'finance') renderFinance(game, financeEl);
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

// Cards the player has collapsed. Persists across re-renders so a game tick
// doesn't pop a card back open.
const collapsedCards = new Set<string>();

/** A titled card whose body collapses when its header is clicked. */
function collapsibleCard(id: string, title: string, body: string): string {
  const open = !collapsedCards.has(id);
  return `<div class="card">
    <h3 class="card-head" data-act="toggle-card" data-card="${id}">
      <span class="chev">${open ? '▾' : '▸'}</span>${title}</h3>
    ${open ? body : ''}</div>`;
}

function renderSidebar() {
  sidebar.innerHTML =
    newRouteCard() + rightsCard() + buyCard() + bankCard() + routesCard() + fleetCard();
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

const PROPULSION_LABEL = { prop: 'Piston', turboprop: 'Turboprop', jet: 'Jet' };

function buyCard(): string {
  const rows = game.aircraftTypes
    .filter((t) => typeAvailable(game, t))
    .map((t) => {
      const afford = game.cash >= t.price;
      const label = afford ? `Buy · ${money(t.price)}` : `Need ${money(t.price)}`;
      const owned = game.fleet.filter((p) => p.typeId === t.id).length;
      return `<div class="plane-line">
        <div class="row"><strong>${t.name}</strong>
          <button class="${afford ? 'primary' : ''}" data-act="buy" data-type="${t.id}" ${afford ? '' : 'disabled'}>${label}</button></div>
        <div class="type-stats">${PROPULSION_LABEL[t.propulsion]} · ${t.introduced} · ${t.capacity} seats · ${t.range.toLocaleString()} km range · ${t.speed} km/h · $${t.costPerKm}/km · ${money(t.weeklyUpkeep)}/wk upkeep · <span class="owned">${owned} owned</span></div>
      </div>`;
    })
    .join('');
  // Tease the next type to enter service so progression is visible.
  const year = currentYear(game);
  const upcoming = game.aircraftTypes
    .filter((t) => t.introduced > year)
    .sort((a, b) => a.introduced - b.introduced)[0];
  const teaser = upcoming
    ? `<div class="tiny muted" style="margin-top:10px">Coming in ${upcoming.introduced}: ${upcoming.name}</div>`
    : '';
  return collapsibleCard('buy', 'Buy Aircraft', rows + teaser);
}

function rightsCard(): string {
  const rep = reputation(game);
  const notHeld = game.airports.filter((a) => !holdsRights(game, a.id));
  const available = notHeld.filter((a) => rightsAvailable(game, a.id));
  const locked = notHeld.filter((a) => !rightsAvailable(game, a.id));

  let next: string;
  if (available.length) {
    next = '';
  } else if (locked.length) {
    const a = [...locked].sort((x, y) => requiredReputation(x) - requiredReputation(y))[0];
    next = `<div class="tiny muted">Next unlock: <strong>${a.code}</strong> at a ${requiredReputation(a)}-airport network.</div>`;
  } else {
    next = `<div class="tiny good">You hold rights everywhere.</div>`;
  }

  const lockedNote = locked.length ? ` <span class="muted">· 🔒 ${locked.length} still locked.</span>` : '';
  const body = `
    <div class="row"><span class="muted">Network</span><strong>${rep} airport${rep === 1 ? '' : 's'}</strong></div>
    <div class="tiny" style="margin:6px 0">Click a <span class="good">green-ringed</span> airport on the map to acquire its rights.${lockedNote}</div>
    ${next}`;
  return collapsibleCard('rights', 'Landing Rights', body);
}

function bankCard(): string {
  const limit = creditLimit(game);
  const credit = Math.max(0, limit - game.debt);
  const rate = interestRate(game);
  const weeklyInterest = game.debt * rate * (7 / 365);
  const earnRate = depositRate(game);
  const weeklyEarned = cashInterestWeekly(game);
  // Right-size the buttons so the label matches what actually happens.
  const borrowAmt = Math.min(5_000_000, credit);
  const repayAmt = Math.min(game.cash < 5_000_000 ? 1_000_000 : 5_000_000, game.debt, Math.max(0, game.cash));
  return `<div class="card"><h3>Bank</h3>
    <div class="row"><span class="muted">Debt</span><strong>${money(game.debt)}</strong></div>
    <div class="row"><span class="muted">Credit line</span><span>${money(credit)} of ${money(limit)}</span></div>
    <div class="row"><span class="muted">Rate</span><span>${(rate * 100).toFixed(1)}%/yr · <span class="bad">-${money(weeklyInterest)}/wk</span></span></div>
    <div class="row"><span class="muted">Cash earns</span><span>${(earnRate * 100).toFixed(1)}%/yr · <span class="good">+${money(weeklyEarned)}/wk</span></span></div>
    <div class="row" style="margin-top:10px">
      <button data-act="borrow" data-amt="${borrowAmt}" ${credit > 0 ? '' : 'disabled'}>Borrow ${money(borrowAmt)}</button>
      <button data-act="repay" data-amt="${repayAmt}" ${game.debt > 0 && game.cash > 0 ? '' : 'disabled'}>Repay ${money(repayAmt)}</button>
    </div></div>`;
}

function routesCard(): string {
  if (game.routes.length === 0)
    return collapsibleCard('routes', 'Routes', '<div class="muted">No routes yet.</div>');
  const net = evaluateNetwork(game);
  const rows = game.routes
    .map((r) => {
      const dist = routeDistance(game, r);
      const res = net.routes.get(r.id)!;
      const n = planesOnRoute(game, r.id).length;
      const load = Math.round(res.loadFactor * 100);
      const loadCls = load >= 90 ? 'good' : load >= 75 ? 'warn' : 'bad';
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
        <div class="tiny">${dist.toLocaleString()} km · ${r.stops.length - 1} legs · ${n} plane${n === 1 ? '' : 's'} · ${Math.round(res.passengers).toLocaleString()} pax/wk · <span class="${loadCls}">${load}% load</span>${premTag}${
          res.connectingPassengers >= 1
            ? ` · <span class="good">${Math.round(res.connectingPassengers).toLocaleString()} connecting</span>`
            : ''
        }</div>
        <div class="row" style="margin-top:6px">
          <span class="muted">Fare <input type="number" min="20" max="300" step="5" value="${Math.round(r.fareFactor * 100)}" data-act="fare" data-route="${r.id}">%</span>
          ${upgradeCandidates(r).length ? `<button class="upgrade-btn" data-act="open-upgrade" data-route="${r.id}">↑ Upgrade</button>` : ''}
        </div>
      </div>`;
    })
    .join('');
  return collapsibleCard('routes', `Routes (${game.routes.length})`, rows);
}

/** In-range types worth upgrading a route's fleet to — strictly pricier than what it flies. */
function upgradeCandidates(r: Route): AircraftType[] {
  const planes = planesOnRoute(game, r.id);
  if (planes.length === 0) return [];
  const longest = routeMaxLeg(game, r);
  const floor = Math.max(...planes.map((p) => typeById(game, p.typeId).price));
  return availableTypes(game).filter((t) => t.range >= longest && t.price > floor);
}

function fleetCard(): string {
  if (game.fleet.length === 0)
    return collapsibleCard('fleet', 'Fleet', '<div class="muted">No aircraft. Buy one above.</div>');
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
      const resale = planeResaleValue(game, plane);
      return `<div class="plane-line">
        <div class="row"><strong>${t.name.split(' (')[0]}</strong>
          <button class="close-x" data-act="sell-plane" data-plane="${plane.id}" title="Sell for ${money(resale)}">Sell ${money(resale)}</button></div>
        <select style="width:100%;margin-top:4px" data-act="assign" data-plane="${plane.id}">${options}</select>
      </div>`;
    })
    .join('');
  return collapsibleCard('fleet', `Fleet (${game.fleet.length})`, rows);
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
    case 'toggle-card': {
      const id = btn.dataset.card!;
      if (collapsedCards.has(id)) collapsedCards.delete(id);
      else collapsedCards.add(id);
      renderSidebar();
      break;
    }
    case 'close-route':
      closeRoute(game, btn.dataset.route!);
      render();
      break;
    case 'sell-plane':
      flash(sellPlane(game, btn.dataset.plane!));
      render();
      break;
    case 'open-upgrade':
      showUpgradeSelect(btn.dataset.route!);
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

const SAVE_KEY = 'airbucks-save';

/** Shared cleanup after the game state is swapped out (reset or load). */
function afterStateSwap() {
  selected = [];
  anim.clear();
  playing = false;
  dayAccumulator = 0;
  lastTs = 0;
  playBtn.textContent = '▶ Play';
  playBtn.classList.remove('paused');
}

const homeSelectEl = document.getElementById('home-select')!;
const homeAirportList = document.getElementById('home-airport-list')!;

function showHomeSelect() {
  const eligible = AIRPORTS.filter((a) => a.size <= MAX_HOME_SIZE)
    .slice()
    .sort((a, b) => b.size - a.size || a.city.localeCompare(b.city));
  homeAirportList.innerHTML = '';
  for (const ap of eligible) {
    const btn = document.createElement('button');
    btn.className = 'home-ap-btn';
    btn.innerHTML =
      `<span class="ap-code">${ap.code}</span>` +
      `<span class="ap-city">${ap.city}</span>` +
      `<span class="ap-pop">${(ap.population / 1_000_000).toFixed(1)}M</span>`;
    btn.addEventListener('click', () => {
      homeSelectEl.classList.add('hidden');
      Object.assign(game, newGame(ap.id));
      afterStateSwap();
      render();
    });
    homeAirportList.appendChild(btn);
  }
  homeSelectEl.classList.remove('hidden');
}

const upgradeSelectEl = document.getElementById('upgrade-select')!;
const upgradeTitleEl = document.getElementById('upgrade-title')!;
const upgradeSubEl = document.getElementById('upgrade-sub')!;
const upgradeListEl = document.getElementById('upgrade-list')!;

const hideUpgradeSelect = () => upgradeSelectEl.classList.add('hidden');

/** Popup (starter-airport style) to swap a route's whole fleet to a newer type. */
function showUpgradeSelect(routeId: string) {
  const r = game.routes.find((x) => x.id === routeId);
  if (!r) return;
  const candidates = upgradeCandidates(r);
  if (candidates.length === 0) return;
  const planes = planesOnRoute(game, r.id);
  // Describe what's flying the route now, e.g. "2 × Dash 8 Q400".
  const counts = new Map<string, number>();
  for (const p of planes) counts.set(p.typeId, (counts.get(p.typeId) ?? 0) + 1);
  const current = [...counts]
    .map(([id, n]) => `${n} × ${typeById(game, id).name.split(' (')[0]}`)
    .join(', ');

  upgradeTitleEl.textContent = `↑ Upgrade fleet · ${routeLabel(game, r)}`;
  upgradeSubEl.textContent = `Flying ${current} now. Picking a type sells the current plane${planes.length === 1 ? '' : 's'} and buys replacements in place — the route stays covered.`;
  upgradeListEl.innerHTML = '';
  for (const t of candidates) {
    const q = upgradeRouteQuote(game, r.id, t.id);
    const afford = game.cash >= q.net;
    const delta = `${q.net >= 0 ? '+' : '−'}${money(Math.abs(q.net))}`;
    const netCls = q.net < 0 ? 'good' : afford ? '' : 'bad';
    const btn = document.createElement('button');
    btn.className = 'upgrade-opt';
    btn.disabled = !afford;
    btn.innerHTML =
      `<div class="up-top"><span class="up-name">${t.name.split(' (')[0]}</span>` +
      `<span class="up-stats">${t.capacity} seats · ${t.range.toLocaleString()} km · ${t.speed} km/h</span></div>` +
      `<div class="up-bot"><span class="up-calc">buy ${money(q.buyCost)} − sell ${money(q.resale)}</span>` +
      `<span class="up-net ${netCls}">${afford ? delta : `need ${money(q.net)}`}</span></div>`;
    btn.addEventListener('click', () => {
      hideUpgradeSelect();
      flash(upgradeRoute(game, r.id, t.id));
      render();
    });
    upgradeListEl.appendChild(btn);
  }
  upgradeSelectEl.classList.remove('hidden');
}

// Dismiss the upgrade popup: Cancel button, backdrop click, or Escape.
document.getElementById('upgrade-cancel')!.addEventListener('click', hideUpgradeSelect);
upgradeSelectEl.addEventListener('click', (e) => {
  if (e.target === upgradeSelectEl) hideUpgradeSelect();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideUpgradeSelect();
});

/** Reset to a fresh airline — shows home airport selection first. */
function resetGame() {
  afterStateSwap();
  showHomeSelect();
}

function saveGame(announce = false) {
  try {
    localStorage.setItem(SAVE_KEY, serialize(game));
    if (announce) {
      game.log.unshift('Game saved.');
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
    game.log.unshift('Game loaded.');
    render();
  } else {
    flash('No saved game found.');
  }
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
  const netInterest = w.interestEarned - w.interest; // +earned, −paid
  game.log.unshift(
    `Week ${weekNumber(game) - 1}: ${Math.round(w.pax).toLocaleString()} pax · ` +
      `rev ${money(w.revenue)} · cost ${money(w.cost)} · ` +
      `int ${netInterest >= 0 ? '+' : ''}${money(netInterest)} · net ${w.net >= 0 ? '+' : ''}${money(w.net)}.`,
  );
  renderLog();
}

function frame(ts: number) {
  const dt = lastTs ? ts - lastTs : 0;
  lastTs = ts;
  let sidebarDirty = false;
  if (playing) {
    dayAccumulator += (dt * speed) / DAY_MS;
    while (dayAccumulator >= 1) {
      dayAccumulator -= 1;
      advanceDay(game);
      sidebarDirty = true;
      if (game.day % 7 === 0) {
        logWeekly();
        recordFinanceSnapshot(game);
      }
    }
    updateAnimations(dt);
  }
  renderHud();
  if (sidebarDirty && !sidebar.contains(document.activeElement)) renderSidebar();
  if (sidebarDirty && currentView === 'finance') renderFinance(game, financeEl);
  drawMap();
  requestAnimationFrame(frame);
}

window.addEventListener('resize', resizeCanvas);

// Persistence: resume the last session, autosave periodically, save on exit.
if (!loadGame()) showHomeSelect();
window.addEventListener('beforeunload', () => saveGame());
setInterval(() => saveGame(), 5000);

loadMap();
resizeCanvas();
render();
requestAnimationFrame(frame);
