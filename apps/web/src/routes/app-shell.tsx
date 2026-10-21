import type { Bot, Team } from '@mowbot/contract';
import { springs } from '@mowbot/design';
import { Link, Outlet, useLocation } from '@tanstack/react-router';
import {
  Activity,
  Blocks,
  CalendarClock,
  ChevronDown,
  Cpu,
  FolderGit2,
  FolderOpen,
  Gauge,
  House,
  LogOut,
  Menu,
  Monitor,
  MonitorSmartphone,
  Network,
  Pause,
  Plus,
  Users,
  Vault,
  X,
} from 'lucide-react';
import { AnimatePresence, LayoutGroup, motion } from 'motion/react';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BotAvatar, TeamAvatar } from '../components/bot-avatar';
import { StatusDot } from '../components/computer-status';
import { LanguageMenu } from '../components/language-menu';
import { OrgDialogsProvider, useOrgDialogs } from '../components/org-dialogs';
import { Button } from '../components/ui/button';
import { useAuth } from '../lib/auth';
import { moodOf, statusLabel } from '../lib/bot-mood';
import { useAccountLocale } from '../lib/locale';
import { useNotifications, useSystem } from '../lib/proactivity';
import { useBots, useChef, useComputers, useMe, useTeams } from '../lib/queries';
import { ServerEvents } from '../lib/server-events';
import { cn } from '../lib/utils';

/** Sidebar link with an active pill that glides between items. */
function NavItem({
  to,
  params,
  exact,
  children,
  onNavigate,
  className,
}: {
  to: string;
  params?: Record<string, string>;
  exact?: boolean;
  children: ReactNode;
  onNavigate(): void;
  className?: string;
}) {
  return (
    <Link
      to={to}
      params={params}
      activeOptions={{ exact, includeSearch: false }}
      onClick={onNavigate}
      className={cn(
        'relative flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-sm text-muted-foreground transition-colors duration-200 hover:text-foreground',
        className,
      )}
    >
      {({ isActive }: { isActive: boolean }) => (
        <>
          {isActive && (
            <motion.span
              layoutId="nav-active"
              transition={springs.soft}
              className="absolute inset-0 rounded-xl border border-white/[0.06] bg-white/[0.06]"
            />
          )}
          <span
            className={cn(
              'relative flex min-w-0 flex-1 items-center gap-2.5',
              isActive && 'text-foreground',
            )}
          >
            {children}
          </span>
        </>
      )}
    </Link>
  );
}

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="space-y-0.5">
      <div className="flex items-center justify-between px-2.5 pb-1">
        <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-faint">{title}</p>
        {action}
      </div>
      {children}
    </div>
  );
}

function SectionButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick(): void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="grid size-6 place-items-center rounded-md text-faint transition-colors hover:bg-white/[0.06] hover:text-foreground"
    >
      {children}
    </button>
  );
}

/** Remembers which teams are folded in the sidebar (per browser; storage may be unavailable). */
function useFolded(): [Set<string>, (teamId: string) => void] {
  const [folded, setFolded] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem('mowbot.folded-teams') ?? '[]') as string[]);
    } catch {
      return new Set();
    }
  });
  const toggle = (teamId: string) =>
    setFolded((current) => {
      const next = new Set(current);
      if (!next.delete(teamId)) next.add(teamId);
      try {
        localStorage.setItem('mowbot.folded-teams', JSON.stringify([...next]));
      } catch {
        // Folding still works for this visit.
      }
      return next;
    });
  return [folded, toggle];
}

function BotNav({ bot, onNavigate }: { bot: Bot; onNavigate(): void }) {
  useTranslation(); // re-render the status line when the language changes
  const mood = moodOf(bot);
  return (
    <NavItem
      to="/bots/$botId"
      params={{ botId: bot.id }}
      onNavigate={onNavigate}
      className="py-1.5"
    >
      <BotAvatar seed={bot.avatarSeed} size={24} mood={mood} />
      <span className="min-w-0 flex-1 truncate">{bot.name}</span>
      {mood !== 'idle' && mood !== 'error' && (
        <span className="shimmer-text max-w-[45%] shrink-0 truncate text-[11px]">
          {statusLabel(bot, mood)}
        </span>
      )}
    </NavItem>
  );
}

