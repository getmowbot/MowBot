import path from 'node:path';
import type { Bot, BotCreate, BotMove, Team, TeamCreate, TeamUpdate } from '@mowbot/contract';
import { newBotSeed } from '@mowbot/design';
import { and, count, eq, ne, sql } from 'drizzle-orm';
import { botFolder, toBot } from '../bots/service';
import type { ComputerService } from '../computers/service';
import type { Db } from '../db/client';
import { isUniqueViolation } from '../db/errors';
import { bots, computers, teams, workspaces } from '../db/schema';
import type { EventBus } from '../events';
import { HttpProblem, notFound } from '../http/problems';
import { newAgentTokenSealed } from '../teams/bootstrap';
import { parentOf, type WorkspaceFiles } from '../workspaces/files';

export const MAX_BOTS = 20;
export const MAX_TEAMS = 10;

type TeamRow = typeof teams.$inferSelect;
type BotRow = typeof bots.$inferSelect;

export function toTeam(row: TeamRow, computerId: string | null): Team {
  return {
    id: row.id,
    name: row.name,
    mission: row.mission,
    isMain: row.isMain,
    isolated: row.isolated,
    leadBotId: row.leadBotId,
    workspaceId: row.workspaceId,
    computerId,
    createdAt: row.createdAt.toISOString(),
  };
}

const nameTaken = (name: string) =>
  new HttpProblem(409, 'bot_name_taken', `A bot named "${name}" already exists`);

/**
 * Teams and bots: each team gets a workspace and a shared PC; a bot shares its team's PC or
 * gets a dedicated one; a solo bot gets its own PC and workspace. Deleting never loses files:
 * the workspace of a deleted team or solo bot goes to the main team's trash.
 */
export class OrgService {
  constructor(
    private readonly db: Db,
    private readonly files: WorkspaceFiles,
    private readonly computers: ComputerService,
    private readonly events: EventBus,
    private readonly masterKey: Buffer,
  ) {}

  async listTeams(): Promise<Team[]> {
    const rows = await this.db
      .select({ team: teams, computerId: computers.id })
      .from(teams)
      .leftJoin(computers, and(eq(computers.teamId, teams.id), eq(computers.kind, 'team')))
      .orderBy(teams.createdAt);
    return rows.map(({ team, computerId }) => toTeam(team, computerId));
  }

  async team(id: string): Promise<Team> {
    const found = (await this.listTeams()).find((team) => team.id === id);
    if (!found) throw notFound('Team not found');
    return found;
  }

  async mainTeam(): Promise<TeamRow> {
    const [main] = await this.db.select().from(teams).where(eq(teams.isMain, true));
    if (!main) throw new Error('The main team does not exist');
    return main;
  }

  async createTeam(input: TeamCreate): Promise<Team> {
    const [{ total = 0 } = {}] = await this.db.select({ total: count() }).from(teams);
    if (total >= MAX_TEAMS) {
      throw new HttpProblem(409, 'too_many_teams', `At most ${MAX_TEAMS} teams`);
    }
    const team = await this.db.transaction(async (tx) => {
      const [workspace] = await tx
        .insert(workspaces)
        .values({ name: input.name, ownerType: 'team' })
        .returning();
      if (!workspace) throw new Error('Workspace insert returned no row');
      const [row] = await tx
        .insert(teams)
        .values({
          name: input.name,
          mission: input.mission ?? null,
          isolated: input.isolated ?? false,
          workspaceId: workspace.id,
        })
        .returning();
      if (!row) throw new Error('Team insert returned no row');
      await tx.insert(computers).values({
        name: `PC — ${input.name}`,
        kind: 'team',
        teamId: row.id,
        workspaceId: workspace.id,
        agentTokenSealed: newAgentTokenSealed(this.masterKey),
      });
      return row;
    });
    await this.files.ensure(team.workspaceId);
    return this.publishTeam(team.id);
  }

