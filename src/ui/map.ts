import type { Airport } from '../game/types';
import {
  airportById,
  evaluateNetwork,
  holdsRights,
  isNegotiating,
  MAX_HOME_SIZE,
  MAX_ROUTE_LEGS,
  pairDemand,
  planesOnRoute,
  requiredReputation,
  rightsAvailable,
  routeDistance,
  typeById,
} from '../game/engine';
import { distanceKm } from '../game/geo';
import { bus, flash, game, pl, spectating, ui } from './app';
import { formatPax } from './format';
import { hideAirportPopover, hoverAirport, showAirportInfo } from './popover';

// Everything drawn on the canvas: projection, pan/zoom, the cached base map,
// routes/airports/planes, the home picker, and the map's mouse interactions.

const canvas = document.getElementById('map') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;

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

/** Screen position of an airport at the canvas's current size (debug helper). */
export const screenOf = (id: string) =>
  airportScreen(id, canvas.clientWidth, canvas.clientHeight);

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
  if (ui.selected.length > 0) {
    const last = airportById(game, ui.selected[ui.selected.length - 1]);
    if (ap.id === last.id) return null; // the path's current endpoint
    return pairDemand(last, ap) / MAX_PAIR_DEMAND;
  }
  return (airportPotential.get(ap.id) ?? 0) / maxPotential;
}

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

