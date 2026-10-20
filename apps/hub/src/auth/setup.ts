import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db/client';
import { owner } from '../db/schema';

export async function ownerExists(db: Db): Promise<boolean> {
  const rows = await db.select({ id: owner.id }).from(owner).limit(1);
  return rows.length > 0;
}

const digest = (value: string) => createHash('sha256').update(value).digest();

/**
 * Guards first-run setup: until an owner exists, creating one requires a one-time token
 * (configured, or generated and printed in the logs). Prevents anyone who reaches a fresh
 * instance first from claiming it.
 */
export class SetupGate {
  private constructor(
    private token: string | null,
    readonly generated: boolean,
  ) {}

  static async create(db: Db, configuredToken: string | undefined): Promise<SetupGate> {
    if (await ownerExists(db)) return new SetupGate(null, false);
    if (configuredToken) return new SetupGate(configuredToken, false);
    return new SetupGate(randomBytes(18).toString('base64url'), true);
  }

  /** The token to print at startup, or null when setup is already done. */
  get pendingToken(): string | null {
    return this.token;
  }

  check(candidate: string): boolean {
    if (!this.token) return false;
    return timingSafeEqual(digest(candidate), digest(this.token));
  }

  complete(): void {
    this.token = null;
  }
}
