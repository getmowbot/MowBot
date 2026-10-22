import type { McpScope } from '@mowbot/contract';
import { springs } from '@mowbot/design';
import { Check, type LucideIcon } from 'lucide-react';
import { motion } from 'motion/react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useBots, useTeams } from '../lib/queries';
import { cn } from '../lib/utils';
import { BotAvatar, TeamAvatar } from './bot-avatar';

type ScopeKind = McpScope['kind'];
const SCOPE_KINDS: readonly ScopeKind[] = ['all', 'teams', 'bots'];

/** "Tous les bots", "Équipes : Ventes, Support"… */
export function useScopeLabel(scope: McpScope): string {
  const { t } = useTranslation();
  const teams = useTeams();
  const bots = useBots();
  if (scope.kind === 'all') return t('mcp.scope.all');
  const list: { id: string; name: string }[] | undefined =
    scope.kind === 'teams' ? teams.data : bots.data;
  if (!list) return '';
  const names = scope.ids.flatMap((id) => list.find((item) => item.id === id)?.name ?? []);
  if (names.length === 0) return t('mcp.scope.none');
  return t(`mcp.scope.${scope.kind}`, { names: names.join(', ') });
}

/** Mutually exclusive options, as tiles with a gliding highlight. */
export function Choice<T extends string>({
  id,
  value,
  options,
  onChange,
}: {
  id: string;
  value: T;
  options: { value: T; label: string; hint?: string; icon?: LucideIcon }[];
  onChange(value: T): void;
}) {
  return (
    <div className={cn('grid gap-2', options.length > 2 ? 'sm:grid-cols-3' : 'sm:grid-cols-2')}>
      {options.map((option) => {
        const Icon = option.icon;
        const selected = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(option.value)}
            className={cn(
              'relative rounded-xl border px-3 py-2.5 text-left transition-colors duration-200',
              selected
                ? 'border-primary/50'
                : 'border-border-strong text-muted-foreground hover:border-ink/20',
            )}
          >
            {selected && (
              <motion.span
                layoutId={`choice-${id}`}
                transition={springs.soft}
                className="absolute inset-0 rounded-xl bg-primary/[0.08]"
              />
            )}
            <span className="relative flex items-center gap-2 text-sm font-medium text-foreground">
              {Icon && <Icon className="size-4 shrink-0" />} {option.label}
            </span>
            {option.hint && (
              <span className="relative block text-xs text-muted-foreground">{option.hint}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** A pill that toggles one team or bot in or out of a selection. */
export function Chip({
  selected,
  onToggle,
  children,
}: {
  selected: boolean;
  onToggle(): void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onToggle}
      className={cn(
        'flex items-center gap-1.5 rounded-full border py-1 pl-1 pr-2.5 text-xs transition-colors duration-200',
        selected
          ? 'border-primary/50 bg-primary/[0.08] text-foreground'
          : 'border-border-strong text-muted-foreground hover:border-ink/20',
      )}
    >
      {children}
      {selected && <Check className="size-3" />}
    </button>
  );
}

/** The picked teams and bots are kept apart, so switching kind back keeps them. */
export interface ScopeDraft {
  kind: ScopeKind;
  teams: string[];
  bots: string[];
}

export const scopeDraft = (scope: McpScope): ScopeDraft => ({
  kind: scope.kind,
  teams: scope.kind === 'teams' ? scope.ids : [],
  bots: scope.kind === 'bots' ? scope.ids : [],
});

export const scopeOf = (draft: ScopeDraft): McpScope => ({
  kind: draft.kind,
  ids: draft.kind === 'all' ? [] : draft[draft.kind],
});

export const sameScope = (a: McpScope, b: McpScope): boolean =>
  a.kind === b.kind && a.ids.length === b.ids.length && a.ids.every((id) => b.ids.includes(id));

export function ScopePicker({
  value,
  onChange,
}: {
  value: ScopeDraft;
  onChange(value: ScopeDraft): void;
}) {
  const { t } = useTranslation();
  const teams = useTeams();
  const bots = useBots();
  const toggle = (kind: 'teams' | 'bots', id: string) =>
    onChange({
      ...value,
      [kind]: value[kind].includes(id)
        ? value[kind].filter((other) => other !== id)
        : [...value[kind], id],
    });
  return (
    <div className="space-y-2">
      <p className="text-[13px] font-medium text-muted-foreground">{t('mcp.scopeLabel')}</p>
      <Choice
        id="scope"
        value={value.kind}
        onChange={(kind) => onChange({ ...value, kind })}
        options={SCOPE_KINDS.map((kind) => ({ value: kind, label: t(`mcp.scopeKinds.${kind}`) }))}
      />
      {value.kind === 'teams' &&
        (teams.data?.length ? (
          <div className="flex flex-wrap gap-1.5">
            {teams.data.map((team) => (
              <Chip
                key={team.id}
                selected={value.teams.includes(team.id)}
                onToggle={() => toggle('teams', team.id)}
              >
                <TeamAvatar
                  seeds={(bots.data ?? [])
                    .filter((bot) => bot.teamId === team.id)
                    .map((bot) => bot.avatarSeed)}
                  size={20}
                />
                {team.name}
              </Chip>
            ))}
          </div>
        ) : (
          <p className="text-xs text-faint">
            {teams.isPending ? t('common.loading') : t('mcp.noTeams')}
          </p>
        ))}
      {value.kind === 'bots' &&
        (bots.data?.length ? (
          <div className="flex flex-wrap gap-1.5">
            {bots.data.map((bot) => (
              <Chip
                key={bot.id}
                selected={value.bots.includes(bot.id)}
                onToggle={() => toggle('bots', bot.id)}
              >
                <BotAvatar seed={bot.avatarSeed} size={20} />
                {bot.name}
              </Chip>
            ))}
          </div>
        ) : (
          <p className="text-xs text-faint">
            {bots.isPending ? t('common.loading') : t('common.noBots')}
          </p>
        ))}
    </div>
  );
}
