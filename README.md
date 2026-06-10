# Airbucks

A modern remake of [Air Bucks](https://en.wikipedia.org/wiki/Air_Bucks), the 1992 airline tycoon game.

Built as an Electron desktop app with Vite + TypeScript.

## What it is

You run a regional airline based out of **Charleston, WV (CRW)**. Start with $40M, borrow against a $50M credit line, buy planes, open routes, and build a network across the Appalachian/Mid-Atlantic region.

The map covers a tight regional network: CRW, CLT, DCA, PIT, CLE, CVG, CMH, RIC, ROA, plus major national gateways (BOS, JFK, ATL, MIA, ORD, DEN, LAX) pinned to the map edges.

The game runs on a real-time clock (pause/play, 1×/2×/4× speed), modeled after Transport Tycoon. Revenue and interest accrue daily.

## Economy

- Routes are evaluated as a **network**, not per-route in isolation. Passengers route over the airline's best path (nonstop or connecting, up to 2 hops, 1.4× detour cap).
- Feeder spokes are credited for connecting traffic — a thin CRW–PIT route earns more if it feeds CRW–DCA traffic.
- Plane depreciation is factored into P&L.
- Short regional hops are realistic: small city-pairs are marginal, big city-pairs (e.g. CLT–DCA) are the profit centers.

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
- Real US state geography from GeoJSON, rendered to an offscreen canvas
