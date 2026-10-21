import { randomBytes, randomUUID } from 'node:crypto';
import type {
  VaultAction,
  VaultEvent,
  VaultField,
  VaultItem,
  VaultItemCreate,
  VaultItemUpdate,
} from '@mowbot/contract';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { BrowserContext, Frame, Page } from 'playwright-core';
import type { BrowserHub } from '../agents/browser';
import type { BotRow } from '../bots/service';
import type { AgentClient } from '../computers/agent-client';
import type { ComputerService, Logger } from '../computers/service';
import { open, seal } from '../crypto/secretbox';
import type { Db } from '../db/client';
import { computers, questions, teams, vaultEvents, vaultGrants, vaultItems } from '../db/schema';
import type { EventBus } from '../events';
import { HttpProblem, notFound } from '../http/problems';
import { hubTexts } from '../i18n';
import type { NotificationService } from '../proactivity/notifications';
import type { QuestionService } from '../proactivity/questions';
import { SecretScope } from './secrets';
import {
  type Cookie,
  changedSites,
  cookiesOf,
  fingerprint,
  type SessionPayload,
  serviceName,
  siteOf,
  sitesWithCookies,
} from './sites';
import { parseTotp, totpCode } from './totp';

export type VaultItemRow = typeof vaultItems.$inferSelect;

interface LoginPayload {
  username?: string;
  password?: string;
  totp?: string;
}
interface SecretPayload {
  value: string;
}

/** The answers of an access request, the first one granting it. */
export const ACCESS_ANSWERS = ['Autoriser', 'Refuser'] as const;

/** localStorage values past this size (caches, not logins) stay behind. */
const MAX_STORAGE_VALUE = 100_000;

const silentLogger: Logger = { warn: () => {}, error: () => {} };

/** Short reference bots use in placeholders: the id's first block. */
export const refOf = (id: string) => id.slice(0, 8);

export const labelOf = (row: Pick<VaultItemRow, 'service' | 'account'>) =>
  `${row.service}${row.account ? ` (${row.account})` : ''}`;

/** Each entry has a data key of its own, sealed with the master key. */
function sealPayload(masterKey: Buffer, id: string, payload: unknown) {
  const key = randomBytes(32);
  return {
    dekSealed: seal(masterKey, `vault-key:${id}`, key.toString('base64')),
    payloadSealed: seal(key, `vault:${id}`, JSON.stringify(payload)),
  };
}

function openPayload<T>(masterKey: Buffer, row: VaultItemRow): T {
  const key = Buffer.from(open(masterKey, `vault-key:${row.id}`, row.dekSealed), 'base64');
  return JSON.parse(open(key, `vault:${row.id}`, row.payloadSealed)) as T;
}

function fieldsOf(payload: LoginPayload | SecretPayload): VaultField[] {
  if ('value' in payload) return ['value'];
  return (['username', 'password', 'totp'] as const).filter((field) => Boolean(payload[field]));
}

function checkTotp(seed: string | null | undefined): void {
  if (!seed) return;
  try {
    parseTotp(seed);
  } catch {
    throw new HttpProblem(
      400,
      'invalid_totp',
      'The 2FA seed is not a base32 secret or an otpauth link',
    );
  }
}

function normalizeSites(sites: string[]): string[] {
  const out: string[] = [];
  for (const input of sites) {
    const site = siteOf(input);
    if (!site) throw new HttpProblem(400, 'invalid_site', `Not a site: ${input}`);
    if (!out.includes(site)) out.push(site);
  }
  return out;
}

/** The origin of an http(s) page, or null. */
function webOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null;
  } catch {
    return null;
  }
}

