import type { CanvasContent, CanvasSize, CardButton } from '@mowbot/contract';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import {
  ArrowUpRight,
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  FileArchive,
  FileCode,
  File as FileIcon,
  FileImage,
  FileMusic,
  FilePlay,
  FileSpreadsheet,
  FileText,
  Folder,
  ImageOff,
  type LucideIcon,
  Plus,
  X,
} from 'lucide-react';
import { type FormEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { client, problemMessage } from '../lib/auth';
import { downloadWorkspacePath, formatSize, IMAGE, MARKDOWN, PDF, TEXT } from '../lib/files';
import { useTheme } from '../lib/theme';
import { cn } from '../lib/utils';
import { Markdown } from './markdown';
import { WorkspaceImage } from './markdown-document';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';

/**
 * What a canvas shows, kind by kind: the same on the home page (inside its card) and in a
 * conversation (where the bot showed it). Only the home page edits a checklist.
 */

const WEB = /^https?:\/\//i;

/** Links open on the user's own device, in a new tab (never inside a bot's PC). */
export function openLink(url: string) {
  window.open(url, '_blank', 'noopener,noreferrer');
}

/** A picture of a canvas: a web address, or a path in the bot's workspace. */
export function CanvasImage({
  src,
  alt,
  workspaceId,
  version,
  className,
  placeholderClassName,
}: {
  src: string;
  alt: string;
  workspaceId: string | null;
  version?: string;
  className?: string;
  /** While it loads, and when it can't be shown. */
  placeholderClassName?: string;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const fallback = (
    <span
      className={cn(
        'grid place-items-center bg-ink/[0.04] text-faint',
        placeholderClassName ?? className,
      )}
    >
      <ImageOff className="size-5" />
    </span>
  );
  if (WEB.test(src)) {
    if (failed === src) return fallback;
    return (
      <img
        src={src}
        alt={alt}
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailed(src)}
        className={className}
      />
    );
  }
  if (!workspaceId) return fallback;
  return (
    <WorkspaceImage
      workspaceId={workspaceId}
      path={src}
      alt={alt}
      version={version}
      className={className}
      placeholderClassName={placeholderClassName}
      fallback={fallback}
    />
  );
}

function Logo({
  workspaceId,
  path,
  name,
  version,
}: {
  workspaceId: string | null;
  path?: string;
  name: string;
  version?: string;
}) {
  if (!path || !workspaceId) {
    return (
      <span className="grid size-12 place-items-center rounded-full bg-ink/[0.06] text-lg font-semibold">
        {name.slice(0, 1).toUpperCase()}
      </span>
    );
  }
  return (
    <WorkspaceImage
      workspaceId={workspaceId}
      path={path}
      alt={name}
      version={version}
      className="size-12 object-contain"
      placeholderClassName="size-12 aspect-auto rounded-full"
    />
  );
}

function Score({
  content,
  workspaceId,
  version,
}: {
  content: Extract<CanvasContent, { kind: 'score' }>;
  workspaceId: string | null;
  version?: string;
}) {
  const played = content.homeScore !== null && content.awayScore !== null;
  const team = (side: 'home' | 'away') => {
    const value = content[side];
    return (
      <div className="flex min-w-0 flex-1 flex-col items-center gap-2 text-center">
        <Logo workspaceId={workspaceId} path={value.logo} name={value.name} version={version} />
        <span className="max-w-full truncate text-sm font-medium">{value.name}</span>
      </div>
    );
  };
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        {team('home')}
        <div className="shrink-0 text-center">
          <p className="text-4xl font-semibold tabular-nums tracking-tight">
            {played ? `${content.homeScore} – ${content.awayScore}` : '–'}
          </p>
          <p className="mt-1 rounded-full bg-ink/[0.06] px-2 py-0.5 text-[11px] text-muted-foreground">
            {content.status}
          </p>
        </div>
        {team('away')}
      </div>
      {content.detail && <p className="text-center text-xs text-faint">{content.detail}</p>}
    </div>
  );
}

/** What the home page can do to a checklist; without it, the list is read-only. */
export interface ChecklistActions {
  toggle(item: { id: string; done: boolean }): void;
  add(text: string): void;
  remove(itemId: string): void;
}

