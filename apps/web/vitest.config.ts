import { defineConfig } from 'vitest/config';

// Unit tests of the app's pure logic (lib/), without the app's Vite plugins.
export default defineConfig({
  test: { include: ['src/**/*.test.ts'] },
});
