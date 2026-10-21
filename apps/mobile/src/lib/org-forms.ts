import type {
  Bot,
  BotComputerChoice,
  BotCreate,
  BotMove,
  BotUpdate,
  Computer,
  ModelRef,
  Team,
  TeamUpdate,
} from '@mowbot/contract';
import type { TFunction } from 'i18next';
import { problemCode } from './hub-url';

/**
 * Pure logic of the bot and team screens (no React Native): what the Bots tab lists, what a
 * form changed, what the API receives. Kept apart so it is unit tested.
 */

/** Team choice of the new bot and move forms: a team id, or no team. */
export const SOLO = 'solo';

// ── Org chart ───────────────────────────────────────────────────────────────

/** Main team first, then the order the hub gives (creation). */
export function sortTeams(teams: readonly Team[]): Team[] {
  return [...teams].sort((a, b) => Number(b.isMain) - Number(a.isMain));
}

/** A team's bots: its lead first, then the Chef, then in creation order. */
export function teamMembers(team: Team, bots: readonly Bot[]): Bot[] {
  const rank = (bot: Bot) => (bot.id === team.leadBotId ? 0 : bot.isChef ? 1 : 2);
  return bots.filter((bot) => bot.teamId === team.id).sort((a, b) => rank(a) - rank(b));
}

export interface OrgChart {
  chef: Bot | undefined;
  /**
   * Every team, main first. The Chef has its own card so it is not in `members`; `size` counts
   * every bot of the team, the Chef included.
   */
  teams: { team: Team; members: Bot[]; size: number }[];
  solo: Bot[];
}

/** The Bots tab: the Chef on top, the teams with their bots, then the solo bots. */
export function orgChart(bots: readonly Bot[], teams: readonly Team[]): OrgChart {
  return {
    chef: bots.find((bot) => bot.isChef),
    teams: sortTeams(teams).map((team) => {
      const all = teamMembers(team, bots);
      return { team, members: all.filter((bot) => !bot.isChef), size: all.length };
    }),
    solo: bots.filter((bot) => !bot.teamId && !bot.isChef),
  };
}

// ── Models ──────────────────────────────────────────────────────────────────

/** A provider + model being edited: either may be missing until the user is done. */
export interface ModelDraft {
  providerId: string | null;
  model: string;
}

export function draftOf(ref: ModelRef | null | undefined): ModelDraft {
  return { providerId: ref?.providerId ?? null, model: ref?.model ?? '' };
}

/** A complete draft becomes a model reference; an incomplete one means "none". */
export function refOf(draft: ModelDraft): ModelRef | null {
  const model = draft.model.trim();
  return draft.providerId && model ? { providerId: draft.providerId, model } : null;
}

const sameRef = (a: ModelRef | null, b: ModelRef | null) =>
  a === b || (a !== null && b !== null && a.providerId === b.providerId && a.model === b.model);

/** At most this many fallback models (botUpdateSchema). */
export const MAX_FALLBACKS = 5;

/** A provider's models matching what is typed: exact match first, then by position. */
export function matchModels(models: readonly string[], query: string, limit = 6): string[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return models.slice(0, limit);
  return models
    .map((id) => ({ id, at: id.toLowerCase().indexOf(needle) }))
    .filter((match) => match.at >= 0)
    .sort((a, b) => a.at - b.at || a.id.length - b.id.length)
    .slice(0, limit)
    .map((match) => match.id);
}

// ── Check-ins and budget ────────────────────────────────────────────────────

/** Check-in rhythms offered (minutes); null: no check-ins. */
export const HEARTBEATS: readonly (number | null)[] = [null, 15, 30, 60, 120, 240, 720];

/** The offered rhythms, plus the bot's own if a bot set another one. */
export function heartbeatChoices(current: number | null): (number | null)[] {
  if (HEARTBEATS.includes(current)) return [...HEARTBEATS];
  return [...HEARTBEATS, current].sort((a, b) => (a ?? 0) - (b ?? 0));
}

export function heartbeatLabel(minutes: number | null, t: TFunction): string {
  if (minutes === null) return t('orgAdmin.bot.heartbeatOff');
  if (minutes % 60 === 0) return t('orgAdmin.bot.everyHours', { count: minutes / 60 });
  return t('orgAdmin.bot.everyMinutes', { count: minutes });
}

