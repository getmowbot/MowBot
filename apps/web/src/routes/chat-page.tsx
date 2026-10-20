import type { Bot, Message } from '@mowbot/contract';
import { springs } from '@mowbot/design';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import { ArrowUp, Monitor, PanelRightClose, Power, Sparkles, Square } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import {
  type FormEvent,
  type KeyboardEvent,
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { BotAvatar } from '../components/bot-avatar';
import { StatusBadge } from '../components/computer-status';
import { Markdown } from '../components/markdown';
import { ToolCard } from '../components/tool-card';
import { Button } from '../components/ui/button';
import { api, problemMessage } from '../lib/auth';
import { moodOf, statusLabel } from '../lib/bot-mood';
import { reveal } from '../lib/motion';
import {
  useBot,
  useChef,
  useComputer,
  useComputerAction,
  useMessages,
  useProviders,
} from '../lib/queries';
import { cn } from '../lib/utils';

const DesktopView = lazy(() =>
  import('../components/desktop-view').then((m) => ({ default: m.DesktopView })),
);

const SUGGESTIONS = [
  'Présente-toi et dis-moi ce que tu sais faire',
  'Ouvre example.com et décris-moi la page',
  'Crée une note de bienvenue dans outputs',
  'Quelle version de Python as-tu sur ton PC ?',
];

function UserMessage({ message }: { message: Message }) {
  const text = message.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-primary-foreground text-[14.5px] leading-relaxed">
        {text}
      </div>
    </div>
  );
}

function BotMessage({ message, bot }: { message: Message; bot: Bot }) {
  const streaming = message.status === 'streaming';
  const lastText = message.parts.findLastIndex((p) => p.type === 'text');
  const empty = message.parts.length === 0;
  return (
    <div className="flex gap-3">
      <div className="pt-0.5">
        <BotAvatar
          seed={bot.avatarSeed}
          size={30}
          mood={streaming ? moodOf(bot, message) : 'idle'}
        />
      </div>
      <div className="min-w-0 flex-1 space-y-2.5">
        {empty && streaming && <p className="shimmer-text text-[14.5px]">{bot.name} réfléchit…</p>}
        {message.parts.map((part, index) => {
          const key = part.type === 'tool' ? part.toolCallId : `${part.type}-${index}`;
          if (part.type === 'tool') return <ToolCard key={key} part={part} />;
          if (part.type === 'reasoning') {
            return (
              <details key={key} className="group text-[13px] text-muted-foreground">
                <summary className="cursor-pointer select-none list-none text-faint hover:text-muted-foreground">
                  <span
                    className={cn(
                      streaming && index === message.parts.length - 1 && 'shimmer-text',
                    )}
                  >
                    Raisonnement
                  </span>
                </summary>
                <p className="mt-1.5 whitespace-pre-wrap border-l border-border-strong pl-3">
                  {part.text}
                </p>
              </details>
            );
          }
          return (
            <Markdown
              key={key}
              text={part.text}
              className={cn(streaming && index === lastText && 'streaming')}
            />
          );
        })}
        {message.status === 'error' && (
          <p className="rounded-xl border border-destructive/25 bg-destructive/[0.07] px-3 py-2 text-sm text-destructive">
            {message.error ?? 'Une erreur est survenue.'}
          </p>
        )}
        {message.status === 'stopped' && <p className="text-xs text-faint">Interrompu.</p>}
      </div>
    </div>
  );
}

function EmptyState({ bot, onPick }: { bot: Bot; onPick(text: string): void }) {
  return (
    <motion.div
      initial="hidden"
      animate="shown"
      variants={{ shown: { transition: { staggerChildren: 0.06 } } }}
      className="mx-auto flex max-w-xl flex-col items-center gap-5 py-[8vh] text-center"
    >
      <motion.div variants={reveal}>
        <BotAvatar seed={bot.avatarSeed} size={132} followPointer />
      </motion.div>
      <motion.div variants={reveal} className="space-y-1.5">
        <h1 className="text-2xl font-semibold tracking-tight">
          Salut, je suis {bot.isChef ? 'le Chef' : bot.name}.
        </h1>
        <p className="text-muted-foreground">
          {bot.isChef
            ? 'Dis-moi ce que tu veux faire : je travaille sur le PC de l’équipe et je dépose mes résultats dans vos fichiers.'
            : bot.role}
        </p>
      </motion.div>
      <motion.div variants={reveal} className="flex flex-wrap justify-center gap-2">
        {SUGGESTIONS.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            onClick={() => onPick(suggestion)}
            className="rounded-full border border-border-strong bg-white/[0.02] px-3.5 py-1.5 text-[13px] text-muted-foreground transition-colors duration-200 hover:border-primary/40 hover:bg-primary/[0.06] hover:text-foreground"
          >
            {suggestion}
          </button>
        ))}
      </motion.div>
    </motion.div>
  );
}

