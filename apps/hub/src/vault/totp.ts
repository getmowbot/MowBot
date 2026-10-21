import { createHmac } from 'node:crypto';

/** A 2FA seed: from an authenticator app's `otpauth://` link or its base32 secret. */
export interface TotpSeed {
  secret: Buffer;
  digits: number;
  period: number;
  algorithm: 'sha1' | 'sha256' | 'sha512';
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[\s=-]/g, '');
  if (!clean || /[^A-Z2-7]/.test(clean)) throw new Error('Invalid base32 secret');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    value = (value << 5) | BASE32.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** Throws on anything that is not a usable seed. */
export function parseTotp(input: string): TotpSeed {
  const text = input.trim();
  if (text.toLowerCase().startsWith('otpauth://')) {
    const url = new URL(text);
    const secret = url.searchParams.get('secret');
    if (!secret) throw new Error('otpauth link without secret');
    const algorithm = (url.searchParams.get('algorithm') ?? 'SHA1').toLowerCase();
    if (algorithm !== 'sha1' && algorithm !== 'sha256' && algorithm !== 'sha512') {
      throw new Error(`Unsupported TOTP algorithm ${algorithm}`);
    }
    const digits = Number(url.searchParams.get('digits') ?? 6);
    const period = Number(url.searchParams.get('period') ?? 30);
    if (![6, 7, 8].includes(digits) || !(period > 0 && period <= 300)) {
      throw new Error('Unsupported TOTP parameters');
    }
    return { secret: base32(secret), digits, period, algorithm };
  }
  return { secret: base32(text), digits: 6, period: 30, algorithm: 'sha1' };
}

/** RFC 6238 code at `now`. */
export function totpCode(seed: TotpSeed, now = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 1000 / seed.period)));
  const mac = createHmac(seed.algorithm, seed.secret).update(counter).digest();
  const offset = (mac.at(-1) ?? 0) & 0x0f;
  const binary = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** seed.digits).padStart(seed.digits, '0');
}
