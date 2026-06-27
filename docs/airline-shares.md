# Airline Shares — acquisition via a stock market (design)

Status: BUILT and merged to main (phases 1–5, 2026-06-26). RRT-inspired. Full
model (all decisions resolved). **Float-only rework (2026-06-27):** forced
tenders are gone in both directions — *only floated shares ever change hands.*
You are exposed exactly to the extent you floated, and not one share more. A
founder that keeps its majority is un-takeoverable via shares (distress/fire-sale
is the only path for those); takeover/raid is reachable only when the target's
public float ≥ the shares needed for control. Everything prices off the single
public per-share price (no separate control price, no squeeze-out premium).

Phase 5 — "uneasy lies the crown": once the player passes `DOMINANCE_THRESHOLD`
(45% of industry equity AND is strictly the biggest carrier) a rival
hostile-accumulates the player's *float* — but through the **same scored decision
pass** as routes/planes/rival-takeovers (`playerRaidAction` in `ai.ts`), so a
rival raids only when seizing your network beats growing its own; an early nibble
is valued at a fraction of the prize, not a full merger. It only fires if you
floated >50% of yourself (a 16-city player who floated 20% is unraidable). The
mechanic is gated on `g.humanControlled` (the app sets it) so headless sims and
engine tests never fire it. The weekly `raidPlayer` clock just resolves an open
window (defended / expired / raider gone); crossing 50% opens a
`DEFENSE_WINDOW_DAYS` (120) grace period; let it expire still controlled and
`g.defeat` is set → game-over screen. Defense is racing to **buy your float back**
(`buyBack`) before the raider corners it — there is no clawing shares out of a
holder.

## Why

The player rolls up the whole AI field as cheap minnows by ~year 4. Validated
from a real save (1954.5): bought all four rivals for ~$49M total — Pacific
Crown for $5.4M (3 cities) — before any could grow. All-or-nothing instant
buyout at a low going-concern price is the exploit; the AI route/acquisition
improvements only matter if rivals survive past year 4, and they don't.

A share market fixes it economically: takeover difficulty becomes
**self-inflicted** (you're vulnerable in proportion to the stock you floated),
early privately-held rivals cost a full **hostile bid** on a **growth-aware**
valuation, and a dominant player becomes a target. No artificial buyer-size
penalty (rejected — see [[acquisition-design]]).

## Core model (RRT-direction)

- **Cap table** per airline (player included): 100 shares, `ownerId → count`.
  Everyone starts owning **100% of themselves; float = 0**.
- **Valuation V** = growth-aware: `equity + slotInvestment + growthGoodwill`,
  where `growthGoodwill = growthMultiple(target) × annualNet` and the multiple
  scales with the target's recent **revenue** growth from its `history`
  (young fast-growers priced high; flat/mature ones cheap on the multiple but
  dear on equity — the cheap window closes from both ends). Share base price = V/100.
- **Issue shares** (financing lever, player + AI): sell your own stock to the
  public for cash at current price. Raises capital alongside debt, increases
  float, dilutes you, and *raises your takeover exposure*. Every share floated is
  a share someone can later turn against you.
- **Open market:** only **float** is freely buyable, at a **rising marginal
  price** (price impact: each block bought lifts the price; selling lowers it).
  Retained shares can't be nibbled passively.
- **Buy back:** repurchase float with cash to re-secure your majority (defense).
- **Hostile takeover:** buy the **float** up to a controlling stake at the rising
  marginal price (the impact curve carries a surcharge on the shares past 50%).
  Retained shares are never touched — so a takeover is possible **only if the
  target floated enough** to deliver control. A healthy private airline that kept
  its majority is un-takeoverable this way (its only exit is distress/fire-sale).
  This reverses the earlier "force-tender always possible" rule, which is dropped.
- **Control at >50% → squeeze-out:** cash out the remaining minority at the
  **public price** (no premium) and absorb the airline, reusing today's
  `acquire()` merge (networks, rights, fleet, debt, inherited slot apps).
  Other-airline minority holders are paid; founder/public remnants dissolve.

## AI behavior (from day one)

AIs use the same market: issue stock to fund growth, take stakes in rivals
(appreciation + a path to control), buy back to defend their majority, and
launch hostile bids on rivals. They raid the **player** only once the player is
**dominant** (below).

## Player as a target — "uneasy lies the crown"

- **Trigger (option c):** rivals start hostile accumulation of the player only
  once the player's equity exceeds **~45% of all airlines' combined equity**
  (you're most of the market). Threshold tunable.
- **Loss condition (NEW — reverses today's player-exempt-from-failure design):**
  if a rival crosses ~50% of the player, fire **warnings + a defense grace
  period** (buy your float back before the raider corners it). Fail to defend
  within the window → you are acquired = **game over**. Purely self-inflicted:
  it can only happen if *you* floated >50% of yourself. Directly punishes winning
  early and coasting; the endgame becomes a takeover war, not a one-sided
  shopping spree.
- Self-balancing: the raid threat only exists *while rivals survive*, so the
  late-game roll-up is contested — the strongest rival can bid for you back.

## Decisions locked

- **No dividends in v1** (appreciation only — stakes are worth their current
  value and tradeable; buy a growing rival low, sell high). If ever added, the
  correct model is a declared payout ≈ **3% of revenue**, split pro-rata by
  ownership — *not* "own X% → get X% of profit."
- **No Tier 3 ever:** no personal-vs-company money / tycoon portfolio. All
  trading uses **airline cash**.
- Growth-aware valuation is **not** a separate change — it's the share-price basis.

## Tuning knobs (settle during build + sim)

Price-impact curve steepness; control surcharge size (the >50% premium in the
impact curve); dominance threshold (~45%); defense-window length; block size
(10%?).

## State / persistence

Cap tables are persisted (new field on each saved airline) → bump `SAVE_VERSION`.
Price-impact state is derived from the cap table (float size), not stored.

## Validation

Sim across seeds: a year-3/4 player *cannot* corner the board (rivals are
100%-held → no float to buy, un-takeoverable via shares); AIs fund via debt and
stay private, so share takeovers are rare and no raids fire in headless sims; a
distressed rival is still buyable via fire-sale; a player who over-floats can be
raided and must defend by buying float back.

## Out of scope

- Tier 3 (personal wealth / full RRT meta-layer) — never.
- Dividends — deferred (model noted above for if/when).
- Interline / code-sharing — separate future item (the "KC→Bucharest problem",
  `docs/TODO.md`).