function TeamNav({
  team,
  members,
  folded,
  onToggle,
  onNavigate,
}: {
  team: Team;
  members: Bot[];
  folded: boolean;
  onToggle(): void;
  onNavigate(): void;
}) {
  const { t } = useTranslation();
  const computers = useComputers();
  const pc = computers.data?.find((c) => c.id === team.computerId);
  return (
    <div>
      <div className="flex items-center">
        <NavItem
          to="/teams/$teamId"
          params={{ teamId: team.id }}
          exact
          onNavigate={onNavigate}
          className="min-w-0 flex-1 py-1.5"
        >
          <TeamAvatar seeds={members.map((b) => b.avatarSeed)} size={24} />
          <span className="truncate font-medium text-foreground/90">{team.name}</span>
        </NavItem>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!folded}
          aria-label={t(folded ? 'shell.expand' : 'shell.collapse', { name: team.name })}
          className="grid size-7 shrink-0 place-items-center rounded-lg text-faint transition-colors hover:bg-white/[0.06] hover:text-foreground"
        >
          <ChevronDown
            className={cn('size-3.5 transition-transform duration-300', folded && '-rotate-90')}
          />
        </button>
      </div>
      <AnimatePresence initial={false}>
        {!folded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={springs.soft}
            className="overflow-hidden"
          >
            <div className="ml-[21px] space-y-0.5 border-l border-border py-0.5 pl-2">
              {members
                .filter((bot) => !bot.isChef)
                .map((bot) => (
                  <BotNav key={bot.id} bot={bot} onNavigate={onNavigate} />
                ))}
              <NavItem
                to="/teams/$teamId/desktop"
                params={{ teamId: team.id }}
                onNavigate={onNavigate}
                className="py-1.5"
              >
                <Monitor className="size-4 shrink-0" />
                <span className="flex-1">{t('common.desktop')}</span>
                {pc && <StatusDot status={pc.status} />}
              </NavItem>
              <NavItem
                to="/teams/$teamId/files"
                params={{ teamId: team.id }}
                onNavigate={onNavigate}
                className="py-1.5"
              >
                <FolderOpen className="size-4 shrink-0" /> {t('common.files')}
              </NavItem>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Sidebar({ onNavigate }: { onNavigate(): void }) {
  const { t } = useTranslation();
  const { logout } = useAuth();
  const me = useMe();
  const chef = useChef();
  const teams = useTeams();
  const bots = useBots();
  const dialogs = useOrgDialogs();
  const [folded, toggle] = useFolded();
  const bot = chef.data;
  const mood = bot ? moodOf(bot) : 'idle';
  const all = bots.data ?? [];
  const solo = all.filter((b) => !b.teamId);
  const unread = useNotifications().data?.unread ?? 0;
  const paused = useSystem().data?.paused ?? false;

  return (
    <nav className="flex h-full flex-col gap-5 p-3">
      <Link to="/" onClick={onNavigate} className="flex items-center gap-2.5 px-2 pt-1.5">
        <img src="/favicon.svg" alt="" className="size-7" />
        <span className="text-[17px] font-semibold tracking-tight">MowBot</span>
      </Link>

      {bot && (
        <NavItem to="/chef" onNavigate={onNavigate} className="py-2.5">
          <BotAvatar seed={bot.avatarSeed} size={30} mood={mood} />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium text-foreground">{bot.name}</span>
            <span
              className={cn(
                'block truncate text-xs',
                mood !== 'idle' ? 'shimmer-text' : 'text-faint',
              )}
            >
              {statusLabel(bot, mood)}
            </span>
          </span>
        </NavItem>
      )}

      <div className="-mx-1 min-h-0 flex-1 space-y-5 overflow-y-auto px-1">
        <div className="space-y-0.5">
          <NavItem to="/" exact onNavigate={onNavigate}>
            <House className="size-4 shrink-0" />
            <span className="flex-1">{t('shell.home')}</span>
            {paused ? (
              <Pause className="size-3.5 text-muted-foreground" aria-label={t('shell.paused')} />
            ) : unread > 0 ? (
              <span className="rounded-full bg-primary px-1.5 text-[11px] font-semibold tabular-nums text-primary-foreground">
                {unread}
              </span>
            ) : null}
          </NavItem>
          <NavItem to="/routines" onNavigate={onNavigate}>
            <CalendarClock className="size-4 shrink-0" /> {t('shell.routines')}
          </NavItem>
          <NavItem to="/org" onNavigate={onNavigate}>
            <Network className="size-4 shrink-0" /> {t('shell.organization')}
          </NavItem>
          <NavItem to="/activity" onNavigate={onNavigate}>
            <Activity className="size-4 shrink-0" /> {t('shell.activity')}
          </NavItem>
        </div>

        <Section
          title={t('shell.teams')}
          action={
            <span className="flex">
              <SectionButton label={t('common.newTeam')} onClick={() => dialogs.newTeam()}>
                <Users className="size-3.5" />
              </SectionButton>
              <SectionButton label={t('common.newBot')} onClick={() => dialogs.newBot()}>
                <Plus className="size-3.5" />
              </SectionButton>
            </span>
          }
        >
          {teams.data?.map((team) => (
            <TeamNav
              key={team.id}
              team={team}
              members={all.filter((b) => b.teamId === team.id)}
              folded={folded.has(team.id)}
              onToggle={() => toggle(team.id)}
              onNavigate={onNavigate}
            />
          ))}
        </Section>

        {solo.length > 0 && (
          <Section title={t('common.soloBots')}>
            {solo.map((b) => (
              <BotNav key={b.id} bot={b} onNavigate={onNavigate} />
            ))}
          </Section>
        )}
      </div>

      <div className="space-y-0.5">
        <NavItem to="/settings/models" onNavigate={onNavigate}>
          <Cpu className="size-4 shrink-0" /> {t('shell.models')}
        </NavItem>
        <NavItem to="/settings/proactivity" onNavigate={onNavigate}>
          <Gauge className="size-4 shrink-0" /> {t('shell.proactivity')}
        </NavItem>
        <NavItem to="/vault" onNavigate={onNavigate}>
          <Vault className="size-4 shrink-0" /> {t('shell.vault')}
        </NavItem>
        <NavItem to="/settings/mcp" onNavigate={onNavigate}>
          <Blocks className="size-4 shrink-0" /> {t('shell.mcp')}
        </NavItem>
        <NavItem to="/settings/projects" onNavigate={onNavigate}>
          <FolderGit2 className="size-4 shrink-0" /> {t('shell.projects')}
        </NavItem>
        <NavItem to="/settings/devices" onNavigate={onNavigate}>
          <MonitorSmartphone className="size-4 shrink-0" /> {t('shell.devices')}
        </NavItem>
        <div className="mt-2 flex items-center gap-2 border-t border-border px-2.5 pt-3">
          <Link
            to="/settings/profile"
            onClick={onNavigate}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-lg py-1 transition-colors duration-150 hover:text-foreground"
            aria-label={t('shell.profile')}
          >
            <span className="grid size-7 shrink-0 place-items-center rounded-full bg-white/[0.07] text-xs font-semibold">
              {me.data?.owner.displayName.slice(0, 1).toUpperCase() ?? '·'}
            </span>
            <span className="flex-1 truncate text-sm">{me.data?.owner.displayName ?? '…'}</span>
          </Link>
          <LanguageMenu />
          <Button
            variant="ghost"
            size="icon"
            onClick={() => void logout()}
            aria-label={t('shell.signOut')}
          >
            <LogOut className="size-4" />
          </Button>
        </div>
      </div>
    </nav>
  );
}

export function AppShell() {
  const { t } = useTranslation();
  useAccountLocale();
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  const fullBleed = pathname === '/chef' || pathname.startsWith('/bots/');

  return (
    <OrgDialogsProvider>
      <div className="flex h-dvh overflow-hidden">
        <aside className="hidden w-[264px] shrink-0 border-r border-border bg-background-raised/60 backdrop-blur-xl md:block">
          <LayoutGroup id="sidebar">
            <Sidebar onNavigate={() => {}} />
          </LayoutGroup>
        </aside>

        <AnimatePresence>
          {open && (
            <>
              <motion.div
                key="scrim"
                className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm md:hidden"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => setOpen(false)}
                aria-hidden
              />
              <motion.aside
                key="drawer"
                className="fixed inset-y-0 left-0 z-50 w-[280px] border-r border-border bg-background-raised md:hidden"
                initial={{ x: -300 }}
                animate={{ x: 0 }}
                exit={{ x: -300 }}
                transition={springs.soft}
              >
                <Button
                  variant="ghost"
                  size="icon"
                  className="absolute right-2 top-2.5"
                  onClick={() => setOpen(false)}
                  aria-label={t('shell.closeMenu')}
                >
                  <X className="size-4" />
                </Button>
                <LayoutGroup id="drawer">
                  <Sidebar onNavigate={() => setOpen(false)} />
                </LayoutGroup>
              </motion.aside>
            </>
          )}
        </AnimatePresence>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3 md:hidden">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setOpen(true)}
              aria-label={t('shell.openMenu')}
            >
              <Menu className="size-4" />
            </Button>
            <span className="font-semibold tracking-tight">MowBot</span>
          </header>
          <main
            className={cn(
              'relative min-h-0 flex-1',
              fullBleed
                ? 'overflow-hidden'
                : // In the desktop app the window's buttons sit in the top corner.
                  'overflow-y-auto p-4 md:p-8 [.desktop-app_&]:md:pt-12',
            )}
          >
            <motion.div
              key={pathname}
              initial={{ opacity: 0, y: 6, filter: 'blur(6px)' }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              transition={springs.soft}
              className="h-full"
            >
              <Outlet />
            </motion.div>
          </main>
        </div>
        <ServerEvents />
      </div>
    </OrgDialogsProvider>
  );
}
