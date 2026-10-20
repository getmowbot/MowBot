// Bundles the hub into dist/ (workspace packages inlined, npm dependencies kept external)
// and copies the SQL migrations next to it.
import { cp, readFile, rm } from 'node:fs/promises';
import { build } from 'esbuild';

const pkg = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));

await rm('dist', { recursive: true, force: true });
await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: true,
  external: [...Object.keys(pkg.dependencies ?? {}), '@electric-sql/pglite', 'drizzle-orm/*'],
  logLevel: 'info',
});
await cp('drizzle', 'dist/drizzle', { recursive: true });