function Checklist({
  content,
  actions,
}: {
  content: Extract<CanvasContent, { kind: 'checklist' }>;
  actions?: ChecklistActions;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = text.trim();
    if (!value) return;
    actions?.add(value);
    setText('');
  };
  return (
    <div className="space-y-1">
      {content.items.length === 0 && <p className="text-sm text-faint">{t('canvas.emptyList')}</p>}
      <ul className="space-y-0.5">
        {content.items.map((item) => {
          const tick = cn(
            'grid size-[18px] shrink-0 place-items-center rounded-full border transition-colors duration-200',
            item.done
              ? 'border-primary bg-primary text-primary-foreground'
              : cn('border-border-strong', actions && 'hover:border-ink/40'),
          );
          return (
            <li key={item.id} className="group flex items-center gap-2.5 rounded-lg py-1">
              {actions ? (
                <button
                  type="button"
                  aria-pressed={item.done}
                  aria-label={item.text}
                  onClick={() => actions.toggle({ id: item.id, done: !item.done })}
                  className={tick}
                >
                  {item.done && <Check className="size-3" strokeWidth={3} />}
                </button>
              ) : (
                <span aria-hidden className={tick}>
                  {item.done && <Check className="size-3" strokeWidth={3} />}
                </span>
              )}
              <span
                className={cn(
                  'min-w-0 flex-1 text-sm transition-colors duration-200',
                  item.done && 'text-faint line-through',
                )}
              >
                {item.text}
              </span>
              {actions && (
                <button
                  type="button"
                  onClick={() => actions.remove(item.id)}
                  aria-label={t('canvas.removeItem', { text: item.text })}
                  className="grid size-6 place-items-center rounded-md text-faint opacity-0 transition-opacity hover:text-foreground focus:opacity-100 group-hover:opacity-100"
                >
                  <X className="size-3.5" />
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {actions && (
        <form onSubmit={submit} className="flex items-center gap-2.5 pt-1">
          <Plus className="size-[18px] shrink-0 text-faint" />
          <input
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={t('canvas.addItem')}
            maxLength={200}
            aria-label={t('canvas.addItem')}
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-faint"
          />
        </form>
      )}
    </div>
  );
}

function Stats({ content }: { content: Extract<CanvasContent, { kind: 'stats' }> }) {
  return (
    <dl className="grid grid-cols-[repeat(auto-fill,minmax(6rem,1fr))] gap-x-4 gap-y-3">
      {content.items.map((item) => (
        <div key={item.label} className="min-w-0">
          <dd className="truncate text-2xl font-semibold tabular-nums tracking-tight">
            {item.value}
          </dd>
          <dt className="truncate text-xs text-muted-foreground">{item.label}</dt>
          {item.hint && <p className="truncate text-[11px] text-faint">{item.hint}</p>}
        </div>
      ))}
    </dl>
  );
}

const FRAME_HEIGHT: Record<CanvasSize, number> = { s: 200, m: 260, l: 360 };

/**
 * The bot's own page, in the strictest sandbox: no scripts, no network, nothing outside the
 * frame (a page written by a bot must not be able to show something else in its place).
 */
function HtmlFrame({ html, size }: { html: string; size: CanvasSize }) {
  // In the page's look: its text color, and the browser's controls.
  const { theme } = useTheme();
  const ink = theme === 'light' ? '#10131a' : '#e8e9ec';
  const page = [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">`,
    `<style>:root{color-scheme:${theme}}html,body{margin:0;background:transparent;color:${ink};font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}</style>`,
    '</head><body>',
    // A refresh would navigate the frame elsewhere.
    html.replace(/<meta[^>]*http-equiv\s*=\s*["']?refresh[^>]*>/gi, ''),
    '</body></html>',
  ].join('');
  return (
    <iframe
      title="canvas"
      sandbox=""
      srcDoc={page}
      style={{ height: FRAME_HEIGHT[size] }}
      className="w-full rounded-lg border-0"
    />
  );
}

/** Where a card's buttons stand. Buttons that only open a link don't answer the bot. */
export interface CardPress {
  /** The button answers the bot. */
  onPress(button: number): void;
  /** Label of the button chosen: shown ticked, and the buttons wait. */
  chosen?: string | null;
  pending?: boolean;
}

/** A product, a place, a link: a picture, a title, a few words, up to 3 buttons. */
function Card({
  content,
  workspaceId,
  version,
  press,
}: {
  content: Extract<CanvasContent, { kind: 'card' }>;
  workspaceId: string | null;
  version?: string;
  press?: CardPress;
}) {
  const { url, buttons } = content;
  const answered = Boolean(press?.chosen);
  const onButton = (button: CardButton, index: number) => {
    if (button.url) openLink(button.url);
    if (button.reply || !button.url) press?.onPress(index);
  };
  return (
    // With a link, the title covers the whole card; the buttons and the text's links stay on top.
    <div className="group relative space-y-3">
      {content.image && (
        <div className="aspect-video overflow-hidden rounded-xl bg-ink/[0.04]">
          <CanvasImage
            src={content.image}
            alt={content.title}
            workspaceId={workspaceId}
            version={version}
            className={cn(
              'size-full object-cover',
              url && 'transition-transform duration-500 ease-out group-hover:scale-[1.03]',
            )}
            placeholderClassName="size-full aspect-auto rounded-none"
          />
        </div>
      )}
      <div className="space-y-0.5 px-0.5">
        <h4 className="flex items-start gap-1.5 font-medium leading-snug">
          {url ? (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="min-w-0 outline-none decoration-ink/30 underline-offset-2 after:absolute after:inset-0 after:rounded-xl group-hover:underline focus-visible:after:ring-2 focus-visible:after:ring-ring/60"
            >
              {content.title}
            </a>
          ) : (
            <span className="min-w-0">{content.title}</span>
          )}
          {url && (
            <ArrowUpRight className="mt-0.5 size-3.5 shrink-0 text-faint transition-colors duration-200 group-hover:text-foreground" />
          )}
        </h4>
        {content.subtitle && (
          <p className="text-[13px] text-muted-foreground">{content.subtitle}</p>
        )}
      </div>
      {content.text && (
        <Markdown
          text={content.text}
          className="px-0.5 text-sm text-foreground/85 [&_a]:relative [&_a]:z-10"
        />
      )}
      {buttons.length > 0 && (
        <div className="relative z-10 flex flex-wrap gap-2 px-0.5">
          {buttons.map((button, index) => {
            const picked = answered && press?.chosen === button.label;
            // Links stay open once the card is answered; only the answers are spent.
            const answers = Boolean(button.reply || !button.url);
            return (
              <Button
                // biome-ignore lint/suspicious/noArrayIndexKey: a button is pressed by its place; the bot replaces the card whole
                key={`${index}-${button.label}`}
                size="sm"
                variant={index === 0 ? 'default' : 'outline'}
                disabled={answers && (answered || press?.pending)}
                aria-pressed={answered ? picked : undefined}
                onClick={() => onButton(button, index)}
                className={cn(
                  picked &&
                    'border-transparent bg-primary text-primary-foreground disabled:opacity-100',
                )}
              >
                {picked && <Check className="size-3.5" strokeWidth={2.5} />}
                {button.label}
                {button.url && !picked && <ArrowUpRight className="size-3.5 opacity-60" />}
              </Button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** The picture before or after, round the gallery. */
const cycle = (index: number | null, by: number, count: number) =>
  index === null ? null : (index + by + count) % count;

/** Pictures side by side; one opens its link, or shows in large. */
function Gallery({
  content,
  workspaceId,
  version,
}: {
  content: Extract<CanvasContent, { kind: 'gallery' }>;
  workspaceId: string | null;
  version?: string;
}) {
  const { t } = useTranslation();
  const { images } = content;
  const count = images.length;
  const [open, setOpen] = useState<number | null>(null);
  const shown = open === null ? undefined : images[open];
  const step = (by: number) => setOpen((index) => cycle(index, by, count));
  const browsing = shown !== undefined && count > 1;
  useEffect(() => {
    if (!browsing) return;
    const onKey = (event: KeyboardEvent) => {
      const by = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
      if (by) setOpen((index) => cycle(index, by, count));
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [browsing, count]);
  return (
    <>
      <div
        className={cn(
          'grid gap-2',
          count === 1 ? 'grid-cols-1' : 'grid-cols-[repeat(auto-fit,minmax(7.5rem,1fr))]',
        )}
      >
        {images.map((image, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the bot replaces the gallery whole; a picture may show twice
          <figure key={`${index}-${image.src}`} className="min-w-0 space-y-1.5">
            <button
              type="button"
              onClick={() => (image.url ? openLink(image.url) : setOpen(index))}
              aria-label={image.caption ?? t('canvas.enlarge')}
              className={cn(
                'group relative block w-full overflow-hidden rounded-xl border border-border bg-ink/[0.04] outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
                count === 1 ? 'aspect-video' : 'aspect-[4/3]',
              )}
            >
              <CanvasImage
                src={image.src}
                alt={image.caption ?? ''}
                workspaceId={workspaceId}
                version={version}
                className="size-full object-cover transition-transform duration-500 ease-out group-hover:scale-[1.04]"
                placeholderClassName="size-full aspect-auto rounded-none"
              />
              {image.url && (
                <span className="absolute right-1.5 top-1.5 grid size-6 place-items-center rounded-full bg-black/55 text-white backdrop-blur-sm">
                  <ArrowUpRight className="size-3.5" />
                </span>
              )}
            </button>
            {image.caption && (
              <figcaption className="line-clamp-2 px-0.5 text-xs text-muted-foreground">
                {image.caption}
              </figcaption>
            )}
          </figure>
        ))}
      </div>
      <Dialog
        open={shown !== undefined}
        onClose={() => setOpen(null)}
        title={shown?.caption ?? t('canvas.image')}
        className="max-w-3xl"
      >
        {shown && open !== null && (
          <div className="space-y-3">
            <div className="grid place-items-center overflow-hidden rounded-xl bg-sunken">
              <CanvasImage
                key={open}
                src={shown.src}
                alt={shown.caption ?? ''}
                workspaceId={workspaceId}
                version={version}
                className="max-h-[70dvh] max-w-full object-contain"
                placeholderClassName="aspect-video w-full rounded-none"
              />
            </div>
            {browsing && (
              <div className="flex items-center justify-center gap-3">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => step(-1)}
                  aria-label={t('canvas.previous')}
                >
                  <ChevronLeft className="size-4" />
                </Button>
                <span className="min-w-12 text-center text-xs tabular-nums text-faint">
                  {open + 1} / {count}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => step(1)}
                  aria-label={t('canvas.next')}
                >
                  <ChevronRight className="size-4" />
                </Button>
              </div>
            )}
          </div>
        )}
      </Dialog>
    </>
  );
}

type FileContent = Extract<CanvasContent, { kind: 'file' }>;

const PICTURE = /\.(png|jpe?g|gif|webp|avif|svg|heic|bmp|tiff?|ico)$/i;
const SHEET = /\.(csv|tsv|xlsx?|xlsm|ods|numbers)$/i;
const ARCHIVE = /\.(zip|tar|gz|tgz|bz2|xz|7z|rar)$/i;
const SOUND = /\.(mp3|wav|ogg|oga|m4a|aac|flac|opus)$/i;
const MOVIE = /\.(mp4|webm|mov|mkv|avi|m4v)$/i;
const CODE =
  /\.(json|jsonl|ya?ml|toml|ini|env|xml|html?|css|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|c|h|cpp|sh|bash|sql|conf)$/i;

/** How a file is told apart at a glance: an icon, a tint (the first that matches). */
const FILE_LOOKS: [RegExp, LucideIcon, string][] = [
  [PICTURE, FileImage, 'text-violet-300'],
  [PDF, FileText, 'text-rose-300'],
  [SHEET, FileSpreadsheet, 'text-emerald-300'],
  [ARCHIVE, FileArchive, 'text-amber-200'],
  [SOUND, FileMusic, 'text-pink-300'],
  [MOVIE, FilePlay, 'text-sky-300'],
  [CODE, FileCode, 'text-cyan-200'],
  [TEXT, FileText, 'text-foreground/80'],
];

export function fileLook(content: Pick<FileContent, 'type' | 'name'>): {
  icon: LucideIcon;
  tone: string;
} {
  if (content.type === 'directory') return { icon: Folder, tone: 'text-primary' };
  const look = FILE_LOOKS.find(([pattern]) => pattern.test(content.name));
  return look
    ? { icon: look[1], tone: look[2] }
    : { icon: FileIcon, tone: 'text-muted-foreground' };
}

/** Bigger pictures are not worth loading for a glance. */
const PEEK_IMAGE_MAX = 10 * 1024 ** 2;
/** Read of a text file for its first lines (the files page reads the rest when opened). */
const PEEK_BYTES = 4096;
const PEEK_LINES = 15;
/** The glance is text: a document's pictures would load from elsewhere, or not at all. */
const MARKDOWN_IMAGE = /!\[[^\]]*\]\([^)]*\)/g;

type Peek = 'image' | 'markdown' | 'text' | null;

function peekOf(content: FileContent): Peek {
  if (content.type === 'directory' || content.size === 0) return null;
  if (IMAGE.test(content.name)) return content.size <= PEEK_IMAGE_MAX ? 'image' : null;
  if (MARKDOWN.test(content.name)) return 'markdown';
  if (TEXT.test(content.name)) return 'text';
  return null;
}

/** The first lines of a file read in part: a line cut short is left out. */
function firstLines(text: string, partial: boolean): { text: string; more: boolean } {
  const lines = text.split(/\r?\n/);
  if (partial && lines.length > 1) lines.pop();
  while (lines.length > 0 && !lines.at(-1)?.trim()) lines.pop();
  return {
    text: lines
      .slice(0, PEEK_LINES)
      .join('\n')
      .replace(/\uFFFD+$/, ''),
    more: partial || lines.length > PEEK_LINES,
  };
}

function ImagePeek({
  content,
  workspaceId,
  version,
  onOpen,
}: {
  content: FileContent;
  workspaceId: string;
  version?: string;
  onOpen(): void;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={t('canvas.openFile', { name: content.name })}
      className="group grid w-full place-items-center overflow-hidden rounded-xl border border-border bg-sunken outline-none transition-colors duration-200 hover:border-border-strong focus-visible:ring-2 focus-visible:ring-ring/60"
    >
      <WorkspaceImage
        workspaceId={workspaceId}
        path={content.path}
        alt={content.name}
        version={version}
        className="max-h-[280px] max-w-full object-contain transition-transform duration-500 ease-out group-hover:scale-[1.02]"
        placeholderClassName="h-40 aspect-auto rounded-none"
        fallback={
          <span className="grid h-24 w-full place-items-center text-faint">
            <ImageOff className="size-5" />
          </span>
        }
      />
    </button>
  );
}

/** The first lines of a text file: laid out for Markdown, as they are for the rest. */
function TextPeek({
  content,
  workspaceId,
  version,
  markdown,
  onOpen,
}: {
  content: FileContent;
  workspaceId: string;
  version?: string;
  markdown: boolean;
  onOpen(): void;
}) {
  const { t } = useTranslation();
  const box = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  const head = useQuery({
    queryKey: ['file-head', workspaceId, content.path, content.size, version],
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
    queryFn: async () => {
      const response = await client.fetch(
        `/api/v1/workspaces/${workspaceId}/files/content?path=${encodeURIComponent(content.path)}`,
        { headers: { range: `bytes=0-${PEEK_BYTES - 1}` } },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = await response.arrayBuffer();
      return firstLines(new TextDecoder().decode(bytes), bytes.byteLength >= PEEK_BYTES);
    },
  });
  const text = head.data?.text;
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure whenever the text changes
  useLayoutEffect(() => {
    const element = box.current;
    if (element) setOverflows(element.scrollHeight > element.clientHeight + 1);
  }, [text]);
  // Gone, unreadable or blank: the card says enough.
  if (head.isError || (text !== undefined && !text.trim())) return null;
  return (
    <div className="group relative">
      <div className="rounded-xl border border-border bg-sunken px-3.5 py-3 transition-colors duration-200 group-hover:border-border-strong">
        {text === undefined ? (
          <div className="space-y-2 py-0.5">
            {['w-3/4', 'w-full', 'w-5/6', 'w-2/3'].map((width) => (
              <span
                key={width}
                className={cn('block h-2.5 animate-pulse rounded-full bg-ink/[0.06]', width)}
              />
            ))}
          </div>
        ) : (
          <div
            ref={box}
            inert
            className={cn(
              'overflow-hidden',
              markdown && 'max-h-52',
              (head.data?.more || overflows) &&
                '[mask-image:linear-gradient(to_bottom,black_60%,transparent)]',
            )}
          >
            {markdown ? (
              <Markdown text={text.replace(MARKDOWN_IMAGE, '')} className="text-[13px]" />
            ) : (
              <pre className="whitespace-pre font-mono text-[11.5px] leading-[1.6] text-foreground/80">
                {text}
              </pre>
            )}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={onOpen}
        aria-label={t('canvas.openFile', { name: content.name })}
        className="absolute inset-0 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
      />
    </div>
  );
}

/** A file or folder of the bot's workspace: what it is, a first look, to open or download. */
function WorkspaceFile({
  content,
  workspaceId,
  version,
}: {
  content: FileContent;
  workspaceId: string | null;
  version?: string;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const folder = content.type === 'directory';
  const { icon: Icon, tone } = fileLook(content);
  const peek = peekOf(content);
  const extension = /\.([a-z0-9]{1,8})$/i.exec(content.name)?.[1]?.toUpperCase();
  const download = useMutation({
    mutationFn: async () => downloadWorkspacePath(workspaceId as string, content.path),
  });
  /** The files page: at the folder, or at the file's folder with the file in the preview. */
  const open = () => {
    if (!workspaceId) return;
    const slash = content.path.lastIndexOf('/');
    const parent = slash > 0 ? { path: content.path.slice(0, slash) } : {};
    void navigate({
      to: '/workspaces/$workspaceId/files',
      params: { workspaceId },
      search: folder ? { path: content.path } : { ...parent, open: content.path },
    });
  };
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <span
          className={cn(
            'grid size-10 shrink-0 place-items-center rounded-xl bg-ink/[0.05] ring-1 ring-inset ring-ink/[0.06]',
            tone,
          )}
        >
          <Icon className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium leading-snug" title={content.path}>
            {content.name}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {folder
              ? t('files.folder')
              : [formatSize(content.size), extension].filter(Boolean).join(' · ')}
          </p>
        </div>
      </div>
      {content.caption && <p className="px-0.5 text-sm text-foreground/85">{content.caption}</p>}
      {workspaceId && peek === 'image' && (
        <ImagePeek content={content} workspaceId={workspaceId} version={version} onOpen={open} />
      )}
      {workspaceId && (peek === 'markdown' || peek === 'text') && (
        <TextPeek
          content={content}
          workspaceId={workspaceId}
          version={version}
          markdown={peek === 'markdown'}
          onOpen={open}
        />
      )}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={open} disabled={!workspaceId}>
          {t('canvas.open')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => download.mutate()}
          disabled={!workspaceId || download.isPending}
        >
          <Download className="size-3.5" />
          {t('preview.download')}
        </Button>
      </div>
      {download.isError && (
        <p role="alert" className="text-xs text-destructive">
          {problemMessage(download.error, t('common.actionFailed'))}
        </p>
      )}
    </div>
  );
}

/** A canvas's content, without the home page's card around it. */

export function CanvasBody({
  content,
  title = '',
  workspaceId,
  version,
  size = 'm',
  checklist,
  press,
}: {
  content: CanvasContent;
  /** Names a note's picture. */
  title?: string;
  /** The bot's workspace, where its pictures are. */
  workspaceId: string | null;
  /** Changes when the pictures may have changed. */
  version?: string;
  size?: CanvasSize;
  checklist?: ChecklistActions;
  press?: CardPress;
}) {
  switch (content.kind) {
    case 'score':
      return <Score content={content} workspaceId={workspaceId} version={version} />;
    case 'checklist':
      return <Checklist content={content} actions={checklist} />;
    case 'stats':
      return <Stats content={content} />;
    case 'note':
      return (
        <div className="space-y-3">
          {content.image && workspaceId && (
            <WorkspaceImage
              workspaceId={workspaceId}
              path={content.image}
              alt={title}
              version={version}
              className="max-h-56 w-full rounded-lg object-cover"
              placeholderClassName="h-40 aspect-auto"
            />
          )}
          <Markdown text={content.markdown} className="text-sm" />
        </div>
      );
    case 'html':
      return <HtmlFrame html={content.html} size={size} />;
    case 'card':
      return <Card content={content} workspaceId={workspaceId} version={version} press={press} />;
    case 'gallery':
      return <Gallery content={content} workspaceId={workspaceId} version={version} />;
    case 'file':
      return <WorkspaceFile content={content} workspaceId={workspaceId} version={version} />;
  }
}
