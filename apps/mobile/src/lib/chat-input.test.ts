import type { MessageMention } from '@mowbot/contract';
import { describe, expect, it } from 'vitest';
import {
  botCommands,
  COMMANDS,
  commandOf,
  filterCommands,
  fold,
  insertMention,
  type MentionTrigger,
  matches,
  mentionSegments,
  mentionsToSend,
  pickerOpen,
  rankMatches,
  triggerAt,
} from './chat-input';

const BOT_ID = '00000000-0000-4000-8000-000000000001';
const TEAM_ID = '00000000-0000-4000-8000-000000000002';

describe('fold and matches', () => {
  it('ignores case and accents', () => {
    expect(fold('Équipe Été')).toBe('equipe ete');
    expect(matches('equi', 'Équipe principale')).toBe(true);
    expect(matches('ÉTÉ', 'Rapport d’été')).toBe(true);
    expect(matches('orion', 'Nova', 'Vega')).toBe(false);
  });

  it('keeps spaces: a name written in full and a space after it no longer matches', () => {
    expect(matches('Équipe p', 'Équipe principale')).toBe(true);
    expect(matches('Nova ', 'Nova')).toBe(false);
  });
});

describe('commands', () => {
  const commands = [
    { name: 'stop', title: 'Arrêter' },
    { name: 'clear', title: 'Recommencer la conversation' },
    { name: 'settings', title: 'Réglages' },
    { name: 'routines', title: 'Routines' },
  ];

  it('lists /project, /pc and /files only for a bot with projects, a PC and a workspace', () => {
    expect(botCommands({ computerId: null, workspaceId: null })).toEqual([
      'stop',
      'clear',
      'settings',
      'mcp',
      'vault',
      'routines',
    ]);
    expect(botCommands({ computerId: 'pc-1', workspaceId: 'ws-1' }, true)).toEqual([...COMMANDS]);
    expect(botCommands({ computerId: null, workspaceId: null }, true)).toContain('project');
  });

  it('takes /projet for /project', () => {
    expect(commandOf('/projet', COMMANDS)).toBe('project');
    expect(commandOf('/Project', COMMANDS)).toBe('project');
    // Only when the bot has the command.
    expect(commandOf('/projet', botCommands({ computerId: null, workspaceId: null }))).toBeNull();
  });

  it('filters on the name or the localized title, names starting with the query first', () => {
    expect(filterCommands(commands, '').map((c) => c.name)).toEqual([
      'stop',
      'clear',
      'settings',
      'routines',
    ]);
    expect(filterCommands(commands, 'st').map((c) => c.name)).toEqual(['stop']);
    expect(filterCommands(commands, 'REGL').map((c) => c.name)).toEqual(['settings']);
    expect(filterCommands(commands, 'rec').map((c) => c.name)).toEqual(['clear']);
    expect(filterCommands(commands, 's').map((c) => c.name)).toEqual([
      'stop',
      'settings',
      'clear',
      'routines',
    ]);
    expect(filterCommands(commands, 'zzz')).toEqual([]);
  });

  it('runs a text that is exactly a known command, sends anything else', () => {
    expect(commandOf('/stop', COMMANDS)).toBe('stop');
    expect(commandOf('  /STOP ', COMMANDS)).toBe('stop');
    expect(commandOf('/stop now', COMMANDS)).toBeNull();
    expect(commandOf('/unknown', COMMANDS)).toBeNull();
    expect(commandOf('stop', COMMANDS)).toBeNull();
    expect(commandOf('/pc', ['stop', 'clear'])).toBeNull();
  });
});

describe('triggerAt', () => {
  it('finds a command while the text is a slash and a word', () => {
    expect(triggerAt('/', 1)).toEqual({ kind: 'command', query: '' });
    expect(triggerAt('/sto', 4)).toEqual({ kind: 'command', query: 'sto' });
    expect(triggerAt('/stop ', 6)).toBeNull();
    expect(triggerAt(' /stop', 6)).toBeNull();
    expect(triggerAt('/stop\n', 6)).toBeNull();
  });

  it('finds a mention at the start or after a space, up to the cursor', () => {
    expect(triggerAt('@', 1)).toEqual({ kind: 'mention', query: '', start: 0, end: 1 });
    expect(triggerAt('Ask @No', 7)).toEqual({ kind: 'mention', query: 'No', start: 4, end: 7 });
    expect(triggerAt('Ask\n@No', 7)).toEqual({ kind: 'mention', query: 'No', start: 4, end: 7 });
    // The cursor in the middle: the query stops there.
    expect(triggerAt('Ask @Nova please', 7)).toEqual({
      kind: 'mention',
      query: 'No',
      start: 4,
      end: 7,
    });
  });

  it('allows spaces in the query, not a line break or a leading space', () => {
    expect(triggerAt('@Équipe p', 9)).toEqual({
      kind: 'mention',
      query: 'Équipe p',
      start: 0,
      end: 9,
    });
    expect(triggerAt('@Nova\nhello', 11)).toBeNull();
    expect(triggerAt('@ hello', 7)).toBeNull();
    expect(triggerAt(`@${'a'.repeat(61)}`, 62)).toBeNull();
  });

  it('ignores an @ inside a word (an email address) and texts without @', () => {
    expect(triggerAt('me@site.com', 11)).toBeNull();
    expect(triggerAt('hello', 5)).toBeNull();
  });

  it('keeps the cursor inside the text', () => {
    expect(triggerAt('@No', 99)).toEqual({ kind: 'mention', query: 'No', start: 0, end: 3 });
  });
});