function Composer({ bot, onSend }: { bot: Bot; onSend(text: string): void }) {
  const [text, setText] = useState('');
  const area = useRef<HTMLTextAreaElement>(null);
  const queryClient = useQueryClient();
  const working = bot.status === 'working';
  const stop = useMutation({
    mutationFn: () => api.POST('/api/v1/bots/{id}/stop', { params: { path: { id: bot.id } } }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['bots'] }),
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure whenever the text changes
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const value = text.trim();
    if (!value) return;
    onSend(value);
    setText('');
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) submit(event);
  };

  return (
    <form
      onSubmit={submit}
      className="glass flex items-end gap-2 rounded-2xl p-2 transition-[border-color] duration-300 focus-within:border-white/30"
    >
      <textarea
        ref={area}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        rows={1}
        placeholder={`Écris à ${bot.name}…`}
        className="max-h-[220px] min-h-10 flex-1 resize-none bg-transparent px-2.5 py-2 text-[14.5px] leading-relaxed outline-none placeholder:text-faint"
      />
      {working ? (
        <Button
          type="button"
          size="icon"
          variant="outline"
          onClick={() => stop.mutate()}
          aria-label="Arrêter"
        >
          <Square className="size-3.5 fill-current" />
        </Button>
      ) : (
        <Button type="submit" size="icon" disabled={!text.trim()} aria-label="Envoyer">
          <ArrowUp className="size-4" />
        </Button>
      )}
    </form>
  );
}

function ComputerPanel({ computerId, onClose }: { computerId: string; onClose(): void }) {
  const computer = useComputer(computerId);
  const action = useComputerAction(computerId);
  const pc = computer.data;
  return (
    <motion.aside
      initial={{ opacity: 0, x: 24, filter: 'blur(8px)' }}
      animate={{ opacity: 1, x: 0, filter: 'blur(0px)' }}
      exit={{ opacity: 0, x: 24, filter: 'blur(8px)' }}
      transition={springs.soft}
      className="glass fixed inset-x-3 bottom-3 top-16 z-40 flex flex-col gap-3 rounded-2xl p-3 lg:static lg:inset-auto lg:z-auto lg:w-[46%] lg:max-w-3xl lg:rounded-none lg:border-y-0 lg:border-r-0 lg:p-4"
    >
      <div className="flex items-center gap-2">
        <Monitor className="size-4 text-muted-foreground" />
        <span className="flex-1 truncate text-sm font-medium">{pc?.name ?? 'PC'}</span>
        {pc && <StatusBadge status={pc.status} />}
        <Button variant="ghost" size="icon" onClick={onClose} aria-label="Fermer le PC">
          <PanelRightClose className="size-4" />
        </Button>
      </div>
      {pc?.status === 'running' ? (
        <Suspense fallback={null}>
          <DesktopView computerId={computerId} interactive={false} />
        </Suspense>
      ) : (
        <div className="grid aspect-[16/10] place-items-center rounded-lg border border-dashed border-border-strong text-center text-sm text-muted-foreground">
          <div className="space-y-3">
            <p>
              {pc?.status === 'starting'
                ? 'Démarrage du PC…'
                : 'Le PC dort. Il s’allume tout seul quand le bot en a besoin.'}
            </p>
            {(pc?.status === 'stopped' || pc?.status === 'error') && (
              <Button size="sm" variant="outline" onClick={() => action.mutate('start')}>
                <Power className="size-3.5" /> Allumer
              </Button>
            )}
          </div>
        </div>
      )}
      <p className="text-xs text-faint">
        Vue en lecture seule. Pour prendre la main, ouvre le Bureau de l’équipe.
      </p>
    </motion.aside>
  );
}

