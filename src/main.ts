import './ui/styles.css';
import type { GameState } from './game/types';
import {
  advanceDay,
  airportById,
  assignPlane,
  borrow,
  buyPlane,
  closeRoute,
  evaluateRoute,
  LOAN_ANNUAL_RATE,
  LOAN_LIMIT,
  money,
  newGame,
  openRoute,
  planesOnRoute,
  repay,
  routeDistance,
  setFare,
  typeById,
  weeklyTotals,
  weekNumber,
} from './game/engine';
import { distanceKm } from './game/geo';

const game: GameState = newGame();
// Expose for debugging from the DevTools console.
(window as unknown as { game: GameState }).game = game;
if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV) {
  (window as unknown as { dbg: unknown }).dbg = {
    game,
    openRoute: (a: string, b: string) => (openRoute(game, a, b), render()),
    buyPlane: (t: string) => (buyPlane(game, t), render()),
    assignPlane: (p: string, r: string | null) => (assignPlane(game, p, r), render()),
    advanceDay: () => (advanceDay(game), render()),
    borrow: (n: number) => (borrow(game, n), render()),
    repay: (n: number) => (repay(game, n), render()),
    evaluate: (r: string) =>
      evaluateRoute(game, game.routes.find((x) => x.id === r)!),
  };
}

/** Airports the player has clicked to stage a new route (max 2). */
let selected: string[] = [];

// Real-time clock state.
let playing = false;
let speed = 1;
let lastTs = 0;
let dayAccumulator = 0;
/** Real milliseconds per simulated day at 1× speed. */
const DAY_MS = 900;
const START_EPOCH = Date.UTC(2000, 0, 1);
/** Real seconds (at 1×) to animate one flight-hour, for the moving plane sprites. */
const HOURS_TO_SECONDS = 5;

/** Per-plane animation: t = 0..1 along its route, dir = which way it's flying. */
const anim = new Map<string, { t: number; dir: 1 | -1 }>();

const canvas = document.getElementById('map') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const hud = document.getElementById('hud')!;
const sidebar = document.getElementById('sidebar')!;
const logEl = document.getElementById('log')!;
const playBtn = document.getElementById('play') as HTMLButtonElement;

// ---- Geographic projection ------------------------------------------------

// Bounding box of the regional network, computed once. We fit this box into
// the canvas (preserving aspect) and correct longitude for latitude so the
// region isn't stretched east-west.
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

// ---- Real US map geometry (loaded at runtime) -----------------------------

/** Flattened list of polygon rings; each ring is a list of [lon, lat] pairs. */
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

// ---- Cached base map (ocean + land), redrawn only on resize / data load ----

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

// ---- Foreground map (routes, airports, selection) -------------------------

function drawMap() {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(ensureBaseMap(w, h, dpr), 0, 0, w, h);

  // Routes.
  for (const route of game.routes) {
    const from = airportScreen(route.fromId, w, h);
    const to = airportScreen(route.toId, w, h);
    const res = evaluateRoute(game, route);
    const hasPlanes = planesOnRoute(game, route.id).length > 0;
    ctx.strokeStyle = !hasPlanes
      ? '#3a5675'
      : res.profit >= 0
        ? 'rgba(74,222,128,0.8)'
        : 'rgba(248,113,113,0.8)';
    ctx.lineWidth = 2;
    ctx.setLineDash(hasPlanes ? [] : [5, 5]);
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Moving plane sprites along their routes.
  for (const plane of game.fleet) {
    if (!plane.routeId) continue;
    const route = game.routes.find((r) => r.id === plane.routeId);
    if (!route) continue;
    const from = airportScreen(route.fromId, w, h);
    const to = airportScreen(route.toId, w, h);
    const a = planeAnim(plane.id);
    const x = from.x + (to.x - from.x) * a.t;
    const y = from.y + (to.y - from.y) * a.t;
    const base = Math.atan2(to.y - from.y, to.x - from.x);
    drawPlaneSprite(x, y, base + (a.dir === -1 ? Math.PI : 0));
  }

  // Staged selection line.
  if (selected.length === 2) {
    const a = airportScreen(selected[0], w, h);
    const b = airportScreen(selected[1], w, h);
    ctx.strokeStyle = 'rgba(245,166,35,0.9)';
    ctx.lineWidth = 2;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Airports.
  for (const ap of game.airports) {
    const p = airportScreen(ap.id, w, h);
    const isSel = selected.includes(ap.id);
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
    ctx.fillStyle = isSel ? '#f5a623' : ap.home ? '#f5a623' : '#3fd0c9';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#0b1622';
    ctx.stroke();

    ctx.fillStyle = '#e8eef6';
    ctx.font = 'bold 13px system-ui';
    ctx.fillText(ap.code + (ap.home ? ' ★' : ''), p.x + 10, p.y + 4);
    ctx.fillStyle = '#93a7c0';
    ctx.font = '11px system-ui';
    ctx.fillText(ap.city, p.x + 10, p.y + 18);
  }
}

function planeAnim(planeId: string) {
  let a = anim.get(planeId);
  if (!a) {
    // Stagger starting positions so co-routed planes don't fly in lockstep.
    a = { t: Math.random(), dir: Math.random() < 0.5 ? 1 : -1 };
    anim.set(planeId, a);
  }
  return a;
}

/** Advance every active plane along its route; called only while playing. */
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

function drawPlaneSprite(x: number, y: number, angle: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.fillStyle = '#f4f8ff';
  ctx.strokeStyle = '#0b1622';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(7, 0);
  ctx.lineTo(-5, 4);
  ctx.lineTo(-2, 0);
  ctx.lineTo(-5, -4);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
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
      toggleSelect(ap.id);
      return;
    }
  }
});

