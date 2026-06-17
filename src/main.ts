import './ui/styles.css';
import type { AircraftType, Airline, Airport, GameState, Route } from './game/types';
import {
  advanceDay,
  airlineAssets,
  airportById,
  assignPlane,
  availableTypes,
  financeMetrics,
  finalStats,
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
  isNegotiating,
  negotiationFor,
  firstSlotInstant,
  negotiationDays,
  negotiationCapFor,
  isEasySlot,
  regionalBonusAvailable,
  concurrentCap,
  effectiveConcurrentCap,
  mergerBoostActive,
  mergerBoostUntil,
  gateFee,
  sellSlot,
  sellRefund,
  startNegotiation,
  money,
  MAX_HOME_SIZE,
  MAX_ROUTE_LEGS,
  nearestHeldAirport,
  newGame,
  openRoute,
  pairDemand,
  planesOnRoute,
  player,
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
  shortPlaneName,
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
  priceLevel,
  START_EPOCH,
} from './game/engine';
import { distanceKm } from './game/geo';
import { addAiAirlines, MAX_AI_AIRLINES, runAI } from './game/ai';
import { acquire, buyoutPrice } from './game/distress';
import { applySave, deserialize, serialize } from './game/persist';
import { AIRPORTS } from './game/data';
import { renderFinance } from './ui/finance';
import { renderCompetitors } from './ui/competitors';
import { renderAwards } from './ui/awards';

const game: GameState = newGame('crw');
/** The player's airline (always airlines[0]); resolved per call since loads/resets swap state. */
const pl = () => player(game);
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
      selected = ids;
      render();
    },
    screenOf: (id: string) =>
      airportScreen(id, canvas.clientWidth, canvas.clientHeight),
    evaluate: (r: string) =>
      evaluateRoute(game, pl(), pl().routes.find((x) => x.id === r)!),
  };
}

/** Ordered airports the player has clicked to stage a new (possibly multi-stop) route. */
let selected: string[] = [];

/** Whether competitor route networks are drawn on the map (toggleable). */
let showCompetitors = true;

/** Aircraft type whose Buy button is mid "✓ Added" confirmation flash, if any. */
let justBoughtType: string | null = null;
let boughtTimer: ReturnType<typeof setTimeout> | null = null;

/** Win tracking: once the player has had rivals, being the last airline wins. */
let everHadRivals = false;
let winShown = false;

/** Rights we've already announced — anything new triggers the slot-granted popup. */
let knownRights = new Set(pl().rights);
/** Airports whose popups are waiting behind the one on screen. */
const slotQueue: string[] = [];