/** Conversation with a bot: the Chef on `/`, any bot on `/bots/$botId`. */
export function ChatPage() {
  const { botId } = useParams({ strict: false }) as { botId?: string };
  const navigate = useNavigate();
  const chef = useChef();
  const byId = useBot(botId);
  const bot = botId ? byId.data : chef.data;
  const messages = useMessages(bot?.id);
  const providers = useProviders();
  const queryClient = useQueryClient();
  const scroller = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const hydrated = useRef(false);
  const [showPc, setShowPc] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = useMutation({
    mutationFn: async (text: string) => {
      const { data, error } = await api.POST('/api/v1/bots/{id}/messages', {
        params: { path: { id: bot?.id as string } },
        body: { text },
      });
      if (error || !data) throw error;
      return data;
    },
    onMutate: () => {
      stickToBottom.current = true;
      setError(null);
    },
    onSuccess: (message) => {
      queryClient.setQueryData<Message[]>(['messages', message.botId], (list) =>
        list && !list.some((m) => m.id === message.id) ? [...list, message] : list,
      );
    },
    onError: (err) => setError(problemMessage(err, 'Message non envoyé.')),
  });

  // Follow the conversation while the user is at the bottom.
  const items = messages.data ?? [];
  const lastLength = items.at(-1)?.parts.reduce((n, p) => n + ('text' in p ? p.text.length : 1), 0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when a message arrives or grows
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !stickToBottom.current) return;
    el.scrollTo({ top: el.scrollHeight, behavior: hydrated.current ? 'smooth' : 'auto' });
  }, [items.length, lastLength]);
  useEffect(() => {
    if (messages.isSuccess) hydrated.current = true;
  }, [messages.isSuccess]);

  if (!bot) {
    return (
      <div className="grid h-full place-items-center text-sm text-muted-foreground">
        {chef.isPending || byId.isPending ? 'Chargement…' : 'Bot introuvable.'}
      </div>
    );
  }

  const live = items.at(-1)?.status === 'streaming' ? items.at(-1) : undefined;
  const mood = moodOf(bot, live);
  const noModel = providers.isSuccess && (providers.data.length === 0 || !bot.model);

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-border px-4 py-3 md:px-6">
          <BotAvatar seed={bot.avatarSeed} size={44} mood={mood} />
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold leading-tight">{bot.name}</p>
            <p
              className={cn(
                'truncate text-[13px] text-muted-foreground',
                mood !== 'idle' && 'shimmer-text',
              )}
            >
              {bot.model ? `${statusLabel(bot, mood)} · ${bot.model}` : statusLabel(bot, mood)}
            </p>
          </div>
          {bot.computerId && (
            <Button
              variant={showPc ? 'outline' : 'ghost'}
              size="sm"
              onClick={() => setShowPc((v) => !v)}
              aria-pressed={showPc}
            >
              <Monitor className="size-4" /> <span className="hidden sm:inline">Voir le PC</span>
            </Button>
          )}
        </header>

        <div
          ref={scroller}
          onScroll={(event) => {
            const el = event.currentTarget;
            stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 140;
          }}
          className="min-h-0 flex-1 overflow-y-auto"
        >
          <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6 md:px-6">
            {noModel && (
              <motion.div
                variants={reveal}
                initial="hidden"
                animate="shown"
                className="glass flex flex-wrap items-center gap-3 rounded-2xl p-4"
              >
                <Sparkles className="size-5 text-primary" />
                <p className="min-w-0 flex-1 text-sm">
                  Connecte un modèle (Command Code, OpenAI ou compatible) pour réveiller {bot.name}.
                </p>
                <Button size="sm" onClick={() => void navigate({ to: '/settings/models' })}>
                  Connecter un modèle
                </Button>
              </motion.div>
            )}
            {messages.isSuccess && items.length === 0 && (
              <EmptyState bot={bot} onPick={(text) => send.mutate(text)} />
            )}
            <AnimatePresence initial={false}>
              {items.map((message) => (
                <motion.div
                  key={message.id}
                  variants={reveal}
                  initial={hydrated.current ? 'hidden' : false}
                  animate="shown"
                  layout="position"
                  transition={springs.soft}
                >
                  {message.role === 'user' ? (
                    <UserMessage message={message} />
                  ) : (
                    <BotMessage message={message} bot={bot} />
                  )}
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        </div>

        <div className="mx-auto w-full max-w-3xl px-3 pb-3 md:px-6 md:pb-5">
          {error && <p className="mb-2 text-sm text-destructive">{error}</p>}
          <Composer bot={bot} onSend={(text) => send.mutate(text)} />
        </div>
      </div>

      <AnimatePresence>
        {showPc && bot.computerId && (
          <ComputerPanel key="pc" computerId={bot.computerId} onClose={() => setShowPc(false)} />
        )}
      </AnimatePresence>
    </div>
  );
}
