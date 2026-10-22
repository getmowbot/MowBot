import type { Initiative, Memory, MemoryKind } from '@mowbot/contract';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Check, Pencil, Plus, Trash2, X } from 'lucide-react';
import { motion } from 'motion/react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BotAvatar } from '../components/bot-avatar';
import { Button } from '../components/ui/button';
import { Card, FormError, Input, Select } from '../components/ui/form';
import { api, problemMessage } from '../lib/auth';
import { Reveal, reveal, stagger } from '../lib/motion';
import { useBots } from '../lib/queries';

const KINDS: MemoryKind[] = ['profile', 'preference', 'event', 'note'];

function useMemories() {
  return useQuery({
    queryKey: ['memories'],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/memories');
      if (error || !data) throw error;
      return data.items;
    },
  });
}

function useInitiatives() {
  return useQuery({
    queryKey: ['initiatives'],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/initiatives');
      if (error || !data) throw error;
      return data.items;
    },
  });
}

const when = (iso: string, locale: string) =>
  new Date(iso).toLocaleString(locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

/** `<input type="datetime-local">` speaks local time without a zone. */
const toLocalInput = (iso: string | null) => {
  if (!iso) return '';
  const date = new Date(iso);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

/** One thing the bots know: who heard it, the fact, and a way to fix or forget it. */
function MemoryRow({ memory }: { memory: Memory }) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const bots = useBots();
  const source = bots.data?.find((bot) => bot.id === memory.sourceBotId);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(memory.text);
  const [at, setAt] = useState(toLocalInput(memory.at));
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['memories'] });
  const save = useMutation({
    mutationFn: async () => {
      const { error } = await api.PATCH('/api/v1/memories/{id}', {
        params: { path: { id: memory.id } },
        body: {
          text: text.trim(),
          ...(memory.kind === 'event' && at ? { at: new Date(at).toISOString() } : {}),
        },
      });
      if (error) throw error;
    },
    onSuccess: () => {
      setEditing(false);
      void refresh();
    },
  });
  const forget = useMutation({
    mutationFn: async () => {
      const { error } = await api.DELETE('/api/v1/memories/{id}', {
        params: { path: { id: memory.id } },
      });
      if (error) throw error;
    },
    onSuccess: () => void refresh(),
  });
  return (
    <motion.li variants={reveal} className="group flex items-start gap-3 py-2.5">
      {source ? (
        <BotAvatar seed={source.avatarSeed} size={24} className="mt-0.5 shrink-0" />
      ) : (
        <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-ink/[0.06] text-[11px] font-semibold text-muted-foreground">
          {t('memory.you')}
        </span>
      )}
      <div className="min-w-0 flex-1">
        {editing ? (
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(event: FormEvent) => {
              event.preventDefault();
              if (text.trim()) save.mutate();
            }}
          >
            <Input
              value={text}
              onChange={(event) => setText(event.target.value)}
              maxLength={500}
              autoFocus
              className="h-9 min-w-0 flex-1"
            />
            {memory.kind === 'event' && (
              <Input
                type="datetime-local"
                value={at}
                onChange={(event) => setAt(event.target.value)}
                className="h-9 w-52"
              />
            )}
            <Button
              type="submit"
              size="icon"
              disabled={save.isPending}
              aria-label={t('common.save')}
            >
              <Check className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => {
                setEditing(false);
                setText(memory.text);
              }}
              aria-label={t('common.cancel')}
            >
              <X className="size-4" />
            </Button>
          </form>
        ) : (
          <>
            <p className="text-sm leading-relaxed">{memory.text}</p>
            <p className="text-xs text-faint">
              {memory.at && (
                <span className="mr-2 font-medium text-muted-foreground">
                  {when(memory.at, i18n.language)}
                </span>
              )}
              {source ? t('memory.heardBy', { name: source.name }) : t('memory.byYou')}
            </p>
          </>
        )}
      </div>
      {!editing && (
        <div className="flex shrink-0 gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            onClick={() => setEditing(true)}
            aria-label={t('memory.edit')}
          >
            <Pencil className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            disabled={forget.isPending}
            onClick={() => forget.mutate()}
            aria-label={t('memory.forget')}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      )}
    </motion.li>
  );
}

