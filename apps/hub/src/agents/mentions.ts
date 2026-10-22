import type { Mention, MessageMention } from '@mowbot/contract';
import { inArray } from 'drizzle-orm';
import type { BotRow } from '../bots/service';
import type { MirrorService } from '../connectors/mirror';
import type { ConnectorService } from '../connectors/service';
import type { Db } from '../db/client';
import { bots, teams } from '../db/schema';
import type { WorkspaceFiles } from '../workspaces/files';
import { projectPlace } from './local-tools';

/** A text file this small is handed to the bot whole, as with @ in a code editor. */
const INLINE_MAX_BYTES = 40_000;

export const size = (bytes: number) =>
  bytes < 1024
    ? `${bytes} o`
    : bytes < 1024 ** 2
      ? `${(bytes / 1024).toFixed(1).replace('.', ',')} Ko`
      : `${(bytes / 1024 ** 2).toFixed(1).replace('.', ',')} Mo`;

/**
 * What the user pointed at with @ in a message: the bot reads who or what it is (a bot to write
 * to, a team, a file of its workspace with its content when short, a project of the user's
 * computer), the apps keep the labels to highlight them. Mentions that no longer resolve (or a
 * project the bot may not use) are dropped.
 */
export async function resolveMentions(
  deps: { db: Db; files: WorkspaceFiles; connectors?: ConnectorService; mirrors?: MirrorService },
  bot: BotRow,
  mentions: Mention[],
): Promise<{ context: string; kept: MessageMention[] }> {
  if (mentions.length === 0) return { context: '', kept: [] };
  const botIds = mentions.flatMap((m) => (m.kind === 'bot' ? [m.id] : []));
  const mentionedBots = botIds.length
    ? await deps.db.select().from(bots).where(inArray(bots.id, botIds))
    : [];
  const teamIds = [
    ...mentions.flatMap((m) => (m.kind === 'team' ? [m.id] : [])),
    ...mentionedBots.flatMap((b) => (b.teamId ? [b.teamId] : [])),
  ];
  const teamRows = teamIds.length
    ? await deps.db.select().from(teams).where(inArray(teams.id, teamIds))
    : [];
  const leadIds = teamRows.flatMap((t) => (t.leadBotId ? [t.leadBotId] : []));
  const leads = leadIds.length
    ? await deps.db
        .select({ id: bots.id, name: bots.name })
        .from(bots)
        .where(inArray(bots.id, leadIds))
    : [];
  const projectIds = mentions.flatMap((m) => (m.kind === 'project' ? [m.id] : []));
  const projectRows =
    projectIds.length && deps.connectors
      ? (await deps.connectors.accessibleTo(bot)).filter((p) => projectIds.includes(p.id))
      : [];
  const machines = deps.connectors ? await deps.connectors.connectorsOf(projectRows) : new Map();

  const lines: string[] = [];
  const kept: MessageMention[] = [];
  const seen = new Set<string>();
  for (const mention of mentions) {
    const key = mention.kind === 'file' ? `file:${mention.path}` : `${mention.kind}:${mention.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (mention.kind === 'bot') {
      const found = mentionedBots.find((b) => b.id === mention.id);
      if (!found) continue;
      kept.push({ kind: 'bot', id: found.id, label: found.name });
      if (found.id === bot.id) {
        lines.push(`- @${found.name} : toi.`);
        continue;
      }
      const team = teamRows.find((t) => t.id === found.teamId);
      const where = found.isChef ? 'le Chef' : team ? `équipe ${team.name}` : 'bot solo';
      lines.push(
        `- @${found.name} : le bot ${found.name} (${found.role}, ${where}). Écris-lui avec send_message, ou ask_bot pour attendre sa réponse.`,
      );
    } else if (mention.kind === 'team') {
      const team = teamRows.find((t) => t.id === mention.id);
      if (!team) continue;
      kept.push({ kind: 'team', id: team.id, label: team.name });
      const lead = leads.find((l) => l.id === team.leadBotId);
      lines.push(
        `- @${team.name} : l'équipe ${team.name}${lead ? `, menée par ${lead.name}` : ''}${team.mission ? ` (mission : ${team.mission})` : ''}. list_bots la détaille.`,
      );
    } else if (mention.kind === 'project') {
      const project = projectRows.find((p) => p.id === mention.id);
      if (!project) continue;
      kept.push({ kind: 'project', id: project.id, label: project.name });
      const online = Boolean(deps.connectors?.isOnline(project.connectorId));
      const place = projectPlace(machines.get(project.connectorId), online);
      const mirror = deps.mirrors?.mirrorIn(project.id, bot.workspaceId);
      const how = mirror
        ? `Son miroir : /workspace/${mirror.folder} (tes outils habituels ; local_exec pour une commande sur son ordinateur).`
        : project.mirror && bot.workspaceId
          ? `local_sync avec project « ${project.name} » en fait un miroir dans ton workspace.`
          : `Outils local_* avec project « ${project.name} ».`;
      lines.push(
        `- @${project.name} : le projet ${project.name}, dossier ${project.path} de l'ordinateur de l'utilisateur (${place})${project.id === bot.projectId ? ', ton projet actif' : ''}. ${how}`,
      );
    } else {
      const line = await describeFile(deps.files, bot, mention.path);
      if (!line) continue;
      kept.push({ kind: 'file', path: line.path, label: line.path });
      lines.push(line.text);
    }
  }
  if (lines.length === 0) return { context: '', kept };
  return { context: `[Mentionnés avec @]\n${lines.join('\n')}`, kept };
}

/**
 * A file or folder of the bot's workspace, as the bot sees it on its PC: a line starting with
 * `label` (`@path` for a mention).
 */
export async function describeFile(
  files: WorkspaceFiles,
  bot: BotRow,
  input: string,
  label?: string,
): Promise<{ path: string; text: string } | null> {
  if (!bot.workspaceId) return null;
  const entry = await files.stat(bot.workspaceId, input).catch(() => null);
  if (!entry) return null;
  const onPc = `/workspace/${entry.path}`;
  const head = `- ${label ?? `@${entry.path}`} :`;
  if (entry.type === 'directory') {
    const { entries } = await files.list(bot.workspaceId, entry.path);
    const names = entries.map((e) => (e.type === 'directory' ? `${e.name}/` : e.name));
    const shown = names.slice(0, 30).join(', ');
    const more = names.length > 30 ? ` et ${names.length - 30} autres` : '';
    return {
      path: entry.path,
      text: `${head} le dossier ${onPc}/ (${names.length ? `${shown}${more}` : 'vide'}).`,
    };
  }
  if (entry.size <= INLINE_MAX_BYTES) {
    const { text } = await files.readText(bot.workspaceId, entry.path, INLINE_MAX_BYTES);
    if (!text.includes('\0')) {
      const fence = text.includes('```') ? '~~~~' : '```';
      return {
        path: entry.path,
        text: `${head} le fichier ${onPc} (${size(entry.size)}), son contenu :\n${fence}\n${text}\n${fence}`,
      };
    }
  }
  return {
    path: entry.path,
    text: `${head} le fichier ${onPc} (${size(entry.size)}), à ouvrir sur ton PC si besoin.`,
  };
}
