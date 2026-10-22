import { useParams } from '@tanstack/react-router';
import { Hand, Maximize, Play, Power, RotateCw, Undo2 } from 'lucide-react';
import { lazy, Suspense, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BotBrowserView, ViewSwitch } from '../components/bot-browser-view';
import { StatusBadge } from '../components/computer-status';
import type { DesktopViewHandle } from '../components/desktop-view';
import { PreviewList } from '../components/preview-list';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/form';
import { problemMessage } from '../lib/auth';
import { useBots, useComputer, useComputerAction, useMe, useTeam } from '../lib/queries';

// noVNC is heavy: load it only when a desktop is shown.
const DesktopView = lazy(() =>
  import('../components/desktop-view').then((m) => ({ default: m.DesktopView })),
);

export function DesktopPage() {
  const { t } = useTranslation();
  // A team's PC (/teams/:id/desktop) or any computer (/computers/:id), e.g. a dedicated one.
  const params = useParams({ strict: false }) as { teamId?: string; computerId?: string };
  const team = useTeam(params.teamId);
  const bots = useBots();
  const computerId = params.computerId ?? team.data?.computerId;
  const computer = useComputer(computerId);
  const me = useMe();
  const action = useComputerAction(computerId);
  const view = useRef<DesktopViewHandle>(null);
  // The screen, or one bot's own browser window.
  const [shown, setShown] = useState('screen');

  if (team.isPending || (computerId && computer.isPending)) {
    return <p className="text-sm text-muted-foreground">{t('common.loading')}</p>;
  }
  if (!computer.data) {
    return <p className="text-sm text-destructive">{t('desktop.notFound')}</p>;
  }

  const pc = computer.data;
  const control = pc.control;
  const inControl = Boolean(control && control.deviceId === me.data?.device.id);
  const busy = action.isPending || pc.status === 'starting' || pc.status === 'stopping';
  const pcBots = (bots.data ?? []).filter((b) => b.computerId === pc.id);
  const shownBot = pcBots.find((b) => b.id === shown);

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm text-muted-foreground">
            {pcBots.map((b) => b.name).join(', ') || t('common.noBots')}
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
                  <Undo2 className="size-4" /> {t('desktop.release')}
                </Button>
              ) : (
                <Button onClick={() => action.mutate('takeover')} disabled={busy}>
                  <Hand className="size-4" /> {t('desktop.takeover')}
                </Button>
              )}
              <Button
                variant="outline"
                size="icon"
                onClick={() => view.current?.fullscreen()}
                aria-label={t('desktop.fullscreen')}
              >
                <Maximize className="size-4" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                onClick={() => action.mutate('restart')}
                disabled={busy}
                aria-label={t('desktop.restart')}
              >
                <RotateCw className="size-4" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                onClick={() => action.mutate('stop')}
                disabled={busy}
                aria-label={t('desktop.turnOff')}
              >
                <Power className="size-4" />
              </Button>
            </>
          )}
          {(pc.status === 'stopped' || pc.status === 'error') && (
            <Button onClick={() => action.mutate('start')} disabled={busy}>
              <Play className="size-4" /> {t('common.turnOn')}
            </Button>
          )}
        </div>
      </div>

      {action.isError && (
        <p role="alert" className="text-sm text-destructive">
          {problemMessage(action.error, t('common.actionFailed'))}
        </p>
      )}

      {pc.status === 'running' && control && (
        <p className="rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-sm">
          {inControl ? t('desktop.inControl') : t('desktop.otherDevice')}
        </p>
      )}

      {pc.status === 'running' && <PreviewList computerId={pc.id} />}

      {pc.status === 'running' && pcBots.length > 0 && (
        <ViewSwitch
          value={shownBot ? shownBot.id : 'screen'}
          options={[
            { value: 'screen', label: t('desktop.screen') },
            ...pcBots.map((b) => ({
              value: b.id,
              label: t('desktop.botWindow', { name: b.name }),
            })),
          ]}
          onChange={setShown}
        />
      )}

      {pc.status === 'running' && shownBot ? (
        <BotBrowserView
          botId={shownBot.id}
          botName={shownBot.name}
          onShown={() => setShown('screen')}
          onTakeOver={
            inControl
              ? undefined
              : () => {
                  action.mutate('takeover');
                  setShown('screen');
                }
          }
        />
      ) : pc.status === 'running' ? (
        <Suspense
          fallback={<p className="text-sm text-muted-foreground">{t('desktop.loading')}</p>}
        >
          <DesktopView ref={view} computerId={pc.id} interactive={inControl} />
        </Suspense>
      ) : (
        <Card className="flex aspect-[16/10] max-h-[calc(100dvh-11rem)] w-full flex-col items-center justify-center gap-2 text-center">
          {pc.status === 'starting' && <p>{t('desktop.starting')}</p>}
          {pc.status === 'stopping' && <p>{t('desktop.stopping')}</p>}
          {pc.status === 'stopped' && (
            <>
              <p className="font-medium">{t('desktop.off')}</p>
              <p className="max-w-md text-sm text-muted-foreground">{t('desktop.offHint')}</p>
            </>
          )}
          {pc.status === 'error' && (
            <>
              <p className="font-medium text-destructive">{t('desktop.failed')}</p>
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
