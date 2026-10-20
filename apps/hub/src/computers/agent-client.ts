import WebSocket from 'ws';
import type { AgentEndpoint } from './runtime';

export interface AgentHealth {
  ok: boolean;
  vnc: boolean;
  controlLocked: boolean;
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

  /** Raw RFB stream to the computer's VNC server, bridged by the agent. */
  openVnc(): WebSocket {
    return new WebSocket(this.url('/vnc', 'ws'), {
      headers: { authorization: `Bearer ${this.token}` },
    });
  }
}
