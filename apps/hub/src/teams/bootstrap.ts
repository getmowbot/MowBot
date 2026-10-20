import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { ownerExists } from '../auth/setup';
import { AGENT_TOKEN_PURPOSE } from '../computers/service';
import { seal } from '../crypto/secretbox';
import type { Db } from '../db/client';
import { isUniqueViolation } from '../db/errors';
import { computers, teams, workspaces } from '../db/schema';
import type { WorkspaceFiles } from '../workspaces/files';

export const MAIN_TEAM_NAME = 'Équipe principale';

export const newAgentTokenSealed = (masterKey: Buffer) =>
  seal(masterKey, AGENT_TOKEN_PURPOSE, randomBytes(32).toString('base64url'));

/**
 * Once an owner exists, makes sure the main team, its workspace and its shared computer exist
 * (setup creates them; instances set up before P1 get them on the next start).
 */
export async function ensureMainTeam(
  db: Db,
  files: WorkspaceFiles,
  masterKey: Buffer,
): Promise<void> {
  if (!(await ownerExists(db))) return;
  const [existing] = await db.select().from(teams).where(eq(teams.isMain, true));
  if (existing) {
    await files.ensure(existing.workspaceId);
    return;
  }

  let workspaceId: string | undefined;
  try {
    await db.transaction(async (tx) => {
      const [workspace] = await tx
        .insert(workspaces)
        .values({ name: MAIN_TEAM_NAME, ownerType: 'team' })
        .returning();
      if (!workspace) throw new Error('Workspace insert returned no row');
      const [team] = await tx
        .insert(teams)
        .values({ name: MAIN_TEAM_NAME, isMain: true, workspaceId: workspace.id })
        .returning();
      if (!team) throw new Error('Team insert returned no row');
      await tx.insert(computers).values({
        name: `PC — ${MAIN_TEAM_NAME}`,
        kind: 'team',
        teamId: team.id,
        workspaceId: workspace.id,
        agentTokenSealed: newAgentTokenSealed(masterKey),
      });
      workspaceId = workspace.id;
    });
  } catch (error) {
    // Lost a race with a concurrent bootstrap: the other one created the team.
    if (!isUniqueViolation(error)) throw error;
    return ensureMainTeam(db, files, masterKey);
  }
  if (workspaceId) await files.ensure(workspaceId);
}
