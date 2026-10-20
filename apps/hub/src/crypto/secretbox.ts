import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v1';

/**
 * AES-256-GCM with the instance master key. `purpose` is bound as additional data so a
 * ciphertext stored for one use cannot be replayed as another.
 * Format: `v1.<iv>.<tag>.<ciphertext>` (base64url parts).
 */
export function seal(masterKey: Buffer, purpose: string, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', masterKey, iv);
  cipher.setAAD(Buffer.from(purpose, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv, tag, ciphertext]
    .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
    .join('.');
}

export function open(masterKey: Buffer, purpose: string, sealed: string): string {
  const [version, iv, tag, ciphertext] = sealed.split('.');
  if (version !== VERSION || !iv || !tag || ciphertext === undefined) {
    throw new Error('Unsupported sealed value');
  }
  const decipher = createDecipheriv('aes-256-gcm', masterKey, Buffer.from(iv, 'base64url'));
  decipher.setAAD(Buffer.from(purpose, 'utf8'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
