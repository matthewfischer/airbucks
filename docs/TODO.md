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

- [ ] **AI visibility** (in progress)
  - [x] Map route lines in each airline's color (thin/dim, with a toggle)
  - [ ] Competitors tab: fleet size, cities served, vague health indicator
        — also the entry point for the for-sale buying UI below
  - [ ] News log events for AI moves (routes opened, slots won)
  - [ ] **For-sale listing UI + player can buy a distressed rival**
        (engine `acquire()` already buyer-agnostic & tested; just needs UI)
- [ ] **v2 demand-splitting** (own feature, not a consolidation hack):
  competition-aware `evaluateNetwork` so overlapping networks pressure
  each other. This is what makes consolidation real.
- [ ] **Balance**: study sim runs (`npm run sim -- 8 30 <seed>`, now fast
  after the evaluateNetwork perf fix); tune personalities, default count (4).
- [ ] **Merge `ai-players` → main** once playable end-to-end.

## Done

- [x] Distress / bankruptcy chain (distress.ts): 8wk-cash / 2yr-equity fuses,
  for-sale countdown, AI-to-AI acquisition (assumes debt), liquidation frees
  slots, news to player log. Save v7.
- [x] Perf: evaluateNetwork served-airports-only (bit-identical, big speedup).
- [x] AI homes capped to size 3-4 secondary hubs (no free size-5/6 major).
- [x] Map route lines for competitors + map toggle.

## Small

- [ ] Grand Cayman postcard (gcm) is CC BY-SA 2.0, not plain CC BY —
  decide: accept SA for manual picks or swap the image.
- [ ] AI weekly log lines? (AIs log slots/purchases but the player never sees
  them until the news-log visibility item lands.)
