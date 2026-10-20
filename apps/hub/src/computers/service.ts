import type { Computer } from '@mowbot/contract';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { open } from '../crypto/secretbox';
import type { Db } from '../db/client';
import { computers } from '../db/schema';
import type { EventBus } from '../events';
import { HttpProblem, notFound } from '../http/problems';
import { AgentClient } from './agent-client';
import type { ComputerRuntime } from './runtime';

export const AGENT_TOKEN_PURPOSE = 'computer-agent-token';

type ComputerRow = typeof computers.$inferSelect;

export interface Logger {
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

const silentLogger: Logger = { warn: () => {}, error: () => {} };

const ACTIVITY_THROTTLE_MS = 60_000;

export function toComputer(row: ComputerRow): Computer {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    teamId: row.teamId,
    workspaceId: row.workspaceId,
    status: row.status,
    statusDetail: row.statusDetail,
    control:
      row.controlDeviceId && row.controlSince
        ? { deviceId: row.controlDeviceId, since: row.controlSince.toISOString() }
        : null,
    lastActivityAt: row.lastActivityAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface ComputerServiceOptions {
  idleMinutes: number;
  /** How long to wait for mow-agent after the container starts. */
  bootTimeoutMs?: number;
}

/** Lifecycle of computers (start, stop, hibernation) and desktop control. */
export class ComputerService {
  private log: Logger = silentLogger;
  /** Open desktop views per computer, counted per device. */
  private readonly desktopSessions = new Map<string, Map<string, number>>();
  private readonly lastTouch = new Map<string, number>();
  private readonly boots = new Map<string, Promise<void>>();
  private hibernationTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: Db,
    private readonly runtime: ComputerRuntime,
    private readonly events: EventBus,
    private readonly masterKey: Buffer,
    private readonly options: ComputerServiceOptions,
  ) {}

  setLogger(log: Logger): void {
    this.log = log;
  }

  async list(): Promise<Computer[]> {
    const rows = await this.db.select().from(computers).orderBy(computers.createdAt);
    return rows.map(toComputer);
  }

  async get(id: string): Promise<Computer> {
    return toComputer(await this.row(id));
  }

  /** Starts the computer in the background; follow `computer.updated` events for progress. */
  async start(id: string): Promise<Computer> {
    const row = await this.row(id);
    if (row.status === 'running' || row.status === 'starting') return toComputer(row);
    if (row.status === 'stopping')
      throw new HttpProblem(409, 'computer_busy', 'Computer is stopping');
    const updated = await this.update(id, { status: 'starting', statusDetail: null });
    const boot = this.boot(updated).finally(() => this.boots.delete(id));
    this.boots.set(id, boot);
    return toComputer(updated);
  }

  /** Resolves once a start launched by `start()` has finished (used by tests). */
  async waitForBoot(id: string): Promise<void> {
    await this.boots.get(id);
  }

  async stop(id: string): Promise<Computer> {
    const row = await this.row(id);
    if (row.status === 'stopped') return toComputer(row);
    await this.boots.get(id);
    await this.update(id, { status: 'stopping' });
    try {
      if (row.containerId) await this.runtime.stop(row.containerId);
      return toComputer(
        await this.update(id, {
          status: 'stopped',
          statusDetail: null,
          controlDeviceId: null,
          controlSince: null,
        }),
      );
    } catch (error) {
      this.log.error({ err: error, computerId: id }, 'Failed to stop computer');
      await this.update(id, { status: 'error', statusDetail: (error as Error).message });
      throw error;
    }
  }

  /** Stops the computer, deletes its container, home volume and row. */
  async remove(id: string): Promise<void> {
    const row = await this.row(id);
    await this.boots.get(id);
    await this.runtime.remove(row.id);
    this.desktopSessions.delete(id);
    this.lastTouch.delete(id);
    await this.db.delete(computers).where(eq(computers.id, id));
  }

  async restart(id: string): Promise<Computer> {
    await this.stop(id);
    return this.start(id);
  }

  async takeover(id: string, deviceId: string): Promise<Computer> {
    const row = await this.row(id);
    if (row.status !== 'running')
      throw new HttpProblem(409, 'computer_not_running', 'Start the computer first');
    await (await this.agent(row)).setControl(true);
    return toComputer(
      await this.update(id, {
        controlDeviceId: deviceId,
        controlSince: new Date(),
        lastActivityAt: new Date(),
      }),
    );
  }

  async release(id: string): Promise<Computer> {
    const row = await this.row(id);
    if (row.status === 'running') {
      await (await this.agent(row)).setControl(false).catch((error) => {
        this.log.warn({ err: error, computerId: id }, 'Could not unlock agent input');
      });
    }
    return toComputer(await this.update(id, { controlDeviceId: null, controlSince: null }));
  }

  /** Agent client of a running computer. */
  async agentFor(id: string): Promise<AgentClient> {
    const row = await this.row(id);
    if (row.status !== 'running')
      throw new HttpProblem(409, 'computer_not_running', 'Computer is not running');
    return this.agent(row);
  }

  desktopOpened(id: string, deviceId: string): void {
    const byDevice = this.desktopSessions.get(id) ?? new Map<string, number>();
    byDevice.set(deviceId, (byDevice.get(deviceId) ?? 0) + 1);
    this.desktopSessions.set(id, byDevice);
    void this.touch(id);
  }

  /**
   * When the device in control closes its last desktop view (tab closed, app killed), the
   * desktop goes back to the bots instead of staying locked.
   */
  desktopClosed(id: string, deviceId: string): void {
    const byDevice = this.desktopSessions.get(id);
    const remaining = (byDevice?.get(deviceId) ?? 1) - 1;
    if (byDevice && remaining > 0) byDevice.set(deviceId, remaining);
    else byDevice?.delete(deviceId);
    if (byDevice?.size === 0) this.desktopSessions.delete(id);
    void this.touch(id);
    if (remaining > 0) return;
    this.row(id)
      .then((row) => (row.controlDeviceId === deviceId ? this.release(id) : undefined))
      .catch((error) => this.log.warn({ err: error, computerId: id }, 'Could not release control'));
  }

  /** Records activity so hibernation leaves the computer alone. Throttled. */
  async touch(id: string): Promise<void> {
    const now = Date.now();
    if (now - (this.lastTouch.get(id) ?? 0) < ACTIVITY_THROTTLE_MS) return;
    this.lastTouch.set(id, now);
    await this.db
      .update(computers)
      .set({ lastActivityAt: new Date(now) })
      .where(eq(computers.id, id));
  }

  /** Aligns stored statuses with reality after a hub restart. */
  async reconcile(): Promise<void> {
    const rows = await this.db
      .select()
      .from(computers)
      .where(inArray(computers.status, ['starting', 'running', 'stopping']));
    for (const row of rows) {
      const running = row.containerId
        ? await this.runtime.isRunning(row.containerId).catch(() => null)
        : null;
      if (running) {
        await this.update(row.id, { status: 'running', statusDetail: null });
      } else {
        await this.update(row.id, {
          status: 'stopped',
          statusDetail: null,
          controlDeviceId: null,
          controlSince: null,
          ...(running === null ? { containerId: null } : {}),
        });
      }
    }
  }

  /** Stops running computers without open desktops and idle for longer than the threshold. */
  async hibernateIdle(now = new Date()): Promise<string[]> {
    if (this.options.idleMinutes <= 0) return [];
    const threshold = now.getTime() - this.options.idleMinutes * 60_000;
    const rows = await this.db
      .select()
      .from(computers)
      .where(and(eq(computers.status, 'running'), isNotNull(computers.containerId)));
    const idle = rows.filter(
      (row) =>
        !this.desktopSessions.has(row.id) &&
        (row.lastActivityAt?.getTime() ?? row.createdAt.getTime()) < threshold,
    );
    for (const row of idle) {
      await this.stop(row.id).catch(() => undefined);
    }
    return idle.map((row) => row.id);
  }

  startHibernation(intervalMs = 60_000): void {
    this.hibernationTimer = setInterval(() => {
      this.hibernateIdle().catch((error) =>
        this.log.error({ err: error }, 'Hibernation sweep failed'),
      );
    }, intervalMs);
    this.hibernationTimer.unref();
  }

  async close(): Promise<void> {
    if (this.hibernationTimer) clearInterval(this.hibernationTimer);
    await Promise.allSettled(this.boots.values());
  }

  private agentToken(row: ComputerRow): string {
    return open(this.masterKey, AGENT_TOKEN_PURPOSE, row.agentTokenSealed);
  }

  private async agent(row: ComputerRow): Promise<AgentClient> {
    if (!row.containerId)
      throw new HttpProblem(409, 'computer_not_running', 'Computer has no container');
    return new AgentClient(await this.runtime.agentEndpoint(row.containerId), this.agentToken(row));
  }

  private async boot(row: ComputerRow): Promise<void> {
    try {
      const { containerId } = await this.runtime.start({
        id: row.id,
        workspaceId: row.workspaceId,
        agentToken: this.agentToken(row),
      });
      const started = await this.update(row.id, { containerId });
      await this.waitForAgent(started);
      await this.update(row.id, {
        status: 'running',
        statusDetail: null,
        lastActivityAt: new Date(),
      });
    } catch (error) {
      this.log.error({ err: error, computerId: row.id }, 'Failed to start computer');
      await this.update(row.id, { status: 'error', statusDetail: (error as Error).message });
    }
  }

  private async waitForAgent(row: ComputerRow): Promise<void> {
    const deadline = Date.now() + (this.options.bootTimeoutMs ?? 90_000);
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        const health = await (await this.agent(row)).health();
        if (health.ok && health.vnc) return;
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    throw new Error(
      `mow-agent did not become ready: ${(lastError as Error | undefined)?.message ?? 'timeout'}`,
    );
  }

  private async row(id: string): Promise<ComputerRow> {
    const [row] = await this.db.select().from(computers).where(eq(computers.id, id));
    if (!row) throw notFound('Computer not found');
    return row;
  }

  private async update(id: string, values: Partial<ComputerRow>): Promise<ComputerRow> {
    const [row] = await this.db
      .update(computers)
      .set(values)
      .where(eq(computers.id, id))
      .returning();
    if (!row) throw notFound('Computer not found');
    this.events.publish({ type: 'computer.updated', computer: toComputer(row) });
    return row;
  }
}
