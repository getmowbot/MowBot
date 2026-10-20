import { buildApp } from './app';
import { loadConfig } from './config';
import { openDatabase } from './db/client';
import { createServices } from './services';

const config = loadConfig();
const database = await openDatabase(config.databaseUrl);
await database.migrate();
const services = await createServices(config, database.db);
const app = await buildApp(services);
await services.computers.reconcile().catch((error) => {
  app.log.warn({ err: error }, 'Could not reconcile computers with Docker (is Docker reachable?)');
});
services.computers.startHibernation();

const pendingSetupToken = services.setup.pendingToken;
if (pendingSetupToken) {
  app.log.warn(
    services.setup.generated
      ? `No owner yet. Finish setup in the web app with this one-time setup token: ${pendingSetupToken}`
      : 'No owner yet. Finish setup in the web app with the configured MOWBOT_SETUP_TOKEN.',
  );
}

let closing = false;
const shutdown = async (signal: string) => {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, 'Shutting down');
  await app.close();
  await database.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: config.host, port: config.port });
