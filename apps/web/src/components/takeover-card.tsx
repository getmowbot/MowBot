import type { MessagePart } from '@mowbot/contract';
import { Hand, Monitor, Undo2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { problemMessage } from '../lib/auth';
import { useComputer, useComputerAction, useMe } from '../lib/queries';
import { Button } from './ui/button';

type TakeoverPart = Extract<MessagePart, { type: 'takeover_request' }>;

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/**
 * A bot needs the user at the keyboard of its PC (a sign-in, a captcha): one button shows the
 * PC next to the conversation and takes control. Giving control back wakes the bot up.
 */
export function TakeoverCard({
  part,
  botName,
  onShowPc,
}: {
  part: TakeoverPart;
  botName: string;
  /** Opens the PC panel next to the conversation. */
  onShowPc(): void;
}) {
  const { t } = useTranslation();
  const pc = useComputer(part.computerId).data;
  const action = useComputerAction(part.computerId);
  const me = useMe();
  const control = pc?.control;
  const inControl = Boolean(control && control.deviceId === me.data?.device.id);

  if (part.status === 'returned') {
    return (
      <div className="flex max-w-md items-center gap-2 rounded-xl border border-border px-3 py-2 text-[13px]">
        <Hand className="size-3.5 shrink-0 text-faint" />
        <span className="min-w-0 truncate">{part.reason}</span>
        <span className="shrink-0 text-muted-foreground">· {t('takeoverCard.returned')}</span>
      </div>
    );
  }

  const takeOver = () => {
    onShowPc();
    action.mutate('takeover');
  };
  return (
    <div className="glass max-w-md space-y-3 rounded-2xl p-4">
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-primary/[0.12] text-primary">
          <Hand className="size-4" />
        </span>
        <div className="min-w-0 space-y-0.5">
          <p className="font-medium leading-snug">{t('takeoverCard.title', { name: botName })}</p>
          <p className="text-[13px] text-muted-foreground">{part.reason}</p>
          {part.url && <p className="truncate text-xs text-faint">{hostOf(part.url)}</p>}
        </div>
      </div>
      {control && (
        <p className="text-xs text-faint">
          {inControl
            ? t('takeoverCard.inControl', { name: botName })
            : t('takeoverCard.otherDevice')}
        </p>
      )}
      {action.isError && (
        <p role="alert" className="text-xs text-destructive">
          {problemMessage(action.error, t('takeoverCard.failed'))}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {inControl ? (
          <>
            <Button size="sm" onClick={() => action.mutate('release')} disabled={action.isPending}>
              <Undo2 className="size-3.5" /> {t('takeoverCard.release')}
            </Button>
            <Button size="sm" variant="outline" onClick={onShowPc}>
              <Monitor className="size-3.5" /> {t('takeoverCard.showScreen')}
            </Button>
          </>
        ) : (
          <Button size="sm" onClick={takeOver} disabled={action.isPending}>
            <Hand className="size-3.5" /> {t('takeoverCard.take')}
          </Button>
        )}
      </div>
    </div>
  );
}
