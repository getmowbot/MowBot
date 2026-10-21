import type { VaultField, VaultItem, VaultKind, VaultPolicy } from '@mowbot/contract';
import { springs } from '@mowbot/design';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  Bot as BotIcon,
  Check,
  ChevronRight,
  Cookie,
  Copy,
  Globe,
  Hand,
  KeyRound,
  LockKeyhole,
  type LucideIcon,
  Monitor,
  Play,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { motion } from 'motion/react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BotAvatar } from '../components/bot-avatar';
import { StatusDot } from '../components/computer-status';
import { Button } from '../components/ui/button';
import { Dialog } from '../components/ui/dialog';
import { FormError, Input, Label, SecretInput, Select, Textarea } from '../components/ui/form';
import { Switch } from '../components/ui/switch';
import { api, problemMessage } from '../lib/auth';
import { Reveal, reveal, stagger } from '../lib/motion';
import { useBots, useComputer, useComputerAction, useComputers } from '../lib/queries';
import { cn, timeAgo } from '../lib/utils';
import {
  byKind,
  detailLabel,
  fieldsOf,
  labelsOf,
  placeholderOf,
  setVaultItem,
  useComputerSites,
  useVault,
  useVaultEvents,
  VAULT_KINDS,
  valuesOf,
} from '../lib/vault';

const KIND_ICON: Record<VaultKind, LucideIcon> = {
  session: Cookie,
  login: KeyRound,
  secret: LockKeyhole,
};

/** The order of the "add" choices: typed values first, then a capture from a PC. */
const ADD_KINDS = ['login', 'secret', 'session'] as const satisfies readonly VaultKind[];

/** What a stored value looks like: it never comes back from the hub. */
const MASKED = '••••••••';

const linkStyle =
  'flex items-center gap-1.5 rounded-lg border border-border-strong px-2.5 py-1.5 text-muted-foreground transition-colors hover:text-foreground';

/** A computer's name; "deleted" once the list is known and the computer is not in it. */
function usePcName() {
  const { t } = useTranslation();
  const computers = useComputers();
  return (computerId: string | null): string => {
    if (!computerId) return t('vault.deletedPc');
    const pc = computers.data?.find((c) => c.id === computerId);
    return pc?.name ?? (computers.data ? t('vault.deletedPc') : '');
  };
}

/** A stored value and the placeholder bots write to use it; a click copies the placeholder. */
function PlaceholderChip({ item, field }: { item: VaultItem; field: VaultField }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const text = placeholderOf(item.ref, field);
  return (
    <button
      type="button"
      onClick={() =>
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1_500);
        })
      }
      title={t('vault.copy')}
      aria-label={t('vault.copyNamed', { placeholder: text })}
      className="flex max-w-full items-center gap-1.5 rounded-full border border-border-strong px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-white/20 hover:text-foreground"
    >
      <span className="shrink-0 text-foreground/90">{t(`vault.fields.${field}`)}</span>
      <code className="truncate font-mono text-faint">{text}</code>
      {copied ? (
        <Check className="size-3 shrink-0 text-primary" />
      ) : (
        <Copy className="size-3 shrink-0" />
      )}
    </button>
  );
}

