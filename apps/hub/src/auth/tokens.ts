import { randomUUID } from 'node:crypto';
import { type Scope, scopeSchema } from '@mowbot/contract';
import { eq } from 'drizzle-orm';
import { exportJWK, generateKeyPair, importJWK, type JWK, jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';
import { open, seal } from '../crypto/secretbox';
import type { Db } from '../db/client';
import { settings } from '../db/schema';

const ALG = 'Ed25519';
const ISSUER = 'mowbot';
const AUDIENCE = 'mowbot-api';
const SETTINGS_KEY = 'auth.access_token_signing_key';
const SEAL_PURPOSE = 'access-token-signing-key';

interface StoredSigningKey {
  kid: string;
  publicJwk: JWK;
  sealedPrivateJwk: string;
}

export interface AccessTokenClaims {
  ownerId: string;
  deviceId: string;
  scopes: Scope[];
}

export interface AccessTokens {
  sign(claims: AccessTokenClaims): Promise<{ token: string; expiresAt: Date }>;
  /** Throws when the token is invalid or expired. */
  verify(token: string): Promise<AccessTokenClaims>;
}

const payloadSchema = z.object({
  sub: z.string(),
  did: z.string(),
  scope: z.string(),
});

/**
 * Loads the Ed25519 signing key from `settings` (private half sealed with the master key),
 * creating it on first start.
 */
async function loadOrCreateSigningKey(db: Db, masterKey: Buffer): Promise<StoredSigningKey> {
  const [row] = await db.select().from(settings).where(eq(settings.key, SETTINGS_KEY));
  if (row) return row.value as StoredSigningKey;

  const { publicKey, privateKey } = await generateKeyPair(ALG, { extractable: true });
  const stored: StoredSigningKey = {
    kid: randomUUID(),
    publicJwk: await exportJWK(publicKey),
    sealedPrivateJwk: seal(masterKey, SEAL_PURPOSE, JSON.stringify(await exportJWK(privateKey))),
  };
  // Another process may have raced us: keep whichever key landed first.
  await db.insert(settings).values({ key: SETTINGS_KEY, value: stored }).onConflictDoNothing();
  const [winner] = await db.select().from(settings).where(eq(settings.key, SETTINGS_KEY));
  return (winner?.value as StoredSigningKey | undefined) ?? stored;
}

export async function createAccessTokens(
  db: Db,
  masterKey: Buffer,
  ttlSec: number,
): Promise<AccessTokens> {
  const stored = await loadOrCreateSigningKey(db, masterKey);
  const privateJwk = JSON.parse(open(masterKey, SEAL_PURPOSE, stored.sealedPrivateJwk)) as JWK;
  const privateKey = await importJWK(privateJwk, ALG);
  const publicKey = await importJWK(stored.publicJwk, ALG);

  return {
    async sign({ ownerId, deviceId, scopes }) {
      const expiresAt = new Date(Date.now() + ttlSec * 1000);
      const token = await new SignJWT({ did: deviceId, scope: scopes.join(' ') })
        .setProtectedHeader({ alg: ALG, kid: stored.kid, typ: 'at+jwt' })
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setSubject(ownerId)
        .setIssuedAt()
        .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
        .sign(privateKey);
      return { token, expiresAt };
    },

    async verify(token) {
      const { payload } = await jwtVerify(token, publicKey, {
        issuer: ISSUER,
        audience: AUDIENCE,
        algorithms: [ALG],
        typ: 'at+jwt',
      });
      const claims = payloadSchema.parse(payload);
      const scopes = claims.scope
        .split(' ')
        .filter((s) => scopeSchema.safeParse(s).success) as Scope[];
      return { ownerId: claims.sub, deviceId: claims.did, scopes };
    },
  };
}
