// A small MCP server speaking stdio, started behind mow-agent's /stdio in the tests.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'notes', version: '1.0.0' });
server.registerTool(
  'echo',
  { description: 'Repeats a text, with the GREETING variable', inputSchema: { text: z.string() } },
  async ({ text }) => ({
    content: [{ type: 'text', text: `${process.env.GREETING ?? 'echo'}: ${text}` }],
  }),
);
server.registerTool(
  'playlist',
  { description: 'Lists the tracks of a long playlist', inputSchema: { count: z.number() } },
  async ({ count }) => ({
    content: [
      {
        type: 'text',
        text: Array.from({ length: count }, (_, i) => `Track ${i + 1}: a rather long title`).join(
          '\n',
        ),
      },
    ],
  }),
);
server.registerTool('whoami', { description: 'Tells its token', inputSchema: {} }, async () => ({
  content: [{ type: 'text', text: `token=${process.env.API_TOKEN ?? ''}` }],
}));
await server.connect(new StdioServerTransport());
