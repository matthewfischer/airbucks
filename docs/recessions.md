# Recessions / demand downturns — design

> **Status: designed, not built.** Decisions locked. TODO — build per the plan
> below.

## Why

The June 2026 balance pass (see `sim-balance-pass` notes) found the overexpander
AI runs at ~$0 cash — **fully fragile, but it never fails, because the world has
no demand downturns.** The 20% loan amortization already built the fragility;
what's missing is a *trigger*. A recession is that trigger, and it's the real
structural fix for "the overexpander wins every seed."

The payoff is that it reuses machinery we already have: a demand dip pushes
thin-cash carriers through the **existing distress fuses** (8-week-cash /
2-year-equity → for-sale → AI acquisition). No new failure plumbing — the
dormant consolidation chain finally fires. A player who kept a cash buffer
survives; the reckless get eaten.

## Mechanism

A pure `demandLevel(g)` — 1.0 in normal years, dipping during downturns —
multiplied into the market pool in `marketCalc`:

```ts
demand: pairDemand(A, B) * distanceFactor(directDist) * appeal * demandLevel(g)
```

It scales the **pool, not the competitive share** — every airline's traffic on
every pair shrinks together. One-line hook; seat allocation, revenue
attribution, and competition are all untouched.

`demandLevel` is computed exactly like `fedFundsRate`: sparse `[year, level]`
anchors, linearly interpolated, clamped at the ends. **Deterministic from the
calendar — no persisted state, no `SAVE_VERSION` bump.** This matches the game's
history DNA (real fed-funds curve, real aircraft intro/retire years, real
airports) and makes downturns telegraphable for free (the engine can look ahead
at the known schedule).

### Decisions

- **Source: historical schedule.** Fixed anchors at real downturns, not random
  rolls. Same every game — predictability is a feature: a skilled player learns
  to hold a buffer going into a known-rough era (strategy, not dice).
- **Scope: global.** One `demandLevel` worldwide; every market dips together.
  Matches how the major recessions actually hit; no per-region data/UI.
- **Depth: follows history.** Each real recession gets a trough scaled to its
  actual (aviation-weighted) severity and a duration set by anchor spacing —
  COVID sharp-and-short, 2008 deep-and-long, the late-'50s dips mild.

### Proposed anchor table (tunable)

Aviation-weighted: 2001 (9/11) and 2020 (COVID) bite harder than GDP alone;
1973–75 and 1979–82 carry the oil shocks. Baseline 1.0 between anchors.

| era | trough | notes |
|-----|--------|-------|
| 1957–58 | 0.86 | sharp, brief |
| 1960–61 | 0.92 | mild |
| 1969–70 | 0.86 | moderate |
| 1973–75 | 0.76 | oil embargo, long |
| 1980 | 0.88 | brief |
| 1981–82 | 0.74 | deep (Volcker) |
| 1990–91 | 0.85 | + Gulf War oil |
| 2001 | 0.78 | dot-com + 9/11 air-travel collapse |
| 2008–09 | 0.68 | Great Recession, long |
| 2020 | 0.52 | COVID — catastrophic but recovers by ~2022 |

Encoded as `[year, level]` with 1.0 anchors on the shoulders to shape each V
(e.g. `[1972,1.0],[1974,0.76],[1976,1.0]`). Sharp-short events place their
shoulders close (`[2019,1.0],[2020,0.52],[2022,1.0]`).

## Telegraph

Because the schedule is known, the engine looks ahead: when a dip below a
threshold (say `demandLevel < 0.9`) begins within ~6 months, emit a news item
("economic clouds gathering / analysts warn of a downturn"), and a recovery
note when it passes. Gives the player time to raise cash / defer expansion —
this is what makes it strategy rather than a surprise tax.

## AI reaction: cautious personalities hunker

Reuse the existing `Personality` traits — no new save data. Derive a per-AI
**caution = 1 − debtAppetite** (cheapskate 0.9, regional 0.7, hub-builder 0.5,
overexpander 0.05). During a downturn window (active OR within the ~6-month
lookahead):

- Temporarily **raise effective `runwayWeeks`** and **cut effective
  `debtAppetite`**, scaled by `caution`.

Effect: the cheapskate and regional pull back / build buffer and ride it out;
the **overexpander (caution ~0) plows straight in and blows up** — exactly the
spread we want, and it's what finally dethrones the overexpander in sims. Purely
a modifier at decision time; no change to persisted AI state.

## Build plan (phased, one commit each)

1. **`demandLevel` + hook** — the function, anchor table, and the one-line
   `marketCalc` multiply. Unit tests on the interpolation + trough values. With
   anchors all 1.0 it's a no-op; land the plumbing first.
2. **Real anchors + telegraph** — fill the table, add the lookahead news
   warnings. Sim to see distress/consolidation fire during downturns.
3. **AI hunker** — the caution modifier in the decision pass; sweep to confirm
   the overexpander now actually loses seeds it used to win, without wiping out
   the whole field.

## Tests

- `demandLevel` interpolates between anchors, clamps outside, hits ~1.0 in calm
  years and the table troughs in downturn years.
- A thin-cash airline trips the distress fuse during a scheduled dip (integration
  with distress.ts).
- Telegraph news fires ahead of a dip and on recovery, once each.
- Cautious AI defers expansion in the window; overexpander does not.

## Open / tuning

- Exact trough depths and durations — settle in phase 2 via sims (the table
  above is a starting point).
- Whether fares should also soften in a recession, or only volume (v1: volume
  only — `demandLevel` on the pool; revisit if downturns feel too survivable).
- Interaction with interest rates: recessions historically pair with rate cuts
  (already in `FED_FUNDS_ANCHORS`) — cheaper debt partly cushions the demand
  hit. That coupling is already there for free; just note it when tuning.
