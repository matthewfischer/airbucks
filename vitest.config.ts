import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      // Game logic and UI helpers — the testable core. main.ts and the ui/
      // modules listed below are DOM wiring (they grab elements and attach
      // listeners at import time, so they can't load outside a browser);
      // electron/scripts aren't unit-tested, and dist/ is build output.
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/main.ts',
        'src/ui/app.ts',
        'src/ui/format.ts',
        'src/ui/map.ts',
        'src/ui/popover.ts',
        'src/ui/popups.ts',
        'src/ui/setup.ts',
        'src/ui/sidebar.ts',
        'src/ui/endgame.ts',
        'src/**/*.d.ts',
        'src/game/types.ts', // pure interfaces, no runtime code
      ],
    },
  },
});