function VaultRow({ item, onOpen }: { item: VaultItem; onOpen(): void }) {
  const { t } = useTranslation();
  const bots = useBots();
  const pcName = usePcName();
  const Icon = KIND_ICON[item.kind];
  const creator = item.createdByBotId
    ? bots.data?.find((b) => b.id === item.createdByBotId)
    : undefined;
  const meta = [
    item.sites.join(', '),
    item.kind === 'session' && pcName(item.computerId),
    item.kind === 'session' &&
      item.capturedAt &&
      t('vault.capturedAgo', { time: timeAgo(item.capturedAt) }),
    item.session && t('vault.cookies', { count: item.session.cookies }),
  ]
    .filter(Boolean)
    .join(' · ');
  const fields = fieldsOf(item.kind).filter((field) => item.fields.includes(field));

  return (
    <motion.li variants={reveal} className="py-3">
      <button
        type="button"
        onClick={onOpen}
        className="group flex w-full items-start gap-3 text-left"
      >
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-white/[0.05]">
          <Icon className="size-4 text-muted-foreground" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="truncate font-medium">{item.service}</span>
            {item.account && (
              <span className="truncate text-sm text-muted-foreground">{item.account}</span>
            )}
            {item.policy === 'ask' && (
              <span className="shrink-0 rounded-full border border-border-strong px-1.5 text-[10px] text-muted-foreground">
                {t('vault.ask')}
              </span>
            )}
          </span>
          {meta && <span className="block truncate text-xs text-muted-foreground">{meta}</span>}
          {(creator || item.lastUsedAt) && (
            <span className="mt-0.5 flex items-center gap-1 text-[11px] text-faint">
              {creator && (
                <>
                  <BotAvatar seed={creator.avatarSeed} size={12} />
                  {t('vault.savedBy', { name: creator.name })}
                </>
              )}
              {creator && item.lastUsedAt && ' · '}
              {item.lastUsedAt && t('vault.lastUsed', { time: timeAgo(item.lastUsedAt) })}
            </span>
          )}
        </span>
        <ChevronRight className="mt-2.5 size-4 shrink-0 text-faint transition-colors group-hover:text-foreground" />
      </button>
      {fields.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5 pl-12">
          {fields.map((field) => (
            <PlaceholderChip key={field} item={item} field={field} />
          ))}
        </div>
      )}
    </motion.li>
  );
}

/** Service, account, sites and notes, shared by every form of the page. */
function LabelFields({ id, item }: { id: string; item?: VaultItem }) {
  const { t } = useTranslation();
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-service`}>{t('vault.service')}</Label>
          <Input
            id={`${id}-service`}
            name="service"
            required
            maxLength={100}
            autoFocus={!item}
            defaultValue={item?.service}
            placeholder="Google"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-account`}>{t('vault.account')}</Label>
          <Input
            id={`${id}-account`}
            name="account"
            maxLength={200}
            autoComplete="off"
            defaultValue={item?.account ?? ''}
            placeholder={t('vault.accountPlaceholder')}
          />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-sites`}>{t('vault.sites')}</Label>
        <Input
          id={`${id}-sites`}
          name="sites"
          autoComplete="off"
          defaultValue={item?.sites.join(', ')}
          placeholder="google.com, accounts.google.com"
        />
        <p className="text-xs text-faint">{t('vault.sitesHint')}</p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-notes`}>{t('vault.notes')}</Label>
        <Textarea
          id={`${id}-notes`}
          name="notes"
          rows={2}
          maxLength={2000}
          defaultValue={item?.notes ?? ''}
          placeholder={t('vault.notesPlaceholder')}
        />
      </div>
    </>
  );
}

function PolicySwitch({
  value,
  onChange,
}: {
  value: VaultPolicy;
  onChange(value: VaultPolicy): void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-start gap-3">
      <span className="pt-0.5">
        <Switch
          checked={value === 'ask'}
          onChange={() => onChange(value === 'ask' ? 'auto' : 'ask')}
          label={t('vault.policy')}
        />
      </span>
      <span>
        <span className="block text-sm">{t('vault.policy')}</span>
        <span className="block text-xs text-muted-foreground">{t('vault.policyHint')}</span>
      </span>
    </div>
  );
}

/** Masked inputs for the values of a login or a secret; empty ones keep what is stored. */
function ValueFields({
  id,
  kind,
  item,
  removed,
  onToggle,
}: {
  id: string;
  kind: VaultKind;
  item?: VaultItem;
  removed?: ReadonlySet<VaultField>;
  onToggle?(field: VaultField): void;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3">
      <div>
        <p className="text-[13px] font-medium text-muted-foreground">{t('vault.values')}</p>
        <p className="text-xs text-faint">{item ? t('vault.valuesKeep') : t('vault.valuesHint')}</p>
      </div>
      {fieldsOf(kind).map((field) => {
        const stored = item?.fields.includes(field) ?? false;
        const gone = removed?.has(field) ?? false;
        return (
          <div key={field} className="space-y-1.5">
            <Label htmlFor={`${id}-${field}`}>{t(`vault.fields.${field}`)}</Label>
            <div className="flex gap-2">
              <SecretInput
                id={`${id}-${field}`}
                name={field}
                disabled={gone}
                required={!item && kind === 'secret'}
                maxLength={field === 'password' || field === 'value' ? 10_000 : 500}
                placeholder={gone ? t('vault.willRemove') : stored ? MASKED : t('vault.empty')}
              />
              {kind === 'login' && stored && onToggle && (
                <Button variant="ghost" className="h-10" onClick={() => onToggle(field)}>
                  {gone ? t('vault.keepValue') : t('vault.remove')}
                </Button>
              )}
            </div>
            {field === 'totp' && <p className="text-xs text-faint">{t('vault.totpHint')}</p>}
          </div>
        );
      })}
    </div>
  );
}