export function toVaultItem(row: VaultItemRow, grantedBotIds: string[]): VaultItem {
  return {
    id: row.id,
    ref: refOf(row.id),
    kind: row.kind,
    service: row.service,
    account: row.account,
    sites: row.sites,
    notes: row.notes,
    policy: row.policy,
    fields: row.fields,
    computerId: row.computerId,
    createdByBotId: row.createdByBotId,
    session: row.session ?? null,
    grantedBotIds,
    capturedAt: row.capturedAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toVaultEvent(row: typeof vaultEvents.$inferSelect): VaultEvent {
  return {
    id: row.id,
    itemId: row.itemId,
    action: row.action,
    botId: row.botId,
    computerId: row.computerId,
    detail: row.detail,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface VaultDeps {
  db: Db;
  events: EventBus;
  masterKey: Buffer;
  computers: ComputerService;
  browser: BrowserHub;
  questions: QuestionService;
  notifications: NotificationService;
}

/** What a takeover changes in a computer's Chrome, watched from its start. */
interface Watch {
  context: BrowserContext;
  before: ReturnType<typeof fingerprint>;
  /** Sites the user's pages went to. */
  visited: Set<string>;
  detach(): void;
}

/**
 * The vault: sessions captured from a computer's Chrome and loaded into another's, logins and
 * secrets bots use through placeholders. Values are sealed, never sent to clients, never shown
 * to a model, and every use is recorded.
 */
export class VaultService {
  private log: Logger = silentLogger;
  private readonly watches = new Map<string, Promise<Watch | null>>();
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly deps: VaultDeps) {}

  setLogger(log: Logger): void {
    this.log = log;
  }

  // -------------------------------------------------------------------------------------------
  // Entries

  async list(): Promise<VaultItem[]> {
    const { db } = this.deps;
    const rows = await db
      .select()
      .from(vaultItems)
      .orderBy(asc(vaultItems.service), asc(vaultItems.createdAt));
    const grants = await db.select().from(vaultGrants);
    return rows.map((row) =>
      toVaultItem(
        row,
        grants.filter((g) => g.itemId === row.id).map((g) => g.botId),
      ),
    );
  }

  async row(id: string): Promise<VaultItemRow> {
    const [row] = await this.deps.db.select().from(vaultItems).where(eq(vaultItems.id, id));
    if (!row) throw notFound('Vault item not found');
    return row;
  }

  async get(id: string): Promise<VaultItem> {
    return this.item(await this.row(id));
  }

  private async item(row: VaultItemRow): Promise<VaultItem> {
    const grants = await this.deps.db
      .select({ botId: vaultGrants.botId })
      .from(vaultGrants)
      .where(eq(vaultGrants.itemId, row.id));
    return toVaultItem(
      row,
      grants.map((g) => g.botId),
    );
  }

  private async publish(row: VaultItemRow): Promise<VaultItem> {
    const item = await this.item(row);
    this.deps.events.publish({ type: 'vault.updated', item });
    return item;
  }

  private async record(
    itemId: string,
    action: VaultAction,
    who: { botId?: string | null; computerId?: string | null; detail?: string | null } = {},
  ): Promise<void> {
    await this.deps.db.insert(vaultEvents).values({
      itemId,
      action,
      botId: who.botId ?? null,
      computerId: who.computerId ?? null,
      detail: who.detail ?? null,
    });
  }

  async history(id: string): Promise<VaultEvent[]> {
    await this.row(id);
    const rows = await this.deps.db
      .select()
      .from(vaultEvents)
      .where(eq(vaultEvents.itemId, id))
      .orderBy(desc(vaultEvents.createdAt))
      .limit(200);
    return rows.map(toVaultEvent);
  }

  /** The entry a bot named by its reference (the id or its beginning). */
  async byRef(ref: string): Promise<VaultItemRow> {
    const clean = ref.trim().toLowerCase();
    if (!/^[0-9a-f-]{4,36}$/.test(clean)) {
      throw new Error(
        `Référence de coffre invalide : « ${ref} » (vault_list donne les références).`,
      );
    }
    const rows = await this.deps.db
      .select()
      .from(vaultItems)
      .where(sql`${vaultItems.id}::text like ${`${clean}%`}`)
      .limit(2);
    const [row] = rows;
    if (!row) throw new Error(`Rien dans le coffre avec la référence ${clean} (vault_list).`);
    if (rows.length > 1) throw new Error(`Référence ${clean} ambiguë : donne-la en entier.`);
    return row;
  }

  /** A login or a secret, entered by the user or saved by a bot. */
  async create(input: VaultItemCreate, by: { botId?: string | null } = {}): Promise<VaultItem> {
    const payload: LoginPayload | SecretPayload =
      input.kind === 'login'
        ? Object.fromEntries(
            Object.entries({
              username: input.username,
              password: input.password,
              totp: input.totp,
            }).filter(([, value]) => value),
          )
        : { value: input.value };
    if (input.kind === 'login') {
      if (fieldsOf(payload).length === 0) {
        throw new HttpProblem(
          400,
          'empty_login',
          'A login needs a username, a password or a 2FA seed',
        );
      }
      checkTotp(input.totp);
    }
    const id = randomUUID();
    const [row] = await this.deps.db
      .insert(vaultItems)
      .values({
        id,
        kind: input.kind,
        service: input.service,
        account: input.account ?? null,
        sites: normalizeSites(input.sites ?? []),
        notes: input.notes ?? null,
        policy: input.policy ?? 'auto',
        fields: fieldsOf(payload),
        createdByBotId: by.botId ?? null,
        ...sealPayload(this.deps.masterKey, id, payload),
      })
      .returning();
    if (!row) throw new Error('Vault insert returned no row');
    await this.record(id, 'created', { botId: by.botId });
    return this.publish(row);
  }

  async update(id: string, patch: VaultItemUpdate): Promise<VaultItem> {
    const row = await this.row(id);
    const values: Partial<VaultItemRow> = { updatedAt: new Date() };
    if (patch.service !== undefined) values.service = patch.service;
    if (patch.account !== undefined) values.account = patch.account;
    if (patch.sites !== undefined) values.sites = normalizeSites(patch.sites);
    if (patch.notes !== undefined) values.notes = patch.notes;
    if (patch.policy !== undefined) values.policy = patch.policy;

    const touchesValues = (['username', 'password', 'totp', 'value'] as const).some(
      (field) => patch[field] !== undefined,
    );
    if (touchesValues) {
      if (row.kind === 'session') {
        throw new HttpProblem(400, 'session_values', 'A session is captured from a computer');
      }
      const payload = openPayload<LoginPayload & Partial<SecretPayload>>(this.deps.masterKey, row);
      if (row.kind === 'secret') {
        if (patch.value) payload.value = patch.value;
      } else {
        for (const field of ['username', 'password', 'totp'] as const) {
          const next = patch[field];
          if (next === null) delete payload[field];
          else if (next !== undefined) payload[field] = next;
        }
        checkTotp(patch.totp);
        if (fieldsOf(payload).length === 0) {
          throw new HttpProblem(
            400,
            'empty_login',
            'A login needs a username, a password or a 2FA seed',
          );
        }
      }
      values.fields = fieldsOf(payload as LoginPayload | SecretPayload);
      Object.assign(values, sealPayload(this.deps.masterKey, row.id, payload));
    }
    const [updated] = await this.deps.db
      .update(vaultItems)
      .set(values)
      .where(eq(vaultItems.id, id))
      .returning();
    if (!updated) throw notFound('Vault item not found');
    await this.record(id, 'updated', {
      detail: touchesValues ? 'values_replaced' : null,
    });
    return this.publish(updated);
  }

  async remove(id: string): Promise<void> {
    await this.row(id);
    await this.deps.db.delete(vaultItems).where(eq(vaultItems.id, id));
    this.deps.events.publish({ type: 'vault.deleted', itemId: id });
  }

  async revoke(id: string, botId: string): Promise<VaultItem> {
    const row = await this.row(id);
    const removed = await this.deps.db
      .delete(vaultGrants)
      .where(and(eq(vaultGrants.itemId, id), eq(vaultGrants.botId, botId)))
      .returning();
    if (removed.length > 0) await this.record(id, 'revoked', { botId });
    return this.publish(row);
  }

  // -------------------------------------------------------------------------------------------
  // Sessions

  private async contextOf(computerId: string, agent?: AgentClient): Promise<BrowserContext> {
    return this.deps.browser.context(
      computerId,
      agent ?? (await this.deps.computers.agentFor(computerId)),
    );
  }

  /** Sites with cookies in a running computer's Chrome, and the sessions already saved. */
  async sitesOn(computerId: string) {
    const context = await this.contextOf(computerId);
    const sites = sitesWithCookies((await context.cookies()) as Cookie[]);
    const saved = await this.deps.db
      .select({ id: vaultItems.id, sites: vaultItems.sites })
      .from(vaultItems)
      .where(and(eq(vaultItems.kind, 'session'), eq(vaultItems.computerId, computerId)));
    return sites.map((entry) => ({
      ...entry,
      itemId: saved.find((s) => s.sites[0] === entry.site)?.id ?? null,
    }));
  }

  /** A site's cookies and the local storage of its open pages, from a computer's Chrome. */
  private async read(context: BrowserContext, sites: string[]): Promise<SessionPayload> {
    const cookies = cookiesOf((await context.cookies()) as Cookie[], sites);
    const origins: SessionPayload['origins'] = [];
    for (const page of context.pages()) {
      const origin = webOrigin(page.url());
      const site = origin ? siteOf(origin) : null;
      if (!origin || !site || !sites.includes(site) || origins.some((o) => o.origin === origin)) {
        continue;
      }
      const entries = await page
        .evaluate<[string, string][]>('Object.entries(localStorage)')
        .catch(() => [] as [string, string][]);
      const kept = entries
        .filter(([, value]) => value.length <= MAX_STORAGE_VALUE)
        .map(([name, value]) => ({ name, value }));
      if (kept.length > 0) origins.push({ origin, localStorage: kept });
    }
    return { cookies, origins };
  }

  /** Loads a session into a computer's Chrome. */
  private async write(context: BrowserContext, payload: SessionPayload): Promise<void> {
    if (payload.cookies.length > 0) await context.addCookies(payload.cookies);
    for (const { origin, localStorage } of payload.origins) {
      // A blank page of that origin, served by the hub without touching the site.
      const page = await context.newPage();
      try {
        await page.route('**/*', (route) =>
          route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html>' }),
        );
        await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded', timeout: 15_000 });
        await page.evaluate((entries) => {
          const store = (
            globalThis as unknown as {
              localStorage: { setItem(name: string, value: string): void };
            }
          ).localStorage;
          for (const { name, value } of entries) store.setItem(name, value);
        }, localStorage);
      } finally {
        await page.close().catch(() => undefined);
      }
    }
  }

  private async storeSession(
    row: VaultItemRow,
    payload: SessionPayload,
    by: { botId?: string | null; detail?: string | null },
  ): Promise<VaultItemRow> {
    const [updated] = await this.deps.db
      .update(vaultItems)
      .set({
        ...sealPayload(this.deps.masterKey, row.id, payload),
        session: { cookies: payload.cookies.length, origins: payload.origins.length },
        capturedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(vaultItems.id, row.id))
      .returning();
    if (!updated) throw notFound('Vault item not found');
    await this.record(row.id, 'captured', {
      botId: by.botId,
      computerId: row.computerId,
      detail: by.detail,
    });
    return updated;
  }

  /**
   * Saves (or refreshes) the session of a site from a computer's Chrome: one entry per site and
   * computer.
   */
  async capture(input: {
    computerId: string;
    site: string;
    service?: string;
    account?: string | null;
    botId?: string | null;
    agent?: AgentClient;
    detail?: string;
  }): Promise<VaultItem> {
    const site = siteOf(input.site);
    if (!site) throw new HttpProblem(400, 'invalid_site', `Not a site: ${input.site}`);
    const { db } = this.deps;
    const [existing] = await db
      .select()
      .from(vaultItems)
      .where(
        and(
          eq(vaultItems.kind, 'session'),
          eq(vaultItems.computerId, input.computerId),
          sql`${vaultItems.sites}->>0 = ${site}`,
        ),
      )
      .limit(1);
    const context = await this.contextOf(input.computerId, input.agent);
    const payload = await this.read(context, existing?.sites ?? [site]);
    if (payload.cookies.length === 0) {
      throw new HttpProblem(
        409,
        'no_session',
        `Aucun cookie de ${site} dans ce Chrome : il faut d'abord se connecter au site.`,
      );
    }
    const by = { botId: input.botId, detail: input.detail ?? null };
    if (existing) {
      let row = await this.storeSession(existing, payload, by);
      if (input.service !== undefined || input.account !== undefined) {
        const [renamed] = await db
          .update(vaultItems)
          .set({
            ...(input.service !== undefined ? { service: input.service } : {}),
            ...(input.account !== undefined ? { account: input.account } : {}),
          })
          .where(eq(vaultItems.id, row.id))
          .returning();
        if (renamed) row = renamed;
      }
      return this.publish(row);
    }
    const id = randomUUID();
    const [row] = await db
      .insert(vaultItems)
      .values({
        id,
        kind: 'session',
        service: input.service ?? serviceName(site),
        account: input.account ?? null,
        sites: [site],
        computerId: input.computerId,
        createdByBotId: input.botId ?? null,
        session: { cookies: payload.cookies.length, origins: payload.origins.length },
        capturedAt: new Date(),
        ...sealPayload(this.deps.masterKey, id, payload),
      })
      .returning();
    if (!row) throw new Error('Vault insert returned no row');
    await this.record(id, 'captured', {
      botId: input.botId,
      computerId: input.computerId,
      detail: input.detail ?? null,
    });
    return this.publish(row);
  }

  /**
   * Loads a session into the bot's own Chrome: fresh from the source computer when it is on,
   * as last captured otherwise. Returns what to tell the bot.
   */
  async useSession(row: VaultItemRow, bot: BotRow, agent: AgentClient): Promise<string> {
    if (row.kind !== 'session') {
      throw new Error(`${labelOf(row)} n'est pas une session : utilise ses placeholders.`);
    }
    if (!bot.computerId) throw new Error("Tu n'as pas d'ordinateur.");
    if (row.computerId === bot.computerId) {
      return `${labelOf(row)} vient du Chrome de ton PC : tu y es déjà connecté, ouvre simplement le site.`;
    }
    await this.ensureAccess(row, bot);
    let payload = openPayload<SessionPayload>(this.deps.masterKey, row);
    let current = row;
    if (row.computerId) {
      const [source] = await this.deps.db
        .select({ status: computers.status })
        .from(computers)
        .where(eq(computers.id, row.computerId));
      if (source?.status === 'running') {
        try {
          const fresh = await this.read(await this.contextOf(row.computerId), row.sites);
          if (fresh.cookies.length > 0) {
            payload = fresh;
            current = await this.storeSession(row, fresh, { detail: 'refreshed' });
          }
        } catch (error) {
          this.log.warn({ err: error, itemId: row.id }, 'Could not refresh a vault session');
        }
      }
    }
    await this.write(await this.deps.browser.context(bot.computerId, agent), payload);
    const [used] = await this.deps.db
      .update(vaultItems)
      .set({ lastUsedAt: new Date() })
      .where(eq(vaultItems.id, row.id))
      .returning();
    await this.record(row.id, 'used', { botId: bot.id, computerId: bot.computerId });
    await this.publish(used ?? current);
    return `Session ${labelOf(row)} chargée dans le Chrome de ton PC (${payload.cookies.length} cookies) : ouvre le site, tu devrais y être connecté. Sinon, la session a expiré : demande à l'utilisateur de se reconnecter.`;
  }

  // -------------------------------------------------------------------------------------------
  // Access

  async allowed(row: VaultItemRow, bot: BotRow): Promise<boolean> {
    if (row.kind === 'session' && row.computerId && row.computerId === bot.computerId) return true;
    if (row.createdByBotId === bot.id) return true;
    const [grant] = await this.deps.db
      .select({ botId: vaultGrants.botId })
      .from(vaultGrants)
      .where(and(eq(vaultGrants.itemId, row.id), eq(vaultGrants.botId, bot.id)));
    if (grant) return true;
    if (row.policy === 'ask') return false;
    // A walled-off team's sessions stay inside it unless the user says otherwise.
    if (row.computerId) {
      const [source] = await this.deps.db
        .select({ teamId: teams.id, isolated: teams.isolated })
        .from(computers)
        .innerJoin(teams, eq(teams.id, computers.teamId))
        .where(eq(computers.id, row.computerId));
      if (source?.isolated && source.teamId !== bot.teamId) return false;
    }
    return true;
  }

  /** Throws (for the bot) unless it may use the entry; asks the user once when needed. */
  async ensureAccess(row: VaultItemRow, bot: BotRow): Promise<void> {
    if (await this.allowed(row, bot)) return;
    const [pending] = await this.deps.db
      .select({ id: questions.id })
      .from(questions)
      .where(
        and(
          eq(questions.botId, bot.id),
          eq(questions.vaultItemId, row.id),
          eq(questions.status, 'open'),
        ),
      )
      .limit(1);
    if (!pending) {
      await this.deps.questions.ask(
        bot,
        `${bot.name} voudrait utiliser ${labelOf(row)} du coffre. Tu l'autorises ?`,
        [...ACCESS_ANSWERS],
        { vaultItemId: row.id },
      );
      await this.record(row.id, 'requested', { botId: bot.id, computerId: bot.computerId });
    }
    throw new Error(
      `${labelOf(row)} ne s'utilise qu'avec l'accord de l'utilisateur : la question lui est posée. Sa réponse t'arrivera en message ; s'il accepte, recommence.`,
    );
  }

  /** The user answered an access request. */
  async answered(itemId: string, botId: string, answer: string): Promise<void> {
    const row = await this.row(itemId).catch(() => null);
    if (!row) return;
    const granted = answer.trim().toLowerCase() === ACCESS_ANSWERS[0].toLowerCase();
    if (granted) {
      await this.deps.db.insert(vaultGrants).values({ itemId, botId }).onConflictDoNothing();
    }
    await this.record(itemId, granted ? 'granted' : 'denied', { botId });
    await this.publish(row);
  }

  // -------------------------------------------------------------------------------------------
  // Logins and secrets in tools

  /** A field's value for a bot's command, after the access check. */
  async reveal(
    ref: string,
    field: VaultField,
    bot: BotRow,
    usedInRun: Set<string>,
  ): Promise<{ value: string; secret: boolean }> {
    const row = await this.byRef(ref);
    if (row.kind === 'session') {
      throw new Error(`${labelOf(row)} est une session : charge-la avec vault_use_session.`);
    }
    await this.ensureAccess(row, bot);
    const payload = openPayload<LoginPayload & Partial<SecretPayload>>(this.deps.masterKey, row);
    const value =
      field === 'totp'
        ? payload.totp
          ? totpCode(parseTotp(payload.totp))
          : undefined
        : payload[field];
    if (!value) {
      throw new Error(
        `${labelOf(row)} n'a pas de champ « ${field} » (champs : ${row.fields.join(', ') || 'aucun'}).`,
      );
    }
    if (!usedInRun.has(row.id)) {
      usedInRun.add(row.id);
      const [used] = await this.deps.db
        .update(vaultItems)
        .set({ lastUsedAt: new Date() })
        .where(eq(vaultItems.id, row.id))
        .returning();
      await this.record(row.id, 'used', {
        botId: bot.id,
        computerId: bot.computerId,
        detail: field,
      });
      if (used) await this.publish(used);
    }
    return { value, secret: field !== 'username' };
  }

  /** Every stored secret value, to mask them in tool outputs. */
  async secretValues(): Promise<string[]> {
    const rows = await this.deps.db
      .select()
      .from(vaultItems)
      .where(inArray(vaultItems.kind, ['login', 'secret']));
    const values: string[] = [];
    for (const row of rows) {
      try {
        const payload = openPayload<LoginPayload & Partial<SecretPayload>>(
          this.deps.masterKey,
          row,
        );
        for (const value of [payload.password, payload.value, payload.totp]) {
          if (value) values.push(value);
        }
      } catch (error) {
        this.log.warn({ err: error, itemId: row.id }, 'Could not open a vault entry');
      }
    }
    return values;
  }

  /** The vault for one run of a bot. */
  async scope(bot: BotRow): Promise<SecretScope> {
    const usedInRun = new Set<string>();
    return new SecretScope(
      { reveal: (ref, field) => this.reveal(ref, field, bot, usedInRun) },
      await this.secretValues(),
    );
  }

  /** What the bot's system prompt says the vault holds. */
  async promptLines(bot: BotRow, limit = 25): Promise<string[]> {
    const { db } = this.deps;
    const rows = await db
      .select()
      .from(vaultItems)
      .orderBy(asc(vaultItems.service))
      .limit(limit + 1);
    const granted = new Set(
      (
        await db
          .select({ itemId: vaultGrants.itemId })
          .from(vaultGrants)
          .where(eq(vaultGrants.botId, bot.id))
      ).map((g) => g.itemId),
    );
    const lines = rows.slice(0, limit).map((row) => {
      const what =
        row.kind === 'session'
          ? row.computerId === bot.computerId
            ? 'session, déjà dans le Chrome de ton PC'
            : 'session à charger avec vault_use_session'
          : row.kind === 'login'
            ? `identifiant : ${row.fields.map((f) => `{{vault:${refOf(row.id)}.${f}}}`).join(' ')}`
            : `secret : {{vault:${refOf(row.id)}.value}}`;
      const ask =
        row.policy === 'ask' && !granted.has(row.id) && row.computerId !== bot.computerId
          ? ", sur accord de l'utilisateur"
          : '';
      const sites = row.sites.length ? ` — ${row.sites.join(', ')}` : '';
      return `- [${refOf(row.id)}] ${labelOf(row)}${sites} : ${what}${ask}`;
    });
    if (rows.length > limit) lines.push('- … et d’autres : vault_list.');
    return lines;
  }

  // -------------------------------------------------------------------------------------------
  // Takeovers

  /**
   * When the user hands a computer back, the sites they went to whose login cookies changed
   * are saved in the vault, ready for bots on other computers.
   */
  watchTakeovers(): void {
    this.unsubscribe ??= this.deps.events.subscribe((event) => {
      if (event.type !== 'computer.updated') return;
      const { id, control, status } = event.computer;
      if (control && status === 'running') {
        if (!this.watches.has(id)) this.watches.set(id, this.beginWatch(id));
        return;
      }
      const watch = this.watches.get(id);
      if (!watch) return;
      this.watches.delete(id);
      void this.endWatch(id, watch);
    });
  }

  private async beginWatch(computerId: string): Promise<Watch | null> {
    try {
      const context = await this.contextOf(computerId);
      const before = fingerprint((await context.cookies()) as Cookie[]);
      const visited = new Set<string>();
      const detachers: (() => void)[] = [];
      const follow = (page: Page) => {
        const onNavigation = (frame: Frame) => {
          if (frame !== page.mainFrame() || !webOrigin(frame.url())) return;
          const site = siteOf(frame.url());
          if (site) visited.add(site);
        };
        page.on('framenavigated', onNavigation);
        detachers.push(() => page.off('framenavigated', onNavigation));
      };
      for (const page of context.pages()) follow(page);
      context.on('page', follow);
      detachers.push(() => context.off('page', follow));
      return {
        context,
        before,
        visited,
        detach: () => {
          for (const detach of detachers) detach();
        },
      };
    } catch (error) {
      this.log.warn({ err: error, computerId }, 'Could not watch a takeover for the vault');
      return null;
    }
  }

  private async endWatch(computerId: string, pending: Promise<Watch | null>): Promise<void> {
    const watch = await pending;
    if (!watch) return;
    watch.detach();
    try {
      for (const page of watch.context.pages()) {
        const site = webOrigin(page.url()) ? siteOf(page.url()) : null;
        if (site) watch.visited.add(site);
      }
      const after = fingerprint((await watch.context.cookies()) as Cookie[]);
      const sites = changedSites(watch.before, after).filter((site) => watch.visited.has(site));
      const saved: VaultItem[] = [];
      for (const site of sites) {
        try {
          saved.push(await this.capture({ computerId, site, detail: 'takeover_end' }));
        } catch (error) {
          this.log.warn({ err: error, computerId, site }, 'Could not save a session');
        }
      }
      if (saved.length > 0) {
        const [pc] = await this.deps.db
          .select({ name: computers.name })
          .from(computers)
          .where(eq(computers.id, computerId));
        const texts = await hubTexts(this.deps.db);
        await this.deps.notifications.create({
          botId: null,
          priority: 'digest',
          title: texts.sessionsSaved(saved.map((item) => item.sites[0]).join(', ')),
          body: texts.sessionsSavedBody(saved.length, pc?.name ?? 'PC'),
        });
      }
    } catch (error) {
      this.log.warn({ err: error, computerId }, 'Could not save the sessions of a takeover');
    }
  }

  close(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const pending of this.watches.values()) {
      void pending.then((watch) => watch?.detach());
    }
    this.watches.clear();
  }
}
