import { useParams } from '@tanstack/react-router';
import { Hand, Maximize, Play, Power, RotateCw, Undo2 } from 'lucide-react';
import { lazy, Suspense, useRef } from 'react';
import { StatusBadge } from '../components/computer-status';
import type { DesktopViewHandle } from '../components/desktop-view';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/form';
import { problemMessage } from '../lib/auth';
import { useBots, useComputer, useComputerAction, useMe, useTeam } from '../lib/queries';

// noVNC is heavy: load it only when a desktop is shown.
const DesktopView = lazy(() =>
  import('../components/desktop-view').then((m) => ({ default: m.DesktopView })),
);

export function DesktopPage() {
  // A team's PC (/teams/:id/desktop) or any computer (/computers/:id), e.g. a dedicated one.
  const params = useParams({ strict: false }) as { teamId?: string; computerId?: string };
  const team = useTeam(params.teamId);
  const bots = useBots();
  const computerId = params.computerId ?? team.data?.computerId;
  const computer = useComputer(computerId);
  const me = useMe();
  const action = useComputerAction(computerId);
  const view = useRef<DesktopViewHandle>(null);

  if (team.isPending || (computerId && computer.isPending)) {
    return <p className="text-sm text-muted-foreground">Chargement…</p>;
  }
  if (!computer.data) {
    return <p className="text-sm text-destructive">Ordinateur introuvable.</p>;
  }

  const pc = computer.data;
  const control = pc.control;
  const inControl = Boolean(control && control.deviceId === me.data?.device.id);
  const busy = action.isPending || pc.status === 'starting' || pc.status === 'stopping';

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm text-muted-foreground">
            {(bots.data ?? [])
              .filter((b) => b.computerId === pc.id)
              .map((b) => b.name)
              .join(', ') || 'Aucun bot'}
          </p>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <span className="truncate">{pc.name}</span>
            <StatusBadge status={pc.status} />
          </h1>
        </div>
        <div className="flex flex-wrap gap-2">
          {pc.status === 'running' && (
            <>
              {inControl ? (
                <Button onClick={() => action.mutate('release')} disabled={busy}>
                  <Undo2 className="size-4" /> Rendre la main
                </Button>
              ) : (
                <Button onClick={() => action.mutate('takeover')} disabled={busy}>
                  <Hand className="size-4" /> Prendre le contrôle
                </Button>
              )}
              <Button
                variant="outline"
                size="icon"
                onClick={() => view.current?.fullscreen()}
                aria-label="Plein écran"
              >
                <Maximize className="size-4" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                onClick={() => action.mutate('restart')}
                disabled={busy}
                aria-label="Redémarrer"
              >
                <RotateCw className="size-4" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                onClick={() => action.mutate('stop')}
                disabled={busy}
                aria-label="Éteindre"
              >
                <Power className="size-4" />
              </Button>
            </>
          )}
          {(pc.status === 'stopped' || pc.status === 'error') && (
            <Button onClick={() => action.mutate('start')} disabled={busy}>
              <Play className="size-4" /> Allumer
            </Button>
          )}
        </div>
      </div>

      {action.isError && (
        <p role="alert" className="text-sm text-destructive">
          {problemMessage(action.error, 'Action impossible.')}
        </p>
      )}

      {pc.status === 'running' && control && (
        <p className="rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-sm">
          {inControl
            ? 'Tu as la main : les bots sont en pause sur ce PC. Clique dans le bureau pour taper.'
            : 'Un autre de tes appareils a la main sur ce PC.'}
        </p>
      )}

      {pc.status === 'running' ? (
        <Suspense fallback={<p className="text-sm text-muted-foreground">Chargement du bureau…</p>}>
          <DesktopView ref={view} computerId={pc.id} interactive={inControl} />
        </Suspense>
      ) : (
        <Card className="flex aspect-[16/10] max-h-[calc(100dvh-11rem)] w-full flex-col items-center justify-center gap-2 text-center">
          {pc.status === 'starting' && (
            <p>Démarrage du PC… (quelques secondes, plus au premier lancement)</p>
          )}
          {pc.status === 'stopping' && <p>Arrêt du PC…</p>}
          {pc.status === 'stopped' && (
            <>
              <p className="font-medium">Le PC est éteint.</p>
              <p className="max-w-md text-sm text-muted-foreground">
                Il s'éteint tout seul après une période d'inactivité. Ses fichiers et ses
                installations sont conservés.
              </p>
            </>
          )}
          {pc.status === 'error' && (
            <>
              <p className="font-medium text-destructive">Le PC n'a pas pu démarrer.</p>
              {pc.statusDetail && (
                <p className="max-w-xl break-words font-mono text-xs text-muted-foreground">
                  {pc.statusDetail}
                </p>
              )}
            </>
          )}
        </Card>
      )}
    </div>
  );
}
