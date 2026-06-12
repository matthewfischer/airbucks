# AI Players (Computer Opponents) — Design

Status: agreed design, not yet built. (2026-06-11)

## Overview

0–8 computer-controlled airlines, chosen on the setup screen. Rule-based
heuristics, not ML. Each AI gets a generated name, a map color, and a home
airport drawn from cities the player didn't pick.

## State refactor

`GameState` currently holds one airline. Introduce an `Airline` object with
the per-airline state — cash, debt, rights, fleet, routes, negotiations,
homeId, log, history — with the player as `airlines[0]`. World state stays
global: airports, aircraft types, day/era, price level, rates. Engine
functions take `(g, airline)` instead of `g`. This refactor is the bulk of
the work.

## Competition (v1)

AIs compete for **slots only**. They consume the existing per-airport slot
pool (`AIRPORT_SLOTS`), so claiming cities first matters and the world fills
up over decades.

Deferred to v2: demand-splitting when two airlines fly the same city pair
(requires making `evaluateNetwork` competition-aware), and aircraft-supply
scarcity.

## AI behavior

Decision pass every N weeks (with jitter), one action per pass: score
candidate routes/slots/planes, pick one. Slow expansion to match the game's
pacing philosophy — competitors creep, not blitz.

Deliberately imperfect, via three levers:

1. **Noisy scoring** — each candidate's score is multiplied by a random
   factor, so AIs regularly pick the 3rd-best option.
2. **Personalities** — parameter sets, e.g. hub-builder, cheapskate (flies
   old props too long), overexpander (carries too much debt), regional
   (ignores big markets).
3. **Cadence** — slow, jittered decision timing the player can outmaneuver.

## Distress, acquisition, bankruptcy

These chain: failing → for sale → liquidated if unbought.

- **Distress trigger:** cash below zero (or negative equity) for N
  consecutive weeks → news event, airline listed for sale with a countdown
  (a couple of months of game time).
- **Acquisition:** player or another AI may buy a distressed airline.
  Buyer gets its rights (duplicates vanish), fleet (`kmFlown` intact),
  and routes (planes stay assigned), and **assumes its debt**. Price is
  equity-based — fleet resale + slot fees paid − debt — floored at a
  minimum, with a distress discount. Cheap sticker, real liabilities.
- **Bankruptcy:** if nobody buys before the countdown ends, the airline
  liquidates and its slots return to the pool.
- AI-to-AI acquisitions are in from v1 — decades-long consolidation
  (8 airlines becoming 3) fits the all-day pacing.
- No hostile bids on healthy airlines for now.

## Visibility

- AI route lines on the map, in each airline's color.
- Competitors tab: rough standings — fleet size, cities served, vague
  health indicator.
- News log events for AI moves (routes opened, slots won, distress,
  acquisitions).
- Full financials visible only when an airline is for sale — inspect the
  books before buying.
