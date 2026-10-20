import { describe, expect, it } from 'vitest';
import { closeScript, inventoryScript, openedBy, parseInventory } from '../src/agents/desktop';

const BOT = '0b6a3c1e-8d2f-4b7a-9c3e-5f1d2a4b6c8e';
const TAB_A = 'BD2AF21E1213A8D9FC7CC82EA06B8AE9';
const TAB_B = 'C36D2D523105447782281443A7561AC4';

describe('desktop inventory', () => {
  const stdout = [
    '#tabs',
    `${TAB_A}\tL&#39;équipe &amp; co\thttps://example.com/`,
    `${TAB_B}\tNew Tab\tchrome://newtab/`,
    '#windows',
    '16777219\tXfce4-panel\txfce4-panel',
    '31457283\tGoogle-chrome\tExample - Google Chrome',
    '41943043\tXfce4-terminal\tTerminal - bot@pc: /workspace',
    '#mine',
    TAB_A,
    '41943043',
    '99999999',
    '',
  ].join('\n');

  it('keeps application windows only and unescapes tab titles', () => {
    const inv = parseInventory(stdout);
    expect(inv.tabs.map((t) => t.title)).toEqual(["L'équipe & co", 'New Tab']);
    expect(inv.windows.map((w) => w.id)).toEqual(['41943043']);
  });

  it('only returns what the bot opened and is still open', () => {
    expect(openedBy(parseInventory(stdout))).toEqual({ tabs: [TAB_A], windows: ['41943043'] });
  });
});

describe('desktop scripts', () => {
  it('keeps the state of each bot in its own folder', () => {
    expect(inventoryScript(BOT)).toContain(`STATE="$HOME/.mowbot/bots/${BOT}"`);
  });

  it('refuses ids that could inject shell', () => {
    expect(() => closeScript(BOT, ['$(reboot)'], [])).toThrow();
    expect(() => closeScript(BOT, [], ['1; rm -rf ~'])).toThrow();
    expect(() => inventoryScript('../../etc')).toThrow();
  });
});
