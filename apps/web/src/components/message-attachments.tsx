import type { Message, MessagePart } from '@mowbot/contract';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { ChevronDown, Download, LoaderCircle, Pause, Play, RotateCw } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { type KeyboardEvent, type MouseEvent, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, client, problemMessage } from '../lib/auth';
import { downloadWorkspacePath, formatSize, IMAGE } from '../lib/files';
import { cn } from '../lib/utils';
import { fitPeaks, formatDuration } from '../lib/voice';
import { CanvasBody, fileLook } from './canvas-body';
import { Button } from './ui/button';

export type AttachmentPart = Extract<MessagePart, { type: 'attachment' }>;
export type AudioPart = Extract<MessagePart, { type: 'audio' }>;

/** Bars of a voice message's waveform in its bubble. */
const BARS = 40;

/** Pictures a browser shows (a HEIC photo comes as a file card). */
export const isShownPicture = (part: AttachmentPart) =>
  part.mimeType.startsWith('image/') && IMAGE.test(part.name);

const parentOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** A file sent with a message: what it is, opened in the files page or downloaded. */
function AttachmentCard({ part }: { part: AttachmentPart }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { icon: Icon, tone } = fileLook({ type: 'file', name: part.name });
  const extension = /\.([a-z0-9]{1,8})$/i.exec(part.name)?.[1]?.toUpperCase();
  const download = useMutation({
    mutationFn: () => downloadWorkspacePath(part.workspaceId, part.path),
  });
  const open = () => {
    const parent = parentOf(part.path);
    void navigate({
      to: '/workspaces/$workspaceId/files',
      params: { workspaceId: part.workspaceId },
      search: { ...(parent ? { path: parent } : {}), open: part.path },
    });
  };
  return (
    <div className="glass flex w-full items-center gap-1 rounded-2xl p-1.5">
      <button
        type="button"
        onClick={open}
        aria-label={t('chat.attach.open', { name: part.name })}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-xl p-1 text-left outline-none transition-colors duration-200 hover:bg-white/[0.04] focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        <span
          className={cn(
            'grid size-10 shrink-0 place-items-center rounded-xl bg-white/[0.05] ring-1 ring-inset ring-white/[0.06]',
            tone,
          )}
        >
          <Icon className="size-5" />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium" title={part.path}>
            {part.name}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {[formatSize(part.size), extension].filter(Boolean).join(' · ')}
          </span>
        </span>
      </button>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => download.mutate()}
        disabled={download.isPending}
        aria-label={t('preview.download')}
        title={download.isError ? problemMessage(download.error, t('common.actionFailed')) : ''}
      >
        <Download className="size-4" />
      </Button>
    </div>
  );
}

/** What the user attached to a message: pictures side by side (to open in large), then files. */
export function MessageAttachments({ parts }: { parts: AttachmentPart[] }) {
  const pictures = parts.filter(isShownPicture);
  const others = parts.filter((part) => !isShownPicture(part));
  const first = pictures[0];
  return (
    <div className="flex w-full max-w-[85%] flex-col items-end gap-2 sm:max-w-sm">
      {first && (
        <div className="w-full">
          <CanvasBody
            content={{ kind: 'gallery', images: pictures.map((part) => ({ src: part.path })) }}
            workspaceId={first.workspaceId}
          />
        </div>
      )}
      {others.map((part) => (
        <AttachmentCard key={part.path} part={part} />
      ))}
    </div>
  );
}

/** The recording, fetched with the session on first play (the hub wants the auth header). */
function useRecordingUrl(part: AudioPart) {
  const [url, setUrl] = useState<string | null>(null);
  const loading = useRef<Promise<string> | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new file (converted to AAC) is fetched again
  useEffect(() => {
    loading.current = null;
    setUrl(null);
  }, [part.workspaceId, part.path]);
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);
  const load = () => {
    loading.current ??= client
      .fetch(
        `/api/v1/workspaces/${part.workspaceId}/files/content?path=${encodeURIComponent(part.path)}`,
      )
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        // Served as a download type for safety: played as the recording it is.
        const created = URL.createObjectURL(new Blob([blob], { type: part.mimeType }));
        setUrl(created);
        return created;
      })
      .catch((error: unknown) => {
        loading.current = null;
        throw error;
      });
    return loading.current;
  };
  return { url, load };
}

/**
 * A voice message: play/pause, its waveform (a click moves in it), its length, and under it the
 * transcript made on the hub, folded until asked for.
 */
