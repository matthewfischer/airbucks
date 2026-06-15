# Economics

How weekly money and passengers are computed. Everything below lives in
`src/game/engine.ts` (`evaluateNetwork`).

The airline is evaluated **as a network**, not route by route. All flying is
pooled into legs (airport pairs), every origin–destination market is routed
over the best path the airline offers, and seats are allocated market by
market. Route-level numbers are attributed back afterward.

## 1. Legs and capacity

Each route's planes contribute weekly seats to every leg the route flies:

- `circuits = tripsPerWeek(type, pathLength, legCount)` — limited by weekly
  fly hours, speed, and per-leg turnaround time.
- Leg capacity = `circuits × 2 × plane capacity` (both directions), summed
  across all planes and routes touching that leg.

A leg also tracks capacity-weighted average speed and fare factor, so
overlapping routes blend together.

## 2. Markets and demand

For every airport pair (A, B) the airline connects (directly or with up to
`MAX_CONNECTIONS = 2` stops, detour ≤ `MAX_DETOUR = 1.4×` direct distance):

```
demand = pairDemand(A, B)                 # A.size × B.size × 90
       × distanceFactor(directDist)       # short markets bigger, sqrt falloff
       × CONNECTION_PENALTY ^ connections # 0.6 per stop
       × demandMult                       # fare elasticity, below
```

`connections` counts legs minus one — a through passenger on a single
multi-stop route (GSO→CMH on GSO–CRW–CMH) **is** a connecting passenger.

### Fare elasticity

The path's fare factor is the capacity-weighted, distance-weighted average of
the route fare sliders on its legs. Speed matters too: planes at or above the
established baseline speed earn up to +20% fare premium; slower planes are
discounted (`speedFareMultiplier`).

```
demandMult = clamp(2 − fareFactor / speedPremium, 0.1, 1.5)
```

So at fare 1.0 with no speed premium, demand is 1.0×; fare 1.5 kills it to
0.5×; fare 0.5 stimulates to 1.5× (the cap).

### Fare paid

```
fare = referenceFare(directDist) × fareFactor × priceLevel
referenceFare(d) = 40 + 0.08 × d
```

Note the fare is based on **direct** O&D distance — a connecting itinerary
doesn't earn more for flying a detour.

## 3. Seat allocation — highest yield per seat first

Markets are sorted by `fare / legCount` (yield per seat consumed) and filled
greedily; each market is capped by the free capacity of its **fullest** leg.
A connecting passenger consumes a seat on every leg.

This ordering means **nonstop local traffic always outranks connecting
traffic on the same legs**: a connector's fare is based on direct distance,
split across 2–3 seats, and its demand already paid the connection penalty.
Locals board first; connectors get the leftovers.

### Consequence: cutting fares can *reduce* connecting passengers

Lowering a route's fare raises `demandMult` for **every** market crossing its
legs — including the point-to-point locals. Near full load, the extra local
demand absorbs the remaining seats and crowds connectors out:

> GSO–CRW–CMH at 97% load. Fare 115% → 110%: slack still exists, connecting
> demand grows, connecting pax rise. 110% → 105%: local GSO–CRW / CRW–CMH
> demand grows enough to fill the bottleneck leg, and connectors — last in
> the allocation order — lose seats. Connecting pax **fall** even though
> connecting demand rose.

This is intentional (real airlines also prefer selling a constrained seat to
a local over a connector splitting revenue across legs). The fix in-game is
capacity, not price: if you want the connecting flow, add seats.

## 4. Revenue attribution to routes

An itinerary's fare is split across its legs in proportion to each leg's
standalone `referenceFare` (not raw distance), so short feeder legs get a
fair share of the through fare. Within a leg, revenue is split between
overlapping routes by their capacity share.

## 5. Route stats are busiest-leg stats

A route's displayed `loadFactor`, `passengers`, and `connectingPassengers`
all come from its **single busiest leg** (scaled by the route's capacity
share of that leg). This keeps load factor and pax consistent and avoids
double-counting through passengers on multi-stop routes — but it means a
fare or network change that flips *which* leg is busiest can make the
displayed numbers jump discontinuously.

## 6. Costs

```
route cost = loadFactor × full-frequency flying cost + weekly upkeep
flying cost = circuits × 2 × pathLength × costPerKm × priceLevel
```

Flying cost scales with load factor — the route only flies enough circuits to
cover its busiest leg. Upkeep is always paid for assigned planes.

## Known imbalance: nonstop is dominated by milk-runs

**Observed:** STL→CVG (direct) earns less than STL→CVG→CLE→PIT, even though the
direct route flies far more frequency.

**Why, structurally:** a route is priced as a network of its legs (§1–2), so
the markets a route can sell scale with the *number of stops*, not its
endpoints:

- **STL→CVG** sells **1** market (STL-CVG).
- **STL→CVG→CLE→PIT** sells **6**: three locals + STL-CLE, CVG-PIT (1 stop) +
  STL-PIT (2 stop).

A single city-pair's demand is small (`size × size × 90` ≈ ~960/wk for
STL-CVG after `distanceFactor`), far less than a plane's seats on a short leg.
So the direct route flies half-empty — its extra "turns" haul air, and revenue
is capped at that one market. The milk-run keeps the same seats full by pooling
6 markets onto shared legs. The current `CONNECTION_PENALTY` (0.6/stop) and
distance falloff don't come close to offsetting 6 markets vs. 1.

This is emergent, not a bug — real hub-and-spoke works this way — but right now
nonstop is *strictly dominated*, which removes it as a strategy.

**Candidate fixes (not yet implemented):**

1. **Frequency reward** — let a direct route's extra trips/day lift the demand
   it captures, so frequency above the static city-pair ceiling means
   something. Most realistic, highest leverage.
2. **Superlinear connection penalty** — make the penalty grow per stop (1
   connection bad, 3 miserable) instead of a flat 0.6^n. Better matches how
   travelers actually weigh multi-stop itineraries.
3. **Nonstop convenience premium** — let nonstop O&D earn a fare bonus
   travelers will pay to avoid stops.

## 7. Eras and the price level

- `priceLevel`: single nominal index for fares, fuel, and upkeep — 1.0 in
  1950, ~1.5%/yr (~3× by 2025). Revenue and cost ride it together, so
  operating margins are era-invariant.
- `eraScale`: separate ~3.8%/yr index that scales fees and credit quoted in
  modern dollars down for earlier eras. Aircraft prices don't scale — the
  roster itself is the price ladder.
- Speed baseline: travelers judge fares against the fastest type in service
  for ≥3 years (capped at 700 km/h). New, faster types earn a fare premium
  during their adoption window instead of moving the bar.
