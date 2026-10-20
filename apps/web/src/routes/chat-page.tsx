import type { Bot, Message, MessagePart } from '@mowbot/contract';
import { springs } from '@mowbot/design';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
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
import { ActivityGroup, type ActivityPart } from '../components/activity';
import { BotAvatar } from '../components/bot-avatar';
import { BotMenu, RenameField } from '../components/bot-menu';
import { StatusBadge } from '../components/computer-status';
import { Markdown } from '../components/markdown';
import { Button } from '../components/ui/button';
import { api, problemMessage } from '../lib/auth';
import { moodOf, statusLabel } from '../lib/bot-mood';
import { reveal } from '../lib/motion';
import {
  useBot,
  useBots,
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
  'Monte une équipe de veille sur l’IA avec deux bots',
  'Ouvre example.com et décris-moi la page',
  'Crée une note de bienvenue dans outputs',
];

const BOT_SUGGESTIONS = [
  'Présente-toi',
  'Où en es-tu de ta mission ?',
  'Que fait ton équipe en ce moment ?',
];

const KIND_LABELS = { chat: 'message', ask: 'question', task: 'tâche' } as const;

/** What another bot (or the user, for a task) gave this bot: a quieter, outlined bubble. */
function IncomingMessage({ message }: { message: Message }) {
  const bots = useBots();
  const from = bots.data?.find((b) => b.id === message.fromBotId);
  const name = from?.name ?? message.fromName ?? 'Toi';
  const text = message.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] space-y-1 rounded-2xl rounded-br-md border border-border-strong bg-white/[0.03] px-4 py-2.5">
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {(from || message.fromName) && <BotAvatar seed={from?.avatarSeed ?? name} size={16} />}
          {from ? (
            <Link
              to={from.isChef ? '/' : '/bots/$botId'}
              params={{ botId: from.id }}
              className="font-medium text-foreground/90 hover:underline"
            >
              {name}
            </Link>
          ) : (
            <span className="font-medium text-foreground/90">{name}</span>
          )}
          <span>· {KIND_LABELS[message.kind]}</span>
        </p>
        <Markdown text={text} className="text-[14.5px]" />
      </div>
    </div>
  );
}

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

type Segment =
  | { kind: 'text'; text: string; index: number }
  | { kind: 'activity'; parts: ActivityPart[]; index: number };

/** Text stays as is; the tool calls and reasoning between two texts become one activity. */
function segments(parts: MessagePart[]): Segment[] {
  const out: Segment[] = [];
  parts.forEach((part, index) => {
    if (part.type === 'text') {
      if (part.text.trim()) out.push({ kind: 'text', text: part.text, index });
      return;
    }
    const tail = out.at(-1);
    if (tail?.kind === 'activity') tail.parts.push(part);
    else out.push({ kind: 'activity', parts: [part], index });
  });
  return out;
}

function BotMessage({ message, bot }: { message: Message; bot: Bot }) {
  const streaming = message.status === 'streaming';
  const blocks = segments(message.parts);
  const empty = blocks.length === 0;
  return (
    <div className="flex gap-3">
      <BotAvatar
        seed={bot.avatarSeed}
        size={30}
        mood={streaming ? moodOf(bot, message) : 'idle'}
        className="shrink-0"
      />
      {/* First lines (24px tall) are centred on the 30px avatar. */}
      <div className="min-w-0 flex-1 space-y-2.5 pt-[3px]">
        {empty && streaming && (
          <p className="shimmer-text text-[14.5px] leading-6">{bot.name} réfléchit…</p>
        )}
        {blocks.map((block, i) => {
          const last = i === blocks.length - 1;
          return block.kind === 'activity' ? (
            <ActivityGroup
              key={`activity-${block.index}`}
              parts={block.parts}
              live={streaming && last}
            />
          ) : (
            <Markdown
              key={`text-${block.index}`}
              text={block.text}
              className={cn(streaming && last && 'streaming')}
            />
          );
        })}
        {message.status === 'error' && (
          <p className="rounded-xl border border-destructive/25 bg-destructive/[0.07] px-3 py-2 text-sm text-destructive">
            {message.errorCode === 'no_model'
              ? 'Aucun modèle configuré : ajoute un fournisseur dans Réglages → Modèles.'
              : message.errorCode === 'hub_restart'
                ? 'Interrompu par un redémarrage du hub.'
                : (message.error ?? 'Une erreur est survenue.')}
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
            ? 'Dis-moi ce que tu veux faire : je travaille sur le PC de l’équipe, je monte des équipes de bots et je dépose les résultats dans vos fichiers.'
            : bot.role}
        </p>
        {!bot.isChef && bot.mission && <p className="text-sm text-faint">{bot.mission}</p>}
      </motion.div>
      <motion.div variants={reveal} className="flex flex-wrap justify-center gap-2">
        {(bot.isChef ? SUGGESTIONS : BOT_SUGGESTIONS).map((suggestion) => (
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
  const [renamingId, setRenamingId] = useState<string | null>(null);
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
            {renamingId === bot.id ? (
              <RenameField bot={bot} onDone={() => setRenamingId(null)} />
            ) : (
              <p
                className="truncate font-semibold leading-tight"
                onDoubleClick={() => setRenamingId(bot.id)}
              >
                {bot.name}
              </p>
            )}
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
          <BotMenu bot={bot} onRename={() => setRenamingId(bot.id)} />
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
                    message.fromBotId || message.fromName || message.kind !== 'chat' ? (
                      <IncomingMessage message={message} />
                    ) : (
                      <UserMessage message={message} />
                    )
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
