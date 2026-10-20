// Writes the OpenAPI document to the path given as argument (consumed by @mowbot/api-client).
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { buildApp } from '../app';
import { loadConfig } from '../config';
import { openDatabase } from '../db/client';
import { createServices } from '../services';

const output = process.argv[2];
if (!output) throw new Error('Usage: export-openapi <output.json>');

const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'pglite://memory',
  MOWBOT_MASTER_KEY: randomBytes(32).toString('base64'),
});
const database = await openDatabase(config.databaseUrl);
await database.migrate();
const app = await buildApp(await createServices(config, database.db));
await app.ready();
await writeFile(output, `${JSON.stringify(app.swagger(), null, 2)}\n`);
await app.close();
await database.close();
console.log(`OpenAPI written to ${output}`);
