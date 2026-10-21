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
await server.connect(new StdioServerTransport());