/** AI airlines already announced as for-sale, so a listing only pops once. */
let knownForSale = new Set(game.airlines.filter((a) => a.forSale).map((a) => a.id));
/** Distressed airlines waiting behind the popup on screen. */
const distressQueue: string[] = [];

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
const competitorsEl = document.getElementById('competitors')!;
const awardsEl = document.getElementById('awards')!;

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
// Scale 1 already fits the whole globe, so don't let the user zoom out past it.
const MIN_SCALE = 1;
// The map now fits the whole globe at scale 1, so allow a deep zoom to reach
// city level (the old cap of 8 was sized for the North-America-only map).
const MAX_SCALE = 24;
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
  // US states for home-region detail, plus world country outlines for everywhere else.
  const results = await Promise.allSettled(
    ['./world-countries.json', './us-states.json'].map(async (url) => {
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
  if (w === 0 || h === 0) return; // canvas is hidden (Finance/Awards tab) — nothing to draw
  const dpr = window.devicePixelRatio || 1;
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(ensureBaseMap(w, h, dpr), 0, 0, w, h);

  // Competitor route networks, drawn first so the player's sit on top — thin
  // and dim, in each airline's color (a for-sale rival's network is dashed).
  if (showCompetitors) {
    ctx.lineWidth = 1;
    for (const airline of game.airlines) {
      if (airline === pl()) continue;
      ctx.strokeStyle = airline.color;
      ctx.globalAlpha = 0.32;
      ctx.setLineDash(airline.forSale ? [3, 4] : []);
      for (const route of airline.routes) {
        const pts = pathPoints(route.stops, w, h);
        ctx.beginPath();
        pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);
  }

  // Routes (multi-leg polylines).
  const net = evaluateNetwork(game, pl());
  for (const route of pl().routes) {
    const pts = pathPoints(route.stops, w, h);
    const res = net.routes.get(route.id)!;
    const hasPlanes = planesOnRoute(pl(), route.id).length > 0;
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
  for (const plane of pl().fleet) {
    if (!plane.routeId) continue;
    const route = pl().routes.find((r) => r.id === plane.routeId);
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
    const held = holdsRights(pl(), ap.id);
    const pending = !held && isNegotiating(pl(), ap.id);
    const acquirable = !held && rightsAvailable(game, pl(), ap.id);
    ctx.globalAlpha = held ? 1 : pending || acquirable ? 0.7 : 0.28;

    if (ap.id === pl().homeId) {
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
    else if (pending) pendingRing(p.x, p.y, r + 3);

    // Hide labels for small airports when zoomed out; home always shows.
    const isHome = ap.id === pl().homeId;
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

/** Amber dashed ring: a slot application is in progress here. */
function pendingRing(x: number, y: number, r: number) {
  ctx.save();
  ctx.globalAlpha = 0.95;
  ctx.setLineDash([2, 4]);
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#f5a623';
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
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
  for (const plane of pl().fleet) {
    if (!plane.routeId) continue;
    const route = pl().routes.find((r) => r.id === plane.routeId);
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
  if (showPopoverTimer) { clearTimeout(showPopoverTimer); showPopoverTimer = null; }
  if (found) {
    // Brief pause before opening, so sweeping the mouse across airports
    // doesn't flash a popover for each one.
    const ap = found;
    const px = foundPx;
    const py = foundPy;
    showPopoverTimer = setTimeout(() => {
      showPopoverTimer = null;
      showAirportInfo(ap, px, py);
    }, 150);
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
      if (holdsRights(pl(), ap.id)) {
        hideAirportPopover();
        addStop(ap.id);
      } else if (rightsAvailable(game, pl(), ap.id) || isNegotiating(pl(), ap.id)) {
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

/** Center the view on an airport at a regional zoom (e.g. a new game's home). */
function zoomToAirport(id: string, scale = 5) {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w === 0 || h === 0) return;
  const a = airportById(game, id);
  const p = projectPoint(a.lat, a.lon, w, h);
  view.scale = clampScale(scale);
  view.offsetX = w / 2 - p.x * view.scale;
  view.offsetY = h / 2 - p.y * view.scale;
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

const toggleCompetitorsBtn = document.getElementById('toggle-competitors')!;
toggleCompetitorsBtn.addEventListener('click', () => {
  showCompetitors = !showCompetitors;
  toggleCompetitorsBtn.classList.toggle('active', showCompetitors);
  drawMap();
});

/** Append a stop to the staged path, allowing revisits (hub-and-spoke). */
function addStop(id: string) {
  // Ignore a double-click on the current endpoint (no zero-length leg).
  if (selected.length && selected[selected.length - 1] === id) return;
  if (selected.length - 1 >= MAX_ROUTE_LEGS) {
    flash(`A route can have at most ${MAX_ROUTE_LEGS} legs.`);
    return;
  }
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
    if (other.id === ap.id || !holdsRights(pl(), other.id)) continue;
    total += pairDemand(ap, other) * distanceFactor(distanceKm(ap, other));
  }
  return total;
}

let lastHoveredAirport: string | null = null;
let hidePopoverTimer: ReturnType<typeof setTimeout> | null = null;
let showPopoverTimer: ReturnType<typeof setTimeout> | null = null;

function hideAirportPopover() {
  if (hidePopoverTimer) { clearTimeout(hidePopoverTimer); hidePopoverTimer = null; }
  if (showPopoverTimer) { clearTimeout(showPopoverTimer); showPopoverTimer = null; }
  popAirport = null;
  lastHoveredAirport = null;
  popover.style.display = 'none';
}

/** Show airport info popover for any airport state (held, acquirable, locked). */
function showAirportInfo(ap: Airport, px: number, py: number) {
  if (hidePopoverTimer) { clearTimeout(hidePopoverTimer); hidePopoverTimer = null; }
  if (showPopoverTimer) { clearTimeout(showPopoverTimer); showPopoverTimer = null; }
  popAirport = ap.id;
  const held = holdsRights(pl(), ap.id);
  const acquirable = !held && rightsAvailable(game, pl(), ap.id);
  const fee = rightsFee(game, ap);
  const afford = pl().cash >= fee;
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
    const near = nearestHeldAirport(game, pl(), ap);
    if (near)
      distRow = `<div class="pop-row"><span class="muted">From ${near.code} (your nearest)</span><span>${distanceKm(near, ap).toLocaleString()} km</span></div>`;
  }

  const pending = negotiationFor(pl(), ap.id);
  const cap = negotiationCapFor(game, pl(), ap);
  const atCap = pl().negotiations.length >= cap;

  let extra = '';
  if (held) {
    const routesHere = pl().routes.filter((r) => r.stops.includes(ap.id)).length;
    const planesHere = pl().fleet.filter((p) => {
      const r = pl().routes.find((r) => r.id === p.routeId);
      return r?.stops.includes(ap.id);
    }).length;
    const isHome = ap.id === pl().homeId;
    const refund = sellRefund(game, ap);
    extra = `
      <div class="pop-row"><span class="muted">Your operation</span><span>${routesHere} route${routesHere !== 1 ? 's' : ''} · ${planesHere} plane${planesHere !== 1 ? 's' : ''}</span></div>
      ${isHome
        ? '<div class="pop-row"><span class="muted">Gate fee</span><span class="good">home — free</span></div>'
        : `<div class="pop-row"><span class="muted">Gate fee</span><span>${money(gateFee(game, ap))}/yr</span></div>`}
      ${isHome
        ? ''
        : routesHere > 0
          ? `<div class="tiny muted" style="margin-top:6px">Close its ${routesHere} route${routesHere !== 1 ? 's' : ''} to sell this slot.</div>`
          : `<button class="pop-buy" data-pop="sell">Sell slot · +${money(refund)}</button>`}`;
  } else if (pending) {
    extra = `<div class="pop-row"><span class="muted">Slot application</span><span class="good">opens ${monthYear(pending.opensDay)}</span></div>`;
  } else if (slotsFull) {
    extra = `<div class="tiny muted" style="margin-top:6px">No slots available (${slotsUsed}/${slotsTotal} taken)</div>`;
  } else if (acquirable) {
    const instant = firstSlotInstant(pl());
    const months = Math.round(negotiationDays(ap) / 30);
    const easy = isEasySlot(game, pl(), ap);
    const blocked = !afford || atCap;
    const label = !afford
      ? `Need ${money(fee)}`
      : atCap
        ? `Limit reached (${pl().negotiations.length}/${cap})`
        : instant
          ? `Acquire slot · ${money(fee)}`
          : `Apply for slot · ${money(fee)}`;
    const timing = instant
      ? `<span class="good">opens immediately (first slot)</span>`
      : `~${months} mo${easy ? ' · quick regional' : ''} · ${pl().negotiations.length}/${cap} open`;
    extra = `
      <div class="pop-row"><span class="muted">Slot fee</span><span class="${afford ? '' : 'bad'}">${money(fee)}</span></div>
      <div class="pop-row"><span class="muted">Negotiation</span><span>${timing}</span></div>
      <button class="pop-buy ${blocked ? '' : 'primary'}" data-pop="buy" ${blocked ? 'disabled' : ''}>${label}</button>`;
  } else {
    const need = requiredReputation(ap);
    extra = `<div class="tiny muted" style="margin-top:6px">Locked — needs a ${need}-airport network (you have ${reputation(pl())})</div>`;
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
    flash(startNegotiation(game, pl(), popAirport));
    hideAirportPopover();
    render();
    announceNewRights(); // the very first slot is granted instantly
  } else if (btn.dataset.pop === 'sell' && popAirport) {
    flash(sellSlot(game, pl(), popAirport));
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

/** Month + year label for an arbitrary simulated day, e.g. "Aug 1985". */
function monthYear(day: number): string {
  return new Date(START_EPOCH + day * 86_400_000).toLocaleDateString('en-US', {
    month: 'short',
    year: 'numeric',
  });
}

type View = 'map' | 'finance' | 'competitors' | 'awards';
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
  else if (view === 'competitors') renderCompetitors(game, competitorsEl);
  else if (view === 'awards') renderAwards(game, awardsEl);
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
  else if (currentView === 'competitors') renderCompetitors(game, competitorsEl);
  else if (currentView === 'awards') renderAwards(game, awardsEl);
}

// Buy a rival off the Competitors tab — distressed (fire-sale) or healthy
// (market price). The acquisition logs to the player's news feed; sync
// knownRights so the bulk of inherited cities doesn't fire a postcard per city.
competitorsEl.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('[data-act="buy-airline"]') as HTMLElement | null;
  if (btn) {
    const target = game.airlines.find((a) => a.id === btn.dataset.airline);
    if (!target || target === pl() || pl().cash < buyoutPrice(game, target)) return;
    acquire(game, pl(), target);
    knownRights = new Set(pl().rights);
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
  `;
}

// Cards the player has collapsed. Persists across re-renders so a game tick
// doesn't pop a card back open.
const collapsedCards = new Set<string>();

// How the Routes card is sorted. null key = creation order (the default until
// the player clicks a header). Persists across re-renders.
type RouteSortKey = 'name' | 'profit' | 'load';
let routeSort: { key: RouteSortKey | null; dir: 'asc' | 'desc' } = { key: null, dir: 'desc' };

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
    const legs = selected.length - 1;
    const more =
      legs >= MAX_ROUTE_LEGS
        ? `at the ${MAX_ROUTE_LEGS}-leg limit`
        : 'click more stops (you can revisit a hub)';
    info = `<div class="row"><strong>${names}</strong><span class="pill">${stagedDistance().toLocaleString()} km</span></div>
      <div class="tiny">${legs} leg${legs === 1 ? '' : 's'} · ${more}</div>`;
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
  // Operating costs are quoted in current-era dollars, matching what the
  // finance and route panels actually charge.
  const lvl = priceLevel(game);
  const rows = game.aircraftTypes
    .filter((t) => typeAvailable(game, t))
    .map((t) => {
      const afford = pl().cash >= t.price;
      // Briefly confirm a just-bought type so the click visibly "lands".
      const justBought = t.id === justBoughtType;
      const label = justBought ? '✓ Added' : afford ? `Buy · ${money(t.price)}` : `Need ${money(t.price)}`;
      const cls = justBought ? 'primary bought' : afford ? 'primary' : '';
      const owned = pl().fleet.filter((p) => p.typeId === t.id).length;
      const perKm = (t.costPerKm * lvl).toFixed(1);
      const upkeep = money(Math.round(t.weeklyUpkeep * lvl));
      return `<div class="plane-line">
        <div class="row"><strong>${t.name}</strong>
          <button class="${cls}" data-act="buy" data-type="${t.id}" ${afford ? '' : 'disabled'}>${label}</button></div>
        <div class="type-stats">${PROPULSION_LABEL[t.propulsion]} · ${t.introduced} · ${t.capacity} seats · ${t.range.toLocaleString()} km range · ${t.speed} km/h · $${perKm}/km · ${upkeep}/wk upkeep · <span class="owned">${owned} owned</span></div>
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
  const rep = reputation(pl());
  const notHeld = game.airports.filter((a) => !holdsRights(pl(), a.id));
  const available = notHeld.filter((a) => rightsAvailable(game, pl(), a.id));
  const locked = notHeld.filter((a) => !rightsAvailable(game, pl(), a.id));

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
  const cap = effectiveConcurrentCap(game, pl());
  const boostNote = mergerBoostActive(game, pl())
    ? `<div class="tiny good">⚡ Merger boost: +${cap - concurrentCap(pl())} applications, slots clear faster (until ${monthYear(mergerBoostUntil(game, pl()))}).</div>`
    : '';
  const negs = pl().negotiations.length;
  const negRows = pl().negotiations
    .slice()
    .sort((a, b) => a.opensDay - b.opensDay)
    .map((n) => {
      const a = airportById(game, n.airportId);
      return `<div class="row"><span class="muted">${a.code}</span><span class="tiny good">opens ${monthYear(n.opensDay)}</span></div>`;
    })
    .join('');
  const negBlock = `
    <div class="row" style="margin-top:6px"><span class="muted">Negotiations</span><strong>${negs} in progress</strong></div>
    <div class="tiny muted">${cap} at a time${regionalBonusAvailable(pl()) ? ' (+1 for a quick regional slot)' : ''}</div>${boostNote}${negRows}`;
  const body = `
    <div class="row"><span class="muted">Network</span><strong>${rep} airport${rep === 1 ? '' : 's'}${lockedNote}</strong></div>
    ${negBlock}
    ${next}`;
  return collapsibleCard('rights', 'Landing Rights', body);
}

function bankCard(): string {
  const limit = creditLimit(game, pl());
  const credit = Math.max(0, limit - pl().debt);
  const rate = interestRate(game, pl());
  const weeklyInterest = pl().debt * rate * (7 / 365);
  const earnRate = depositRate(game);
  const weeklyEarned = cashInterestWeekly(game, pl());
  // Leverage vs. the 60% loan-to-value ceiling, so a maxed-out line is legible.
  const assets = airlineAssets(game, pl());
  const leverage = assets > 0 ? pl().debt / assets : 0;
  const maxedByLtv = credit === 0 && leverage >= 0.59;
  // Right-size the buttons so the label matches what actually happens.
  const borrowAmt = Math.min(5_000_000, credit);
  const repayAmt = Math.min(pl().cash < 5_000_000 ? 1_000_000 : 5_000_000, pl().debt, Math.max(0, pl().cash));
  return `<div class="card"><h3>Bank</h3>
    <div class="row"><span class="muted">Debt</span><strong>${money(pl().debt)}</strong></div>
    <div class="row"><span class="muted">Credit line</span><span>${money(credit)} of ${money(limit)}</span></div>
    <div class="row"><span class="muted">Leverage</span><span>${(leverage * 100).toFixed(0)}% of 60% max${maxedByLtv ? ' · <span class="bad">repay or grow assets to borrow</span>' : ''}</span></div>
    <div class="row"><span class="muted">Rate</span><span>${(rate * 100).toFixed(1)}%/yr · <span class="bad">-${money(weeklyInterest)}/wk</span></span></div>
    <div class="row"><span class="muted">Cash earns</span><span>${(earnRate * 100).toFixed(1)}%/yr · <span class="good">+${money(weeklyEarned)}/wk</span></span></div>
    <div class="row" style="margin-top:10px">
      <button data-act="borrow" data-amt="${borrowAmt}" ${credit > 0 ? '' : 'disabled'}>Borrow ${money(borrowAmt)}</button>
      <button data-act="repay" data-amt="${repayAmt}" ${pl().debt > 0 && pl().cash > 0 ? '' : 'disabled'}>Repay ${money(repayAmt)}</button>
    </div></div>`;
}

function routesCard(): string {
  if (pl().routes.length === 0)
    return collapsibleCard('routes', 'Routes', '<div class="muted">No routes yet.</div>');
  const net = evaluateNetwork(game, pl());
  const rows = sortedRoutes(net)
    .map((r) => {
      const dist = routeDistance(game, r);
      const res = net.routes.get(r.id)!;
      const n = planesOnRoute(pl(), r.id).length;
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
        <div class="tiny">${dist.toLocaleString()} km · ${r.stops.length - 1} legs · ${n} plane${n === 1 ? '' : 's'}${n > 0 ? ` (${routePlanesLabel(r)})` : ''} · ${Math.round(res.passengers).toLocaleString()} pax/wk · <span class="${loadCls}">${load}% load</span>${premTag}${
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
  return collapsibleCard('routes', `Routes (${pl().routes.length})`, routeSortBar() + rows);
}

/** Player routes ordered by the current sort (creation order until a header is clicked). */
function sortedRoutes(net: ReturnType<typeof evaluateNetwork>): Route[] {
  const routes = [...pl().routes];
  if (routeSort.key === null) return routes;
  const sign = routeSort.dir === 'asc' ? 1 : -1;
  const key = (r: Route): number | string => {
    const res = net.routes.get(r.id)!;
    if (routeSort.key === 'name') return routeLabel(game, r).toLowerCase();
    if (routeSort.key === 'load') return res.loadFactor;
    return res.profit; // 'profit'
  };
  return routes.sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (ka < kb) return -sign;
    if (ka > kb) return sign;
    return 0;
  });
}

/** Clickable sort headers for the Routes card. */
function routeSortBar(): string {
  const labels: Record<RouteSortKey, string> = { name: 'Name', profit: 'Profit', load: 'Load' };
  const btns = (['name', 'profit', 'load'] as RouteSortKey[])
    .map((k) => {
      const active = routeSort.key === k;
      const arrow = active ? (routeSort.dir === 'asc' ? ' ▴' : ' ▾') : '';
      return `<button class="sort-btn${active ? ' active' : ''}" data-act="sort-routes" data-key="${k}">${labels[k]}${arrow}</button>`;
    })
    .join('');
  return `<div class="route-sort tiny muted">Sort: ${btns}</div>`;
}

/** What's flying a route: "DC-4" · "DC-4 ×2" · "DC-4, Viscount 800". */
function routePlanesLabel(r: Route): string {
  const counts = new Map<string, number>();
  for (const p of planesOnRoute(pl(), r.id)) {
    const name = shortPlaneName(typeById(game, p.typeId).name);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].map(([name, c]) => (c > 1 ? `${name} ×${c}` : name)).join(', ');
}

/** In-range types worth upgrading a route's fleet to — strictly pricier than what it flies. */
function upgradeCandidates(r: Route): AircraftType[] {
  const planes = planesOnRoute(pl(), r.id);
  if (planes.length === 0) return [];
  const longest = routeMaxLeg(game, r);
  const floor = Math.max(...planes.map((p) => typeById(game, p.typeId).price));
  return availableTypes(game).filter((t) => t.range >= longest && t.price > floor);
}

function fleetCard(): string {
  if (pl().fleet.length === 0)
    return collapsibleCard('fleet', 'Fleet', '<div class="muted">No aircraft. Buy one above.</div>');
  const rows = pl().fleet
    .map((plane) => {
      const t = typeById(game, plane.typeId);
      const options = [`<option value="">Hangar (idle)</option>`]
        .concat(
          pl().routes.map((r) => {
            const tooFar = t.range < routeMaxLeg(game, r);
            const sel = plane.routeId === r.id ? 'selected' : '';
            return `<option value="${r.id}" ${sel} ${tooFar ? 'disabled' : ''}>${routeLabel(game, r)}${tooFar ? ' (out of range)' : ''}</option>`;
          }),
        )
        .join('');
      const resale = planeResaleValue(game, plane);
      // Upgrade is a route-wide swap; surface it here on an assigned plane whose
      // route has a better type available, opening the same route-upgrade dialog.
      const route = plane.routeId ? pl().routes.find((r) => r.id === plane.routeId) : undefined;
      const canUpgrade = route && upgradeCandidates(route).length > 0;
      return `<div class="plane-line">
        <div class="row"><strong>${t.name.split(' (')[0]}</strong>
          <span class="row" style="gap:6px">${
            canUpgrade
              ? `<button class="upgrade-btn" data-act="open-upgrade" data-route="${route!.id}" title="Upgrade this route's fleet">↑ Upgrade</button>`
              : ''
          }<button class="close-x" data-act="sell-plane" data-plane="${plane.id}" title="Sell for ${money(resale)}">Sell ${money(resale)}</button></span></div>
        <select style="width:100%;margin-top:4px" data-act="assign" data-plane="${plane.id}">${options}</select>
      </div>`;
    })
    .join('');
  return collapsibleCard('fleet', `Fleet (${pl().fleet.length})`, rows);
}

function renderLog() {
  logEl.innerHTML = pl().log
    .slice(0, 20)
    .map((e) => `<div class="entry">${e}</div>`)
    .join('');
}

// ---- Event delegation -----------------------------------------------------

function flash(message: string | null) {
  if (message) {
    pl().log.unshift(`⚠ ${message}`);
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
      const err = openRoute(game, pl(), selected);
      if (err) flash(err);
      else {
        selected = [];
        render();
      }
      break;
    }
    case 'buy': {
      const err = buyPlane(game, pl(), btn.dataset.type!);
      if (err) {
        flash(err);
      } else {
        // Flash a "✓ Added" confirmation on the button, then revert.
        justBoughtType = btn.dataset.type!;
        if (boughtTimer) clearTimeout(boughtTimer);
        boughtTimer = setTimeout(() => {
          justBoughtType = null;
          renderSidebar();
        }, 850);
      }
      render();
      break;
    }
    case 'borrow':
      borrow(game, pl(), Number(btn.dataset.amt));
      render();
      break;
    case 'repay':
      repay(game, pl(), Number(btn.dataset.amt));
      render();
      break;
    case 'toggle-card': {
      const id = btn.dataset.card!;
      if (collapsedCards.has(id)) collapsedCards.delete(id);
      else collapsedCards.add(id);
      renderSidebar();
      break;
    }
    case 'sort-routes': {
      const key = btn.dataset.key as RouteSortKey;
      if (routeSort.key === key) {
        routeSort.dir = routeSort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        // Sensible default direction per key: A→Z for names, biggest-first for numbers.
        routeSort = { key, dir: key === 'name' ? 'asc' : 'desc' };
      }
      renderSidebar();
      break;
    }
    case 'close-route':
      closeRoute(game, pl(), btn.dataset.route!);
      render();
      break;
    case 'sell-plane':
      flash(sellPlane(game, pl(), btn.dataset.plane!));
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
    flash(assignPlane(game, pl(), el.dataset.plane!, sel.value || null));
    render();
  } else if (el.dataset.act === 'fare') {
    const input = el as unknown as HTMLInputElement;
    setFareFactor(pl(), el.dataset.route!, Number(input.value) / 100);
    render();
  }
});

// ---- Transport controls + real-time loop ----------------------------------

function setPlaying(v: boolean) {
  playing = v;
  lastTs = 0;
  playBtn.textContent = playing ? '⏸ Pause' : '▶ Play';
  playBtn.classList.toggle('paused', playing);
}

playBtn.addEventListener('click', () => setPlaying(!playing));

const SAVE_KEY = 'airbucks-save';

/** Shared cleanup after the game state is swapped out (reset or load). */
function afterStateSwap() {
  selected = [];
  anim.clear();
  setPlaying(false);
  dayAccumulator = 0;
  knownRights = new Set(pl().rights);
  slotQueue.length = 0;
  slotGrantedEl.classList.add('hidden');
  knownForSale = new Set(game.airlines.filter((a) => a.forSale).map((a) => a.id));
  distressQueue.length = 0;
  distressShownId = null;
  distressEl.classList.add('hidden');
  justBoughtType = null;
  everHadRivals = false;
  winShown = false;
  document.getElementById('win-screen')!.classList.add('hidden');
}

const homeSelectEl = document.getElementById('home-select')!;
const homeAirportList = document.getElementById('home-airport-list')!;
const aiCountEl = document.getElementById('ai-count')!;

/** Competitor count for the next new game. Remembered for the session. */
let chosenAiCount = 4;
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
      addAiAirlines(game, chosenAiCount);
      if (chosenAiCount > 0) {
        pl().log.unshift(
          `${chosenAiCount} rival airline${chosenAiCount === 1 ? ' is' : 's are'} setting up: ` +
            game.airlines.slice(1).map((a) => `${a.name} (${a.homeId.toUpperCase()})`).join(', ') + '.',
        );
      }
      afterStateSwap();
      render();
      zoomToAirport(ap.id);
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
  const r = pl().routes.find((x) => x.id === routeId);
  if (!r) return;
  const candidates = upgradeCandidates(r);
  if (candidates.length === 0) return;
  const planes = planesOnRoute(pl(), r.id);
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
    const q = upgradeRouteQuote(game, pl(), r.id, t.id);
    const afford = pl().cash >= q.net;
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
      flash(upgradeRoute(game, pl(), r.id, t.id));
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
  if (e.key === 'Escape') {
    hideUpgradeSelect();
    if (!slotGrantedEl.classList.contains('hidden')) hideSlotGranted();
  }
});

// ---- "Landing rights granted" popup ----------------------------------------

const slotGrantedEl = document.getElementById('slot-granted')!;
const slotPhotoEl = document.getElementById('slot-photo') as HTMLImageElement;
const slotCityEl = document.getElementById('slot-city')!;
const slotStatsEl = document.getElementById('slot-stats')!;
const slotCreditEl = document.getElementById('slot-credit')!;
/** Airport currently shown in the popup. */
let slotShownId: string | null = null;

// The photo (a public-domain vintage postcard bundled per city) only appears
// once it actually loads; cities without one just show the text card.
slotPhotoEl.addEventListener('load', () => {
  slotPhotoEl.classList.remove('hidden');
  slotCreditEl.classList.remove('hidden');
});
slotPhotoEl.addEventListener('error', () => {
  slotPhotoEl.classList.add('hidden');
  slotCreditEl.classList.add('hidden');
});

function showSlotGranted(airportId: string) {
  const ap = airportById(game, airportId);
  slotShownId = airportId;
  slotPhotoEl.classList.add('hidden');
  slotCreditEl.classList.add('hidden');
  slotPhotoEl.src = `/postcards/${ap.id}.jpg`;
  slotCityEl.textContent = `${ap.city} (${ap.code})`;
  const near = nearestHeldAirport(game, pl(), ap);
  const parts = [
    `Market ${'★'.repeat(ap.size)}`,
    `${(ap.population / 1_000_000).toFixed(1)}M metro`,
  ];
  if (near) parts.push(`${Math.round(distanceKm(ap, near)).toLocaleString()} km from ${near.code}`);
  slotStatsEl.textContent = parts.join(' · ');
  slotGrantedEl.classList.remove('hidden');
}

/** Close the popup; if more grants are queued behind it, show the next one. */
function hideSlotGranted() {
  slotShownId = null;
  slotGrantedEl.classList.add('hidden');
  const next = slotQueue.shift();
  if (next) showSlotGranted(next);
  else pumpDistress(); // a distress listing may have been deferred behind this
}

/** Pause and pop up a card for any airport whose rights just arrived. */
function announceNewRights() {
  const fresh = pl().rights.filter((id) => !knownRights.has(id));
  knownRights = new Set(pl().rights);
  if (!fresh.length) return;
  setPlaying(false);
  if (slotShownId === null) showSlotGranted(fresh.shift()!);
  slotQueue.push(...fresh);
}

document.getElementById('slot-later')!.addEventListener('click', hideSlotGranted);
slotGrantedEl.addEventListener('click', (e) => {
  if (e.target === slotGrantedEl) hideSlotGranted();
});
document.getElementById('slot-plan')!.addEventListener('click', () => {
  const id = slotShownId;
  hideSlotGranted();
  if (!id) return;
  setView('map');
  selected = [id];
  render();
});

// ---- "Airline in distress" popup -------------------------------------------

const distressEl = document.getElementById('distress')!;
const distressNameEl = document.getElementById('distress-name')!;
const distressStatsEl = document.getElementById('distress-stats')!;
/** Airline currently shown in the popup. */
let distressShownId: string | null = null;

function showDistress(al: Airline) {
  distressShownId = al.id;
  distressNameEl.textContent = al.name;
  const fs = al.forSale!;
  const debtNote = al.debt > 0 ? `, assumes ${money(al.debt)} debt` : '';
  distressStatsEl.textContent =
    `Up for sale at ${money(fs.price)}${debtNote} · ` +
    `liquidates ${monthYear(fs.deadlineDay)} if no buyer.`;
  distressEl.classList.remove('hidden');
}

/** Close the popup and show the next queued listing, if any. */
function hideDistress() {
  distressShownId = null;
  distressEl.classList.add('hidden');
  pumpDistress();
}

/** Show the next queued listing — unless a slot popup is up; defer to it. */
function pumpDistress() {
  if (distressShownId || slotShownId) return;
  let id = distressQueue.shift();
  // Skip any that were acquired or liquidated before we got to them.
  while (id && !game.airlines.some((a) => a.id === id && a.forSale)) {
    id = distressQueue.shift();
  }
  if (!id) return;
  setPlaying(false);
  showDistress(game.airlines.find((a) => a.id === id)!);
}

/** Pause and pop up a card for any AI airline that just entered distress. */
function announceDistress() {
  for (const al of game.airlines) {
    if (al.ai && al.forSale && !knownForSale.has(al.id)) {
      knownForSale.add(al.id);
      distressQueue.push(al.id);
    }
  }
  pumpDistress();
}

document.getElementById('distress-later')!.addEventListener('click', hideDistress);
distressEl.addEventListener('click', (e) => {
  if (e.target === distressEl) hideDistress();
});
document.getElementById('distress-view')!.addEventListener('click', () => {
  hideDistress();
  setView('competitors');
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

document.getElementById('speeds')!.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('[data-speed]') as HTMLElement | null;
  if (!btn) return;
  speed = Number(btn.dataset.speed);
  document
    .querySelectorAll('#speeds .speed')
    .forEach((b) => b.classList.toggle('active', b === btn));
});

function logWeekly() {
  const w = weeklyTotals(game, pl());
  const netInterest = w.interestEarned - w.interest; // +earned, −paid
  pl().log.unshift(
    `Week ${weekNumber(game) - 1}: ${Math.round(w.pax).toLocaleString()} pax · ` +
      `rev ${money(w.revenue)} · cost ${money(w.cost)} · ` +
      `int ${netInterest >= 0 ? '+' : ''}${money(netInterest)} · net ${w.net >= 0 ? '+' : ''}${money(w.net)}.`,
  );
  renderLog();
}

// ---- Victory ---------------------------------------------------------------

const winScreenEl = document.getElementById('win-screen')!;
const winSubEl = document.getElementById('win-sub')!;
const winStatsEl = document.getElementById('win-stats')!;

const km = (n: number) => `${Math.round(n).toLocaleString()} km`;

/** Build the victory scorecard tiles from the player's final stats. */
function winStatsHtml(): string {
  const s = finalStats(game, pl());
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
function checkWin() {
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
  setPlaying(false);
  const m = financeMetrics(game, pl());
  winSubEl.textContent =
    `${dateStr()} — every competitor has been bought out or driven under. ` +
    `Air Bucks stands alone with ${pl().rights.length} cities and a net worth of ${money(m.equity)}.`;
  winStatsEl.innerHTML = winStatsHtml();
  winScreenEl.classList.remove('hidden');
}

document.getElementById('win-keep')!.addEventListener('click', () => {
  winScreenEl.classList.add('hidden'); // play on; winShown stays true so it won't nag
});
document.getElementById('win-quit')!.addEventListener('click', () => window.close());

function frame(ts: number) {
  const dt = lastTs ? ts - lastTs : 0;
  lastTs = ts;
  let sidebarDirty = false;
  if (playing) {
    dayAccumulator += (dt * speed) / DAY_MS;
    const badgesBefore = pl().badges.length;
    while (dayAccumulator >= 1) {
      dayAccumulator -= 1;
      advanceDay(game);
      runAI(game);
      sidebarDirty = true;
      if (game.day % 7 === 0) {
        logWeekly();
        recordFinanceSnapshot(game, pl());
      }
    }
    if (pl().badges.length > badgesBefore) renderLog(); // surface freshly-earned badges
    if (sidebarDirty) {
      announceNewRights();
      announceDistress();
    }
    updateAnimations(dt);
  }
  checkWin();
  renderHud();
  if (sidebarDirty && !sidebar.contains(document.activeElement)) renderSidebar();
  if (sidebarDirty && currentView === 'finance') renderFinance(game, financeEl);
  if (sidebarDirty && currentView === 'competitors') renderCompetitors(game, competitorsEl);
  if (sidebarDirty && currentView === 'awards') renderAwards(game, awardsEl);
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
