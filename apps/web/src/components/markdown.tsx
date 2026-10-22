import { useMemo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { type ChipBot, nameSegments } from '../lib/incoming';
import { cn } from '../lib/utils';
import { BotChip } from './bot-chip';

const components: Components = {
  p: ({ node: _, ...props }) => <p className="mb-3 leading-relaxed last:mb-0" {...props} />,
  a: ({ node: _, ...props }) => (
    <a
      className="text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
      target="_blank"
      rel="noreferrer noopener"
      {...props}
    />
  ),
  ul: ({ node: _, ...props }) => (
    <ul className="mb-3 list-disc space-y-1 pl-5 last:mb-0" {...props} />
  ),
  ol: ({ node: _, ...props }) => (
    <ol className="mb-3 list-decimal space-y-1 pl-5 last:mb-0" {...props} />
  ),
  h1: ({ node: _, ...props }) => (
    <h3 className="mb-2 mt-4 text-base font-semibold first:mt-0" {...props} />
  ),
  h2: ({ node: _, ...props }) => (
    <h3 className="mb-2 mt-4 text-[15px] font-semibold first:mt-0" {...props} />
  ),
  h3: ({ node: _, ...props }) => <h4 className="mb-2 mt-3 font-semibold first:mt-0" {...props} />,
  blockquote: ({ node: _, ...props }) => (
    <blockquote
      className="mb-3 border-l-2 border-primary/40 pl-3 text-muted-foreground"
      {...props}
    />
  ),
  code: ({ node: _, className, children, ...props }) =>
    className ? (
      <code className={cn('font-mono text-[12.5px]', className)} {...props}>
        {children}
      </code>
    ) : (
      <code className="rounded-md bg-ink/[0.07] px-1.5 py-0.5 font-mono text-[0.86em]" {...props}>
        {children}
      </code>
    ),
  pre: ({ node: _, ...props }) => (
    <pre
      className="mb-3 overflow-x-auto rounded-xl border border-border bg-sunken p-3 text-[12.5px] leading-relaxed last:mb-0"
      {...props}
    />
  ),
  table: ({ node: _, ...props }) => (
    <div className="mb-3 overflow-x-auto">
      <table className="w-full border-collapse text-sm" {...props} />
    </div>
  ),
  th: ({ node: _, ...props }) => (
    <th className="border-b border-border-strong px-2 py-1.5 text-left font-medium" {...props} />
  ),
  td: ({ node: _, ...props }) => <td className="border-b border-border px-2 py-1.5" {...props} />,
};

/** The bits of the Markdown tree bot names are looked for in. */
interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: { hName: string; hProperties: Record<string, string> };
}

/** Bot names in the text become chips (`<span data-bot>`), links and code aside. */
function remarkBots(bots: ChipBot[]) {
  const walk = (node: MdNode) => {
    if (!node.children || node.type === 'link' || node.type === 'linkReference') return;
    node.children = node.children.flatMap((child): MdNode[] => {
      if (child.type !== 'text') {
        walk(child);
        return [child];
      }
      return nameSegments(child.value ?? '', bots).map(({ text, ref }) =>
        ref
          ? {
              type: 'botChip',
              data: { hName: 'span', hProperties: { dataBot: String(bots.indexOf(ref)) } },
              children: [{ type: 'text', value: text }],
            }
          : { type: 'text', value: text },
      );
    });
  };
  return () => walk;
}

export function Markdown({
  text,
  className,
  bots,
}: {
  text: string;
  className?: string;
  /** Bots shown as chips (character and colored name) where the text names them. */
  bots?: ChipBot[];
}) {
  const withBots = useMemo(() => {
    if (!bots?.length) return null;
    const chips: Components = {
      ...components,
      span: ({ node: _, ...props }) => {
        const bot = bots[Number((props as Record<string, unknown>)['data-bot'] ?? Number.NaN)];
        return bot ? <BotChip bot={bot} /> : <span {...props} />;
      },
    };
    return { plugins: [remarkGfm, remarkBots(bots)], components: chips };
  }, [bots]);
  return (
    <div className={cn('text-[14.5px] text-foreground/95', className)}>
      <ReactMarkdown
        remarkPlugins={withBots?.plugins ?? [remarkGfm]}
        components={withBots?.components ?? components}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
