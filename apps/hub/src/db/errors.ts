/** Postgres unique violation (23505), as raised by pg or PGlite, possibly wrapped by Drizzle. */
export function isUniqueViolation(error: unknown): boolean {
  const err = error as { code?: string; cause?: { code?: string } };
  return err.code === '23505' || err.cause?.code === '23505';
}
