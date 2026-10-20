import { existsSync } from 'node:fs';
import { createAgent } from './server';

const token = process.env.MOWBOT_AGENT_TOKEN;
if (!token) {
  console.error('MOWBOT_AGENT_TOKEN is required');
  process.exit(1);
}

const agent = createAgent({
  token,
  display: process.env.DISPLAY ?? ':0',
  vncPort: Number(process.env.MOWBOT_VNC_PORT ?? 5900),
  workdir: existsSync('/workspace') ? '/workspace' : process.env.HOME,
});

// Bundled as CommonJS: no top-level await.
agent
  .listen(Number(process.env.MOWBOT_AGENT_PORT ?? 7070))
  .then((address) => console.log(`mow-agent listening on ${address.address}:${address.port}`))
  .catch((error: Error) => {
    console.error(`mow-agent failed to start: ${error.message}`);
    process.exit(1);
  });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void agent.close().then(() => process.exit(0));
  });
}
