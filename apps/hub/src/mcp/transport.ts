import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import WebSocket from 'ws';

type Frame = { t: 'out'; d: string } | { t: 'err'; d: string } | { t: 'exit'; code: number | null };

/** How much of what the server writes on stderr is kept, to explain a failure. */
const STDERR_KEPT = 2_000;

/**
 * An MCP stdio server running on a computer: mow-agent starts the command and relays its
 * stdin and stdout over a WebSocket, one JSON-RPC message per line.
 */
export class AgentStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private socket: WebSocket | null = null;
  /** The end of what the server wrote on stderr. */
  stderr = '';

  constructor(
    private readonly endpoint: { url: string; headers: Record<string, string> },
    private readonly command: string,
    private readonly env: Record<string, string>,
  ) {}

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.endpoint.url, { headers: this.endpoint.headers });
      this.socket = socket;
      socket.once('open', () => {
        socket.send(JSON.stringify({ t: 'start', command: this.command, env: this.env }));
        resolve();
      });
      socket.once('error', reject);
      socket.on('message', (data: WebSocket.RawData) => {
        let frame: Frame;
        try {
          frame = JSON.parse(data.toString()) as Frame;
        } catch {
          return;
        }
        if (frame.t === 'err') {
          this.stderr = (this.stderr + frame.d).slice(-STDERR_KEPT);
        } else if (frame.t === 'out') {
          try {
            this.onmessage?.(JSON.parse(frame.d) as JSONRPCMessage);
          } catch {
            // A line that is not JSON-RPC (a log on stdout): ignored.
          }
        } else if (frame.t === 'exit' && frame.code) {
          this.onerror?.(
            new Error(`The server stopped (exit ${frame.code}): ${this.stderr.trim().slice(-400)}`),
          );
        }
      });
      socket.on('close', () => this.onclose?.());
      socket.on('error', (error) => this.onerror?.(error));
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.socket?.readyState !== WebSocket.OPEN)
      throw new Error('The MCP server is not running');
    this.socket.send(JSON.stringify({ t: 'in', d: JSON.stringify(message) }));
  }

  async close(): Promise<void> {
    this.socket?.close();
    this.socket = null;
  }
}
