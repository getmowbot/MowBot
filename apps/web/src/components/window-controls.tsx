import { getCurrentWindow } from '@tauri-apps/api/window';
import { Copy, Minus, Square, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { inDesktopApp } from '../lib/projects';
import { cn } from '../lib/utils';

/** macOS keeps its own traffic lights over the interface (the app asks for it). */
const isMac = () => /mac/i.test(navigator.userAgent);

/** The band at the top of the window that moves it, like a title bar would. */
const DRAG_BAND_PX = 40;
const INTERACTIVE = 'button, a, input, textarea, select, label, [role="button"], [data-no-drag]';

/**
 * In the desktop app the window has no system title bar: on Windows and Linux these replace the
 * system's buttons; on macOS the native traffic lights stay. Either way the top of the interface
 * moves the window (a double click maximizes it).
 */
export function WindowControls() {
  const { t } = useTranslation();
  const [maximized, setMaximized] = useState(false);
  const desktop = inDesktopApp();

  useEffect(() => {
    if (!desktop) return;
    const win = getCurrentWindow();
    // desktop-frameless: room for these buttons; desktop-mac: room for the traffic lights.
    document.documentElement.classList.add(
      'desktop-app',
      isMac() ? 'desktop-mac' : 'desktop-frameless',
    );
    const sync = () => void win.isMaximized().then(setMaximized, () => undefined);
    sync();
    const unlisten = win.onResized(sync);
    const onMouseDown = (event: MouseEvent) => {
      if (event.button !== 0 || event.clientY > DRAG_BAND_PX) return;
      if ((event.target as Element | null)?.closest(INTERACTIVE)) return;
      event.preventDefault();
      void (event.detail === 2 ? win.toggleMaximize() : win.startDragging());
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      void unlisten.then((off) => off());
    };
  }, [desktop]);

  if (!desktop || isMac()) return null;
  const win = getCurrentWindow();
  const button =
    'grid h-full w-11 place-items-center text-muted-foreground transition-colors duration-150 hover:text-foreground';
  return (
    <div className="fixed top-0 right-0 z-[70] flex h-9 items-stretch">
      <button
        type="button"
        aria-label={t('window.minimize')}
        onClick={() => void win.minimize()}
        className={cn(button, 'hover:bg-white/[0.07]')}
      >
        <Minus className="size-4" strokeWidth={1.5} />
      </button>
      <button
        type="button"
        aria-label={maximized ? t('window.restore') : t('window.maximize')}
        onClick={() => void win.toggleMaximize()}
        className={cn(button, 'hover:bg-white/[0.07]')}
      >
        {maximized ? (
          <Copy className="size-3.5 -scale-x-100" strokeWidth={1.5} />
        ) : (
          <Square className="size-3.5" strokeWidth={1.5} />
        )}
      </button>
      <button
        type="button"
        aria-label={t('window.close')}
        onClick={() => void win.close()}
        className={cn(button, 'hover:bg-red-600 hover:text-white')}
      >
        <X className="size-4" strokeWidth={1.5} />
      </button>
    </div>
  );
}