function toggleSelect(id: string) {
  if (selected.includes(id)) selected = selected.filter((s) => s !== id);
  else selected = [...selected, id].slice(-2);
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
  hud.innerHTML = `
    <div class="stat"><span class="label">Date</span><span class="value">${dateStr()}</span></div>
    <div class="stat"><span class="label">Cash</span><span class="value ${cashClass}">${money(game.cash)}</span></div>
    <div class="stat"><span class="label">Debt</span><span class="value">${money(game.debt)}</span></div>
    <div class="stat"><span class="label">Fleet</span><span class="value">${game.fleet.length}</span></div>
    <div class="stat"><span class="label">Routes</span><span class="value">${game.routes.length}</span></div>
  `;
}

function renderSidebar() {
  sidebar.innerHTML =
    newRouteCard() + buyCard() + bankCard() + routesCard() + fleetCard();
}

function newRouteCard(): string {
  const names = selected.map((id) => airportById(game, id).code).join(' ⇆ ');
  let info = '<div class="muted">Click two airports on the map.</div>';
  let canOpen = false;
  if (selected.length === 2) {
    const dist = distanceKm(
      airportById(game, selected[0]),
      airportById(game, selected[1]),
    );
    info = `<div class="row"><strong>${names}</strong><span class="pill">${dist.toLocaleString()} km</span></div>`;
    canOpen = true;
  } else if (selected.length === 1) {
    info = `<div class="muted">Selected <strong>${names}</strong>. Pick one more.</div>`;
  }
  return `<div class="card"><h3>New Route</h3>${info}
    <div class="row" style="margin-top:10px">
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
  const credit = LOAN_LIMIT - game.debt;
  const weeklyInterest = game.debt * LOAN_ANNUAL_RATE * (7 / 365);
  return `<div class="card"><h3>Bank</h3>
    <div class="row"><span class="muted">Debt</span><strong>${money(game.debt)}</strong></div>
    <div class="row"><span class="muted">Credit available</span><span>${money(credit)}</span></div>
    <div class="row"><span class="muted">Interest (${(LOAN_ANNUAL_RATE * 100).toFixed(0)}% / yr)</span><span class="bad">-${money(weeklyInterest)}/wk</span></div>
    <div class="row" style="margin-top:10px">
      <button data-act="borrow" ${credit > 0 ? '' : 'disabled'}>Borrow $5M</button>
      <button data-act="repay" ${game.debt > 0 ? '' : 'disabled'}>Repay $5M</button>
    </div></div>`;
}

function routesCard(): string {
  if (game.routes.length === 0)
    return `<div class="card"><h3>Routes</h3><div class="muted">No routes yet.</div></div>`;
  const rows = game.routes
    .map((r) => {
      const a = airportById(game, r.fromId);
      const b = airportById(game, r.toId);
      const dist = routeDistance(game, r);
      const res = evaluateRoute(game, r);
      const n = planesOnRoute(game, r.id).length;
      const load =
        res.seatsOffered > 0
          ? Math.round((res.passengers / res.seatsOffered) * 100)
          : 0;
      const cls = res.profit >= 0 ? 'good' : 'bad';
      const prem = Math.round((res.speedPremium - 1) * 100);
      const premTag =
        n > 0 && prem !== 0
          ? ` · <span class="${prem > 0 ? 'good' : 'bad'}">⚡${prem > 0 ? '+' : ''}${prem}% fare</span>`
          : '';
      return `<div class="route-line">
        <div class="row"><strong>${a.code} ⇆ ${b.code}</strong>
          <span class="row" style="gap:6px"><span class="pill ${cls}">${res.profit >= 0 ? '+' : ''}${money(res.profit)}/wk</span>
          <button class="close-x" data-act="close-route" data-route="${r.id}" title="Close route">✕</button></span></div>
        <div class="tiny">${dist.toLocaleString()} km · ${n} plane${n === 1 ? '' : 's'} · ${res.passengers.toLocaleString()}/${res.demand.toLocaleString()} pax · ${load}% load${premTag}</div>
        <div class="row" style="margin-top:6px">
          <span class="muted">Fare $<input type="number" min="0" step="10" value="${r.fare}" data-act="fare" data-route="${r.id}"></span>
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
            const a = airportById(game, r.fromId);
            const b = airportById(game, r.toId);
            const dist = routeDistance(game, r);
            const tooFar = t.range < dist;
            const sel = plane.routeId === r.id ? 'selected' : '';
            return `<option value="${r.id}" ${sel} ${tooFar ? 'disabled' : ''}>${a.code} ⇆ ${b.code}${tooFar ? ' (out of range)' : ''}</option>`;
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
    case 'clear-sel':
      selected = [];
      render();
      break;
    case 'open-route': {
      const err = openRoute(game, selected[0], selected[1]);
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
      borrow(game, 5_000_000);
      render();
      break;
    case 'repay':
      repay(game, 5_000_000);
      render();
      break;
    case 'close-route':
      closeRoute(game, btn.dataset.route!);
      if (selected.length) selected = [];
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
    setFare(game, el.dataset.route!, Number(input.value));
    render();
  }
});

// ---- Transport controls + real-time loop ----------------------------------

playBtn.addEventListener('click', () => {
  playing = !playing;
  lastTs = 0; // avoid a big dt jump after a pause
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