describe('the picker', () => {
  const bots = [{ name: 'Orion' }, { name: 'Nova' }, { name: 'Supernova' }, { name: 'Vega' }];
  const name = (item: { name: string }) => item.name;

  it('ranks names starting with the query first, a few at most', () => {
    expect(rankMatches(bots, 'nova', name).map(name)).toEqual(['Nova', 'Supernova']);
    expect(rankMatches(bots, '', name, 2).map(name)).toEqual(['Orion', 'Nova']);
    expect(rankMatches(bots, 'x', name)).toEqual([]);
  });

  it('stays open while something matches or the query has no space', () => {
    expect(pickerOpen('nov', 0)).toBe(true);
    expect(pickerOpen('Équipe p', 1)).toBe(true);
    expect(pickerOpen('Nova merci', 0)).toBe(false);
  });

  it('replaces the typed query with the label and a space', () => {
    const trigger = triggerAt('Ask @No to check', 7) as MentionTrigger;
    expect(insertMention('Ask @No to check', trigger, 'Nova')).toEqual({
      text: 'Ask @Nova to check',
      caret: 10,
    });
    const atEnd = triggerAt('See @rep', 8) as MentionTrigger;
    expect(insertMention('See @rep', atEnd, 'outputs/report.md')).toEqual({
      text: 'See @outputs/report.md ',
      caret: 23,
    });
  });
});

describe('mentionsToSend', () => {
  const picked: MessageMention[] = [
    { kind: 'bot', id: BOT_ID, label: 'Nova' },
    { kind: 'team', id: TEAM_ID, label: 'Équipe principale' },
    { kind: 'file', path: 'outputs/report.md', label: 'outputs/report.md' },
    { kind: 'bot', id: BOT_ID, label: 'Nova' },
  ];

  it('keeps the mentions still written in the text, once each, without labels', () => {
    expect(mentionsToSend('@Nova read @outputs/report.md', picked)).toEqual([
      { kind: 'bot', id: BOT_ID },
      { kind: 'file', path: 'outputs/report.md' },
    ]);
    expect(mentionsToSend('Ask @Équipe principale', picked)).toEqual([
      { kind: 'team', id: TEAM_ID },
    ]);
    expect(mentionsToSend('Nova, hello', picked)).toEqual([]);
  });

  it('sends a project by its id, like a bot or a team', () => {
    const project: MessageMention = { kind: 'project', id: TEAM_ID, label: 'Site' };
    expect(mentionsToSend('Regarde @Site', [project, project])).toEqual([
      { kind: 'project', id: TEAM_ID },
    ]);
  });
});

describe('mentionSegments', () => {
  const mentions: MessageMention[] = [
    { kind: 'bot', id: BOT_ID, label: 'Équipe' },
    { kind: 'team', id: TEAM_ID, label: 'Équipe principale' },
    { kind: 'file', path: 'notes.md', label: 'notes.md' },
  ];

  it('returns the text whole without mentions', () => {
    expect(mentionSegments('Hello @Nova', [])).toEqual([{ text: 'Hello @Nova' }]);
  });

  it('cuts the text around each @label, the longest label first', () => {
    expect(mentionSegments('Ask @Équipe principale about @notes.md.', mentions)).toEqual([
      { text: 'Ask ' },
      { text: '@Équipe principale', mention: mentions[1] },
      { text: ' about ' },
      { text: '@notes.md', mention: mentions[2] },
      { text: '.' },
    ]);
    expect(mentionSegments('@Équipe, me@mail.com', mentions)).toEqual([
      { text: '@Équipe', mention: mentions[0] },
      { text: ', me@mail.com' },
    ]);
  });
});
