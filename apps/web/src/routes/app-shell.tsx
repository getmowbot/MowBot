import { Link, Outlet } from '@tanstack/react-router';
import { Bot, Crown, FolderOpen, LogOut, Menu, Monitor, MonitorSmartphone, X } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { StatusDot } from '../components/computer-status';
import { Button } from '../components/ui/button';
import { useAuth } from '../lib/auth';
import { useComputers, useMe, useTeams } from '../lib/queries';
import { ServerEvents } from '../lib/server-events';
import { cn } from '../lib/utils';

function TeamsNav({ onNavigate }: { onNavigate(): void }) {
  const teams = useTeams();
  const computers = useComputers();
  if (teams.isPending) return <p className="px-2 text-sm text-muted-foreground">…</p>;
  return (
    <>
      {teams.data?.map((team) => {
        const pc = computers.data?.find((c) => c.id === team.computerId);
        return (
          <div key={team.id} className="space-y-0.5">
            <p className="truncate px-2 pt-1 text-sm font-medium">{team.name}</p>
            <Link
              to="/teams/$teamId/desktop"
              params={{ teamId: team.id }}
              className={cn(navLink, 'pl-4')}
              onClick={onNavigate}
            >
              <Monitor className="size-4" />
              <span className="flex-1">Bureau</span>
              {pc && <StatusDot status={pc.status} />}
            </Link>
            <Link
              to="/teams/$teamId/files"
              params={{ teamId: team.id }}
              search={{}}
              className={cn(navLink, 'pl-4')}
              onClick={onNavigate}
            >
              <FolderOpen className="size-4" /> Fichiers
            </Link>
          </div>
        );
      })}
    </>
  );
}

function SidebarSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="px-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </p>
      {children}
    </div>
  );
}

function SoonItem({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground">
      {icon}
      <span className="flex-1 truncate">{label}</span>
      <span className="rounded bg-muted px-1.5 text-[10px]">bientôt</span>
    </div>
  );
}

const navLink =
  'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted [&.active]:bg-muted [&.active]:font-medium';

export function AppShell() {
  const { logout } = useAuth();
  const me = useMe();
  const [open, setOpen] = useState(false);

  const sidebar = (
    <nav className="flex h-full flex-col gap-6 p-3">
      <Link to="/" className="flex items-center gap-2 px-2 pt-1" onClick={() => setOpen(false)}>
        <img src="/favicon.svg" alt="" className="size-7" />
        <span className="text-lg font-semibold">MowBot</span>
      </Link>
      <SidebarSection title="Chef">
        <Link
          to="/"
          className={navLink}
          onClick={() => setOpen(false)}
          activeOptions={{ exact: true }}
        >
          <Crown className="size-4" /> Chef
        </Link>
      </SidebarSection>
      <SidebarSection title="Équipes">
        <TeamsNav onNavigate={() => setOpen(false)} />
      </SidebarSection>
      <SidebarSection title="Bots solo">
        <SoonItem icon={<Bot className="size-4" />} label="Aucun bot solo" />
      </SidebarSection>
      <div className="mt-auto space-y-1">
        <Link to="/settings/devices" className={navLink} onClick={() => setOpen(false)}>
          <MonitorSmartphone className="size-4" /> Appareils
        </Link>
        <div className="flex items-center gap-2 border-t px-2 pt-3">
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

  return (
    <div className="flex min-h-dvh">
      <aside className="hidden w-64 shrink-0 border-r bg-card md:block">{sidebar}</aside>
      <div
        className={cn('fixed inset-0 z-40 bg-black/40 md:hidden', open ? 'block' : 'hidden')}
        onClick={() => setOpen(false)}
        aria-hidden
      />
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 w-72 border-r bg-card transition-transform md:hidden',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <Button
          variant="ghost"
          size="icon"
          className="absolute top-2 right-2"
          onClick={() => setOpen(false)}
          aria-label="Fermer le menu"
        >
          <X className="size-4" />
        </Button>
        {sidebar}
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 items-center gap-2 border-b px-4 md:hidden">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setOpen(true)}
            aria-label="Ouvrir le menu"
          >
            <Menu className="size-4" />
          </Button>
          <span className="font-semibold">MowBot</span>
        </header>
        <main className="flex-1 p-4 md:p-8">
          <Outlet />
        </main>
      </div>
      <ServerEvents />
    </div>
  );
}

export function HomePage() {
  return (
    <div className="mx-auto flex h-full max-w-2xl flex-col items-center justify-center gap-3 py-24 text-center">
      <Crown className="size-10 text-primary" />
      <h1 className="text-2xl font-semibold">Le Chef arrive bientôt</h1>
      <p className="text-muted-foreground">
        L'Équipe principale a déjà son PC et ses fichiers : ouvre son bureau ou son dossier dans le
        menu. Le Chef, qui pilotera les bots, arrive dans la prochaine phase.
      </p>
    </div>
  );
}
