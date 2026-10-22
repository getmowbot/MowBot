import http from 'node:http';
import type net from 'node:net';
import WebSocket from 'ws';
import type { AgentEndpoint } from './runtime';

/** mow-agent's raw relay upgrade (see /tcp in apps/agent). */
const TCP_UPGRADE = 'mowbot-tcp';

/** Nothing listens on that port of the computer, or the agent refused it. */
export class TunnelRefusedError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface AgentHealth {
  ok: boolean;
  vnc: boolean;
  controlLocked: boolean;
}

export interface ExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export class UserHasControlError extends Error {
  constructor() {
    super('The user has taken control of the desktop; wait until they hand it back.');
  }
}

async function agentError(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  return `mow-agent: ${body?.error ?? `HTTP ${response.status}`}`;
}

/** Talks to the mow-agent daemon running inside a computer. */
export class AgentClient {
  constructor(
    private readonly endpoint: AgentEndpoint,
    private readonly token: string,
  ) {}

  private url(pathname: string, protocol = 'http'): string {
    return `${protocol}://${this.endpoint.host}:${this.endpoint.port}${pathname}`;
  }

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' };
  }

  async health(timeoutMs = 3_000): Promise<AgentHealth> {
    const response = await fetch(this.url('/health'), {
      headers: this.headers(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`mow-agent health returned ${response.status}`);
    return (await response.json()) as AgentHealth;
  }

  /** While locked, the agent refuses input actions from bots (the user has the mouse). */
  async setControl(locked: boolean): Promise<void> {
    const response = await fetch(this.url('/control'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ locked }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`mow-agent control returned ${response.status}`);
  }

  /** Runs `bash -lc command` as the `bot` user. */
  async exec(
    command: string,
    options: { timeoutMs?: number; cwd?: string } = {},
  ): Promise<ExecResult> {
    const timeoutMs = options.timeoutMs ?? 120_000;
    const response = await fetch(this.url('/exec'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ command, timeoutMs, cwd: options.cwd }),
      signal: AbortSignal.timeout(timeoutMs + 10_000),
    });
    if (!response.ok) throw new Error(await agentError(response));
    return (await response.json()) as ExecResult;
  }

  /** PNG of the whole display. */
  async screenshot(): Promise<Buffer> {
    const response = await fetch(this.url('/screenshot'), {
      headers: this.headers(),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(await agentError(response));
    return Buffer.from(await response.arrayBuffer());
  }

  /** Mouse/keyboard action (see mow-agent `InputAction`). Fails while the user has control. */
  async input(action: Record<string, unknown>): Promise<void> {
    const response = await fetch(this.url('/input'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(action),
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status === 423) throw new UserHasControlError();
    if (!response.ok) throw new Error(await agentError(response));
  }

  /** Raw RFB stream to the computer's VNC server, bridged by the agent. */
  openVnc(): WebSocket {
    return new WebSocket(this.url('/vnc', 'ws'), {
      headers: { authorization: `Bearer ${this.token}` },
    });
  }

  /** Where to reach the computer's Chrome DevTools (bridged by the agent), and how to sign in. */
  cdpEndpoint(): { url: string; headers: Record<string, string> } {
    return {
      url: this.url('/cdp', 'ws'),
      headers: { authorization: `Bearer ${this.token}` },
    };
  }

  /**
   * A raw connection to a port of the computer's loopback (a dev server), relayed by the
   * agent: speak HTTP over it. Fails with `TunnelRefusedError` when nothing listens there.
   */
  openTunnel(port: number, timeoutMs = 10_000): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const request = http.request({
        host: this.endpoint.host,
        port: this.endpoint.port,
        path: `/tcp?port=${port}`,
        headers: {
          authorization: `Bearer ${this.token}`,
          connection: 'Upgrade',
          upgrade: TCP_UPGRADE,
        },
        timeout: timeoutMs,
      });
      request.once('upgrade', (_res, socket, head) => {
        socket.setTimeout(0);
        if (head.length > 0) socket.unshift(head);
        resolve(socket);
      });
      request.once('response', (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => {
          const error = (() => {
            try {
              return (JSON.parse(body) as { error?: string }).error;
            } catch {
              return undefined;
            }
          })();
          reject(new TunnelRefusedError(res.statusCode ?? 502, error ?? `HTTP ${res.statusCode}`));
        });
      });
      request.once('timeout', () => request.destroy(new Error('mow-agent did not answer')));
      request.once('error', reject);
      request.end();
    });
  }

  /** A long-lived process on the computer, its stdio over a WebSocket (MCP servers). */
  stdioEndpoint(): { url: string; headers: Record<string, string> } {
    return {
      url: this.url('/stdio', 'ws'),
      headers: { authorization: `Bearer ${this.token}` },
    };
  }
}
