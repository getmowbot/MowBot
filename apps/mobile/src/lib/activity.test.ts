import { describe, expect, it } from 'vitest';
import { tool, translator } from '../test/fixtures';
import { activityHeadline, searchQuery, segments, summarize, toolTitle } from './activity';

describe('activity line', () => {
  it('summarizes a finished run by kind, in both languages', async () => {
    const parts = [
      tool('open_url', { url: 'https://www.google.com/search?q=mowbot+mobile' }),
      tool('open_url', { url: 'https://duckduckgo.com/?q=expo' }),
      tool('screenshot'),
      tool('screenshot'),
      tool('screenshot'),
      tool('open_url', { url: 'https://example.com/page' }),
    ];
    expect(summarize(parts, await translator('fr'))).toBe('2 recherches · 3 captures · 1 page');
    expect(summarize(parts, await translator('en'))).toBe('2 searches · 3 screenshots · 1 page');
  });

  it('counts plain actions when no kind applies', async () => {
    const t = await translator('fr');
    expect(summarize([tool('pc_status'), tool('list_windows')], t)).toBe('2 actions');
    expect(summarize([tool('pc_status')], t)).toBe('1 action');
  });

  it('shows what the bot does right now while live', async () => {
    const t = await translator('fr');
    const running = tool('bash', { command: 'cd /tmp && sudo curl -sL x' }, 'running');
    expect(activityHeadline([tool('screenshot'), running], true, t)).toMatchObject({
      title: 'Lance curl',
      icon: 'terminal',
    });
    expect(activityHeadline([{ type: 'reasoning', text: '…' }], true, t).title).toBe('Réfléchit…');
  });

  it('prefers the intent the bot gave', async () => {
    const t = await translator('en');
    expect(
      toolTitle(tool('computer', { action: 'click', x: 1, y: 2, intent: 'Opens the menu' }), t),
    ).toBe('Opens the menu');
    expect(toolTitle(tool('computer', { action: 'click', x: 1, y: 2 }), t)).toBe('Click (1, 2)');
  });

  it('translates task statuses inside update_task', async () => {
    expect(toolTitle(tool('update_task', { status: 'done' }), await translator('fr'))).toBe(
      'Tâche terminée',
    );
    expect(toolTitle(tool('update_task', { status: 'nope' }), await translator('en'))).toBe(
      'Task updated',
    );
  });

  it('reads search queries without the URL API', () => {
    expect(searchQuery('https://www.google.fr/search?hl=fr&q=caf%C3%A9+cr%C3%A8me')).toBe(
      'café crème',
    );
    expect(searchQuery('https://example.com/?q=x')).toBeNull();
  });

  it('groups tool calls and reasoning between two texts', () => {
    const blocks = segments([
      { type: 'text', text: 'Je regarde.' },
      { type: 'reasoning', text: 'hmm' },
      tool('screenshot'),
      { type: 'text', text: '   ' },
      tool('bash', { command: 'ls' }),
      { type: 'text', text: 'Fini.' },
    ]);
    expect(blocks.map((b) => b.kind)).toEqual(['text', 'activity', 'text']);
    expect(blocks[1]?.kind === 'activity' && blocks[1].parts).toHaveLength(3);
  });

  it('places what the bot shows between its texts', () => {
    const card = {
      type: 'canvas' as const,
      content: { kind: 'card' as const, title: 'Kiprun', buttons: [] },
      pressed: null,
    };
    const blocks = segments([
      { type: 'text', text: 'Voici la chaussure.' },
      tool('open_url', { url: 'https://example.com' }),
      tool('show_in_chat', { content: {} }),
      card,
      { type: 'text', text: 'Elle te va ?' },
    ]);
    // The finished show_in_chat call is left out: the card stands for it.
    expect(blocks.map((b) => [b.kind, b.index])).toEqual([
      ['text', 0],
      ['activity', 1],
      ['canvas', 3],
      ['text', 4],
    ]);
    expect(blocks[1]?.kind === 'activity' && blocks[1].parts).toHaveLength(1);
    expect(blocks[2]?.kind === 'canvas' && blocks[2].part).toBe(card);
  });

  it('keeps a takeover request as its own block', () => {
    const request = {
      type: 'takeover_request' as const,
      computerId: '00000000-0000-4000-8000-000000000001',
      reason: 'Connecte-toi à BadNet',
      url: null,
      status: 'pending' as const,
    };
    const blocks = segments([{ type: 'text', text: 'Il me faut ta main.' }, request]);
    expect(blocks.map((b) => [b.kind, b.index])).toEqual([
      ['text', 0],
      ['takeover', 1],
    ]);
    expect(blocks[1]?.kind === 'takeover' && blocks[1].part).toBe(request);
  });

  it('keeps a show_in_chat call while it runs, or when it failed', async () => {
    const t = await translator('fr');
    const running = tool('show_in_chat', {}, 'running');
    expect(segments([running]).map((b) => b.kind)).toEqual(['activity']);
    expect(segments([tool('show_in_chat', {}, 'error')]).map((b) => b.kind)).toEqual(['activity']);
    expect(activityHeadline([running], true, t).title).toBe('Prépare un aperçu');
  });
});
