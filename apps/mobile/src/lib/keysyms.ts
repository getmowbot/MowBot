/**
 * Keys sent to a PC's desktop over VNC (RFB key events carry X11 keysyms). The phone keyboard
 * types text: each character becomes its keysym; special keys come from the keyboard bar.
 */
export interface KeyPress {
  keysym: number;
  /** DOM `code` of the physical key, for servers that take scancodes (QEMU extension). */
  code?: string;
}

/** X11 keysyms (keysymdef.h) of the keys the keyboard bar offers. */
export const KEYS = {
  enter: { keysym: 0xff0d, code: 'Enter' },
  escape: { keysym: 0xff1b, code: 'Escape' },
  tab: { keysym: 0xff09, code: 'Tab' },
  backspace: { keysym: 0xff08, code: 'Backspace' },
  delete: { keysym: 0xffff, code: 'Delete' },
  left: { keysym: 0xff51, code: 'ArrowLeft' },
  up: { keysym: 0xff52, code: 'ArrowUp' },
  right: { keysym: 0xff53, code: 'ArrowRight' },
  down: { keysym: 0xff54, code: 'ArrowDown' },
  control: { keysym: 0xffe3, code: 'ControlLeft' },
} as const satisfies Record<string, KeyPress>;

/** Ctrl+C / Ctrl+V: pressed in order, released in reverse. */
export const CTRL_C: KeyPress[] = [KEYS.control, { keysym: 0x63, code: 'KeyC' }];
export const CTRL_V: KeyPress[] = [KEYS.control, { keysym: 0x76, code: 'KeyV' }];

/** Unicode characters outside Latin-1 are keysyms 0x01000000 + code point (X11 convention). */
const UNICODE_KEYSYM = 0x01000000;

/**
 * Typographic quotes the phone keyboard substitutes as you type (iOS smart punctuation): the
 * plain ASCII one is what a terminal or a form on the PC expects.
 */
const PLAIN: Record<string, string> = {
  '‘': "'",
  '’': "'",
  '‚': "'",
  '“': '"',
  '”': '"',
  '„': '"',
};

/** The keysym of one character (a code point), or null when it cannot be typed. */
export function keysymForChar(char: string): number | null {
  const plain = PLAIN[char] ?? char;
  const code = plain.codePointAt(0);
  if (code === undefined || plain.length > (code > 0xffff ? 2 : 1)) return null;
  if (plain === '\n' || plain === '\r') return KEYS.enter.keysym;
  if (plain === '\t') return KEYS.tab.keysym;
  // Other control characters (and DEL) have no printable keysym.
  if (code < 0x20 || (code >= 0x7f && code < 0xa0)) return null;
  // Latin-1 keysyms are the code points themselves (`a` = 0x61, `é` = 0xe9).
  if (code <= 0xff) return code;
  return UNICODE_KEYSYM + code;
}

/** Key presses that type `text` (characters with no keysym are skipped). */
export function keysForText(text: string): KeyPress[] {
  const keys: KeyPress[] = [];
  for (const char of text) {
    const keysym = keysymForChar(char);
    if (keysym !== null) keys.push({ keysym });
  }
  return keys;
}

/**
 * What changed in the text field since the last keystroke, as the PC sees it (its cursor sits at
 * the end of what was typed): erase what follows the common prefix, then type the rest. Covers
 * typing, deleting, autocorrect replacing a word and pasting.
 */
export function typingDiff(previous: string, next: string): { erase: number; type: string } {
  const before = Array.from(previous);
  const after = Array.from(next);
  let common = 0;
  while (common < before.length && common < after.length && before[common] === after[common]) {
    common++;
  }
  return { erase: before.length - common, type: after.slice(common).join('') };
}

/** Key presses that turn what the PC received for `previous` into `next`. */
export function keysForEdit(previous: string, next: string): KeyPress[] {
  const { erase, type } = typingDiff(previous, next);
  return [...Array.from({ length: erase }, () => KEYS.backspace), ...keysForText(type)];
}
