# TODO (ai-players branch)

Status 2026-06-13: distress chain done. AI engine + sim + setup screen + the
distress/acquisition/bankruptcy chain all committed.

## Finding (2026-06-13)

A 25-year seed-3 sim (8 AIs) consolidated 8→7 only: one early liquidation
(Lone Star, before any rival was big enough to buy it), then every survivor
got rich ($0.5–1.3B equity, all profitable). Root cause: **v1 has no
passenger competition** (slots-only), so airlines in different regions never
hurt each other and healthy ones don't fail. Real 8→3 consolidation needs v2
demand-splitting — do NOT force it by tightening the distress fuse (that just
kills viable airlines). Distress is working correctly; it catches genuine
failures, which are rare by design in v1.

## Next

- [x] **AI visibility** — DONE
  - [x] Map route lines in each airline's color (thin/dim, with a toggle)
  - [x] Competitors tab: cities/routes/planes + vague health band
  - [x] For-sale listing + inline buy of a distressed rival (Competitors tab)
  - [x] News events for rival moves in your network (route opens / slot wins,
        gated to cities you hold; distress & acquisitions also log)
- [ ] **v2 demand-splitting** (own feature, not a consolidation hack):
  competition-aware `evaluateNetwork` so overlapping networks pressure
  each other. This is what makes consolidation real.
- [ ] **Balance**: study sim runs (`npm run sim -- 8 30 <seed>`, now fast
  after the evaluateNetwork perf fix); tune personalities, default count (4).
- [ ] **Interline / code-sharing — the "KC→Bucharest problem"** (tabled
  2026-06-20, fun-later, not now): today an O&D market is only realized if a
  *single* airline's network spans both ends (`evaluateNetwork` enumerates
  markets over one carrier's served airports only). A passenger from Kansas
  City to Bucharest who'd ride carrier A to a hub, then carrier B onward, is
  never carried — that through-demand is computed by `pairDemand` but goes
  unrealized for everyone. Add interline so two networks can jointly capture a
  trip neither serves end-to-end, each earning a partial fare. Note: the
  per-airline isolation in `competition()` is load-bearing; this is a real
  change to demand allocation, and it helps whoever has the better network
  (possibly the player), so it's not a fix for early-win balance.
- [x] **Merged `ai-players` → main** (2026-06-13). v1 AI is feature-complete:
      engine, sim, setup, distress chain, full visibility, competitor net-worth.

## Done

- [x] Distress / bankruptcy chain (distress.ts): 8wk-cash / 2yr-equity fuses,
  for-sale countdown, AI-to-AI acquisition (assumes debt), liquidation frees
  slots, news to player log. Save v7.
- [x] Perf: evaluateNetwork served-airports-only (bit-identical, big speedup).
- [x] AI homes capped to size 3-4 secondary hubs (no free size-5/6 major).
- [x] Map route lines for competitors + map toggle.

## Small

- (none — postcard licensing is a non-issue; this is a personal game.
  AI news to the player now ships via the visibility work.)
