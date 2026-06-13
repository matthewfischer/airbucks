# TODO (ai-players branch)

Status 2026-06-12: AI engine + sim + setup screen done and committed.

## Next

- [ ] **Distress / bankruptcy chain** (docs/ai-players.md §Distress)
  - Trigger: cash < 0 for ~8 consecutive weeks, OR equity < 0 for ~2 game-years
    (long window so recovering overexpanders survive; kills the Northern Cross
    zombie case — $380M debt, −$172M equity, positive cash flow forever).
  - Distress → news event → for sale (equity-based price, buyer assumes debt,
    ~2 game-months countdown) → liquidation if unbought, slots back to pool.
  - AI-to-AI acquisitions in from the start; player can buy too.
- [ ] **AI visibility**
  - [ ] Map route lines in each airline's color (thinner/dimmer than player's)
  - [ ] Competitors tab: fleet size, cities served, vague health indicator
  - [ ] News log events for AI moves (routes opened, slots won)
- [ ] **Balance**: study 30-year sim runs (`npm run sim -- 8 30 <seed>`);
  tune personalities, default competitor count (currently 4).
- [ ] **Merge `ai-players` → main** once playable end-to-end.

## Small

- [ ] Grand Cayman postcard (gcm) is CC BY-SA 2.0, not plain CC BY —
  decide: accept SA for manual picks or swap the image.
- [ ] AI weekly log lines? (AIs log slots/purchases but the player never sees
  them until the news-log visibility item lands.)
