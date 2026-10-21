import { QueryClient } from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import { beforeAll, describe, expect, it } from 'vitest';
import { bot, connector, project, translator } from '../test/fixtures';
import { applyServerEvent } from './event-cache';
import {
  activeProject,
  computerSummary,
  connectorHint,
  connectorName,
  modeBody,
  modeLabel,
  NAME_MAX,
  nameProblem,
  PATH_CHARS,
  presenceText,
  projectChoices,
  projectHint,
  projectsFor,
  renameBody,
  shortPath,
  sortConnectors,
  sortProjects,
  usableBy,
} from './projects';
import { keys } from './query-keys';

let fr: TFunction;
let en: TFunction;
beforeAll(async () => {
  fr = await translator('fr');
  en = await translator('en');
});

const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

describe('sorting', () => {
  it('sorts projects by name, then by where they are', () => {
    const b = project({ name: 'site' });
    const a2 = project({ name: 'App', path: '/home/joris/app' });
    const a1 = project({ name: 'app', path: 'C:\\dev\\app' });
    expect(sortProjects([b, a2, a1]).map((p) => p.id)).toEqual([a2.id, a1.id, b.id]);
  });

  it('sorts computers by name', () => {
    const laptop = connector({ name: 'portable' });
    const desk = connector({ name: 'Bureau' });
    expect(sortConnectors([laptop, desk]).map((c) => c.name)).toEqual(['Bureau', 'portable']);
  });
});

describe('paths', () => {
  it('keeps a path that fits', () => {
    const path = 'C:\\Users\\Joris\\projects\\MowBot';
    expect(shortPath(path)).toBe(path);
    expect(shortPath('/home/joris/projects/mowbot/', 27)).toBe('/home/joris/projects/mowbot');
  });

  it('cuts a Windows path in the middle, keeping its start and last folders', () => {
    const path = 'C:\\Users\\Joris\\Documents\\projects\\clients\\acme\\website-redesign';
    expect(shortPath(path)).toBe('C:\\Users\\…\\clients\\acme\\website-redesign');
  });

  it('cuts Unix, home and network paths the same way', () => {
    expect(shortPath('/home/joris/dev/clients/acme/website-redesign/packages/frontend')).toBe(
      '/home/…/website-redesign/packages/frontend',
    );
    expect(shortPath('~/projets/clients/acme/site/packages/frontend/src/components', 30)).toBe(
      '~/projets/…/src/components',
    );
    expect(shortPath('\\\\server\\share\\equipe\\projets\\2026\\clients\\acme\\site', 40)).toBe(
      '\\\\server\\…\\2026\\clients\\acme\\site',
    );
  });

  it('cuts characters when a folder alone is too long', () => {
    const long = `/Users/joris/${'a'.repeat(60)}`;
    expect(shortPath(long)).toBe(`/Users/joris/aaaa…${'a'.repeat(26)}`);
    expect(shortPath(long)).toHaveLength(PATH_CHARS);
    expect(shortPath(`/${'x'.repeat(50)}`)).toHaveLength(PATH_CHARS);
  });
});

