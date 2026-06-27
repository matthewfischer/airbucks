# Airline Shares — acquisition via a stock market (design)

Status: BUILT and merged to main (phases 1–5, 2026-06-26). RRT-inspired. Full
model (all decisions resolved). Phase 5 — "uneasy lies the crown": once the
player passes `DOMINANCE_THRESHOLD` (45% of industry equity) the strongest rival
hostile-accumulates the player's stock (`raidPlayer` in `ai.ts`, driven weekly
from the main loop, never from `runAI`/sims); crossing 50% opens a
`DEFENSE_WINDOW_DAYS` (120) grace period; let it expire still controlled and
`g.defeat` is set → game-over screen. Defense is `forceBuy(player, player, …)` —
clawing shares back from the raider at the control price. Holding a majority is
NOT a shield: force-tender is always possible at a (steep, rising) price.

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
- **Hostile takeover:** a deliberate, *expensive* bid that **can** reach retained
  shares at a steep **control premium**. On the open market your retained shares
  are untouchable, but a determined raider can always force a tender **at a
  price** — so takeover is *always possible but expensive* (honors the earlier
  never-stuck rule; you can never be permanently blocked by a refusenik).
- **Control at >50% → squeeze-out:** force-buy the remaining minority at market +
  a premium and absorb the airline, reusing today's `acquire()` merge (networks,
  rights, fleet, debt, inherited slot apps).

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
  period** (buy back float / outbid). Fail to defend within the window → you are
  acquired = **game over**. Directly punishes winning early and coasting; the
  endgame becomes a takeover war, not a one-sided shopping spree.
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

Price-impact curve steepness; control premium size; squeeze-out premium; growth
multiple curve + cap (e.g. flat→~2×, ≥100%/yr growth→~15×); dominance threshold
(~45%); defense-window length; block size (10%?).

## State / persistence

Cap tables are persisted (new field on each saved airline) → bump `SAVE_VERSION`.
Price-impact state is derived from the cap table (float size), not stored.

## Validation

Sim across seeds: a year-3/4 player *cannot* corner the board (early rivals are
100%-held → full hostile bid on a high growth-aware V is unaffordable); a rich
player/AI can still take over later; AI-vs-AI stake-building and consolidation
occur; a dominant player gets raided and must defend; nobody is permanently
un-buyable (hostile bid always possible at a price).

## Out of scope

- Tier 3 (personal wealth / full RRT meta-layer) — never.
- Dividends — deferred (model noted above for if/when).
- Interline / code-sharing — separate future item (the "KC→Bucharest problem",
  `docs/TODO.md`).