/** Daily token budget as typed: '' is no cap; anything else must be a whole number ≥ 1000. */
export function parseBudget(text: string): { ok: true; value: number | null } | { ok: false } {
  // Thousands separators are fine: "10 000", "10,000", "10.000".
  const digits = text.replace(/[\s,.']/g, '');
  if (!digits) return { ok: true, value: null };
  if (!/^\d+$/.test(digits)) return { ok: false };
  const value = Number(digits);
  return Number.isSafeInteger(value) && value >= 1000 ? { ok: true, value } : { ok: false };
}

// ── Bot settings ────────────────────────────────────────────────────────────

/** A fallback being edited; `id` keeps its row stable while others are removed. */
export interface FallbackDraft extends ModelDraft {
  id: number;
}

export interface BotForm {
  name: string;
  role: string;
  mission: string;
  providerId: string | null;
  /** '' : the provider's default model. */
  model: string;
  lightModel: ModelDraft;
  fallbacks: FallbackDraft[];
  heartbeatMinutes: number | null;
  budget: string;
  /** Lead of its team (ignored without a team). */
  lead: boolean;
}

export function botForm(bot: Bot, team: Team | undefined): BotForm {
  return {
    name: bot.name,
    role: bot.role,
    mission: bot.mission ?? '',
    providerId: bot.providerId,
    model: bot.model ?? '',
    lightModel: draftOf(bot.lightModel),
    fallbacks: bot.fallbacks.map((ref, id) => ({ ...draftOf(ref), id })),
    heartbeatMinutes: bot.heartbeatMinutes,
    budget: bot.dailyTokenBudget === null ? '' : String(bot.dailyTokenBudget),
    lead: Boolean(team && team.leadBotId === bot.id),
  };
}

/** One more (empty) fallback row. */
export function addFallback(fallbacks: readonly FallbackDraft[]): FallbackDraft[] {
  if (fallbacks.length >= MAX_FALLBACKS) return [...fallbacks];
  const id = Math.max(-1, ...fallbacks.map((draft) => draft.id)) + 1;
  return [...fallbacks, { id, providerId: null, model: '' }];
}

export type BotFormError = 'name' | 'role' | 'budget' | 'lightModel' | 'fallback';

/** A provider picked but no model named. */
const incomplete = (draft: ModelDraft) => Boolean(draft.providerId) && !draft.model.trim();

/** What prevents saving, if anything. */
export function botFormError(form: BotForm): BotFormError | null {
  if (!form.name.trim()) return 'name';
  if (!form.role.trim()) return 'role';
  if (!parseBudget(form.budget).ok) return 'budget';
  if (incomplete(form.lightModel)) return 'lightModel';
  if (form.fallbacks.some(incomplete)) return 'fallback';
  return null;
}

/** What the API needs to know of the providers: their default model. */
export type ProviderDefaults = readonly { id: string; defaultModel: string | null }[];

/**
 * The PATCH body: only what differs from the bot (an empty object when nothing changed). An
 * empty model name means the provider's default, which the hub applies when it receives a
 * provider without a model.
 */
export function botChanges(bot: Bot, form: BotForm, providers: ProviderDefaults = []): BotUpdate {
  const changes: BotUpdate = {};
  const name = form.name.trim();
  if (name && name !== bot.name) changes.name = name;
  const role = form.role.trim();
  if (role && role !== bot.role) changes.role = role;
  const mission = form.mission.trim() || null;
  if (mission !== bot.mission) changes.mission = mission;

  const model = form.model.trim();
  if (form.providerId === null) {
    if (bot.providerId !== null || bot.model !== null) {
      changes.providerId = null;
      changes.model = null;
    }
  } else if (form.providerId !== bot.providerId) {
    changes.providerId = form.providerId;
    if (model) changes.model = model;
  } else {
    const fallback = providers.find((p) => p.id === form.providerId)?.defaultModel ?? null;
    if ((model || fallback) !== bot.model) {
      if (model) changes.model = model;
      else changes.providerId = form.providerId;
    }
  }

  const light = refOf(form.lightModel);
  if (!sameRef(light, bot.lightModel)) changes.lightModel = light;

  const fallbacks = form.fallbacks.map(refOf).filter((ref): ref is ModelRef => ref !== null);
  if (
    fallbacks.length !== bot.fallbacks.length ||
    fallbacks.some((ref, index) => !sameRef(ref, bot.fallbacks[index] ?? null))
  ) {
    changes.fallbacks = fallbacks.slice(0, MAX_FALLBACKS);
  }

  if (form.heartbeatMinutes !== bot.heartbeatMinutes) {
    changes.heartbeatMinutes = form.heartbeatMinutes;
  }
  const budget = parseBudget(form.budget);
  if (budget.ok && budget.value !== bot.dailyTokenBudget) changes.dailyTokenBudget = budget.value;
  return changes;
}

/**
 * The team's new lead when the switch moved: the bot, nobody, or undefined (unchanged). The
 * Chef is not offered the switch (it runs the whole organization).
 */
export function leadChange(
  bot: Bot,
  team: Team | undefined,
  lead: boolean,
): string | null | undefined {
  if (!team || bot.isChef) return undefined;
  const isLead = team.leadBotId === bot.id;
  if (lead === isLead) return undefined;
  return lead ? bot.id : null;
}

/** Whether saving would change anything (the bot or its team's lead). */
export function botFormChanged(
  bot: Bot,
  team: Team | undefined,
  form: BotForm,
  providers: ProviderDefaults = [],
): boolean {
  return (
    Object.keys(botChanges(bot, form, providers)).length > 0 ||
    leadChange(bot, team, form.lead) !== undefined
  );
}

// ── Teams ───────────────────────────────────────────────────────────────────

export interface TeamForm {
  name: string;
  mission: string;
  isolated: boolean;
  leadBotId: string | null;
}

export function teamForm(team: Team): TeamForm {
  return {
    name: team.name,
    mission: team.mission ?? '',
    isolated: team.isolated,
    leadBotId: team.leadBotId,
  };
}

/** The PATCH body: only what differs from the team. */
export function teamChanges(team: Team, form: TeamForm): TeamUpdate {
  const changes: TeamUpdate = {};
  const name = form.name.trim();
  if (name && name !== team.name) changes.name = name;
  const mission = form.mission.trim() || null;
  if (mission !== team.mission) changes.mission = mission;
  if (form.isolated !== team.isolated) changes.isolated = form.isolated;
  if (form.leadBotId !== team.leadBotId) changes.leadBotId = form.leadBotId;
  return changes;
}

/** Why a team cannot be deleted, if it cannot. */
export function teamDeleteBlock(team: Team): 'main' | null {
  return team.isMain ? 'main' : null;
}

// ── New bot, move ───────────────────────────────────────────────────────────

export interface NewBotForm {
  name: string;
  role: string;
  mission: string;
  /** A team id or SOLO. */
  team: string;
  computer: BotComputerChoice;
  lead: boolean;
}

export function newBotBody(form: NewBotForm): BotCreate {
  const solo = form.team === SOLO;
  const mission = form.mission.trim();
  return {
    name: form.name.trim(),
    role: form.role.trim(),
    ...(mission ? { mission } : {}),
    teamId: solo ? null : form.team,
    // A solo bot always gets its own PC.
    computer: solo ? 'dedicated' : form.computer,
    lead: !solo && form.lead,
  };
}

/** Where a bot works now, in the move form's terms. */
export function placementOf(
  bot: Bot,
  pc: Computer | undefined,
): { team: string; computer: BotComputerChoice } {
  return { team: bot.teamId ?? SOLO, computer: pc?.kind === 'dedicated' ? 'dedicated' : 'team' };
}

export function moveUnchanged(
  current: { team: string; computer: BotComputerChoice },
  team: string,
  computer: BotComputerChoice,
): boolean {
  return team === current.team && (team === SOLO || computer === current.computer);
}

export function moveBody(team: string, computer: BotComputerChoice): BotMove {
  return team === SOLO ? { teamId: null, computer: 'dedicated' } : { teamId: team, computer };
}

// ── Errors ──────────────────────────────────────────────────────────────────

/** Hub problems the app words itself; any other shows the hub's detail or a fallback. */
const WORDED = [
  'bot_name_taken',
  'too_many_bots',
  'too_many_teams',
  'lead_not_member',
  'main_team',
  'team_not_empty',
  'chef',
  'validation_failed',
  'rate_limited',
  'forbidden',
] as const;
type Worded = (typeof WORDED)[number];

export function problemMessage(error: unknown, fallback: string, t: TFunction): string {
  const code = problemCode(error);
  if (code && (WORDED as readonly string[]).includes(code)) {
    return t(`orgAdmin.problems.${code as Worded}`);
  }
  const detail = (error as { detail?: unknown } | null | undefined)?.detail;
  return typeof detail === 'string' && detail ? detail : fallback;
}
