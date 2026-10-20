import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // PGlite boots a WASM Postgres per test file; give it room on slow machines.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
