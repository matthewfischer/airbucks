import type { GameState } from '../game/types';
import { newGame, player } from '../game/engine';

/** The one live game. Reset/load swap its contents in place (Object.assign /
 *  applySave), so every module can safely hold this reference forever. */
export const game: GameState = newGame('crw');
game.humanControlled = true; // the app drives airlines[0] — enables rivals to target the player

/** The canonical player airline — always airlines[0]. Game logic uses this. */
export const me = () => player(game);
/** Whether the AI is driving the player's airline (a watch-only sim). */
export const spectating = () => !!me().ai;

/** Cross-module UI state. Mutable fields on one object so any module can both
 *  read and write them (module-level `let` bindings can't be reassigned by
 *  importers). */
export const ui = {
  /**
   * Which airline the views follow. You, normally; in spectate mode you can
   * switch focus to any airline from the Competitors tab so the HUD, sidebar,
   * map, and news feed render it.
   */
  watchedId: me().id,
  /** Ordered airports the player has clicked to stage a new (possibly multi-stop) route. */
  selected: [] as string[],
  /** True while the new-game home airport is being picked directly on the map. */
  homeSelecting: false,
  /** Measuring pin (⇧-click any airport): popovers show distance from here. */
  measureFrom: null as string | null,
  /** Airport under the cursor, for hover cards and the measuring rule. */
  lastHoveredAirport: null as string | null,
};

/** The watched airline, falling back to you if it's gone. */
export const watched = () =>
  spectating() ? game.airlines.find((a) => a.id === ui.watchedId) ?? me() : me();
/** The airline the views render — your own, or whoever you're watching. */
export const pl = () => watched();

export type View = 'map' | 'finance' | 'competitors' | 'awards';

/** App-level orchestration, late-bound by main.ts at startup. Modules call
 *  through here instead of importing main.ts (which would be circular). */
export const bus = {
  render: () => {},
  setView: (_v: View) => {},
  setPlaying: (_v: boolean) => {},
  startGameAt: (_homeId: string) => {},
  resetGame: () => {},
  afterStateSwap: () => {},
};

/** Log a warning to the news feed and re-render. No-op on null (the engine's
 *  "it worked" result), so call sites can pass an action's return directly. */
export function flash(message: string | null) {
  if (message) {
    pl().log.unshift(`⚠ ${message}`);
    bus.render();
  }
}
