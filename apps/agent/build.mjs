// Bundles mow-agent and its dependencies into a single CommonJS file copied into the
// workstation image (no node_modules there).
import { build } from 'esbuild';

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/agent.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  // Optional native accelerators of `ws`, absent at runtime.
  external: ['bufferutil', 'utf-8-validate'],
  logLevel: 'info',
});