/** Where a session comes from, and a fresh capture while that PC is on. */
function SessionSource({ item }: { item: VaultItem }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const computers = useComputers();
  const pcName = usePcName();
  const pc = computers.data?.find((c) => c.id === item.computerId);
  const site = item.sites[0];
  const refresh = useMutation({
    mutationFn: async () => {
      const { data, error } = await api.POST('/api/v1/vault/sessions', {
        body: { computerId: item.computerId as string, site: site as string },
      });
      if (error || !data) throw error;
      return data;
    },
    onSuccess: (updated) => setVaultItem(queryClient, updated),
  });
  const captured = [
    item.capturedAt && t('vault.capturedAgo', { time: timeAgo(item.capturedAt) }),
    item.session && t('vault.cookies', { count: item.session.cookies }),
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border-strong px-3 py-2.5">
      <Monitor className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-sm">
          <span className="truncate">
            {t('vault.sessionFrom', { pc: pcName(item.computerId) })}
          </span>
          {pc && <StatusDot status={pc.status} />}
        </p>
        {captured && <p className="text-xs text-muted-foreground">{captured}</p>}
      </div>
      {pc?.status === 'running' && site && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => refresh.mutate()}
          disabled={refresh.isPending}
        >
          <RefreshCw className="size-3.5" />{' '}
          {refresh.isPending ? t('vault.reading') : t('vault.refresh')}
        </Button>
      )}
      {pc && <p className="basis-full text-xs text-faint">{t('vault.autoRefresh')}</p>}
      {refresh.isError && (
        <p role="alert" className="basis-full text-xs text-destructive">
          {problemMessage(refresh.error, t('vault.sessionNotSaved'))}
        </p>
      )}
    </div>
  );
}

