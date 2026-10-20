import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from './schema';

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface Database {
  db: Db;
  migrate(): Promise<void>;
  close(): Promise<void>;
}

const PGLITE_PREFIX = 'pglite://';

/** Migrations sit next to the bundle in production (dist/drizzle) and at the package root in dev. */
function migrationsFolder(): string {
  const candidates = [
    path.join(import.meta.dirname, 'drizzle'),
    path.join(import.meta.dirname, '..', '..', 'drizzle'),
  ];
  const found = candidates.find((dir) => existsSync(path.join(dir, 'meta', '_journal.json')));
  if (!found) throw new Error(`Drizzle migrations not found (looked in ${candidates.join(', ')})`);
  return found;
}

/**
 * Opens Postgres (`postgres://…`) or an embedded PGlite (`pglite://<dir>`, `pglite://memory`).
 * PGlite lets the hub and its tests run on a laptop without Docker.
 */
export async function openDatabase(url: string): Promise<Database> {
  if (url.startsWith(PGLITE_PREFIX)) {
    const { PGlite } = await import('@electric-sql/pglite');
    const { drizzle } = await import('drizzle-orm/pglite');
    const { migrate } = await import('drizzle-orm/pglite/migrator');
    const location = url.slice(PGLITE_PREFIX.length);
    if (location !== 'memory') mkdirSync(location, { recursive: true });
    const client = location === 'memory' ? new PGlite() : new PGlite(location);
    const db = drizzle(client, { schema });
    return {
      db,
      migrate: () => migrate(db, { migrationsFolder: migrationsFolder() }),
      close: () => client.close(),
    };
  }

  const { Pool } = (await import('pg')).default;
  const { drizzle } = await import('drizzle-orm/node-postgres');
  const { migrate } = await import('drizzle-orm/node-postgres/migrator');
  const pool = new Pool({ connectionString: url, max: 10 });
  const db = drizzle(pool, { schema });
  return {
    db,
    migrate: () => migrate(db, { migrationsFolder: migrationsFolder() }),
    close: () => pool.end(),
  };
}
