# Airline Shares — acquisition via stock (design)

Status: design agreed 2026-06-20, not built. Branch: `airline-shares` (off the
AI route-optimization work). RRT-inspired.

## Why

The player rolls up the whole AI field as cheap minnows by ~year 4. Validated
from a real save (seed, 1954.5): bought all four rivals for ~$49M total —
Pacific Crown for $5.4M (3 cities) — before any could grow. All-or-nothing
instant buyout at a low going-concern price is the exploit. The AI
route/acquisition improvements only matter if rivals survive past year 4, and
they don't.

A share market with **price impact** fixes this economically: cornering a
company gets progressively expensive, and a founder-controlled young airline
can't be taken cheaply. No artificial buyer-size penalty (which we rejected —
see [[acquisition-design]]).

## Scope — Tier 2 only

- **No Tier 3, ever** (decided 2026-06-20): no personal-vs-company money, no
  separate tycoon portfolio. Stakes are bought with **airline cash** (corporate
  strategic holdings).
- Replaces the instant `acquire()` *entry point*: absorbing a rival becomes
  "reach >50%, then squeeze out the rest" — but the existing `acquire()` merge
  logic (networks, rights, fleet, debt, inherited slot apps) is reused for the
  final absorption.
- The growth-aware valuation we discussed is **not** built separately — it
  becomes the **share-price basis** here (young fast-growers priced high).

## Core model

- **Cap table** per airline: ownerId → fraction (sums to 1). Founder starts at
  100% (or with a small public float — open decision).
- **Share price** = growth-aware valuation ÷ shares. A young, fast-growing
  airline (high revenue growth from its `history`) commands a high multiple; a
  flat/mature one is cheap on the multiple but expensive on equity. The cheap
  window closes from both ends.
- **Trade in blocks** (e.g. 10%). **Price impact:** buying a block raises the
  price, selling lowers it. Accumulating control costs more at the margin than
  the first block — the core brake. Curve steepness is the main tuning knob.

## Hard requirement: never get stuck (force-buy)

The player must never be stuck facing a cheap airline that refuses to sell and
exists forever. Two guarantees:

1. **No hard refusal.** Holders always sell at a high enough price. The price
   rises with accumulation but stays **finite**, so with enough capital you can
   *always* reach majority. The brake is cost, never a wall.
2. **Squeeze-out at >50%.** Once you hold majority, force-buy the remaining
   minority at market + a premium and absorb the airline (reuse `acquire()`). No
   lingering rump shareholder.

## AI behavior

AIs trade stakes too: invest spare cash in rivals, defend their own majority,
and take stakes in each other **and in the player** (a predator above the
leader). Symmetric pricing, so early AI-vs-AI roll-ups also slow.

## Open decisions (resolve when planning the build)

- **Dividends in v1?** Minority stakes need a point (share of profit) — include
  or defer (without them, minority stakes are only a path to control).
- **AI share-trading from day 1, or player-only first** then add AI traders once
  the core works?
- **Block size** (10%?) and **price-impact curve** steepness — tune via sim.
- **Initial float:** founder at 100% (you buy from them, price climbs) or a
  starting public float?

## Validation

Sim across seeds: a year-3/4 player *cannot* corner the board (cost
prohibitive), but a rich player/AI still can later; AI-vs-AI stake-building
occurs; nobody is permanently un-buyable (force-buy guarantee holds).

## Out of scope

- Tier 3 (personal wealth / full RRT meta-layer) — never.
- Interline / code-sharing — separate future item (the "KC→Bucharest problem",
  see `docs/TODO.md`).
