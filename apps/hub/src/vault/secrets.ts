import type { VaultField } from '@mowbot/contract';

/** `{{vault:3f2a9c1b.password}}`: a value from the vault, filled in when the tool runs. */
export const PLACEHOLDER =
  /\{\{\s*vault:([0-9a-f-]{4,36})\.(username|password|totp|value)\s*\}\}/gi;

export const MASK = '[secret masqué]';

/** Shorter values would mask ordinary text. */
const MIN_MASKED = 4;

export interface Revealer {
  /** The value of a field; `secret` when it must not show in outputs. */
  reveal(ref: string, field: VaultField): Promise<{ value: string; secret: boolean }>;
}

/** Replaces every secret in strings nested in a tool's output. */
export function maskIn<T>(value: T, secrets: string[]): T {
  if (secrets.length === 0) return value;
  const mask = (text: string) =>
    secrets.reduce((acc, secret) => acc.replaceAll(secret, MASK), text);
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') return mask(node);
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object' && Object.getPrototypeOf(node) === Object.prototype) {
      return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, walk(child)]));
    }
    return node;
  };
  return walk(value) as T;
}

/**
 * The vault as one bot's run sees it: placeholders in its commands and typed text become the
 * values, and every vault secret is masked in what its tools return.
 */
export class SecretScope {
  private readonly secrets = new Set<string>();

  constructor(
    private readonly revealer: Revealer,
    known: string[] = [],
  ) {
    for (const secret of known) this.remember(secret);
  }

  private remember(secret: string): void {
    if (secret.length >= MIN_MASKED) this.secrets.add(secret);
  }

  /** The text with its placeholders filled in. */
  async expand(text: string): Promise<string> {
    const found = new Map<string, string>();
    for (const [whole, ref, field] of text.matchAll(PLACEHOLDER)) {
      if (found.has(whole) || !ref || !field) continue;
      const { value, secret } = await this.revealer.reveal(
        ref.toLowerCase(),
        field.toLowerCase() as VaultField,
      );
      if (secret) this.remember(value);
      found.set(whole, value);
    }
    if (found.size === 0) return text;
    return text.replace(PLACEHOLDER, (whole) => found.get(whole) ?? whole);
  }

  /** Longest first, so a secret containing another is masked whole. */
  private ordered(): string[] {
    return [...this.secrets].sort((a, b) => b.length - a.length);
  }

  mask<T>(value: T): T {
    return maskIn(value, this.ordered());
  }

  maskError(error: unknown): unknown {
    if (!(error instanceof Error) || this.secrets.size === 0) return error;
    const masked = this.mask(error.message);
    return masked === error.message ? error : new Error(masked);
  }
}