export function VoiceMessage({ message, part }: { message: Message; part: AudioPart }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const player = useRef<HTMLAudioElement | null>(null);
  const frame = useRef(0);
  const { load } = useRecordingUrl(part);
  const [playing, setPlaying] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [failed, setFailed] = useState(false);
  const [position, setPosition] = useState(0);
  const [measured, setMeasured] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const duration = part.durationMs || measured || 0;
  const progress = duration > 0 ? Math.min(1, position / duration) : 0;
  const bars = fitPeaks(part.peaks, BARS);

  const retry = useMutation({
    mutationFn: async () => {
      const { data, error } = await api.POST('/api/v1/bots/{id}/messages/{messageId}/transcribe', {
        params: { path: { id: message.botId, messageId: message.id } },
      });
      if (error || !data) throw error;
      return data;
    },
    onSuccess: (updated) =>
      queryClient.setQueryData<Message[]>(['messages', updated.botId], (list) =>
        list?.map((m) => (m.id === updated.id ? updated : m)),
      ),
  });

  // The file changed (converted on the hub): start over with it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the file changes
  useEffect(() => {
    player.current?.pause();
    player.current = null;
    setPlaying(false);
    setPosition(0);
  }, [part.path]);
  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current);
      player.current?.pause();
    },
    [],
  );

  const follow = () => {
    const audio = player.current;
    if (!audio) return;
    setPosition(audio.currentTime * 1000);
    if (!audio.paused) frame.current = requestAnimationFrame(follow);
  };

  const ensurePlayer = async () => {
    if (player.current) return player.current;
    setWaiting(true);
    try {
      const audio = new Audio(await load());
      audio.onloadedmetadata = () => {
        if (Number.isFinite(audio.duration)) setMeasured(audio.duration * 1000);
      };
      audio.onplay = () => {
        setPlaying(true);
        frame.current = requestAnimationFrame(follow);
      };
      audio.onpause = () => {
        setPlaying(false);
        cancelAnimationFrame(frame.current);
      };
      audio.onended = () => {
        setPlaying(false);
        setPosition(0);
      };
      audio.onerror = () => setFailed(true);
      player.current = audio;
      return audio;
    } finally {
      setWaiting(false);
    }
  };

  const toggle = async () => {
    setFailed(false);
    try {
      const audio = await ensurePlayer();
      if (audio.paused) await audio.play();
      else audio.pause();
    } catch {
      setFailed(true);
    }
  };

  const seekTo = async (fraction: number) => {
    if (duration <= 0) return;
    setPosition(fraction * duration);
    try {
      const audio = await ensurePlayer();
      audio.currentTime = (fraction * duration) / 1000;
      if (audio.paused) await audio.play();
    } catch {
      setFailed(true);
    }
  };

  const onBarsClick = (event: MouseEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    void seekTo(Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)));
  };
  const onBarsKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === 'ArrowRight' ? 0.05 : event.key === 'ArrowLeft' ? -0.05 : 0;
    if (!step) return;
    event.preventDefault();
    void seekTo(Math.min(1, Math.max(0, progress + step)));
  };

  const { transcriptStatus, transcript } = part;
  return (
    <div className="w-72 max-w-[85%] rounded-2xl rounded-br-md bg-primary px-3 py-2.5 text-primary-foreground">
      <div className="flex items-center gap-2.5">
        <button
          type="button"
          onClick={() => void toggle()}
          aria-label={playing ? t('chat.voice.pause') : t('chat.voice.play')}
          className="grid size-9 shrink-0 place-items-center rounded-full bg-primary-foreground/12 outline-none transition-colors duration-200 hover:bg-primary-foreground/20 focus-visible:ring-2 focus-visible:ring-primary-foreground/50"
        >
          {waiting ? (
            <LoaderCircle className="size-4 animate-spin" />
          ) : playing ? (
            <Pause className="size-4 fill-current" />
          ) : (
            <Play className="size-4 translate-x-px fill-current" />
          )}
        </button>
        <div
          role="slider"
          tabIndex={0}
          aria-label={t('chat.voice.seek')}
          aria-valuemin={0}
          aria-valuemax={Math.round(duration / 1000)}
          aria-valuenow={Math.round(position / 1000)}
          aria-valuetext={formatDuration(position)}
          onClick={onBarsClick}
          onKeyDown={onBarsKey}
          className="flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-[2px] rounded outline-none focus-visible:ring-2 focus-visible:ring-primary-foreground/40"
        >
          {bars.map((peak, i) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed bars of a fixed recording
              key={i}
              style={{ height: `${Math.max(12, peak * 100)}%` }}
              className={cn(
                'flex-1 rounded-full transition-colors duration-150',
                (i + 0.5) / bars.length <= progress
                  ? 'bg-primary-foreground'
                  : 'bg-primary-foreground/35',
              )}
            />
          ))}
        </div>
        <span className="w-9 shrink-0 text-right font-mono text-[11px] tabular-nums opacity-75">
          {formatDuration(playing || position > 0 ? position : duration)}
        </span>
      </div>
      {failed && <p className="mt-1.5 text-[11px] opacity-75">{t('chat.voice.unplayable')}</p>}
      <div className="mt-1.5 border-t border-primary-foreground/12 pt-1.5 text-[12px]">
        {transcriptStatus === 'pending' && (
          <p className="shimmer-text opacity-80">{t('chat.voice.transcribing')}</p>
        )}
        {(transcriptStatus === 'failed' || (transcriptStatus === 'done' && !transcript)) && (
          <p className="flex flex-wrap items-center gap-x-2 opacity-75">
            {transcriptStatus === 'failed' ? t('chat.voice.failed') : t('chat.voice.silent')}
            <button
              type="button"
              onClick={() => retry.mutate()}
              disabled={retry.isPending}
              className="inline-flex items-center gap-1 font-medium underline-offset-2 hover:underline disabled:opacity-50"
            >
              <RotateCw className={cn('size-3', retry.isPending && 'animate-spin')} />
              {t('chat.voice.retry')}
            </button>
          </p>
        )}
        {transcriptStatus === 'done' && transcript && (
          <>
            <button
              type="button"
              onClick={() => setOpen((value) => !value)}
              aria-expanded={open}
              className="flex items-center gap-1 font-medium opacity-80 transition-opacity hover:opacity-100"
            >
              {t('chat.voice.transcript')}
              <ChevronDown
                className={cn('size-3.5 transition-transform duration-200', open && 'rotate-180')}
              />
            </button>
            <AnimatePresence initial={false}>
              {open && (
                <motion.p
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.2 }}
                  className="overflow-hidden whitespace-pre-wrap break-words pt-1 text-[13.5px] leading-relaxed"
                >
                  {transcript}
                </motion.p>
              )}
            </AnimatePresence>
          </>
        )}
      </div>
    </div>
  );
}
