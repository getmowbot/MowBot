import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ALL_SCOPES, type DeviceInput, type Scope } from '@mowbot/contract';
import { and, eq, isNull } from 'drizzle-orm';
import { type RequestContext, recordAudit } from '../audit';
import type { Config } from '../config';
import type { Db } from '../db/client';
import { devices, refreshTokens } from '../db/schema';
import { HttpProblem, unauthorized } from '../http/problems';
import type { AccessTokenClaims, AccessTokens } from './tokens';

export type DeviceRow = typeof devices.$inferSelect;

export interface IssuedSession {
  deviceId: string;
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

const LAST_SEEN_THROTTLE_MS = 5 * 60 * 1000;

const hashToken = (token: string) => createHash('sha256').update(token).digest('base64url');

/** Devices, access tokens and rotating refresh tokens. */
export class SessionService {
  constructor(
    private readonly db: Db,
    private readonly tokens: AccessTokens,
    private readonly config: Pick<Config, 'refreshTokenTtlSec' | 'refreshReuseGraceSec'>,
  ) {}

  async createDevice(
    ownerId: string,
    input: DeviceInput,
    scopes: readonly Scope[] = ALL_SCOPES,
  ): Promise<DeviceRow> {
    const [device] = await this.db
      .insert(devices)
      .values({ ownerId, name: input.name, kind: input.kind, scopes: [...scopes] })
      .returning();
    if (!device) throw new Error('Device insert returned no row');
    return device;
  }

  async issue(
    ownerId: string,
    deviceId: string,
    scopes: Scope[],
    familyId: string = randomUUID(),
  ): Promise<IssuedSession> {
    const refreshToken = randomBytes(32).toString('base64url');
    const refreshTokenExpiresAt = new Date(Date.now() + this.config.refreshTokenTtlSec * 1000);
    await this.db.insert(refreshTokens).values({
      deviceId,
      familyId,
      tokenHash: hashToken(refreshToken),
      expiresAt: refreshTokenExpiresAt,
    });
    const access = await this.tokens.sign({ ownerId, deviceId, scopes });
    return {
      deviceId,
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken,
      refreshTokenExpiresAt,
    };
  }

  /**
   * Rotates a refresh token. Reusing an already rotated token outside the grace window is
   * treated as theft: the device and its whole token family are revoked.
   */
  async refresh(
    rawToken: string,
    ctx: RequestContext,
  ): Promise<{ session: IssuedSession; device: DeviceRow }> {
    const [row] = await this.db
      .select({ token: refreshTokens, device: devices })
      .from(refreshTokens)
      .innerJoin(devices, eq(refreshTokens.deviceId, devices.id))
      .where(eq(refreshTokens.tokenHash, hashToken(rawToken)));

    const now = new Date();
    if (!row || row.token.revokedAt || row.device.revokedAt || row.token.expiresAt <= now) {
      throw unauthorized('Invalid refresh token');
    }

    if (row.token.usedAt) {
      if (now.getTime() - row.token.usedAt.getTime() <= this.config.refreshReuseGraceSec * 1000) {
        throw new HttpProblem(401, 'refresh_token_race', 'Refresh token already rotated');
      }
      await this.revokeDevice(row.device.id);
      await recordAudit(this.db, {
        actorType: 'system',
        action: 'auth.refresh_token_reused',
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        data: { deviceId: row.device.id, familyId: row.token.familyId },
      });
      throw new HttpProblem(401, 'refresh_token_reused', 'Refresh token reuse detected');
    }

    // Conditional update: only one concurrent caller can consume the token.
    const consumed = await this.db
      .update(refreshTokens)
      .set({ usedAt: now })
      .where(and(eq(refreshTokens.id, row.token.id), isNull(refreshTokens.usedAt)))
      .returning({ id: refreshTokens.id });
    if (consumed.length === 0) {
      throw new HttpProblem(401, 'refresh_token_race', 'Refresh token already rotated');
    }

    const session = await this.issue(
      row.device.ownerId,
      row.device.id,
      row.device.scopes,
      row.token.familyId,
    );
    return { session, device: row.device };
  }

  async revokeDevice(deviceId: string): Promise<void> {
    const now = new Date();
    await this.db.update(devices).set({ revokedAt: now }).where(eq(devices.id, deviceId));
    await this.db
      .update(refreshTokens)
      .set({ revokedAt: now })
      .where(and(eq(refreshTokens.deviceId, deviceId), isNull(refreshTokens.revokedAt)));
  }

  /** Verifies an access token and checks its device is still active (revocation is immediate). */
  async authenticate(accessToken: string): Promise<AccessTokenClaims> {
    let claims: AccessTokenClaims;
    try {
      claims = await this.tokens.verify(accessToken);
    } catch {
      throw unauthorized('Invalid or expired access token');
    }
    const [device] = await this.db
      .select({ revokedAt: devices.revokedAt, lastSeenAt: devices.lastSeenAt })
      .from(devices)
      .where(eq(devices.id, claims.deviceId));
    if (!device || device.revokedAt) throw unauthorized('Device revoked');

    const now = Date.now();
    if (!device.lastSeenAt || now - device.lastSeenAt.getTime() > LAST_SEEN_THROTTLE_MS) {
      await this.db
        .update(devices)
        .set({ lastSeenAt: new Date(now) })
        .where(eq(devices.id, claims.deviceId));
    }
    return claims;
  }
}
