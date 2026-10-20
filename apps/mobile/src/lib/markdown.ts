import MarkdownIt, { type Token } from 'markdown-it';

/** A small Markdown tree for native rendering (GFM tables and strikethrough included). */
export type Inline =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'strong' | 'em' | 's'; children: Inline[] }
  | { type: 'link'; href: string; children: Inline[] };

export type Block =
  | { type: 'paragraph'; children: Inline[] }
  | { type: 'heading'; level: number; children: Inline[] }
  | { type: 'list'; ordered: boolean; start: number; items: Block[][] }
  | { type: 'quote'; children: Block[] }
  | { type: 'code'; text: string; lang: string }
  | { type: 'rule' }
  | { type: 'table'; head: Inline[][]; rows: Inline[][][] };

// Raw HTML stays text: bot output is untrusted.
const md = new MarkdownIt({ html: false, linkify: true, breaks: false });

type Container = Extract<Inline, { children: Inline[] }>;

function pushText(target: Inline[], text: string) {
  const last = target.at(-1);
  if (last?.type === 'text') last.text += text;
  else target.push({ type: 'text', text });
}

function parseInline(tokens: Token[]): Inline[] {
  const root: Inline[] = [];
  const stack: Inline[][] = [root];
  for (const token of tokens) {
    const target = stack[stack.length - 1] ?? root;
    switch (token.type) {
      case 'text':
      case 'html_inline':
        pushText(target, token.content);
        break;
      case 'softbreak':
        // Same as the web: a single newline inside a paragraph reads as a space.
        pushText(target, ' ');
        break;
      case 'hardbreak':
        pushText(target, '\n');
        break;
      case 'code_inline':
        target.push({ type: 'code', text: token.content });
        break;
      case 'image':
        pushText(target, token.content || String(token.attrGet('alt') ?? ''));
        break;
      case 'strong_open':
      case 'em_open':
      case 's_open': {
        const node: Container = {
          type: token.type.replace('_open', '') as 'strong' | 'em' | 's',
          children: [],
        };
        target.push(node);
        stack.push(node.children);
        break;
      }
      case 'link_open': {
        const node: Container = {
          type: 'link',
          href: String(token.attrGet('href') ?? ''),
          children: [],
        };
        target.push(node);
        stack.push(node.children);
        break;
      }
      case 'strong_close':
      case 'em_close':
      case 's_close':
      case 'link_close':
        if (stack.length > 1) stack.pop();
        break;
    }
  }
  return root;
}

export function parseMarkdown(source: string): Block[] {
  const tokens = md.parse(source, {});
  let i = 0;

  const inlineAt = (index: number) => parseInline(tokens[index]?.children ?? []);

  function table(): Block {
    const head: Inline[][] = [];
    const rows: Inline[][][] = [];
    let row: Inline[][] | null = null;
    let inHead = false;
    while (i < tokens.length && tokens[i]?.type !== 'table_close') {
      const token = tokens[i] as Token;
      if (token.type === 'thead_open') inHead = true;
      else if (token.type === 'thead_close') inHead = false;
      else if (token.type === 'tr_open') row = [];
      else if (token.type === 'tr_close' && row) {
        if (inHead) head.push(...row);
        else rows.push(row);
        row = null;
      } else if (token.type === 'inline') row?.push(parseInline(token.children ?? []));
      i++;
    }
    i++;
    return { type: 'table', head, rows };
  }

  function blocks(until?: string): Block[] {
    const out: Block[] = [];
    while (i < tokens.length) {
      const token = tokens[i] as Token;
      if (until && token.type === until) {
        i++;
        return out;
      }
      switch (token.type) {
        case 'paragraph_open':
          out.push({ type: 'paragraph', children: inlineAt(i + 1) });
          i += 3;
          break;
        case 'heading_open':
          out.push({
            type: 'heading',
            level: Number(token.tag.slice(1)),
            children: inlineAt(i + 1),
          });
          i += 3;
          break;
        case 'bullet_list_open':
        case 'ordered_list_open': {
          const ordered = token.type === 'ordered_list_open';
          const start = Number(token.attrGet('start') ?? 1);
          const items: Block[][] = [];
          i++;
          while (tokens[i]?.type === 'list_item_open') {
            i++;
            items.push(blocks('list_item_close'));
          }
          i++;
          out.push({ type: 'list', ordered, start, items });
          break;
        }
        case 'blockquote_open':
          i++;
          out.push({ type: 'quote', children: blocks('blockquote_close') });
          break;
        case 'fence':
        case 'code_block':
          out.push({
            type: 'code',
            text: token.content.replace(/\n$/, ''),
            lang: token.info.trim(),
          });
          i++;
          break;
        case 'hr':
          out.push({ type: 'rule' });
          i++;
          break;
        case 'table_open':
          i++;
          out.push(table());
          break;
        case 'html_block':
          out.push({ type: 'paragraph', children: [{ type: 'text', text: token.content.trim() }] });
          i++;
          break;
        default:
          i++;
      }
    }
    return out;
  }

  return blocks();
}

/** Only web and mail links open from a bot's message. */
export function isSafeLink(href: string): boolean {
  return /^(https?:|mailto:)/i.test(href);
}
