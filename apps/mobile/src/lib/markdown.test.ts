import { describe, expect, it } from 'vitest';
import { isSafeLink, markdownToPlain, parseMarkdown } from './markdown';

describe('markdown', () => {
  it('parses paragraphs with nested inline styles and links', () => {
    expect(parseMarkdown('Voici **un _test_** avec `code` et [un lien](https://x.dev).')).toEqual([
      {
        type: 'paragraph',
        children: [
          { type: 'text', text: 'Voici ' },
          {
            type: 'strong',
            children: [
              { type: 'text', text: 'un ' },
              { type: 'em', children: [{ type: 'text', text: 'test' }] },
            ],
          },
          { type: 'text', text: ' avec ' },
          { type: 'code', text: 'code' },
          { type: 'text', text: ' et ' },
          { type: 'link', href: 'https://x.dev', children: [{ type: 'text', text: 'un lien' }] },
          { type: 'text', text: '.' },
        ],
      },
    ]);
  });

  it('parses lists, code fences, quotes, rules and tables', () => {
    const blocks = parseMarkdown(
      [
        '# Titre',
        '',
        '3. trois',
        '4. quatre',
        '',
        '```ts',
        'const a = 1;',
        '```',
        '',
        '> cité',
        '',
        '---',
        '',
        '| a | b |',
        '|---|---|',
        '| 1 | ~~2~~ |',
      ].join('\n'),
    );
    expect(blocks.map((b) => b.type)).toEqual([
      'heading',
      'list',
      'code',
      'quote',
      'rule',
      'table',
    ]);
    expect(blocks[1]).toMatchObject({ type: 'list', ordered: true, start: 3 });
    expect(blocks[2]).toEqual({ type: 'code', text: 'const a = 1;', lang: 'ts' });
    expect(blocks[5]).toMatchObject({
      type: 'table',
      head: [[{ type: 'text', text: 'a' }], [{ type: 'text', text: 'b' }]],
      rows: [
        [[{ type: 'text', text: '1' }], [{ type: 's', children: [{ type: 'text', text: '2' }] }]],
      ],
    });
  });

  it('keeps raw HTML as text and only opens web or mail links', () => {
    expect(parseMarkdown('<b>hi</b>')).toEqual([
      { type: 'paragraph', children: [{ type: 'text', text: '<b>hi</b>' }] },
    ]);
    expect(isSafeLink('https://example.com')).toBe(true);
    expect(isSafeLink('mailto:a@b.c')).toBe(true);
    expect(isSafeLink('javascript:alert(1)')).toBe(false);
  });

  it('survives a half-streamed answer', () => {
    expect(() => parseMarkdown('Liste :\n\n- un\n- **deu')).not.toThrow();
    expect(parseMarkdown('')).toEqual([]);
  });

  it('reads as plain text for previews', () => {
    expect(markdownToPlain('Salut, prépare la **veille IA** :\n\n1. un\n2. `deux`')).toBe(
      'Salut, prépare la veille IA :\n1. un\n2. deux',
    );
  });
});
