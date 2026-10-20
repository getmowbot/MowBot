import type { KeyPress } from './keysyms';

/**
 * A PC's live desktop on the phone: noVNC runs in a WebView, the app drives it with commands and
 * listens to its events. noVNC is not bundled (Expo Go): the page imports it from a CDN.
 */

/**
 * Same noVNC as the web app (`@novnc/novnc` in apps/web). Its `core/rfb.js` is a browser ES
 * module whose relative imports (`./util/…`, `../vendor/pako/…`, all with `.js`) are published
 * in the package, so the CDN serves the whole graph.
 */
export const NOVNC_VERSION = '1.7.0';
export const NOVNC_MODULE_URL = `https://cdn.jsdelivr.net/npm/@novnc/novnc@${NOVNC_VERSION}/core/rfb.js`;

/** `http://host:8787` → `ws://host:8787/api/v1/computers/{id}/desktop?ticket=…` (RFB proxy). */
export function desktopSocketUrl(hubUrl: string, computerId: string, ticket: string): string {
  const base = hubUrl
    .replace(/\/+$/, '')
    .replace(/^https?:/i, (scheme) => (scheme.length === 6 ? 'wss:' : 'ws:'));
  return `${base}/api/v1/computers/${encodeURIComponent(computerId)}/desktop?ticket=${encodeURIComponent(ticket)}`;
}

/** App → page. */
export type DesktopCommand =
  | { type: 'connect'; url: string; viewOnly: boolean }
  | { type: 'disconnect' }
  | { type: 'viewOnly'; value: boolean }
  /** Pressed and released one after the other (typing). */
  | { type: 'keys'; keys: KeyPress[] }
  /** Pressed in order, released in reverse (Ctrl+C). */
  | { type: 'combo'; keys: KeyPress[] }
  /** Puts text on the PC's clipboard, then presses `keys` (Ctrl+V) to paste it. */
  | { type: 'paste'; text: string; keys: KeyPress[] };

/** Page → app. */
export type DesktopEvent =
  /** noVNC is loaded: the page can connect. */
  | { type: 'ready' }
  /** Size of the PC's screen, in pixels (0 if unknown). */
  | { type: 'connected'; width: number; height: number }
  | { type: 'disconnected' }
  | { type: 'error'; reason: 'load' | 'security'; message: string }
  /** Something was copied on the PC (only while the user has control: noVNC's rule). */
  | { type: 'clipboard'; text: string };

/** Reads a message posted by the page; null when it is not one of ours. */
export function parseDesktopEvent(raw: string): DesktopEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const event = value as Record<string, unknown>;
  const size = (key: string) => {
    const n = event[key];
    return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
  };
  switch (event.type) {
    case 'ready':
    case 'disconnected':
      return { type: event.type };
    case 'connected':
      return { type: 'connected', width: size('width'), height: size('height') };
    case 'error':
      return {
        type: 'error',
        reason: event.reason === 'security' ? 'security' : 'load',
        message: typeof event.message === 'string' ? event.message : '',
      };
    case 'clipboard':
      return typeof event.text === 'string' ? { type: 'clipboard', text: event.text } : null;
    default:
      return null;
  }
}

/** Script injected in the page to deliver a command (`true` keeps iOS from logging a warning). */
export function commandScript(command: DesktopCommand): string {
  return `window.mowbot&&window.mowbot.receive(${JSON.stringify(command)});true;`;
}

/**
 * The page hosting noVNC: a black full-bleed screen, view-only until told otherwise. It loads
 * RFB with a dynamic `import()` so a CDN failure is reported instead of leaving a black page,
 * then waits for `connect` (each connection needs a fresh one-time ticket from the app).
 */
export function desktopHtml(moduleUrl: string = NOVNC_MODULE_URL): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<style>
html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:#000;}
body{touch-action:none;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;-webkit-tap-highlight-color:transparent;}
#screen{position:absolute;inset:0;}
</style>
</head>
<body>
<div id="screen"></div>
<script>
(function () {
  var target = document.getElementById('screen');
  var RFB = null;
  var rfb = null;
  function post(message) {
    if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(message));
  }
  function screenSize() {
    var canvas = target.querySelector('canvas');
    return canvas ? { width: canvas.width, height: canvas.height } : { width: 0, height: 0 };
  }
  function disconnect() {
    var current = rfb;
    rfb = null;
    if (current) {
      try { current.disconnect(); } catch (e) {}
    }
  }
  function connect(url, viewOnly) {
    disconnect();
    if (!RFB) return;
    var current;
    try {
      current = new RFB(target, url, { shared: true });
    } catch (e) {
      post({ type: 'disconnected' });
      return;
    }
    rfb = current;
    current.scaleViewport = true;
    current.resizeSession = false;
    current.showDotCursor = false;
    current.background = '#000';
    current.viewOnly = viewOnly;
    current.addEventListener('connect', function () {
      if (rfb !== current) return;
      var size = screenSize();
      post({ type: 'connected', width: size.width, height: size.height });
    });
    current.addEventListener('disconnect', function () {
      // A connection replaced or closed on purpose is not a drop.
      if (rfb !== current) return;
      rfb = null;
      post({ type: 'disconnected' });
    });
    current.addEventListener('clipboard', function (event) {
      if (rfb !== current) return;
      var text = event && event.detail && event.detail.text;
      if (typeof text === 'string') post({ type: 'clipboard', text: text });
    });
    current.addEventListener('securityfailure', function (event) {
      var reason = event && event.detail && event.detail.reason;
      post({ type: 'error', reason: 'security', message: String(reason || '') });
    });
  }
  function press(key, down) {
    rfb.sendKey(key.keysym, key.code || null, down);
  }
  function combo(keys) {
    keys.forEach(function (key) { press(key, true); });
    keys.slice().reverse().forEach(function (key) { press(key, false); });
  }
  window.mowbot = {
    receive: function (command) {
      switch (command.type) {
        case 'connect':
          connect(command.url, command.viewOnly);
          break;
        case 'disconnect':
          disconnect();
          break;
        case 'viewOnly':
          if (rfb) rfb.viewOnly = command.value;
          break;
        case 'keys':
          if (rfb) command.keys.forEach(function (key) { press(key); });
          break;
        case 'combo':
          if (rfb) combo(command.keys);
          break;
        case 'paste':
          if (!rfb) break;
          // Sent on the same socket before the keys: the PC has the text when Ctrl+V arrives.
          rfb.clipboardPasteFrom(command.text);
          combo(command.keys);
          break;
      }
    }
  };
  import(${JSON.stringify(moduleUrl)})
    .then(function (module) {
      RFB = module.default;
      post({ type: 'ready' });
    })
    .catch(function (error) {
      post({ type: 'error', reason: 'load', message: String((error && error.message) || error) });
    });
})();
</script>
</body>
</html>`;
}

export interface Size {
  width: number;
  height: number;
}

/** The largest box of ratio `aspect` (width / height) that fits in `area`. */
export function fitBox(area: Size, aspect: number): Size {
  if (area.width <= 0 || area.height <= 0 || !(aspect > 0)) return { width: 0, height: 0 };
  const width = Math.min(area.width, area.height * aspect);
  return { width: Math.floor(width), height: Math.floor(width / aspect) };
}

/** The PC desktop's shape until noVNC reports the real one (the containers run 16:10). */
export const DEFAULT_ASPECT = 16 / 10;