export async function loadMap() {
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

/** Whether competitor route networks are drawn on the map (toggleable). */
let showCompetitors = true;

export function drawMap() {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w === 0 || h === 0) return; // canvas is hidden (Finance/Awards tab) — nothing to draw
  const dpr = window.devicePixelRatio || 1;
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(ensureBaseMap(w, h, dpr), 0, 0, w, h);

  if (ui.homeSelecting) {
    drawHomePicker(w, h);
    return;
  }

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
  if (ui.selected.length >= 2) {
    const pts = pathPoints(ui.selected, w, h);
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
    const positions = ui.selected.flatMap((s, i) => (s === ap.id ? [i + 1] : []));
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
    if (ui.selected.length > 0 && v !== null) {
      ctx.fillStyle = heat(v);
      ctx.font = 'bold 11px system-ui';
      ctx.fillText(`${formatPax(v * MAX_PAIR_DEMAND)}/wk`, p.x + 10, p.y + 31);
    }
    drawOrderBadge(p.x, p.y, r, positions);
  }
  ctx.globalAlpha = 1;

  // Measuring pin: ring it and rule a line with km to the hovered airport.
  if (ui.measureFrom) {
    const pin = airportById(game, ui.measureFrom);
    const pp = airportScreen(pin.id, w, h);
    const r = (5 + pin.size) * Math.max(0.2, Math.min(1.0, view.scale));
    ctx.save();
    ctx.strokeStyle = '#5ac8fa';
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.arc(pp.x, pp.y, r + 6, 0, Math.PI * 2);
    ctx.stroke();
    if (ui.lastHoveredAirport && ui.lastHoveredAirport !== pin.id) {
      const other = airportById(game, ui.lastHoveredAirport);
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

/** Whether an airport can be chosen as a starting home (small/mid cities only). */
const isHomeEligible = (ap: Airport) => ap.size <= MAX_HOME_SIZE;

/**
 * New-game map: eligible cities glow green and are clickable; major hubs are
 * dimmed. Hovering an eligible city shows its name and population.
 */
function drawHomePicker(w: number, h: number) {
  for (const ap of game.airports) {
    const p = airportScreen(ap.id, w, h);
    const eligible = isHomeEligible(ap);
    const r = (5 + ap.size) * Math.max(0.2, Math.min(1.0, view.scale));
    const hover = eligible && ui.lastHoveredAirport === ap.id;

    ctx.globalAlpha = eligible ? 1 : 0.22;
    if (eligible) acquireRing(p.x, p.y, r + (hover ? 7 : 4), false);
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = eligible ? '#f5a623' : '#3a5675';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = hover ? '#ffffff' : '#0b1622';
    ctx.stroke();

    // Code labels for eligible cities once zoomed in a little; hubs stay quiet.
    const minScale = ap.size <= 1 ? 2.0 : ap.size <= 2 ? 1.4 : 0;
    if (eligible && view.scale >= minScale && !hover) {
      ctx.fillStyle = '#e8eef6';
      ctx.font = 'bold 13px system-ui';
      ctx.fillText(ap.code, p.x + 10, p.y + 4);
    }
  }
  ctx.globalAlpha = 1;

  // Hover card: city + population for the airport under the cursor.
  if (ui.lastHoveredAirport) {
    const ap = airportById(game, ui.lastHoveredAirport);
    if (isHomeEligible(ap)) {
      const p = airportScreen(ap.id, w, h);
      const label = `${ap.code} · ${ap.city} · ${(ap.population / 1_000_000).toFixed(1)}M`;
      ctx.font = 'bold 13px system-ui';
      const tw = ctx.measureText(label).width;
      const lx = p.x + 14;
      const ly = p.y - 16;
      ctx.fillStyle = 'rgba(11,22,34,0.95)';
      ctx.beginPath();
      ctx.roundRect(lx - 6, ly - 14, tw + 12, 22, 6);
      ctx.fill();
      ctx.strokeStyle = '#4ade80';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = '#e8eef6';
      ctx.fillText(label, lx, ly + 1);
    }
  }
}

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

/** Small gold badge listing a staged stop's position(s) on the route. */
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
    ui.selected.length > 0 ? 'Leg demand from path end' : 'Airport market potential';
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

// ---- Plane animation --------------------------------------------------------

const HOURS_TO_SECONDS = 5;

/** Per-plane animation: t = 0..1 along its route path, dir = travel direction. */
const anim = new Map<string, { t: number; dir: 1 | -1 }>();

export const clearAnimations = () => anim.clear();

function planeAnim(planeId: string) {
  let a = anim.get(planeId);
  if (!a) {
    a = { t: Math.random(), dir: Math.random() < 0.5 ? 1 : -1 };
    anim.set(planeId, a);
  }
  return a;
}

export function updateAnimations(dt: number, speed: number) {
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

// ---- Sizing, pan & zoom -----------------------------------------------------

export function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  invalidateBaseMap();
  drawMap();
}

window.addEventListener('resize', resizeCanvas);

const clampScale = (s: number) => Math.max(MIN_SCALE, Math.min(MAX_SCALE, s));

export function resetView() {
  view.scale = 1;
  view.offsetX = 0;
  view.offsetY = 0;
  drawMap();
}

/** Center the view on an airport at a regional zoom (e.g. a new game's home). */
export function zoomToAirport(id: string, scale = 5) {
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

// ---- Hover + click on airports ----------------------------------------------

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
  if (foundId === ui.lastHoveredAirport) return;
  ui.lastHoveredAirport = foundId;
  if (ui.homeSelecting) {
    // No popover during home selection — just highlight + redraw the hover card.
    canvas.style.cursor = found && isHomeEligible(found) ? 'pointer' : '';
    drawMap();
    return;
  }
  hoverAirport(found, foundPx, foundPy);
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
      if (ui.homeSelecting) {
        if (isHomeEligible(ap)) bus.startGameAt(ap.id);
        return;
      }
      if (e.shiftKey) {
        // Toggle the measuring pin — works on any airport, owned or not.
        ui.measureFrom = ui.measureFrom === ap.id ? null : ap.id;
        showAirportInfo(ap, p.x, p.y);
        drawMap();
        return;
      }
      if (spectating()) {
        // Watch-only: the AI owns the airline; never stage a route. Just show info.
        showAirportInfo(ap, p.x, p.y);
      } else if (holdsRights(pl(), ap.id)) {
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

/** Append a stop to the staged path, allowing revisits (hub-and-spoke). */
function addStop(id: string) {
  // Ignore a double-click on the current endpoint (no zero-length leg).
  if (ui.selected.length && ui.selected[ui.selected.length - 1] === id) return;
  if (ui.selected.length - 1 >= MAX_ROUTE_LEGS) {
    flash(`A route can have at most ${MAX_ROUTE_LEGS} legs.`);
    return;
  }
  ui.selected = [...ui.selected, id];
  bus.render();
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    hideAirportPopover();
    if (ui.measureFrom) {
      ui.measureFrom = null;
      drawMap();
    }
  }
});

/** Clear the home-picker cursor once a home is chosen (startGameAt calls this). */
export function clearMapCursor() {
  canvas.style.cursor = '';
}
