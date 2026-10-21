import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // PGlite boots a WASM Postgres per test file; give it room on slow machines.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Each worker holds a PGlite (~1 GB): one per core would fill the RAM of a dev machine.
    maxWorkers: 4,
  },
});
