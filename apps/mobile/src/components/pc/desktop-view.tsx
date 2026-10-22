import { RotateCw } from 'lucide-react-native';
import { type Ref, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import WebView, { type WebViewMessageEvent } from 'react-native-webview';
import {
  commandScript,
  DEFAULT_ASPECT,
  type DesktopCommand,
  desktopHtml,
  desktopSocketUrl,
  fitBox,
  parseDesktopEvent,
  type Size,
} from '../../lib/desktop';
import { CTRL_V, type KeyPress } from '../../lib/keysyms';
import { desktopTicket, useAppActive } from '../../lib/pc-queries';
import { hubUrl } from '../../lib/session';
import { colors, shape, themed } from '../../theme';
import { Button } from '../ui/button';
import { T } from '../ui/text';

export interface DesktopHandle {
  /** Typed one after the other. */
  sendKeys(keys: KeyPress[]): void;
  /** Held together (Ctrl+C). */
  sendCombo(keys: KeyPress[]): void;
  /** Puts text on the PC's clipboard and pastes it (Ctrl+V). */
  paste(text: string): void;
}

type Phase = 'loading' | 'connecting' | 'connected' | 'disconnected' | 'loadFailed';

interface Props {
  computerId: string;
  /** View-only unless the user has taken control. */
  interactive: boolean;
  /** Full screen: no frame. */
  bare?: boolean;
  /** Text copied on the PC, while the user has control. */
  onClipboard?(text: string): void;
  ref?: Ref<DesktopHandle>;
}

const RETRY_MS = 2_000;
/** Drops in a row before waiting for the user (a PC restarting comes back by itself). */
const MAX_RETRIES = 4;

// The same page for every PC: what changes is sent to it once loaded.
const HTML = desktopHtml();

/**
 * A PC's live screen: noVNC in a WebView, connected through the hub with a one-time ticket,
 * fitted in the space it is given at the PC's aspect ratio. Touches become clicks once the user
 * has control; until then it is view-only. Reconnects by itself after a drop, a few times.
 */
export function DesktopView({ computerId, interactive, bare = false, onClipboard, ref }: Props) {
  const { t } = useTranslation();
  const webView = useRef<WebView>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [aspect, setAspect] = useState(DEFAULT_ASPECT);
  const [area, setArea] = useState<Size>({ width: 0, height: 0 });
  // Remounts the WebView (a failed noVNC download is retried by loading the page again).
  const [page, setPage] = useState(0);
  // One object for the view's life: a new one could make the WebView load the page again. The
  // hub's origin makes `ws://` to the hub same-scheme (no mixed content) on both platforms.
  const [source] = useState(() => ({ html: HTML, baseUrl: hubUrl() ?? undefined }));
  const active = useAppActive();

  const loaded = useRef(false);
  const failures = useRef(0);
  const retry = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Each connection attempt; a ticket that arrives for an older one is dropped.
  const attempt = useRef(0);
  const viewOnly = useRef(!interactive);
  const paused = useRef(false);

  const send = (command: DesktopCommand) =>
    webView.current?.injectJavaScript(commandScript(command));

  const stop = () => {
    attempt.current++;
    clearTimeout(retry.current);
  };

  const connect = async () => {
    stop();
    const current = attempt.current;
    setPhase('connecting');
    const hub = hubUrl();
    try {
      const ticket = await desktopTicket(computerId);
      if (current !== attempt.current || !hub) return;
      send({
        type: 'connect',
        url: desktopSocketUrl(hub, computerId, ticket),
        viewOnly: viewOnly.current,
      });
    } catch {
      if (current === attempt.current) dropped();
    }
  };

  const dropped = () => {
    if (paused.current) return;
    failures.current++;
    if (failures.current > MAX_RETRIES) {
      stop();
      setPhase('disconnected');
      return;
    }
    setPhase('connecting');
    clearTimeout(retry.current);
    retry.current = setTimeout(() => void connect(), RETRY_MS);
  };

  /** Loads the page again (noVNC failed to download, or the web process died). */
  const reload = () => {
    stop();
    loaded.current = false;
    failures.current = 0;
    setPhase('loading');
    setPage((n) => n + 1);
  };

  const reconnect = () => {
    if (!loaded.current) {
      reload();
      return;
    }
    failures.current = 0;
    void connect();
  };

  const onMessage = (event: WebViewMessageEvent) => {
    const message = parseDesktopEvent(event.nativeEvent.data);
    if (!message) return;
    switch (message.type) {
      case 'ready':
        loaded.current = true;
        failures.current = 0;
        if (!paused.current) void connect();
        break;
      case 'connected':
        failures.current = 0;
        setPhase('connected');
        if (message.width > 0 && message.height > 0) setAspect(message.width / message.height);
        break;
      case 'disconnected':
        dropped();
        break;
      case 'clipboard':
        onClipboard?.(message.text);
        break;
      case 'error':
        // A security failure is followed by a disconnect, which retries.
        if (message.reason === 'load') {
          stop();
          setPhase('loadFailed');
        }
        break;
    }
  };

  useImperativeHandle(ref, () => ({
    sendKeys: (keys) => {
      if (keys.length > 0) send({ type: 'keys', keys });
    },
    sendCombo: (keys) => send({ type: 'combo', keys }),
    paste: (text) => send({ type: 'paste', text, keys: CTRL_V }),
  }));

  // Taking or giving back control switches noVNC between view-only and interactive.
  useEffect(() => {
    viewOnly.current = !interactive;
    webView.current?.injectJavaScript(commandScript({ type: 'viewOnly', value: !interactive }));
  }, [interactive]);

  // In the background a view-only screen is closed (nothing to see, data and battery saved);
  // in control it stays open: closing the last view hands the PC back to the bots.
  // biome-ignore lint/correctness/useExhaustiveDependencies: connect and stop only touch refs
  useEffect(() => {
    if (!active && viewOnly.current) {
      paused.current = true;
      stop();
      webView.current?.injectJavaScript(commandScript({ type: 'disconnect' }));
      return;
    }
    if (active && paused.current) {
      paused.current = false;
      failures.current = 0;
      if (loaded.current) void connect();
    }
  }, [active]);

  useEffect(
    () => () => {
      attempt.current++;
      clearTimeout(retry.current);
    },
    [],
  );

  const box = fitBox(area, aspect);
  const busy = phase === 'loading' || phase === 'connecting';

  return (
    <View
      style={[styles.area, bare && styles.areaBare]}
      onLayout={(event) => {
        const { width, height } = event.nativeEvent.layout;
        setArea({ width, height });
      }}
    >
      <View
        style={[
          styles.frame,
          bare ? styles.frameBare : styles.frameCard,
          { width: box.width, height: box.height },
        ]}
      >
        <WebView
          key={page}
          ref={webView}
          source={source}
          originWhitelist={['*']}
          onMessage={onMessage}
          onContentProcessDidTerminate={reload}
          onRenderProcessGone={reload}
          style={styles.web}
          containerStyle={styles.web}
          scrollEnabled={false}
          bounces={false}
          overScrollMode="never"
          setBuiltInZoomControls={false}
          textZoom={100}
          allowsLinkPreview={false}
          dataDetectorTypes="none"
          automaticallyAdjustContentInsets={false}
          contentInsetAdjustmentBehavior="never"
          hideKeyboardAccessoryView
          webviewDebuggingEnabled={__DEV__}
          accessibilityLabel={t('pcView.screen')}
        />
        {phase !== 'connected' && (
          <View style={styles.overlay}>
            {busy ? (
              <>
                <ActivityIndicator color={colors.textMuted} />
                <T variant="footnote" tone="muted" style={styles.center}>
                  {t(phase === 'loading' ? 'pcView.loadingViewer' : 'pcView.connecting')}
                </T>
              </>
            ) : (
              <>
                <T variant="footnote" tone="muted" style={styles.center}>
                  {t(phase === 'loadFailed' ? 'pcView.loadFailed' : 'pcView.disconnected')}
                </T>
                <Button
                  label={t('pcView.reconnect')}
                  icon={RotateCw}
                  variant="secondary"
                  onPress={reconnect}
                />
              </>
            )}
          </View>
        )}
      </View>
    </View>
  );
}

const styles = themed(() =>
  StyleSheet.create({
    area: { flex: 1, alignItems: 'center' },
    areaBare: { justifyContent: 'center' },
    frame: { backgroundColor: '#000', overflow: 'hidden' },
    frameCard: {
      borderRadius: shape.field,
      borderCurve: 'continuous',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.borderStrong,
    },
    frameBare: {},
    web: { flex: 1, backgroundColor: '#000' },
    overlay: {
      ...StyleSheet.absoluteFill,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 12,
      padding: 16,
      backgroundColor: 'rgba(0, 0, 0, 0.72)',
    },
    center: { textAlign: 'center' },
  }),
);
