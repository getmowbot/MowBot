import { useQuery } from '@tanstack/react-query';
import { ImageOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { client } from '../lib/auth';
import { cn } from '../lib/utils';

const EXTERNAL = /^(https?:|mailto:)/i;

/** `report.md` in `outputs/` links to `../shared/plan.md` → `shared/plan.md` (null: not a file). */
export function resolveWorkspacePath(href: string, baseDir: string): string | null {
  if (!href || href.startsWith('#') || EXTERNAL.test(href) || /^[a-z]+:/i.test(href)) return null;
  const url = new URL(href, `file:///${baseDir ? `${baseDir}/` : ''}`);
  return decodeURIComponent(url.pathname).replace(/^\/+/, '').replace(/\/+$/, '');
}

/** An image of the workspace, fetched with the session. */
function WorkspaceImage({
  workspaceId,
  path,
  alt,
}: {
  workspaceId: string;
  path: string;
  alt: string;
}) {
  const image = useQuery({
    queryKey: ['file-blob', workspaceId, path],
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
    queryFn: async () => {
      const response = await client.fetch(
        `/api/v1/workspaces/${workspaceId}/files/content?path=${encodeURIComponent(path)}`,
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return URL.createObjectURL(await response.blob());
    },
  });
  useEffect(() => () => void (image.data && URL.revokeObjectURL(image.data)), [image.data]);
  if (image.isError) {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
        <ImageOff className="size-4" /> {alt || path}
      </span>
    );
  }
  if (!image.data) {
    return <span className="block aspect-video w-full animate-pulse rounded-lg bg-white/[0.04]" />;
  }
  return (
    <img src={image.data} alt={alt} className="my-4 max-w-full rounded-lg border border-border" />
  );
}

/**
 * An image from the internet is not loaded until asked: a document written by a bot could
 * otherwise tell a third party when and from where it is read.
 */
function ExternalImage({ src, alt }: { src: string; alt: string }) {
  const [shown, setShown] = useState(false);
  if (shown) return <img src={src} alt={alt} className="my-4 max-w-full rounded-lg" />;
  return (
    <button
      type="button"
      onClick={() => setShown(true)}
      className="my-2 inline-flex max-w-full items-center gap-2 rounded-lg border border-dashed border-border-strong px-3 py-2 text-left text-sm text-muted-foreground transition-colors hover:text-foreground"
    >
      <ImageOff className="size-4 shrink-0" />
      <span className="min-w-0 truncate">
        Image externe non chargée{alt ? ` (${alt})` : ''} : afficher
      </span>
    </button>
  );
}

/**
 * A Markdown file of a workspace, laid out as a document. Links to other files of the
 * workspace open them in place; links to the web open in a new tab.
 */
export function MarkdownDocument({
  text,
  workspaceId,
  baseDir,
  onOpenPath,
  className,
}: {
  text: string;
  workspaceId: string;
  /** Folder of the document, for relative links and images. */
  baseDir: string;
  onOpenPath?(path: string): void;
  className?: string;
}) {
  const components: Components = {
    h1: ({ node: _, ...props }) => (
      <h1 className="mb-4 mt-8 text-2xl font-semibold tracking-tight first:mt-0" {...props} />
    ),
    h2: ({ node: _, ...props }) => (
      <h2
        className="mb-3 mt-8 border-b border-border pb-1.5 text-xl font-semibold tracking-tight first:mt-0"
        {...props}
      />
    ),
    h3: ({ node: _, ...props }) => (
      <h3 className="mb-2 mt-6 text-lg font-semibold first:mt-0" {...props} />
    ),
    h4: ({ node: _, ...props }) => <h4 className="mb-2 mt-5 font-semibold first:mt-0" {...props} />,
    p: ({ node: _, ...props }) => <p className="mb-4 leading-7 last:mb-0" {...props} />,
    a: ({ node: _, href = '', children, ...props }) => {
      const target = resolveWorkspacePath(href, baseDir);
      if (target !== null && onOpenPath) {
        return (
          <button
            type="button"
            onClick={() => onOpenPath(target)}
            className="text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
          >
            {children}
          </button>
        );
      }
      return (
        <a
          href={EXTERNAL.test(href) ? href : undefined}
          className="text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
          target="_blank"
          rel="noreferrer noopener"
          {...props}
        >
          {children}
        </a>
      );
    },
    ul: ({ node: _, className: kind, ...props }) => (
      <ul
        className={cn(
          'mb-4 space-y-1.5 pl-6 last:mb-0',
          kind?.includes('contains-task-list') ? 'list-none pl-1' : 'list-disc',
        )}
        {...props}
      />
    ),
    ol: ({ node: _, ...props }) => (
      <ol className="mb-4 list-decimal space-y-1.5 pl-6 last:mb-0" {...props} />
    ),
    li: ({ node: _, ...props }) => (
      <li className="leading-7 [&>ol]:mt-1.5 [&>ul]:mt-1.5" {...props} />
    ),
    input: ({ node: _, ...props }) => (
      <input {...props} disabled className="mr-2 size-3.5 translate-y-0.5 accent-white" />
    ),
    blockquote: ({ node: _, ...props }) => (
      <blockquote
        className="mb-4 border-l-2 border-primary/40 pl-4 text-muted-foreground"
        {...props}
      />
    ),
    hr: () => <hr className="my-8 border-border" />,
    code: ({ node: _, className: language, children, ...props }) =>
      language ? (
        <code className={cn('font-mono text-[13px]', language)} {...props}>
          {children}
        </code>
      ) : (
        <code
          className="rounded-md bg-white/[0.07] px-1.5 py-0.5 font-mono text-[0.86em]"
          {...props}
        >
          {children}
        </code>
      ),
    pre: ({ node: _, ...props }) => (
      <pre
        className="mb-4 overflow-x-auto rounded-xl border border-border bg-black/40 p-4 text-[13px] leading-relaxed last:mb-0"
        {...props}
      />
    ),
    table: ({ node: _, ...props }) => (
      <div className="mb-4 overflow-x-auto">
        <table className="w-full border-collapse text-sm" {...props} />
      </div>
    ),
    th: ({ node: _, ...props }) => (
      <th className="border-b border-border-strong px-3 py-2 text-left font-medium" {...props} />
    ),
    td: ({ node: _, ...props }) => <td className="border-b border-border px-3 py-2" {...props} />,
    img: ({ node: _, src = '', alt = '' }) => {
      const source = typeof src === 'string' ? src : '';
      if (/^data:image\//i.test(source))
        return <img src={source} alt={alt} className="my-4 max-w-full" />;
      const path = resolveWorkspacePath(source, baseDir);
      if (path !== null) return <WorkspaceImage workspaceId={workspaceId} path={path} alt={alt} />;
      return <ExternalImage src={source} alt={alt} />;
    },
  };

  return (
    <article
      className={cn('mx-auto max-w-3xl px-6 py-8 text-[15px] text-foreground/95', className)}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </article>
  );
}