/** Tell every bot something about yourself. */
function AddMemory() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<MemoryKind>('profile');
  const [text, setText] = useState('');
  const [at, setAt] = useState('');
  const add = useMutation({
    mutationFn: async () => {
      const { error } = await api.POST('/api/v1/memories', {
        body: {
          kind,
          text: text.trim(),
          ...(kind === 'event' && at ? { at: new Date(at).toISOString() } : {}),
        },
      });
      if (error) throw error;
    },
    onSuccess: () => {
      setText('');
      setAt('');
      void queryClient.invalidateQueries({ queryKey: ['memories'] });
    },
  });
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        if (text.trim() && (kind !== 'event' || at)) add.mutate();
      }}
    >
      <Select
        value={kind}
        onChange={(event) => setKind(event.target.value as MemoryKind)}
        className="h-9 w-40"
        aria-label={t('memory.kind')}
      >
        {KINDS.map((option) => (
          <option key={option} value={option}>
            {t(`memory.kinds.${option}`)}
          </option>
        ))}
      </Select>
      <Input
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder={t(`memory.placeholders.${kind}`)}
        maxLength={500}
        className="h-9 min-w-0 flex-1"
      />
      {kind === 'event' && (
        <Input
          type="datetime-local"
          value={at}
          onChange={(event) => setAt(event.target.value)}
          className="h-9 w-52"
          aria-label={t('memory.when')}
        />
      )}
      <Button type="submit" size="sm" disabled={add.isPending || !text.trim()}>
        <Plus className="size-3.5" /> {t('memory.add')}
      </Button>
      <FormError message={add.isError ? problemMessage(add.error, t('memory.notSaved')) : null} />
    </form>
  );
}

/** What the bots planned to do on their own, and when; the user may cancel it. */
function Initiatives({ items }: { items: Initiative[] }) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const bots = useBots();
  const cancel = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await api.DELETE('/api/v1/initiatives/{id}', {
        params: { path: { id } },
      });
      if (error) throw error;
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['initiatives'] }),
  });
  return (
    <Card className="space-y-3">
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-ink/[0.05]">
          <CalendarClock className="size-4 text-muted-foreground" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="font-medium">{t('memory.planned')}</h2>
          <p className="text-sm text-muted-foreground">{t('memory.plannedHint')}</p>
        </div>
      </div>
      {items.length === 0 ? (
        <p className="text-sm text-faint">{t('memory.nothingPlanned')}</p>
      ) : (
        <ul className="divide-y divide-border">
          {items.map((item) => {
            const bot = bots.data?.find((b) => b.id === item.botId);
            return (
              <li key={item.id} className="group flex items-start gap-3 py-2.5">
                {bot && <BotAvatar seed={bot.avatarSeed} size={24} className="mt-0.5 shrink-0" />}
                <div className="min-w-0 flex-1">
                  <p className="text-sm">{item.what}</p>
                  <p className="text-xs text-faint">
                    <span className="font-medium text-muted-foreground">
                      {when(item.at, i18n.language)}
                    </span>
                    {bot && ` · ${bot.name}`}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={cancel.isPending}
                  onClick={() => cancel.mutate(item.id)}
                  className="opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
                >
                  {t('memory.cancel')}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

/** What the bots know about the user, by kind, and what they planned for them. */
export function MemoryPage() {
  const { t } = useTranslation();
  const memories = useMemories();
  const initiatives = useInitiatives();
  const items = memories.data ?? [];
  const now = Date.now();
  const groups = KINDS.map((kind) => {
    const of = items.filter((m) => m.kind === kind);
    // Events: what is coming first, then the past ones.
    if (kind === 'event') {
      of.sort((a, b) => {
        const [x, y] = [new Date(a.at ?? 0).getTime(), new Date(b.at ?? 0).getTime()];
        return (x < now ? 1 : 0) - (y < now ? 1 : 0) || x - y;
      });
    }
    return { kind, items: of };
  });
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Reveal>
        <h1 className="text-2xl font-semibold tracking-tight">{t('memory.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('memory.subtitle')}</p>
      </Reveal>

      <Card className="space-y-2">
        <AddMemory />
      </Card>

      {memories.isSuccess && items.length === 0 && (
        <p className="text-sm text-muted-foreground">{t('memory.empty')}</p>
      )}
      {groups
        .filter((group) => group.items.length > 0)
        .map((group) => (
          <section key={group.kind} className="space-y-2">
            <h2 className="text-xs font-medium uppercase tracking-wide text-faint">
              {t(`memory.kinds.${group.kind}`)}
            </h2>
            <Card className="py-1">
              <motion.ul
                variants={stagger}
                initial="hidden"
                animate="shown"
                className="divide-y divide-border"
              >
                {group.items.map((memory) => (
                  <MemoryRow key={memory.id} memory={memory} />
                ))}
              </motion.ul>
            </Card>
          </section>
        ))}

      <Initiatives items={initiatives.data ?? []} />
    </div>
  );
}
