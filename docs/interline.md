# Interline / Alliances — design

> **Status: designed, not built.** All design decisions (D1–D5) locked. This is
> a TODO — implement per the phased build plan below.


## The problem ("KC → Bucharest")

Today an O&D market is only realized if a **single** airline's network spans both
ends. `evaluateNetwork` enumerates markets over the airports **one** carrier
touches and routes them over that carrier's own legs (`buildLegs` → `bestPath`).
A passenger flying Kansas City → hub on carrier A, then hub → Bucharest on
carrier B, is carried by nobody — `pairDemand` computes that through-demand but
it goes unrealized for everyone.

Interline lets two networks jointly capture a trip neither serves end-to-end,
each carrier earning its leg.

## Model decision: alliances, not universal interline

Interlining is a **strategic choice**, not free physics. Members of an alliance
pool their networks for demand capture; non-members don't. This gives the player
a verb (propose / accept / leave), creates rivalry texture ("the Pacific
alliance"), and — critically — reuses the existing per-carrier machinery almost
verbatim.

A solo airline is just an alliance of one. That framing is the whole trick.

## Core mechanic: group the network eval

`evaluateNetwork(g, al)` and `competition(g)` currently treat each airline in
isolation. Generalize both to operate on an **alliance group** (the set of
airlines sharing an alliance; singleton for the unallied):

1. **Pool legs across the group.** `buildLegs` runs per airline; concatenate the
   groups' leg maps into one combined graph (`adj`, `legs`). A leg is still flown
   by exactly one carrier, so `LegInfo.routeCap` keys stay unambiguous — each
   leg's capacity maps back to the owning carrier's route.
2. **Enumerate markets over the group's served airports.** `bestPath` now walks
   the combined `adj`, so a path may hand off at a hub where carrier A lands and
   carrier B departs (both must hold that airport — connection requires a shared
   point, which is exactly a real interline hub).
3. **Competition is group-vs-group.** `competition()` sums weight per *group*
   per market; `rivalWeight` = other groups' weight. Allied carrier weights
   combine instead of competing.
4. **Seats & revenue fall out unchanged.** Seat allocation is already per-leg
   (`remaining` map), so a through-pax consuming a seat on each carrier's leg is
   automatic. Revenue attribution already flows `leg → route (by routeCap share)
   → airline`, so each carrier is credited for its own legs with no new
   bookkeeping. Costs stay per-route/per-airline (`routeFly`/`routeUp`).

The fare blend also already works: the itinerary fare in `marketCalc` is the
capacity-weighted mean of the path legs' `fareFactor`s, so a through-fare
naturally reflects both carriers' pricing.

## Fare split on a through trip

Leg-fare split, reusing the existing rule in `evaluateNetwork`: the itinerary
fare is divided across legs by each leg's standalone `referenceFare`. Each
carrier keeps the share for its own legs. No prorate accounting, no
inter-carrier payment — the split is implicit in per-leg revenue attribution.

## Decisions

- **D1 — Allies pool on shared pairs (truce).** Allied carriers do NOT compete
  on pairs they both serve — group-eval merges their legs by city-pair (the
  engine already does this for one carrier's overlapping routes), so combined
  capacity presents a united front vs. outsiders and revenue splits by each
  carrier's `routeCap` share. This is also the *simpler* build: the merge is
  automatic in `buildLegs`; keeping allies competing would require preventing
  that merge (per-carrier leg identity) — strictly more code. A shared single-leg
  pair earns full fare (the D2 haircut hits only multi-carrier itineraries).
- **D2 — Interline yield haircut: 0.75×.** Multi-carrier itineraries earn 75% of
  the single-carrier fare (interline fares leak in reality). Applies only to
  paths whose legs span >1 carrier.
- **D3 — Alliance size cap: 3 members.** Small blocs allowed; the board can't
  merge into one super-network.
- **D4 — Cost to form: one-time setup fee, scaled to network size.** Allying is a
  deliberate investment, not a reflex. No standing weekly fee.
- **D5 — AI behavior: accept + AI–AI.** AIs accept a player proposal when it
  grows their evaluated network, and form alliances among themselves when two
  complementary networks would both gain. Needs a sweep to confirm alliances
  don't trivialize the board.

## Emergent behavior: network rationalization (a feature, from D1)

Because a pair's demand is a **fixed** pool (`pairDemand = size × size × 90`) that
the alliance captures as one bloc and splits by capacity, flying a route your
partner already covers with enough seats is **redundant** — it doesn't grow the
pie, it just divides the same group revenue between you. The rational move is to
pull that capacity and redeploy it to a market the alliance doesn't yet serve,
which raises the alliance's total captured demand. This mirrors real alliance
metal rationalization and gives alliances a genuine strategic layer beyond raw
interline capture.

It's **selective**, not blanket withdrawal — keep flying a partner's pair when:

1. **Seats are the binding constraint** — pair demand (local + connecting flow)
   exceeds the partner's capacity, so your seats carry real overflow.
2. **An outsider contests the pair** — combined capacity = combined weight =
   larger group share vs. the rival; withdrawing cedes it.
3. **It's an interline feeder leg** — needs seats for through-flow, not just
   local demand.

Rule of thumb: **drop redundant capacity where the partner already satisfies
demand; keep it where seats are the bottleneck or an outsider is fighting you.**

For the AI (D5), the greedy route scorer should lean this way automatically once
eval is group-aware (a plane added to an already-satisfied pooled pair scores
near-zero marginal revenue vs. a fresh market). Confirm in the sweep, and watch
for a mild free-rider wobble (both partners preferring the *other* to fly a thin
shared route). **TODO: verify in the sweep once built.**

## Data model

`Airline.alliance?: string` (alliance id) — absent ⇒ unallied. Alliance
membership is a flat group id; no roles. Proposals are transient game state:
`GameState.allianceOffers?: { from, to, day }[]`. Bumps `SAVE_VERSION`.

Helper `allianceGroup(g, al): Airline[]` — the al plus co-members (or `[al]`).
`competition()` and `evaluateNetwork()` key off the group.

## UI

- **Competitors tab**: per rival, an "Propose alliance" / "Leave alliance"
  button; show current alliance membership and a combined-network hint.
- **News feed**: alliance formed / dissolved (gated to your network as other
  rival events are).
- **Map**: optionally tint allied carriers' routes toward a shared hue, or a
  legend grouping — defer, confirm visually first.

## Build plan (phased, one commit each)

1. **Grouping refactor** — `allianceGroup`, thread groups through `competition`
   and `evaluateNetwork`; with everyone unallied this is a **no-op**
   (bit-identical to today). Lock that in with a test before any behavior change.
2. **Alliance data + formation** — `alliance` field, offer/accept/leave engine
   functions, `SAVE_VERSION` bump, persistence test.
3. **Brakes** — D2 yield haircut, D3 size cap (per decisions above).
4. **UI** — Competitors-tab buttons + news events.
5. **AI** — accept/propose logic (D5), then a sweep to check alliances don't
   trivialize the board.

## Tests

- Grouping refactor is a no-op for unallied airlines (regression guard).
- Two carriers, each flying one leg of a two-leg trip, allied ⇒ the through
  market is now carried and split by leg; unallied ⇒ carried by neither.
- Yield haircut applies only to multi-carrier itineraries.
- Group competition: an alliance's combined weight vs. an outside rival.
- Persistence round-trips `alliance` and pending offers.

## Open (decide during build)

- Interaction with the share market / takeovers: does acquiring an ally auto-
  dissolve the alliance? (Merged carriers become one network anyway — probably
  just drop the alliance link on `acquire`.) Flag, decide during phase 2.
- Network-rationalization behavior needs a sweep once built (see that section).
