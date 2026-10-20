/**
 * Coordination of bots sharing a team PC. Shells, files and the network run in parallel; the
 * display (mouse, keyboard, what a screenshot shows) is one, so bots take turns on it: a bot
 * holds the screen while it uses it and a little after, others wait in line.
 */

interface Holder {
  botId: string;
  botName: string;
  until: number;
}

const SCREEN_LEASE_MS = 30_000;
const SCREEN_WAIT_MS = 120_000;
const FILE_LOCK_MS = 20 * 60_000;

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

export class ScreenLeases {
  private readonly leases = new Map<string, Holder>();

  constructor(
    private readonly leaseMs = SCREEN_LEASE_MS,
    private readonly waitMs = SCREEN_WAIT_MS,
  ) {}

  holder(computerId: string): Holder | null {
    const lease = this.leases.get(computerId);
    return lease && lease.until > Date.now() ? lease : null;
  }

  /** Takes (or renews) the screen of a computer, waiting for the bot that has it. */
  async acquire(
    computerId: string,
    bot: { id: string; name: string },
    signal?: AbortSignal,
  ): Promise<void> {
    const deadline = Date.now() + this.waitMs;
    for (;;) {
      const lease = this.holder(computerId);
      if (!lease || lease.botId === bot.id) {
        this.leases.set(computerId, {
          botId: bot.id,
          botName: bot.name,
          until: Date.now() + this.leaseMs,
        });
        return;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `L'écran du PC est utilisé par ${lease.botName}. Avance sur autre chose (shell, fichiers) et réessaie dans un moment.`,
        );
      }
      await sleep(Math.min(500, lease.until - Date.now() + 10), signal);
    }
  }

  /** Lets the next bot in (end of a run). */
  releaseAll(botId: string): void {
    for (const [computerId, lease] of this.leases) {
      if (lease.botId === botId) this.leases.delete(computerId);
    }
  }
}

/** Advisory locks on workspace files, so two bots don't rewrite the same file at once. */
export class FileLocks {
  private readonly locks = new Map<string, Holder & { workspaceId: string; path: string }>();

  private key = (workspaceId: string, path: string) => `${workspaceId}:${path}`;

  holder(workspaceId: string, path: string): Holder | null {
    const lock = this.locks.get(this.key(workspaceId, path));
    return lock && lock.until > Date.now() ? lock : null;
  }

  lock(workspaceId: string, path: string, bot: { id: string; name: string }): void {
    const current = this.holder(workspaceId, path);
    if (current && current.botId !== bot.id) {
      throw new Error(`/workspace/${path} est verrouillé par ${current.botName}.`);
    }
    this.locks.set(this.key(workspaceId, path), {
      workspaceId,
      path,
      botId: bot.id,
      botName: bot.name,
      until: Date.now() + FILE_LOCK_MS,
    });
  }

  unlock(workspaceId: string, path: string, botId: string): boolean {
    const key = this.key(workspaceId, path);
    if (this.locks.get(key)?.botId !== botId) return false;
    return this.locks.delete(key);
  }

  /** Writing is refused while another bot holds the lock. */
  assertWritable(workspaceId: string, path: string, botId: string): void {
    const current = this.holder(workspaceId, path);
    if (current && current.botId !== botId) {
      throw new Error(
        `/workspace/${path} est verrouillé par ${current.botName} : attends qu'il ait fini ou demande-lui.`,
      );
    }
  }

  list(workspaceId: string): { path: string; botName: string }[] {
    return [...this.locks.values()]
      .filter((lock) => lock.workspaceId === workspaceId && lock.until > Date.now())
      .map(({ path, botName }) => ({ path, botName }));
  }

  releaseAll(botId: string): void {
    for (const [key, lock] of this.locks) if (lock.botId === botId) this.locks.delete(key);
  }
}
