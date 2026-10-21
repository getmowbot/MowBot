import { z } from 'zod';

/**
 * A web page a bot is building on its PC (a dev server), shown to the user on a port of the
 * hub's own address. The link carries a secret: whoever has it can open the page (phone, another
 * computer); the first visit swaps it for a cookie of that preview.
 */
export const previewSchema = z.object({
  id: z.uuid(),
  computerId: z.uuid(),
  /** The bot that shared it (null once that bot is gone). */
  botId: z.uuid().nullable(),
  title: z.string(),
  /** Where the dev server listens on the PC. */
  port: z.number().int(),
  /** The hub's port it is served on, next to the hub's own address. */
  publicPort: z.number().int(),
  /** Page the link opens ("/", "/admin"…). */
  path: z.string(),
  /** The link to open or share, for the address the caller reaches the hub at. */
  url: z.url(),
  /** It ends then, or sooner when the PC stops or goes to sleep. */
  expiresAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
});
export type Preview = z.infer<typeof previewSchema>;

export const previewListSchema = z.object({ items: z.array(previewSchema) });

export const previewListQuerySchema = z.object({ computerId: z.uuid().optional() });

export const previewIdParamsSchema = z.object({ id: z.uuid() });
