import { randomBytes } from 'node:crypto';

export type TicketKind = 'events' | 'desktop' | 'download';

export interface TicketPayload {
  kind: TicketKind;
  ownerId: string;
  deviceId: string;
  data: Record<string, string>;
}

/**
 * Single-use, short-lived credentials for URLs a client cannot attach an Authorization header
 * to (WebSocket handshakes, download links). Kept in memory: the hub runs as one process.
 */
export class TicketService {
  private readonly tickets = new Map<string, TicketPayload & { expiresAt: number }>();

  constructor(private readonly ttlMs = 60_000) {}

  issue(payload: TicketPayload): { ticket: string; expiresAt: Date } {
    const now = Date.now();
    for (const [key, value] of this.tickets) if (value.expiresAt <= now) this.tickets.delete(key);
    const ticket = randomBytes(24).toString('base64url');
    const expiresAt = now + this.ttlMs;
    this.tickets.set(ticket, { ...payload, expiresAt });
    return { ticket, expiresAt: new Date(expiresAt) };
  }

  consume(ticket: string | undefined, kind: TicketKind): TicketPayload | null {
    if (!ticket) return null;
    const found = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    if (!found || found.kind !== kind || found.expiresAt <= Date.now()) return null;
    const { expiresAt: _, ...payload } = found;
    return payload;
  }
}
