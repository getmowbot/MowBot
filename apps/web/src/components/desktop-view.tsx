import RFB from '@novnc/novnc';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, client } from '../lib/auth';

export interface DesktopViewHandle {
  fullscreen(): void;
  sendCtrlAltDel(): void;
}

interface Props {
  computerId: string;
  /** View-only unless the user has taken control. */
  interactive: boolean;
}

const RETRY_MS = 2_000;

/** Live desktop of a computer (noVNC over the hub's WebSocket proxy). Reconnects on drops. */
export const DesktopView = forwardRef<DesktopViewHandle, Props>(function DesktopView(
  { computerId, interactive },
  ref,
) {
  const { t } = useTranslation();
  const frameRef = useRef<HTMLDivElement>(null);
  const screenRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RFB | null>(null);
  const interactiveRef = useRef(interactive);
  const [connected, setConnected] = useState(false);

  useImperativeHandle(ref, () => ({
    fullscreen: () => void frameRef.current?.requestFullscreen?.(),
    sendCtrlAltDel: () => rfbRef.current?.sendCtrlAltDel(),
  }));

  useEffect(() => {
    let disposed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;

    async function connect() {
      setConnected(false);
      const { data } = await api
        .POST('/api/v1/computers/{id}/desktop-ticket', { params: { path: { id: computerId } } })
        .catch(() => ({ data: undefined }));
      if (disposed || !screenRef.current) return;
      if (!data) {
        retry = setTimeout(connect, RETRY_MS);
        return;
      }
      const url = client.socketUrl(
        `/api/v1/computers/${computerId}/desktop?ticket=${encodeURIComponent(data.ticket)}`,
      );
      const rfb = new RFB(screenRef.current, url, { shared: true });
      rfb.scaleViewport = true;
      rfb.resizeSession = false;
      rfb.background = 'transparent';
      rfb.viewOnly = !interactiveRef.current;
      rfb.addEventListener('connect', () => setConnected(true));
      rfb.addEventListener('disconnect', () => {
        rfbRef.current = null;
        setConnected(false);
        if (!disposed) retry = setTimeout(connect, RETRY_MS);
      });
      rfbRef.current = rfb;
    }

    void connect();
    return () => {
      disposed = true;
      clearTimeout(retry);
      rfbRef.current?.disconnect();
      rfbRef.current = null;
    };
  }, [computerId]);

  useEffect(() => {
    interactiveRef.current = interactive;
    const rfb = rfbRef.current;
    if (!rfb) return;
    rfb.viewOnly = !interactive;
    if (interactive) rfb.focus();
  }, [interactive]);

  return (
    <div
      ref={frameRef}
      className="relative aspect-[16/10] max-h-[calc(100dvh-11rem)] w-full overflow-hidden rounded-lg border bg-black"
    >
      <div ref={screenRef} className="absolute inset-0" />
      {!connected && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-white/70">
          {t('computer.connecting')}
        </div>
      )}
    </div>
  );
});
