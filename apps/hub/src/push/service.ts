import { DEFAULT_PUSH_PREFS, type PushPrefs } from '@mowbot/contract';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import type { Logger } from '../computers/service';
import type { Db } from '../db/client';
import { bots, devices } from '../db/schema';
import type { SystemService } from '../proactivity/notifications';
import { inQuietHours } from '../proactivity/schedule';

/**
 * `finished`: a bot finished what the user asked; `needs_you`: a bot waits for the user
 * (question, login to enter…); `notification`: what a bot notified (urgent or normal).
 */
export type PushKind = 'finished' | 'needs_you' | 'notification';

export interface Push {
  kind: PushKind;
  botId: string | null;
  /** Looked up from botId when not given. */
  botName?: string | null;
  title: string;
  body?: string | null;
  urgent?: boolean;
}

const PREF: Record<PushKind, keyof PushPrefs> = {
  finished: 'finished',
  needs_you: 'needsYou',
  notification: 'notifications',
};

/** Expo accepts up to 100 messages per request. */
const BATCH = 100;
const MAX_BODY = 180;

/** What the phone shows when the bots' words are hidden. */
function hidden(push: Push, who: string): { title: string } {
  if (push.kind === 'finished') return { title: `${who} a fini` };
  if (push.kind === 'needs_you') return { title: `${who} a besoin de toi` };
  return { title: `${who} : nouvelle notification` };
}

/** Markdown read aloud by a notification: no markup, one paragraph, short. */
export function plainExcerpt(text: string, max = MAX_BODY): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>|~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length <= max ? plain : `${plain.slice(0, max - 1).trimEnd()}…`;
}

interface ExpoTicket {
  status: 'ok' | 'error';
  details?: { error?: string };
}

/**
 * Push notifications to the user's phones, through Expo's push service (which hands them to
 * Apple and Google). Each device chooses what it hears about, and whether bots' words show.
 */
export class PushService {
  private log: Logger = { warn: () => {}, error: () => {} };

  constructor(
    private readonly db: Db,
    private readonly system: SystemService,
    private readonly options: { url: string; fetch?: typeof fetch },
  ) {}

  setLogger(log: Logger): void {
    this.log = log;
  }

  /** Sends in the background: a failed push never fails what triggered it. */
  notify(push: Push): void {
    this.send(push).catch((error) => this.log.warn({ err: error }, 'Push failed'));
  }

  async send(push: Push): Promise<number> {
    // Bots' own news waits outside quiet hours, unless urgent; answers and requests do not.
    if (push.kind === 'notification' && !push.urgent) {
      const settings = await this.system.get();
      if (inQuietHours(settings.quietHours, new Date(), this.system.timeZone)) return 0;
    }
    const rows = await this.db
      .select({ id: devices.id, token: devices.pushToken, prefs: devices.pushPrefs })
      .from(devices)
      .where(and(isNotNull(devices.pushToken), isNull(devices.revokedAt)));
    const url = push.botId ? `/chat/${push.botId}` : '/activity';
    const [bot] = push.botId
      ? await this.db.select({ name: bots.name }).from(bots).where(eq(bots.id, push.botId))
      : [];
    const who = push.botName ?? bot?.name ?? 'MowBot';
    const messages = rows.flatMap((row) => {
      const prefs = { ...DEFAULT_PUSH_PREFS, ...row.prefs };
      if (!row.token || !prefs[PREF[push.kind]]) return [];
      const text = prefs.hideContent
        ? hidden(push, who)
        : {
            title: push.title,
            ...(push.body ? { body: plainExcerpt(push.body) } : {}),
          };
      return [
        {
          deviceId: row.id,
          message: {
            to: row.token,
            ...text,
            sound: 'default',
            priority: push.urgent ? 'high' : 'default',
            data: { url },
          },
        },
      ];
    });
    for (let i = 0; i < messages.length; i += BATCH) {
      await this.post(messages.slice(i, i + BATCH));
    }
    return messages.length;
  }

  private async post(batch: { deviceId: string; message: object }[]): Promise<void> {
    const response = await (this.options.fetch ?? fetch)(this.options.url, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(batch.map((entry) => entry.message)),
    });
    if (!response.ok) {
      this.log.warn({ status: response.status }, 'Push service refused the notifications');
      return;
    }
    const { data } = (await response.json()) as { data?: ExpoTicket[] };
    // A phone that uninstalled the app (or turned notifications off) is forgotten.
    for (const [index, ticket] of (data ?? []).entries()) {
      const entry = batch[index];
      if (entry && ticket.status === 'error' && ticket.details?.error === 'DeviceNotRegistered') {
        await this.db
          .update(devices)
          .set({ pushToken: null })
          .where(eq(devices.id, entry.deviceId));
      }
    }
  }
}
