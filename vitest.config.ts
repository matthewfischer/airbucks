import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      // Game logic and UI helpers — the testable core. main.ts is DOM wiring,
      // electron/scripts aren't unit-tested, and dist/ is build output.
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/main.ts',
        'src/**/*.d.ts',
        'src/game/types.ts', // pure interfaces, no runtime code
      ],
    },
  },
});