describe('computers', () => {
  it('names the computer of a project', () => {
    const pc = connector({ name: 'Bureau' });
    expect(connectorName(pc.id, [pc], fr)).toBe('Bureau');
    expect(connectorName('gone', [pc], fr)).toBe('Ordinateur délié');
    expect(connectorName(pc.id, undefined, fr)).toBe('…');
  });

  it('says whether it is there, or when it was last seen', () => {
    expect(presenceText(connector({ online: true }), fr, 'fr', NOW)).toBe('en ligne');
    const away = connector({ online: false, lastSeenAt: minutesAgo(5) });
    expect(presenceText(away, fr, 'fr', NOW)).toBe('vu il y a 5 min');
    expect(presenceText(away, en, 'en', NOW)).toBe('seen 5 min ago');
    expect(presenceText(connector({ online: false, lastSeenAt: null }), fr, 'fr')).toBe(
      'jamais connecté',
    );
  });

  it('sums up what its app reported, the hostname only when it differs', () => {
    const renamed = connector({ name: 'Bureau', hostname: 'PC-de-Joris', os: 'windows' });
    expect(computerSummary(renamed, fr, 'fr', NOW)).toBe('PC-de-Joris · Windows · en ligne');
    const same = connector({ name: 'mac-joris', hostname: 'mac-joris', os: 'macos' });
    expect(computerSummary(same, en, 'en', NOW)).toBe('macOS · online');
    const fresh = connector({ hostname: null, os: null, online: false, lastSeenAt: null });
    expect(computerSummary(fresh, en, 'en', NOW)).toBe('never connected');
  });

  it('counts the folders each computer shares', () => {
    const pc = connector({ os: 'linux' });
    const other = connector();
    const projects = [project({ connectorId: pc.id }), project({ connectorId: pc.id })];
    expect(connectorHint(pc, projects, fr, 'fr', NOW)).toBe(
      'Linux · en ligne\n2 dossiers partagés',
    );
    expect(connectorHint(other, projects, en, 'en', NOW)).toBe(
      'Windows · online\nNo shared folders',
    );
    expect(connectorHint(pc, undefined, fr, 'fr', NOW)).toBe('Linux · en ligne');
  });
});

describe('projects', () => {
  it('words the mode', () => {
    expect(modeLabel('ask', fr)).toBe('Commandes sur accord');
    expect(modeLabel('auto', en)).toBe('Commands without asking');
  });

  it('tells where a project is, whether it is reachable and how commands run', () => {
    const pc = connector({ name: 'PC-de-Joris' });
    const here = project({ connectorId: pc.id });
    expect(projectHint(here, [pc], fr)).toBe('PC-de-Joris · en ligne · Commandes sur accord');
    const away = project({ connectorId: pc.id, online: false, mode: 'auto' });
    expect(projectHint(away, [pc], en)).toBe('PC-de-Joris · offline · Commands without asking');
  });

  it('checks a new name and only sends a change', () => {
    expect(nameProblem('  ')).toBe('name');
    expect(nameProblem('x'.repeat(NAME_MAX + 1))).toBe('nameLong');
    expect(nameProblem(' Site ')).toBeNull();
    const current = project({ name: 'MowBot' });
    expect(renameBody(current, '  Site client ')).toEqual({ name: 'Site client' });
    expect(renameBody(current, 'MowBot ')).toBeNull();
    expect(renameBody(current, '')).toBeNull();
  });

  it('turns the switch into a mode', () => {
    expect(modeBody(true)).toEqual({ mode: 'auto' });
    expect(modeBody(false)).toEqual({ mode: 'ask' });
  });
});

describe('events', () => {
  it('keeps projects live', () => {
    const client = new QueryClient();
    const first = project();
    client.setQueryData(keys.projects, [first]);
    const changed = { ...first, mode: 'auto' as const };
    applyServerEvent(client, { type: 'project.updated', project: changed });
    const added = project({ name: 'Site' });
    applyServerEvent(client, { type: 'project.updated', project: added });
    expect(client.getQueryData(keys.projects)).toEqual([changed, added]);
    applyServerEvent(client, { type: 'project.deleted', projectId: first.id });
    expect(client.getQueryData(keys.projects)).toEqual([added]);
  });

  it('keeps computers live, and drops the projects of one unlinked', () => {
    const client = new QueryClient();
    const pc = connector();
    const other = connector({ name: 'Bureau' });
    const mine = project({ connectorId: pc.id });
    const theirs = project({ connectorId: other.id });
    client.setQueryData(keys.connectors, [pc]);
    client.setQueryData(keys.projects, [mine, theirs]);
    const offline = { ...pc, online: false };
    applyServerEvent(client, { type: 'connector.updated', connector: offline });
    applyServerEvent(client, { type: 'connector.updated', connector: other });
    expect(client.getQueryData(keys.connectors)).toEqual([offline, other]);
    applyServerEvent(client, { type: 'connector.deleted', connectorId: pc.id });
    expect(client.getQueryData(keys.connectors)).toEqual([other]);
    expect(client.getQueryData(keys.projects)).toEqual([theirs]);
  });

  it('refetches them on reconnect', () => {
    const client = new QueryClient();
    client.setQueryData(keys.projects, []);
    client.setQueryData(keys.connectors, []);
    applyServerEvent(client, { type: 'ready' });
    expect(client.getQueryState(keys.projects)?.isInvalidated).toBe(true);
    expect(client.getQueryState(keys.connectors)?.isInvalidated).toBe(true);
  });
});

