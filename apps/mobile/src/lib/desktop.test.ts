import { describe, expect, it } from 'vitest';
import {
  commandScript,
  DEFAULT_ASPECT,
  desktopHtml,
  desktopSocketUrl,
  fitBox,
  NOVNC_MODULE_URL,
  parseDesktopEvent,
} from './desktop';
import { CTRL_C, KEYS, keysForEdit, keysForText, keysymForChar, typingDiff } from './keysyms';

describe('desktop socket URL', () => {
  it('turns the hub URL into the RFB WebSocket URL', () => {
    expect(desktopSocketUrl('http://192.168.1.10:8787', 'pc-1', 'abc')).toBe(
      'ws://192.168.1.10:8787/api/v1/computers/pc-1/desktop?ticket=abc',
    );
    expect(desktopSocketUrl('https://hub.example.com/', 'pc-1', 'abc')).toBe(
      'wss://hub.example.com/api/v1/computers/pc-1/desktop?ticket=abc',
    );
  });

  it('keeps a path prefix and encodes the ticket', () => {
    expect(desktopSocketUrl('HTTPS://example.com/mowbot', 'pc 1', 'a+b/c=')).toBe(
      'wss://example.com/mowbot/api/v1/computers/pc%201/desktop?ticket=a%2Bb%2Fc%3D',
    );
  });
});

describe('noVNC page', () => {
  it('imports RFB as an ES module from the CDN, same version as the web app', () => {
    expect(NOVNC_MODULE_URL).toBe('https://cdn.jsdelivr.net/npm/@novnc/novnc@1.7.0/core/rfb.js');
    const html = desktopHtml();
    expect(html).toContain(`import("${NOVNC_MODULE_URL}")`);
    expect(html).toContain('ReactNativeWebView.postMessage');
    expect(html).toContain('{ shared: true }');
    expect(html).toContain('scaleViewport = true');
  });

  it('uses the module URL it is given', () => {
    expect(desktopHtml('https://cdn.test/rfb.js')).toContain('import("https://cdn.test/rfb.js")');
  });

  it('delivers commands as a script calling the page bridge', () => {
    const script = commandScript({ type: 'connect', url: 'ws://h/x?ticket=t', viewOnly: true });
    expect(script).toBe(
      'window.mowbot&&window.mowbot.receive({"type":"connect","url":"ws://h/x?ticket=t","viewOnly":true});true;',
    );
  });

  it('reads the events the page posts', () => {
    expect(parseDesktopEvent('{"type":"ready"}')).toEqual({ type: 'ready' });
    expect(parseDesktopEvent('{"type":"connected","width":1280,"height":800}')).toEqual({
      type: 'connected',
      width: 1280,
      height: 800,
    });
    expect(parseDesktopEvent('{"type":"connected"}')).toEqual({
      type: 'connected',
      width: 0,
      height: 0,
    });
    expect(parseDesktopEvent('{"type":"disconnected"}')).toEqual({ type: 'disconnected' });
    expect(parseDesktopEvent('{"type":"error","reason":"load","message":"x"}')).toEqual({
      type: 'error',
      reason: 'load',
      message: 'x',
    });
    expect(parseDesktopEvent('nope')).toBeNull();
    expect(parseDesktopEvent('{"type":"other"}')).toBeNull();
    expect(parseDesktopEvent('null')).toBeNull();
  });

  it('carries the clipboard both ways', () => {
    expect(parseDesktopEvent('{"type":"clipboard","text":"copié"}')).toEqual({
      type: 'clipboard',
      text: 'copié',
    });
    expect(parseDesktopEvent('{"type":"clipboard"}')).toBeNull();
    const html = desktopHtml();
    // What the PC copies goes to the app; what the app pastes lands on the PC's clipboard.
    expect(html).toContain("addEventListener('clipboard'");
    expect(html).toContain('rfb.clipboardPasteFrom(command.text)');
    expect(
      commandScript({ type: 'paste', text: 'secret', keys: [{ keysym: 0x76, code: 'KeyV' }] }),
    ).toContain('"type":"paste","text":"secret"');
  });
});

describe('fitBox', () => {
  it('fits the width when the area is tall', () => {
    expect(fitBox({ width: 390, height: 600 }, DEFAULT_ASPECT)).toEqual({
      width: 390,
      height: 243,
    });
  });

  it('fits the height when the area is wide', () => {
    expect(fitBox({ width: 800, height: 200 }, 2)).toEqual({ width: 400, height: 200 });
  });

  it('is empty until laid out', () => {
    expect(fitBox({ width: 0, height: 0 }, 2)).toEqual({ width: 0, height: 0 });
    expect(fitBox({ width: 10, height: 10 }, 0)).toEqual({ width: 0, height: 0 });
  });
});

describe('keysyms', () => {
  it('maps Latin-1 characters to themselves', () => {
    expect(keysymForChar('a')).toBe(0x61);
    expect(keysymForChar('A')).toBe(0x41);
    expect(keysymForChar(' ')).toBe(0x20);
    expect(keysymForChar('~')).toBe(0x7e);
    expect(keysymForChar('é')).toBe(0xe9);
    expect(keysymForChar('ÿ')).toBe(0xff);
  });

  it('maps other characters to Unicode keysyms', () => {
    expect(keysymForChar('€')).toBe(0x010020ac);
    expect(keysymForChar('œ')).toBe(0x01000153);
    expect(keysymForChar('😀')).toBe(0x0101f600);
  });

  it('maps line breaks and tabs to their keys, drops other control characters', () => {
    expect(keysymForChar('\n')).toBe(KEYS.enter.keysym);
    expect(keysymForChar('\t')).toBe(KEYS.tab.keysym);
    expect(keysymForChar('\u0007')).toBeNull();
    expect(keysymForChar('\u007f')).toBeNull();
    expect(keysymForChar('')).toBeNull();
    expect(keysymForChar('ab')).toBeNull();
  });

  it('types smart quotes as plain ones', () => {
    expect(keysymForChar('’')).toBe(0x27);
    expect(keysymForChar('“')).toBe(0x22);
  });

  it('types text one code point at a time', () => {
    expect(keysForText('Hé 😀')).toEqual([
      { keysym: 0x48 },
      { keysym: 0xe9 },
      { keysym: 0x20 },
      { keysym: 0x0101f600 },
    ]);
  });

  it('presses Ctrl before C', () => {
    expect(CTRL_C.map((key) => key.keysym)).toEqual([0xffe3, 0x63]);
  });
});

describe('typing diff', () => {
  it('types what was added', () => {
    expect(typingDiff('hel', 'hello')).toEqual({ erase: 0, type: 'lo' });
    expect(keysForEdit('', 'hi')).toEqual([{ keysym: 0x68 }, { keysym: 0x69 }]);
  });

  it('erases what was removed', () => {
    expect(typingDiff('hello', 'hel')).toEqual({ erase: 2, type: '' });
    expect(keysForEdit('ab', 'a')).toEqual([KEYS.backspace]);
  });

  it('replaces an autocorrected word', () => {
    expect(typingDiff('teh ', 'the ')).toEqual({ erase: 3, type: 'he ' });
  });

  it('counts code points, not UTF-16 units', () => {
    expect(typingDiff('a😀', 'a')).toEqual({ erase: 1, type: '' });
  });
});
