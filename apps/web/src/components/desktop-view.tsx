import RFB from '@novnc/novnc';
import { ClipboardPaste, Copy, Send } from 'lucide-react';
import {
  type FormEvent,
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { api, client } from '../lib/auth';
import { Button } from './ui/button';

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
const NOTICE_MS = 2_500;

// X11 keysyms (and DOM codes) noVNC sends.
const KEY_V = { keysym: 0x0076, code: 'KeyV' };
const KEY_CONTROL = { keysym: 0xffe3, code: 'ControlLeft' };
const KEY_SUPER = { keysym: 0xffeb, code: 'MetaLeft' };

/** Copies with a user gesture, even where the async clipboard API is missing (plain http). */
function copyText(text: string): boolean {
  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  field.style.position = 'fixed';
  field.style.opacity = '0';
  document.body.append(field);
  field.select();
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }
  field.remove();
  return copied;
}

/**
 * Live desktop of a computer (noVNC over the hub's WebSocket proxy). Reconnects on drops.
 * While the user has control, the clipboard crosses both ways: Ctrl+V pastes theirs on the PC,
 * and what is copied on the PC comes back to them.
 */
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
  // Copied on the PC but not yet on the user's clipboard (the browser refused to write it).
  const [pcCopy, setPcCopy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [typing, setTyping] = useState(false);
  const [text, setText] = useState('');
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Ctrl+V (or ⌘V) went to the browser: the paste event that follows sends the text to the PC.
  const pasteKey = useRef<'ctrl' | 'meta' | null>(null);

  const say = (message: string) => {
    setNotice(message);
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), NOTICE_MS);
  };

  useImperativeHandle(ref, () => ({
    fullscreen: () => void frameRef.current?.requestFullscreen?.(),
    sendCtrlAltDel: () => rfbRef.current?.sendCtrlAltDel(),
  }));

  // biome-ignore lint/correctness/useExhaustiveDependencies: `say` and `t` only show notices
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
      // Copied on the PC (noVNC only reports it while the user has control).
      rfb.addEventListener('clipboard', (event) => {
        const copied = (event as CustomEvent<{ text: string }>).detail.text;
        if (!copied) return;
        if (window.isSecureContext && navigator.clipboard) {
          navigator.clipboard.writeText(copied).then(
            () => {
              setPcCopy(null);
              say(t('desktop.clipboard.copied'));
            },
            () => setPcCopy(copied),
          );
        } else {
          setPcCopy(copied);
        }
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
    else setPcCopy(null);
  }, [interactive]);

  useEffect(() => () => clearTimeout(noticeTimer.current), []);

  // Ctrl+V / ⌘V in the screen: let the browser paste (noVNC would swallow the key), then send
  // the pasted text to the PC's clipboard followed by the V that completes its Ctrl+V.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!interactiveRef.current || event.code !== 'KeyV') return;
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      event.stopPropagation();
      pasteKey.current = event.metaKey ? 'meta' : 'ctrl';
    };
    const onPaste = (event: ClipboardEvent) => {
      const rfb = rfbRef.current;
      const pasted = event.clipboardData?.getData('text/plain') ?? '';
      const key = pasteKey.current;
      pasteKey.current = null;
      if (!rfb || !interactiveRef.current || !pasted) return;
      event.preventDefault();
      rfb.clipboardPasteFrom(pasted);
      if (key === 'ctrl') {
        // Ctrl is already held on the PC: only the V is missing.
        rfb.sendKey(KEY_V.keysym, KEY_V.code, true);
        rfb.sendKey(KEY_V.keysym, KEY_V.code, false);
      } else {
        // ⌘ means Ctrl on the PC (Linux).
        if (key === 'meta') rfb.sendKey(KEY_SUPER.keysym, KEY_SUPER.code, false);
        sendCtrlV(rfb);
      }
    };
    frame.addEventListener('keydown', onKeyDown, true);
    frame.addEventListener('paste', onPaste);
    return () => {
      frame.removeEventListener('keydown', onKeyDown, true);
      frame.removeEventListener('paste', onPaste);
    };
  }, []);

  const sendText = (event: FormEvent) => {
    event.preventDefault();
    const rfb = rfbRef.current;
    if (!rfb || !text) return;
    rfb.clipboardPasteFrom(text);
    rfb.focus();
    sendCtrlV(rfb);
    setText('');
    setTyping(false);
    say(t('desktop.clipboard.pasted'));
  };

  return (
    <div className="space-y-2">
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
      {interactive && connected && (
        <div className="space-y-2 text-xs text-muted-foreground">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <ClipboardPaste className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1">{notice ?? t('desktop.clipboard.hint')}</span>
            {pcCopy !== null && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  if (copyText(pcCopy)) {
                    setPcCopy(null);
                    say(t('desktop.clipboard.copied'));
                  } else {
                    say(t('desktop.clipboard.copyFailed'));
                  }
                  rfbRef.current?.focus();
                }}
              >
                <Copy className="size-3.5" /> {t('desktop.clipboard.copyFromPc')}
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => setTyping((v) => !v)}>
              {t('desktop.clipboard.pasteText')}
            </Button>
          </div>
          {typing && (
            <form onSubmit={sendText} className="flex gap-2">
              <input
                // A password may be pasted here: never kept, never shown in clear.
                type="password"
                autoComplete="off"
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder={t('desktop.clipboard.placeholder')}
                className="h-8 min-w-0 flex-1 rounded-md border border-border-strong bg-transparent px-2.5 text-sm text-foreground outline-none focus:border-white/40"
              />
              <Button type="submit" size="sm" disabled={!text}>
                <Send className="size-3.5" /> {t('desktop.clipboard.send')}
              </Button>
            </form>
          )}
        </div>
      )}
    </div>
  );
});

/** Ctrl+V on the PC: pastes what was just put on its clipboard. */
function sendCtrlV(rfb: RFB) {
  rfb.sendKey(KEY_CONTROL.keysym, KEY_CONTROL.code, true);
  rfb.sendKey(KEY_V.keysym, KEY_V.code, true);
  rfb.sendKey(KEY_V.keysym, KEY_V.code, false);
  rfb.sendKey(KEY_CONTROL.keysym, KEY_CONTROL.code, false);
}