/** Bots the user allowed to use the entry, each with a way to take it back. */
function Grants({ item }: { item: VaultItem }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const bots = useBots();
  const revoke = useMutation({
    mutationFn: async (botId: string) => {
      const { data, error } = await api.DELETE('/api/v1/vault/items/{id}/grants/{botId}', {
        params: { path: { id: item.id, botId } },
      });
      if (error || !data) throw error;
      return data;
    },
    onSuccess: (updated) => setVaultItem(queryClient, updated),
    onError: (err) => alert(problemMessage(err, t('common.actionFailed'))),
  });
  if (item.policy === 'auto' && item.grantedBotIds.length === 0) return null;
  return (
    <div className="space-y-2">
      <p className="text-[13px] font-medium text-muted-foreground">{t('vault.granted')}</p>
      {item.grantedBotIds.length === 0 ? (
        <p className="text-xs text-faint">{t('vault.grantedNone')}</p>
      ) : (
        <ul className="space-y-1">
          {item.grantedBotIds.map((botId) => {
            const bot = bots.data?.find((b) => b.id === botId);
            const name = bot?.name ?? t('vault.deletedBot');
            return (
              <li key={botId} className="flex items-center gap-2.5 text-sm">
                <BotAvatar seed={bot?.avatarSeed ?? botId} size={22} title={name} />
                <span className="min-w-0 flex-1 truncate">{name}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => revoke.mutate(botId)}
                  disabled={revoke.isPending}
                  aria-label={t('vault.revokeNamed', { name })}
                >
                  {t('vault.revoke')}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Captures, uses, requests and decisions, newest first. */
function History({ item }: { item: VaultItem }) {
  const { t } = useTranslation();
  const events = useVaultEvents(item.id);
  const bots = useBots();
  const pcName = usePcName();
  return (
    <section className="space-y-2 border-t border-border pt-4">
      <h3 className="text-[13px] font-medium text-muted-foreground">{t('vault.history')}</h3>
      {events.isPending ? (
        <p className="text-xs text-faint">{t('common.loading')}</p>
      ) : !events.data?.length ? (
        <p className="text-xs text-faint">{t('vault.historyEmpty')}</p>
      ) : (
        <ul className="max-h-64 space-y-1.5 overflow-y-auto pr-1">
          {events.data.map((event) => {
            const bot = event.botId ? bots.data?.find((b) => b.id === event.botId) : undefined;
            const who = event.botId ? (bot?.name ?? t('vault.deletedBot')) : null;
            const context = [
              who,
              event.computerId && pcName(event.computerId),
              event.detail && detailLabel(event.detail),
            ].filter(Boolean);
            return (
              <li key={event.id} className="flex items-start gap-2 text-xs">
                {event.botId ? (
                  <BotAvatar seed={bot?.avatarSeed ?? event.botId} size={16} />
                ) : (
                  <span className="mx-[5px] mt-1.5 size-1.5 shrink-0 rounded-full bg-white/25" />
                )}
                <span className="min-w-0 flex-1">
                  <span
                    className={cn(
                      'font-medium',
                      event.action === 'denied' ? 'text-destructive' : 'text-foreground/90',
                    )}
                  >
                    {t(`vault.actions.${event.action}`)}
                  </span>
                  {context.length > 0 && (
                    <span className="text-muted-foreground"> · {context.join(' · ')}</span>
                  )}
                </span>
                <span className="shrink-0 text-faint">{timeAgo(event.createdAt)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function VaultItemForm({ item, onDone }: { item: VaultItem; onDone(): void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [policy, setPolicy] = useState<VaultPolicy>(item.policy);
  const [removed, setRemoved] = useState<ReadonlySet<VaultField>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const id = `vault-${item.id}`;
  const save = useMutation({
    mutationFn: async (form: FormData) => {
      const { data, error } = await api.PATCH('/api/v1/vault/items/{id}', {
        params: { path: { id: item.id } },
        body: { ...labelsOf(form), policy, ...valuesOf(form, fieldsOf(item.kind), removed) },
      });
      if (error || !data) throw error;
      return data;
    },
    onSuccess: (updated) => {
      setVaultItem(queryClient, updated);
      onDone();
    },
    onError: (err) => setError(problemMessage(err, t('vault.notSaved'))),
  });
  const remove = useMutation({
    mutationFn: async () => {
      const { error } = await api.DELETE('/api/v1/vault/items/{id}', {
        params: { path: { id: item.id } },
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.setQueryData<VaultItem[]>(['vault'], (list) =>
        list?.filter((i) => i.id !== item.id),
      );
      onDone();
    },
    onError: (err) => setError(problemMessage(err, t('vault.notDeleted'))),
  });
  const toggle = (field: VaultField) =>
    setRemoved((current) => {
      const next = new Set(current);
      if (!next.delete(field)) next.add(field);
      return next;
    });

  return (
    <div className="space-y-5">
      <form
        className="space-y-4"
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          setError(null);
          save.mutate(new FormData(event.currentTarget));
        }}
      >
        {item.kind === 'session' && <SessionSource item={item} />}
        <LabelFields id={id} item={item} />
        <PolicySwitch value={policy} onChange={setPolicy} />
        {item.kind !== 'session' && (
          <ValueFields id={id} kind={item.kind} item={item} removed={removed} onToggle={toggle} />
        )}
        <Grants item={item} />
        <FormError message={error} />
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? t('common.saving') : t('common.save')}
          </Button>
          <Button variant="ghost" onClick={onDone}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="destructive"
            className="ml-auto"
            disabled={remove.isPending}
            onClick={() =>
              confirm(t('vault.confirmDelete', { name: item.service })) && remove.mutate()
            }
          >
            <Trash2 className="size-3.5" /> {t('common.delete')}
          </Button>
        </div>
      </form>
      <History item={item} />
    </div>
  );
}

function NewValueForm({ kind, onDone }: { kind: 'login' | 'secret'; onDone(): void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [policy, setPolicy] = useState<VaultPolicy>('auto');
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: async (form: FormData) => {
      const labels = { ...labelsOf(form), policy };
      const values = valuesOf(form, fieldsOf(kind));
      const { data, error } = await api.POST('/api/v1/vault/items', {
        body:
          kind === 'login'
            ? {
                kind,
                ...labels,
                username: values.username ?? undefined,
                password: values.password ?? undefined,
                totp: values.totp ?? undefined,
              }
            : { kind, ...labels, value: values.value ?? '' },
      });
      if (error || !data) throw error;
      return data;
    },
    onSuccess: (item) => {
      setVaultItem(queryClient, item);
      onDone();
    },
    onError: (err) => setError(problemMessage(err, t('vault.notCreated'))),
  });
  return (
    <form
      className="space-y-4"
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        setError(null);
        const form = new FormData(event.currentTarget);
        if (kind === 'login' && Object.keys(valuesOf(form, fieldsOf(kind))).length === 0) {
          setError(t('problems.empty_login'));
          return;
        }
        create.mutate(form);
      }}
    >
      <LabelFields id={`vault-new-${kind}`} />
      <ValueFields id={`vault-new-${kind}`} kind={kind} />
      <PolicySwitch value={policy} onChange={setPolicy} />
      <FormError message={error} />
      <div className="flex gap-2">
        <Button type="submit" disabled={create.isPending}>
          {create.isPending ? t('common.saving') : t('vault.create')}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  );
}

/** Saves a site's session from a computer's Chrome: pick the PC (on), then the site. */
function NewSessionForm({ onDone }: { onDone(): void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const computers = useComputers();
  const list = computers.data ?? [];
  const [picked, setPicked] = useState<string | null>(null);
  const listed =
    list.find((c) => c.id === picked) ?? list.find((c) => c.status === 'running') ?? list[0];
  // The single computer query polls while it starts.
  const pc = useComputer(listed?.id).data ?? listed;
  const running = pc?.status === 'running';
  const sites = useComputerSites(pc?.id ?? null, running);
  const power = useComputerAction(pc?.id);
  const [site, setSite] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string | null>(null);
  const entries = sites.data ?? [];
  const needle = filter.trim().toLowerCase();
  const shown = needle ? entries.filter((entry) => entry.site.includes(needle)) : entries;
  const chosen = running ? entries.find((entry) => entry.site === site) : undefined;
  const save = useMutation({
    mutationFn: async (form: FormData) => {
      const value = (name: string) => String(form.get(name) ?? '').trim();
      const { data, error } = await api.POST('/api/v1/vault/sessions', {
        body: {
          computerId: pc?.id as string,
          site: chosen?.site as string,
          service: value('service') || undefined,
          account: value('account') || undefined,
        },
      });
      if (error || !data) throw error;
      return data;
    },
    onSuccess: (item) => {
      setVaultItem(queryClient, item);
      void queryClient.invalidateQueries({ queryKey: ['computer-sites', item.computerId] });
      onDone();
    },
    onError: (err) => setError(problemMessage(err, t('vault.sessionNotSaved'))),
  });

  if (computers.isPending) return <p className="text-sm text-faint">{t('common.loading')}</p>;
  if (!pc) return <p className="text-sm text-muted-foreground">{t('vault.noComputers')}</p>;

  return (
    <form
      className="space-y-4"
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        setError(null);
        if (chosen) save.mutate(new FormData(event.currentTarget));
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor="vault-pc">{t('vault.computer')}</Label>
        <Select
          id="vault-pc"
          value={pc.id}
          onChange={(event) => {
            setPicked(event.target.value);
            setSite(null);
            setFilter('');
          }}
        >
          {list.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} — {t(`computer.status.${c.status}`)}
            </option>
          ))}
        </Select>
        <p className="text-xs text-faint">{t('vault.computerHint')}</p>
      </div>

      {!running && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border-strong px-3 py-3">
          <StatusDot status={pc.status} />
          {pc.status === 'starting' || pc.status === 'stopping' ? (
            <p className="shimmer-text min-w-0 flex-1 text-sm">
              {t(`computer.status.${pc.status}`)}
            </p>
          ) : (
            <p className="min-w-0 flex-1 text-sm">{t('vault.pcOff', { pc: pc.name })}</p>
          )}
          {(pc.status === 'stopped' || pc.status === 'error') && (
            <Button size="sm" onClick={() => power.mutate('start')} disabled={power.isPending}>
              <Play className="size-3.5" /> {t('common.turnOn')}
            </Button>
          )}
          {power.isError && (
            <p role="alert" className="basis-full text-xs text-destructive">
              {problemMessage(power.error, t('common.actionFailed'))}
            </p>
          )}
        </div>
      )}

      {running && (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[13px] font-medium text-muted-foreground">
              {t('vault.pickSite')}
            </span>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => void sites.refetch()}
              disabled={sites.isFetching}
              aria-label={t('vault.reloadSites')}
            >
              <RefreshCw className={cn('size-4', sites.isFetching && 'animate-spin')} />
            </Button>
          </div>
          {sites.isPending ? (
            <p className="shimmer-text text-sm">{t('vault.reading')}</p>
          ) : sites.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {problemMessage(sites.error, t('vault.sitesNotRead'))}
            </p>
          ) : entries.length === 0 ? (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">{t('vault.noSites')}</p>
              <Link
                to="/computers/$computerId"
                params={{ computerId: pc.id }}
                onClick={onDone}
                className={cn(linkStyle, 'w-fit text-sm')}
              >
                <Monitor className="size-3.5" /> {t('vault.openDesktop')}
              </Link>
            </div>
          ) : (
            <>
              {entries.length > 6 && (
                <Input
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  placeholder={t('vault.filterSites')}
                  aria-label={t('vault.filterSites')}
                />
              )}
              <ul className="max-h-60 space-y-1 overflow-y-auto pr-1">
                {shown.map((entry) => (
                  <li key={entry.site}>
                    <button
                      type="button"
                      aria-pressed={site === entry.site}
                      onClick={() => setSite(entry.site)}
                      className={cn(
                        'relative flex w-full items-center gap-3 rounded-xl border px-3 py-2 text-left text-sm transition-colors duration-200',
                        site === entry.site
                          ? 'border-primary/50'
                          : 'border-border-strong text-muted-foreground hover:border-white/20',
                      )}
                    >
                      {site === entry.site && (
                        <motion.span
                          layoutId="vault-site"
                          transition={springs.soft}
                          className="absolute inset-0 rounded-xl bg-primary/[0.08]"
                        />
                      )}
                      <Globe className="relative size-4 shrink-0" />
                      <span className="relative min-w-0 flex-1 truncate text-foreground">
                        {entry.site}
                      </span>
                      {entry.itemId && (
                        <span className="relative shrink-0 rounded-full border border-border-strong px-1.5 text-[10px] text-muted-foreground">
                          {t('vault.alreadySaved')}
                        </span>
                      )}
                      <span className="relative shrink-0 text-xs tabular-nums text-faint">
                        {t('vault.cookies', { count: entry.cookies })}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      {chosen && (
        <div key={chosen.site} className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="vault-session-service">{t('vault.service')}</Label>
            <Input
              id="vault-session-service"
              name="service"
              maxLength={100}
              placeholder={t('vault.fromSite')}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="vault-session-account">{t('vault.account')}</Label>
            <Input
              id="vault-session-account"
              name="account"
              maxLength={200}
              autoComplete="off"
              placeholder={t('vault.accountPlaceholder')}
            />
          </div>
        </div>
      )}

      <FormError message={error} />
      <div className="flex gap-2">
        <Button type="submit" disabled={!chosen || save.isPending}>
          {save.isPending
            ? t('vault.reading')
            : chosen?.itemId
              ? t('vault.refreshSession')
              : t('vault.saveSession')}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  );
}

function AddVaultItem({ onDone }: { onDone(): void }) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<(typeof ADD_KINDS)[number]>('login');
  return (
    <div className="space-y-5">
      <div className="grid gap-2 sm:grid-cols-3">
        {ADD_KINDS.map((option) => {
          const Icon = KIND_ICON[option];
          return (
            <button
              key={option}
              type="button"
              aria-pressed={kind === option}
              onClick={() => setKind(option)}
              className={cn(
                'relative rounded-xl border px-3 py-2.5 text-left transition-colors duration-200',
                kind === option
                  ? 'border-primary/50'
                  : 'border-border-strong text-muted-foreground hover:border-white/20',
              )}
            >
              {kind === option && (
                <motion.span
                  layoutId="vault-kind"
                  transition={springs.soft}
                  className="absolute inset-0 rounded-xl bg-primary/[0.08]"
                />
              )}
              <span className="relative flex items-center gap-2 text-sm font-medium text-foreground">
                <Icon className="size-4 shrink-0" /> {t(`vault.addKinds.${option}`)}
              </span>
              <span className="relative block text-xs text-muted-foreground">
                {t(`vault.addHints.${option}`)}
              </span>
            </button>
          );
        })}
      </div>
      {kind === 'session' ? (
        <NewSessionForm onDone={onDone} />
      ) : (
        <NewValueForm key={kind} kind={kind} onDone={onDone} />
      )}
    </div>
  );
}

/** How entries get in: a takeover, a bot, or this page. */
function EmptyVault() {
  const { t } = useTranslation();
  const ways: [LucideIcon, string][] = [
    [Hand, t('vault.emptyTakeover')],
    [BotIcon, t('vault.emptyBots')],
    [Plus, t('vault.emptyHere')],
  ];
  return (
    <Reveal
      delay={0.05}
      className="rounded-2xl border border-dashed border-border-strong px-6 py-10"
    >
      <p className="text-center font-medium">{t('vault.emptyTitle')}</p>
      <ul className="mx-auto mt-4 max-w-md space-y-2.5">
        {ways.map(([Icon, text]) => (
          <li key={text} className="flex gap-3 text-sm text-muted-foreground">
            <Icon className="mt-0.5 size-4 shrink-0 text-faint" />
            {text}
          </li>
        ))}
      </ul>
    </Reveal>
  );
}

/** The vault: what bots sign in with, grouped by kind, without ever showing a value. */
export function VaultPage() {
  const { t } = useTranslation();
  const vault = useVault();
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const items = vault.data ?? [];
  const groups = byKind(items);
  const opened = items.find((item) => item.id === openId);
  const OpenedIcon = opened ? KIND_ICON[opened.kind] : null;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Reveal className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 basis-full sm:basis-0 sm:flex-1">
          <h1 className="text-2xl font-semibold tracking-tight">{t('shell.vault')}</h1>
          <p className="text-sm text-muted-foreground">{t('vault.subtitle')}</p>
        </div>
        <Button onClick={() => setAdding(true)}>
          <Plus className="size-4" /> {t('vault.add')}
        </Button>
      </Reveal>

      {vault.isPending && <p className="text-sm text-muted-foreground">{t('common.loading')}</p>}
      {vault.isError && <p className="text-sm text-destructive">{t('vault.loadFailed')}</p>}
      {vault.isSuccess && items.length === 0 && <EmptyVault />}

      {VAULT_KINDS.filter((kind) => groups[kind].length > 0).map((kind, index) => (
        <Reveal key={kind} delay={0.05 * (index + 1)} className="glass rounded-2xl px-4 py-2">
          <div className="pt-2">
            <h2 className="flex items-baseline gap-2 font-medium">
              {t(`vault.kinds.${kind}`)}
              <span className="text-xs tabular-nums text-faint">{groups[kind].length}</span>
            </h2>
            <p className="text-xs text-faint">{t(`vault.kindHints.${kind}`)}</p>
          </div>
          <motion.ul
            initial="hidden"
            animate="shown"
            variants={stagger}
            className="divide-y divide-border"
          >
            {groups[kind].map((item) => (
              <VaultRow key={item.id} item={item} onOpen={() => setOpenId(item.id)} />
            ))}
          </motion.ul>
        </Reveal>
      ))}

      <Dialog open={adding} onClose={() => setAdding(false)} title={t('vault.addTitle')}>
        <AddVaultItem onDone={() => setAdding(false)} />
      </Dialog>
      <Dialog
        open={Boolean(opened)}
        onClose={() => setOpenId(null)}
        className="max-w-xl"
        title={
          opened && OpenedIcon ? (
            <span className="flex items-center gap-2.5">
              <OpenedIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate">{opened.service}</span>
            </span>
          ) : (
            ''
          )
        }
        description={
          opened && [t(`vault.kind.${opened.kind}`), opened.account].filter(Boolean).join(' · ')
        }
      >
        {opened && <VaultItemForm key={opened.id} item={opened} onDone={() => setOpenId(null)} />}
      </Dialog>
    </div>
  );
}