  async updateTeam(id: string, input: TeamUpdate): Promise<Team> {
    await this.team(id);
    if (input.leadBotId) {
      const [lead] = await this.db.select().from(bots).where(eq(bots.id, input.leadBotId));
      if (lead?.teamId !== id) {
        throw new HttpProblem(400, 'lead_not_member', 'The lead must be a member of the team');
      }
    }
    await this.db
      .update(teams)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.mission !== undefined ? { mission: input.mission } : {}),
        ...(input.isolated !== undefined ? { isolated: input.isolated } : {}),
        ...(input.leadBotId !== undefined ? { leadBotId: input.leadBotId } : {}),
      })
      .where(eq(teams.id, id));
    return this.publishTeam(id);
  }

  /** Deletes an empty team: its PC goes, its files move to the main team's trash. */
  async deleteTeam(id: string): Promise<void> {
    const [row] = await this.db.select().from(teams).where(eq(teams.id, id));
    if (!row) throw notFound('Team not found');
    if (row.isMain) throw new HttpProblem(409, 'main_team', 'The main team cannot be deleted');
    const [{ members = 0 } = {}] = await this.db
      .select({ members: count() })
      .from(bots)
      .where(eq(bots.teamId, id));
    if (members > 0) {
      throw new HttpProblem(409, 'team_not_empty', 'Move or delete its bots first');
    }
    const pcs = await this.db.select().from(computers).where(eq(computers.teamId, id));
    for (const pc of pcs) await this.computers.remove(pc.id);
    await this.db.delete(teams).where(eq(teams.id, id));
    await this.archiveWorkspace(row.workspaceId, row.name);
    this.events.publish({ type: 'team.deleted', teamId: id });
  }

  /** Creates a bot in a team (on the team's PC or a dedicated one) or solo. */
  async createBot(input: BotCreate, managerId: string | null = null): Promise<Bot> {
    const [{ total = 0 } = {}] = await this.db.select({ total: count() }).from(bots);
    if (total >= MAX_BOTS) throw new HttpProblem(409, 'too_many_bots', `At most ${MAX_BOTS} bots`);
    const [taken] = await this.db.select({ id: bots.id }).from(bots).where(eqName(input.name));
    if (taken) throw nameTaken(input.name);

    const team = input.teamId ? await this.team(input.teamId) : null;
    const [chef] = await this.db.select().from(bots).where(eq(bots.isChef, true));
    const providerId =
      input.providerId !== undefined ? input.providerId : (chef?.providerId ?? null);
    const model =
      input.model !== undefined
        ? input.model
        : providerId === chef?.providerId
          ? (chef?.model ?? null)
          : null;

    let row: BotRow;
    try {
      row = await this.db.transaction(async (tx) => {
        let workspaceId = team?.workspaceId ?? null;
        let computerId = team && input.computer === 'team' ? team.computerId : null;
        if (!team) {
          const [workspace] = await tx
            .insert(workspaces)
            .values({ name: input.name, ownerType: 'bot' })
            .returning();
          if (!workspace) throw new Error('Workspace insert returned no row');
          workspaceId = workspace.id;
        }
        if (!computerId && workspaceId) {
          const [pc] = await tx
            .insert(computers)
            .values({
              name: `PC de ${input.name}`,
              kind: 'dedicated',
              teamId: team?.id ?? null,
              workspaceId,
              agentTokenSealed: newAgentTokenSealed(this.masterKey),
            })
            .returning();
          computerId = pc?.id ?? null;
        }
        const [created] = await tx
          .insert(bots)
          .values({
            name: input.name,
            role: input.role,
            mission: input.mission ?? null,
            teamId: team?.id ?? null,
            computerId,
            workspaceId,
            providerId,
            model,
            managerId,
            avatarSeed: newBotSeed(),
          })
          .returning();
        if (!created) throw new Error('Bot insert returned no row');
        if (team && input.lead) {
          await tx.update(teams).set({ leadBotId: created.id }).where(eq(teams.id, team.id));
        }
        return created;
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw nameTaken(input.name);
      throw error;
    }
    if (row.workspaceId) {
      await this.files.ensure(row.workspaceId);
      await this.files.writeFile(row.workspaceId, `${botFolder(row.name)}/.keep`, '');
    }
    if (team && input.lead) await this.publishTeam(team.id);
    const bot = toBot(row);
    this.events.publish({ type: 'bot.updated', bot });
    return bot;
  }

  /**
   * Deletes a bot (not the Chef) and its conversation. Its dedicated PC goes; a solo bot's
   * files move to the main team's trash. The caller stops the bot first.
   */
  async retireBot(id: string): Promise<void> {
    const [row] = await this.db.select().from(bots).where(eq(bots.id, id));
    if (!row) throw notFound('Bot not found');
    if (row.isChef) throw new HttpProblem(409, 'chef', 'The Chef cannot be deleted');
    const [pc] = row.computerId
      ? await this.db.select().from(computers).where(eq(computers.id, row.computerId))
      : [];
    await this.db.delete(bots).where(eq(bots.id, id));
    if (pc?.kind === 'dedicated') {
      const [other] = await this.db
        .select({ id: bots.id })
        .from(bots)
        .where(and(eq(bots.computerId, pc.id), ne(bots.id, id)));
      if (!other) await this.computers.remove(pc.id);
    }
    if (!row.teamId && row.workspaceId) await this.archiveWorkspace(row.workspaceId, row.name);
    this.events.publish({ type: 'bot.deleted', botId: id });
    if (row.teamId) {
      // The lead may have been cleared by the foreign key.
      await this.publishTeam(row.teamId).catch(() => undefined);
    }
  }

  /**
   * Moves a bot to another team (or makes it solo): it then works on that team's PC (or a
   * dedicated one) and its folder follows it to the new workspace. A solo bot's former
   * workspace goes to the main team's trash. Not the Chef. The caller stops the bot and tidies
   * its windows first.
   */
  async moveBot(id: string, input: BotMove): Promise<Bot> {
    const [row] = await this.db.select().from(bots).where(eq(bots.id, id));
    if (!row) throw notFound('Bot not found');
    if (row.isChef) throw new HttpProblem(409, 'chef', 'The Chef stays in the main team');
    const team = input.teamId ? await this.team(input.teamId) : null;
    const [oldPc] = row.computerId
      ? await this.db.select().from(computers).where(eq(computers.id, row.computerId))
      : [];
    const teamPc = team && input.computer === 'team' ? team.computerId : null;
    const sameTeam = (team?.id ?? null) === row.teamId;
    if (sameTeam && (teamPc ? oldPc?.id === teamPc : oldPc?.kind === 'dedicated')) {
      return toBot(row);
    }

    const moved = await this.db.transaction(async (tx) => {
      let workspaceId = team ? team.workspaceId : row.teamId ? null : row.workspaceId;
      if (!workspaceId) {
        const [workspace] = await tx
          .insert(workspaces)
          .values({ name: row.name, ownerType: 'bot' })
          .returning();
        if (!workspace) throw new Error('Workspace insert returned no row');
        workspaceId = workspace.id;
      }
      let computerId = teamPc;
      if (!computerId && oldPc?.kind === 'dedicated' && oldPc.workspaceId === workspaceId) {
        computerId = oldPc.id;
      }
      if (!computerId) {
        const [pc] = await tx
          .insert(computers)
          .values({
            name: `PC de ${row.name}`,
            kind: 'dedicated',
            teamId: team?.id ?? null,
            workspaceId,
            agentTokenSealed: newAgentTokenSealed(this.masterKey),
          })
          .returning();
        if (!pc) throw new Error('Computer insert returned no row');
        computerId = pc.id;
      }
      if (row.teamId && !sameTeam) {
        await tx
          .update(teams)
          .set({ leadBotId: null })
          .where(and(eq(teams.id, row.teamId), eq(teams.leadBotId, id)));
      }
      const [updated] = await tx
        .update(bots)
        .set({ teamId: team?.id ?? null, workspaceId, computerId })
        .where(eq(bots.id, id))
        .returning();
      if (!updated) throw new Error('Bot update returned no row');
      return updated;
    });

    // First, as it mounts the workspace that may be archived below.
    if (oldPc?.kind === 'dedicated' && oldPc.id !== moved.computerId) {
      const [other] = await this.db
        .select({ id: bots.id })
        .from(bots)
        .where(eq(bots.computerId, oldPc.id));
      if (!other) await this.computers.remove(oldPc.id);
    }
    if (row.workspaceId && moved.workspaceId && moved.workspaceId !== row.workspaceId) {
      await this.files.ensure(moved.workspaceId);
      const folder = botFolder(row.name);
      const taken = await this.files.stat(moved.workspaceId, folder).then(
        () => true,
        () => false,
      );
      const stamp = new Date().toISOString().slice(0, 10);
      await this.files
        .moveInto(
          row.workspaceId,
          folder,
          moved.workspaceId,
          // Its name is taken there: what it brings goes inside.
          taken ? folder : parentOf(folder),
          taken ? `apporte-le-${stamp}` : path.posix.basename(folder),
        )
        .catch(() => this.files.writeFile(moved.workspaceId as string, `${folder}/.keep`, ''));
      for (const workspaceId of [row.workspaceId, moved.workspaceId]) {
        this.events.publish({ type: 'workspace.changed', workspaceId, paths: ['bots'] });
      }
      if (!row.teamId) await this.archiveWorkspace(row.workspaceId, `espace solo de ${row.name}`);
    }
    const bot = toBot(moved);
    this.events.publish({ type: 'bot.updated', bot });
    for (const teamId of new Set([row.teamId, moved.teamId])) {
      if (teamId) await this.publishTeam(teamId).catch(() => undefined);
    }
    return bot;
  }

  private async archiveWorkspace(workspaceId: string, label: string): Promise<void> {
    const main = await this.mainTeam();
    await this.files.archiveInto(workspaceId, main.workspaceId, label);
    await this.db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    this.events.publish({
      type: 'workspace.changed',
      workspaceId: main.workspaceId,
      paths: ['.trash'],
    });
  }

  private async publishTeam(id: string): Promise<Team> {
    const team = await this.team(id);
    this.events.publish({ type: 'team.updated', team });
    return team;
  }
}

/** Case-insensitive match on a bot's name (names are unique that way). */
export const eqName = (name: string) => eq(sql`lower(${bots.name})`, name.trim().toLowerCase());
