import type { Connector, ConnectorOs, Project, ProjectMode, ProjectUpdate } from '@mowbot/contract';
import type { TFunction } from 'i18next';
import { timeAgo } from './time';

/**
 * Pure logic of the Projects screens (no React, no native modules): the folders shared from the
 * user's computers by the MowBot desktop app, those computers, and what the screens send. Who may
 * use a project has the same shape as an MCP server's bots (`lib/mcp`: scopeSummary, liveScope…).
 */

const byText = (a: string, b: string) => a.toLowerCase().localeCompare(b.toLowerCase());

/** By name, then where they are (two "app" folders on two computers). */
export function sortProjects(projects: readonly Project[]): Project[] {
  return [...projects].sort(
    (a, b) =>
      byText(a.name, b.name) || byText(a.path, b.path) || a.createdAt.localeCompare(b.createdAt),
  );
}

/** By name (the hub lists them by link date; events append new ones at the end). */
export function sortConnectors(connectors: readonly Connector[]): Connector[] {
  return [...connectors].sort(
    (a, b) => byText(a.name, b.name) || a.createdAt.localeCompare(b.createdAt),
  );
}

// ---------------------------------------------------------------------------------------------
// Paths

/** Characters of a path that fit on one line of a row. */
export const PATH_CHARS = 44;
const ELLIPSIS = '…';
const DRIVE = /^[A-Za-z]:$/;

/** How many segments say where a path starts: "/home", "C:\Users", "~/projets", "\\serveur". */
function headLength(segments: readonly string[]): number {
  let count = 0;
  for (const segment of segments) {
    count += 1;
    if (segment && segment !== '~' && !DRIVE.test(segment)) break;
  }
  return count;
}

/** Characters cut in the middle, keeping more of the end (the folder's own name). */
function cutMiddle(text: string, max: number): string {
  const end = Math.ceil((max - 1) * 0.6);
  return `${text.slice(0, max - 1 - end)}${ELLIPSIS}${text.slice(text.length - end)}`;
}

/**
 * "C:\Users\Joris\…\projects\MowBot": a long path cut in the middle, keeping where it starts and
 * as many of its last folders as fit in `max` characters. Windows and Unix paths alike.
 */
export function shortPath(path: string, max = PATH_CHARS): string {
  if (path.length <= max) return path;
  const trimmed = path.replace(/[\\/]+$/, '');
  if (trimmed.length <= max) return trimmed;
  const sep = trimmed.lastIndexOf('\\') > trimmed.lastIndexOf('/') ? '\\' : '/';
  const segments = trimmed.split(sep);
  const head = headLength(segments);
  // Nothing between the start and the last folder to leave out.
  if (segments.length - head < 2) return cutMiddle(trimmed, max);
  const start = segments.slice(0, head).join(sep);
  const joined = (from: number) =>
    `${start}${sep}${ELLIPSIS}${sep}${segments.slice(from).join(sep)}`;
  let from = segments.length - 1;
  if (joined(from).length > max) return cutMiddle(trimmed, max);
  // At least one folder stays left out (hence `> head + 1`).
  while (from > head + 1 && joined(from - 1).length <= max) from -= 1;
  return joined(from);
}

// ---------------------------------------------------------------------------------------------
// Computers

export const OS_NAMES: Record<ConnectorOs, string> = {
  windows: 'Windows',
  macos: 'macOS',
  linux: 'Linux',
};

/** The computer a project is on, by the name it was linked with ("…" while loading). */
export function connectorName(
  connectorId: string,
  connectors: readonly Pick<Connector, 'id' | 'name'>[] | undefined,
  t: TFunction,
): string {
  if (!connectors) return ELLIPSIS;
  return connectors.find((c) => c.id === connectorId)?.name ?? t('projects.computers.unknown');
}

/** "en ligne", "vu il y a 5 min", "jamais connecté". */
export function presenceText(
  connector: Pick<Connector, 'online' | 'lastSeenAt'>,
  t: TFunction,
  language: string,
  now?: number,
): string {
  if (connector.online) return t('projects.online');
  if (!connector.lastSeenAt) return t('projects.neverSeen');
  return t('projects.lastSeen', { time: timeAgo(connector.lastSeenAt, t, language, now) });
}

/**
 * What its app reported, then whether it is there: "PC-de-Joris · Windows · en ligne" (the
 * hostname only when the computer was linked under another name).
 */
export function computerSummary(
  connector: Connector,
  t: TFunction,
  language: string,
  now?: number,
): string {
  const { hostname, os, name } = connector;
  return [
    hostname && hostname !== name ? hostname : null,
    os ? OS_NAMES[os] : null,
    presenceText(connector, t, language, now),
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Under a linked computer's name: its summary, then how many folders it shares. */
export function connectorHint(
  connector: Connector,
  projects: readonly Pick<Project, 'connectorId'>[] | undefined,
  t: TFunction,
  language: string,
  now?: number,
): string {
  const summary = computerSummary(connector, t, language, now);
  if (!projects) return summary;
  const count = projects.filter((p) => p.connectorId === connector.id).length;
  const shared =
    count === 0 ? t('projects.computers.noProjects') : t('projects.computers.projects', { count });
  return `${summary}\n${shared}`;
}

// ---------------------------------------------------------------------------------------------
// Projects

export function modeLabel(mode: ProjectMode, t: TFunction): string {
  return t(`projects.modes.${mode}`);
}

/** Under a project's path: "PC-de-Joris · en ligne · Commandes sans demander". */
export function projectHint(
  project: Pick<Project, 'connectorId' | 'online' | 'mode'>,
  connectors: readonly Pick<Connector, 'id' | 'name'>[] | undefined,
  t: TFunction,
): string {
  return [
    connectorName(project.connectorId, connectors, t),
    project.online ? t('projects.online') : t('projects.offline'),
    modeLabel(project.mode, t),
  ].join(' · ');
}

/** Same limit as the hub. */
export const NAME_MAX = 80;

export type NameProblem = 'name' | 'nameLong';

export function nameProblem(typed: string): NameProblem | null {
  const name = typed.trim();
  if (!name) return 'name';
  return name.length > NAME_MAX ? 'nameLong' : null;
}

/** What renaming sends; null when the name did not change. */
export function renameBody(project: Pick<Project, 'name'>, typed: string): ProjectUpdate | null {
  const name = typed.trim();
  return name && name !== project.name ? { name } : null;
}

/** The switch "Commandes sans demander": on runs commands freely, off asks for each one. */
export function modeBody(auto: boolean): ProjectUpdate {
  return { mode: auto ? 'auto' : 'ask' };
}
