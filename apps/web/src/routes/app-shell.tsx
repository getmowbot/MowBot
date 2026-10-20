import { springs } from '@mowbot/design';
import { Link, Outlet, useLocation } from '@tanstack/react-router';
import { Cpu, FolderOpen, LogOut, Menu, Monitor, MonitorSmartphone, X } from 'lucide-react';
import { AnimatePresence, LayoutGroup, motion } from 'motion/react';
import { type ReactNode, useState } from 'react';
import { BotAvatar, TeamAvatar } from '../components/bot-avatar';
import { StatusDot } from '../components/computer-status';
import { Button } from '../components/ui/button';
import { useAuth } from '../lib/auth';
import { moodOf, statusLabel } from '../lib/bot-mood';
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

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-0.5">
      <p className="px-2.5 pb-1 text-[11px] font-medium uppercase tracking-[0.12em] text-faint">
        {title}
      </p>
      {children}
    </div>
  );
}

function Sidebar({ onNavigate }: { onNavigate(): void }) {
  const { logout } = useAuth();
  const me = useMe();
  const chef = useChef();
  const teams = useTeams();
  const computers = useComputers();
  const bots = useBots();
  const bot = chef.data;
  const mood = bot ? moodOf(bot) : 'idle';

  return (
    <nav className="flex h-full flex-col gap-6 p-3">
      <Link to="/" onClick={onNavigate} className="flex items-center gap-2.5 px-2 pt-1.5">
        <img src="/favicon.svg" alt="" className="size-7" />
        <span className="text-[17px] font-semibold tracking-tight">MowBot</span>
      </Link>

      {bot && (
        <NavItem to="/" exact onNavigate={onNavigate} className="py-2.5">
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

      <Section title="Équipes">
        {teams.data?.map((team) => {
          const pc = computers.data?.find((c) => c.id === team.computerId);
          return (
            <div key={team.id} className="space-y-0.5">
              <p className="flex items-center gap-2 px-2.5 pb-0.5 pt-1 text-[13px] font-medium text-foreground/90">
                <TeamAvatar
                  seeds={(bots.data ?? [])
                    .filter((b) => b.teamId === team.id)
                    .map((b) => b.avatarSeed)}
                  size={22}
                />
                <span className="truncate">{team.name}</span>
              </p>
              <NavItem
                to="/teams/$teamId/desktop"
                params={{ teamId: team.id }}
                onNavigate={onNavigate}
              >
                <Monitor className="size-4 shrink-0" />
                <span className="flex-1">Bureau</span>
                {pc && <StatusDot status={pc.status} />}
              </NavItem>
              <NavItem
                to="/teams/$teamId/files"
                params={{ teamId: team.id }}
                onNavigate={onNavigate}
              >
                <FolderOpen className="size-4 shrink-0" /> Fichiers
              </NavItem>
            </div>
          );
        })}
      </Section>

      <div className="mt-auto space-y-0.5">
        <NavItem to="/settings/models" onNavigate={onNavigate}>
          <Cpu className="size-4 shrink-0" /> Modèles
        </NavItem>
        <NavItem to="/settings/devices" onNavigate={onNavigate}>
          <MonitorSmartphone className="size-4 shrink-0" /> Appareils
        </NavItem>
        <div className="mt-2 flex items-center gap-2 border-t border-border px-2.5 pt-3">
          <span className="grid size-7 place-items-center rounded-full bg-white/[0.07] text-xs font-semibold">
            {me.data?.owner.displayName.slice(0, 1).toUpperCase() ?? '·'}
          </span>
          <span className="flex-1 truncate text-sm">{me.data?.owner.displayName ?? '…'}</span>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => void logout()}
            aria-label="Se déconnecter"
          >
            <LogOut className="size-4" />
          </Button>
        </div>
      </div>
    </nav>
  );
}

export function AppShell() {
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  const fullBleed = pathname === '/' || pathname.startsWith('/bots/');

  return (
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
                aria-label="Fermer le menu"
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
            aria-label="Ouvrir le menu"
          >
            <Menu className="size-4" />
          </Button>
          <span className="font-semibold tracking-tight">MowBot</span>
        </header>
        <main
          className={cn(
            'relative min-h-0 flex-1',
            fullBleed ? 'overflow-hidden' : 'overflow-y-auto p-4 md:p-8',
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
  );
}
