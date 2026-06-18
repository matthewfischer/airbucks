# AI Players (Computer Opponents) — Design

Status: agreed design. (2026-06-11)
Progress: the state refactor below landed 2026-06-12 (`Airline` extracted,
player = `airlines[0]`, engine takes `(g, airline)`, seeded RNG via `rand(g)`,
save format v6). AI behavior itself is not built yet.

## Overview

0–8 computer-controlled airlines, chosen on the setup screen. Rule-based
heuristics, not ML. Each AI gets a generated name, a map color, and a home
airport drawn from cities the player didn't pick.

## Home airports: regional, by economic merit

Revised 2026-06-18: AI homes are no longer a fixed North-American pool. The
candidate set is now the size-3/4 secondary hubs **nearest the player's start**
(`pickHomes` in `ai.ts`), so rivals are regional wherever you begin — a Cape
Town start faces African rivals, a Frankfurt start European ones — and a thin
region naturally borrows from the next continent (a Perth start reaches into SE
Asia/the Indian-Ocean rim). Within that pool each hub is drawn weighted by its
**appeal as a base** (`hubAppeal`: own market × distance-discounted size of
every city within early reach, the same `pairDemand × distanceFactor` math the
engine rewards) and a mild proximity tilt. There is no spacing rule: rivals
settle where the money is, free to cluster near the player or each other. This
fixed two faults of the old maximin pool — it always converged on the same five
geographic corners (only ~21 distinct home-sets in 200 games; now ~210), and it
stranded any non-NA player among transatlantic-only rivals.

Note: South America and Oceania have very few size-3/4 hubs (their big cities
are size-5/6 majors, excluded from the AI tier), so starts there draw rivals
from the nearest hubs across an ocean. Adding secondary hubs in those regions
(as was done for southern Africa) would tighten their regionality.

### History

Decided 2026-06-11. The map is deliberately player-centric — a dense taper
of small cheap cities around the Appalachian core, but abroad only the
biggest 2–4 metros per region. A foreign-based AI has no regional ladder to
climb (no size-1/2 feeders, only expensive gateway slots), and with v1
competition being slots-only it would never contest anything the player
touches. So AI homes are drawn from a curated pool of North American hubs,
excluding the player's home and its nearest neighbors, spread one-per-region
so eight AIs don't pile into one corner.

Revised 2026-06-13: capped AI homes at **size 3–4 secondary hubs** (PDX, SLC,
DEN, AUS, STL, MCI, BNA, MEM, TPA, YYC, GDL, SJU, …), close to the player's
own size-≤3 starting tier. Previously the pool reached the size-5/6 majors
(ATL, ORD, YYZ, MEX), which let an AI spawn on a top-tier hub the player needs
a 6-airport network even to apply for — too much of a free head start. Now an
AI must climb the same reputation ladder to reach the majors. The Appalachian
core (PIT/CVG/CMH/CLE/SDF) stays out of the pool — that's the player's ladder.

Default count may prove too high at 8 — wait and see; tune the default,
not the design. If v2 adds demand-splitting, one or two foreign "flag
carrier" AIs flying transatlantic into the player's gateways could work
without densifying Europe.

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
- A healthy airline can be bought outright at its market price: net worth +
  slot-portfolio replacement cost + goodwill, marked up by a control premium
  (its owners aren't selling at book). The buyer inherits cash, assumes debt.

## Visibility

- AI route lines on the map, in each airline's color.
- Competitors tab: rough standings — fleet size, cities served, vague
  health indicator.
- News log events for AI moves (routes opened, slots won, distress,
  acquisitions).
- Full financials visible only when an airline is for sale — inspect the
  books before buying.
