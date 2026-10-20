import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '../lib/utils';

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
      <code className="rounded-md bg-white/[0.07] px-1.5 py-0.5 font-mono text-[0.86em]" {...props}>
        {children}
      </code>
    ),
  pre: ({ node: _, ...props }) => (
    <pre
      className="mb-3 overflow-x-auto rounded-xl border border-border bg-black/40 p-3 text-[12.5px] leading-relaxed last:mb-0"
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

export function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn('text-[14.5px] text-foreground/95', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