describe('the project a bot works in', () => {
  const TEAM = '00000000-0000-4000-8000-0000000000aa';
  const nova = bot({ name: 'Nova', teamId: TEAM });
  const pc = connector({ name: 'PC-de-Joris' });
  const site = project({ name: 'Site', connectorId: pc.id });
  const compta = project({ name: 'compta', connectorId: pc.id, online: false });
  const forOthers = project({ name: 'Autre', scope: { kind: 'bots', ids: ['someone-else'] } });
  const forTeam = project({ name: 'Équipe', scope: { kind: 'teams', ids: [TEAM] } });

  it('keeps the projects the bot may use, sorted', () => {
    expect(usableBy(site, nova)).toBe(true);
    expect(usableBy(forOthers, nova)).toBe(false);
    expect(usableBy(forTeam, nova)).toBe(true);
    expect(usableBy(forTeam, { ...nova, teamId: null })).toBe(false);
    expect(usableBy(project({ scope: { kind: 'bots', ids: [nova.id] } }), nova)).toBe(true);
    expect(projectsFor(nova, [site, forOthers, compta, forTeam]).map((p) => p.name)).toEqual([
      'compta',
      'Équipe',
      'Site',
    ]);
    expect(projectsFor(nova, undefined)).toEqual([]);
  });

  it('finds the active project, while the bot may still use it', () => {
    expect(activeProject({ ...nova, projectId: site.id }, [site, compta])).toBe(site);
    expect(activeProject(nova, [site])).toBeNull();
    // Gone, or no longer for this bot.
    expect(activeProject({ ...nova, projectId: site.id }, [compta])).toBeNull();
    expect(activeProject({ ...nova, projectId: forOthers.id }, [forOthers])).toBeNull();
    expect(activeProject({ ...nova, projectId: site.id }, undefined)).toBeNull();
  });

  it('offers the usable projects with their computer, offline ones marked, then none', () => {
    const working = { ...nova, projectId: site.id };
    expect(projectChoices(working, [site, compta, forOthers], [pc], fr)).toEqual([
      {
        projectId: compta.id,
        label: 'compta · PC-de-Joris (hors ligne)',
        checked: false,
        offline: true,
      },
      { projectId: site.id, label: '✓ Site · PC-de-Joris', checked: true, offline: false },
      { projectId: null, label: 'Aucun projet', checked: false, offline: false },
    ]);
    expect(projectChoices(nova, [site], [pc], en).map((c) => c.label)).toEqual([
      'Site · PC-de-Joris',
      '✓ No project',
    ]);
  });

  it('offers nothing when the bot may use no project', () => {
    expect(projectChoices(nova, [forOthers], [pc], fr)).toEqual([]);
    expect(projectChoices(nova, undefined, undefined, fr)).toEqual([]);
  });

  it('follows the bot on every device', () => {
    const client = new QueryClient();
    client.setQueryData(keys.bots, [nova]);
    const moved = { ...nova, projectId: site.id };
    applyServerEvent(client, { type: 'bot.updated', bot: moved });
    expect(client.getQueryData(keys.bots)).toEqual([moved]);
  });
});
