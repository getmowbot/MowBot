import type { FileEntry } from '@mowbot/contract';
import { useQuery } from '@tanstack/react-query';
import { Code, Download, FileText, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { client } from '../lib/auth';
import { MarkdownDocument } from './markdown-document';
import { Button } from './ui/button';

const MARKDOWN = /\.(md|markdown)$/i;

const TEXT =
  /\.(txt|md|markdown|csv|tsv|log|json|jsonl|ya?ml|toml|ini|env|xml|html?|css|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|c|h|cpp|sh|bash|sql|conf)$/i;
const IMAGE = /\.(png|jpe?g|gif|webp|avif|svg)$/i;
const AUDIO = /\.(mp3|wav|ogg)$/i;
const VIDEO = /\.(mp4|webm)$/i;
const PDF = /\.pdf$/i;

const LIMITS = {
  text: 2 * 1024 ** 2,
  image: 25 * 1024 ** 2,
  pdf: 50 * 1024 ** 2,
  media: 100 * 1024 ** 2,
};

type Kind = 'text' | 'image' | 'pdf' | 'audio' | 'video' | null;

function kindOf(entry: FileEntry): Kind {
  if (TEXT.test(entry.name) && entry.size <= LIMITS.text) return 'text';
  if (IMAGE.test(entry.name) && entry.size <= LIMITS.image) return 'image';
  if (PDF.test(entry.name) && entry.size <= LIMITS.pdf) return 'pdf';
  if (AUDIO.test(entry.name) && entry.size <= LIMITS.media) return 'audio';
  if (VIDEO.test(entry.name) && entry.size <= LIMITS.media) return 'video';
  return null;
}

interface Props {
  workspaceId: string;
  entry: FileEntry;
  onClose(): void;
  onDownload(entry: FileEntry): void;
  /** A Markdown document links to another file of the workspace. */
  onOpenPath?(path: string): void;
}

/**
 * Modal preview. Files are fetched with the session and shown from blob URLs; HTML is shown as
 * source; Markdown is laid out as a document (its source one click away).
 */
export function FilePreview({ workspaceId, entry, onClose, onDownload, onOpenPath }: Props) {
  const { t } = useTranslation();
  const kind = kindOf(entry);
  const markdown = kind === 'text' && MARKDOWN.test(entry.name);
  const [source, setSource] = useState(false);
  const baseDir = entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : '';
  const content = useQuery({
    queryKey: ['file-content', workspaceId, entry.path, entry.modifiedAt],
    enabled: kind !== null,
    gcTime: 0,
    queryFn: async () => {
      const response = await client.fetch(
        `/api/v1/workspaces/${workspaceId}/files/content?path=${encodeURIComponent(entry.path)}`,
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      return kind === 'text' ? { text: await blob.text() } : { url: URL.createObjectURL(blob) };
    },
  });

  const url = content.data && 'url' in content.data ? content.data.url : null;
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2 md:p-8">
      <button
        type="button"
        aria-label={t('preview.close')}
        tabIndex={-1}
        className="absolute inset-0 cursor-default bg-black/60"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={entry.name}
        className="relative flex max-h-full w-full max-w-5xl flex-col overflow-hidden rounded-xl border bg-card shadow-xl"
      >
        <div className="flex items-center gap-2 border-b px-4 py-2">
          <p className="min-w-0 flex-1 truncate font-medium">{entry.name}</p>
          {markdown && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSource((v) => !v)}
              aria-pressed={source}
            >
              {source ? <FileText className="size-4" /> : <Code className="size-4" />}
              {source ? t('preview.rendered') : t('preview.source')}
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => onDownload(entry)}>
            <Download className="size-4" /> {t('preview.download')}
          </Button>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label={t('preview.close')}>
            <X className="size-4" />
          </Button>
        </div>
        <div className="min-h-48 flex-1 overflow-auto">
          {kind === null && (
            <p className="p-6 text-sm text-muted-foreground">{t('preview.none')}</p>
          )}
          {kind && content.isPending && (
            <p className="p-6 text-sm text-muted-foreground">{t('common.loading')}</p>
          )}
          {content.isError && <p className="p-6 text-sm text-destructive">{t('preview.failed')}</p>}
          {content.data && 'text' in content.data && markdown && !source && (
            <MarkdownDocument
              text={content.data.text ?? ''}
              workspaceId={workspaceId}
              baseDir={baseDir}
              onOpenPath={onOpenPath}
            />
          )}
          {content.data && 'text' in content.data && (!markdown || source) && (
            <pre className="whitespace-pre-wrap break-words p-4 font-mono text-xs leading-relaxed">
              {content.data.text}
            </pre>
          )}
          {url && kind === 'image' && (
            <img src={url} alt={entry.name} className="mx-auto max-h-[80dvh] object-contain p-4" />
          )}
          {url && kind === 'pdf' && (
            <iframe src={url} title={entry.name} className="h-[80dvh] w-full" />
          )}
          {url && kind === 'audio' && (
            // biome-ignore lint/a11y/useMediaCaption: user files, no captions available
            <audio src={url} controls className="m-6 w-[calc(100%-3rem)]" />
          )}
          {url && kind === 'video' && (
            // biome-ignore lint/a11y/useMediaCaption: user files, no captions available
            <video src={url} controls className="mx-auto max-h-[80dvh]" />
          )}
        </div>
      </div>
    </div>
  );
}
