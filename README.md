# Airbucks

A modern remake of [Air Bucks](https://en.wikipedia.org/wiki/Air_Bucks), the 1992 airline tycoon game.

Built as an Electron desktop app with Vite + TypeScript.

## What it is

You start a regional airline anywhere in the world. At the start of a new game you **pick your home airport** by clicking it on the world map — any secondary/regional city (the big mega-hubs are off-limits as a starting base). Begin with $3M cash and a credit line that grows with your revenue, then buy planes, open routes, and grow from a regional carrier into a global network.

The map spans the whole world — ~230 airports across North America, Europe, Asia, Africa, South America, and Oceania, from small regional fields up to the major intercontinental gateways. Charleston, WV (CRW) is the default starting city, but you're free to begin in Appalachia, the Alps, or anywhere else.

AI-controlled rivals (a configurable number) set up near you and compete for the same markets — expanding, consolidating, and, once you grow dominant, raiding your stock through the share market.

The game runs on a real-time clock (pause/play, 1×/2×/4× speed), modeled after Transport Tycoon. Revenue and interest accrue daily.

## Economy

- Routes are evaluated as a **network**, not per-route in isolation. Passengers route over the airline's best path (nonstop or connecting, up to 2 hops, 1.4× detour cap).
- Feeder spokes are credited for connecting traffic — a thin spoke earns more when it feeds a trunk route at your hub.
- Plane depreciation is factored into P&L.
- Demand is realistic: small city-pairs are marginal, big city-pairs are the profit centers, and intercontinental trunk routes are the prizes.

## Running

```sh
npm install
npm run dev       # Electron + Vite dev mode
npm test          # Run tests
npm run build     # Production build
```

## Tech stack

- **Electron** — desktop shell
- **Vite + TypeScript** — frontend build
- **Vitest** — tests
- Real-world geography from GeoJSON (world country outlines + US states), rendered to an offscreen canvas
