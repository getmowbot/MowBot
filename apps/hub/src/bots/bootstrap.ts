import { newBotSeed } from '@mowbot/design';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { isUniqueViolation } from '../db/errors';
import { bots, computers, providerProfiles, teams } from '../db/schema';
import { ensureMainTeam } from '../teams/bootstrap';
import type { WorkspaceFiles } from '../workspaces/files';
import { botFolder } from './service';

export const CHEF_NAME = 'Chef';

/** Creates the Chef in the main team, on its PC, with the first provider if any. Idempotent. */
async function ensureChef(db: Db, files: WorkspaceFiles): Promise<void> {
  const [main] = await db.select().from(teams).where(eq(teams.isMain, true));
  if (!main) return;
  const [chef] = await db.select({ id: bots.id }).from(bots).where(eq(bots.isChef, true));
  if (chef) {
    // Instances from before P3: the Chef leads the main team.
    if (!main.leadBotId)
      await db.update(teams).set({ leadBotId: chef.id }).where(eq(teams.id, main.id));
    return;
  }

  const [pc] = await db
    .select({ id: computers.id })
    .from(computers)
    .where(and(eq(computers.teamId, main.id), eq(computers.kind, 'team')));
  const [provider] = await db
    .select()
    .from(providerProfiles)
    .orderBy(providerProfiles.createdAt)
    .limit(1);
  try {
    const [created] = await db
      .insert(bots)
      .values({
        name: CHEF_NAME,
        role: "Chef d'équipe — ton point d'entrée",
        isChef: true,
        teamId: main.id,
        computerId: pc?.id ?? null,
        workspaceId: main.workspaceId,
        providerId: provider?.id ?? null,
        model: provider?.defaultModel ?? null,
        avatarSeed: newBotSeed(),
      })
      .returning({ id: bots.id });
    if (created) await db.update(teams).set({ leadBotId: created.id }).where(eq(teams.id, main.id));
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }
  await files.writeFile(main.workspaceId, `${botFolder(CHEF_NAME)}/.keep`, '');
}

/** Everything that must exist once an owner does: main team, its PC and workspace, the Chef. */
export async function bootstrapOrganization(
  db: Db,
  files: WorkspaceFiles,
  masterKey: Buffer,
): Promise<void> {
  await ensureMainTeam(db, files, masterKey);
  await ensureChef(db, files);
}
