import type { AgentClient } from '../computers/agent-client';

/**
 * What a bot leaves open on its computer: Chrome tabs (through the local DevTools endpoint)
 * and application windows (X11). The computer itself remembers which ones each bot opened,
 * in `~/.mowbot/bots/<botId>/`, so tidying up still works after a hub restart.
 */

export interface Tab {
  id: string;
  title: string;
  url: string;
}

export interface AppWindow {
  id: string;
  className: string;
  name: string;
}

export interface Inventory {
  tabs: Tab[];
  /** Application windows: the desktop's own (panel, wallpaper) and Chrome's are left out. */
  windows: AppWindow[];
  /** Ids of the tabs and windows the bot opened. */
  mine: Set<string>;
  /** Which bot opened each tracked tab (tab id → bot id), for every bot of the computer. */
  owners: Map<string, string>;
}

/** Window classes that belong to the desktop or to Chrome (whose tabs are handled apart). */
const SYSTEM_WINDOWS = new Set([
  'google-chrome',
  'xfce4-panel',
  'xfdesktop',
  'xfwm4',
  'xfce4-notifyd',
  'wrapper-2.0',
]);

const TAB_ID = /^[0-9A-F]{32}$/i;
const WINDOW_ID = /^\d{1,12}$/;

export const isTabId = (id: string) => TAB_ID.test(id);
export const isWindowId = (id: string) => WINDOW_ID.test(id);

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

function prelude(botId: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(botId)) throw new Error('Invalid bot id');
  return [
    'DEVTOOLS=http://127.0.0.1:9222',
    `STATE="$HOME/.mowbot/bots/${botId}"`,
    'mkdir -p "$STATE" && touch "$STATE/tabs" "$STATE/windows"',
    'devtools() { curl -fs -o /dev/null --max-time 2 "$DEVTOOLS/json/version"; }',
    `pages() { curl -fs --max-time 5 "$DEVTOOLS/json/list" | jq -r '.[] | select(.type == "page") | .id'; }`,
  ].join('\n');
}

/**
 * Opens a page in the computer's shared Chrome, by default in place of the bot's current tab
 * (a new tab is opened, then the previous one closed, so bots don't pile tabs up). Waits for
 * Chrome after a cold boot and restarts it, with its DevTools port, if it was closed.
 */
export function openUrlScript(botId: string, url: string, newTab: boolean): string {
  return [
    prelude(botId),
    `URL=${quote(url)}`,
    'for i in $(seq 1 75); do devtools && break; sleep 0.2; done',
    'if ! devtools; then',
    '  nohup /usr/local/bin/mowbot-chrome >/dev/null 2>&1 &',
    '  for i in $(seq 1 100); do devtools && break; sleep 0.2; done',
    'fi',
    'devtools || { echo "Chrome ne répond pas" >&2; exit 1; }',
    // Forget the tabs closed since (by the user, or by a click in the page).
    `grep -Fxf <(printf '%s\\n' $(pages)) "$STATE/tabs" > "$STATE/tabs.next" || true`,
    'ID=$(curl -fs -X PUT "$DEVTOOLS/json/new?$URL" | jq -r .id)',
    '[ -n "$ID" ] || { echo "Chrome n\'a pas ouvert la page" >&2; exit 1; }',
    'curl -fs -o /dev/null "$DEVTOOLS/json/activate/$ID"',
    `if [ ${newTab ? 1 : 0} = 0 ] && [ -s "$STATE/tabs.next" ]; then`,
    `  curl -fs -o /dev/null "$DEVTOOLS/json/close/$(tail -n 1 "$STATE/tabs.next")" || true`,
    `  sed -i '$d' "$STATE/tabs.next"`,
    'fi',
    'echo "$ID" >> "$STATE/tabs.next" && mv "$STATE/tabs.next" "$STATE/tabs"',
    'xdotool search --onlyvisible --class google-chrome windowactivate >/dev/null 2>&1 || true',
    'sleep 1.5',
  ].join('\n');
}

/** Lists Chrome tabs, application windows and what the bot opened, as tab-separated sections. */
export function inventoryScript(botId: string): string {
  return [
    prelude(botId),
    'echo "#tabs"',
    `devtools && curl -fs --max-time 5 "$DEVTOOLS/json/list" | jq -r '.[] | select(.type == "page") | [.id, .title, .url] | @tsv'`,
    'echo "#windows"',
    'for w in $(xdotool search --onlyvisible --name . 2>/dev/null | sort -u); do',
    `  class=$(xprop -id "$w" WM_CLASS 2>/dev/null | sed -n 's/.*, "\\(.*\\)"$/\\1/p')`,
    `  [ -n "$class" ] && printf '%s\\t%s\\t%s\\n' "$w" "$class" "$(xdotool getwindowname "$w" 2>/dev/null)"`,
    'done',
    'echo "#mine"',
    'cat "$STATE/tabs" "$STATE/windows"',
    'echo "#owners"',
    'for dir in "$HOME"/.mowbot/bots/*/; do',
    `  while read -r tab; do [ -n "$tab" ] && printf '%s\\t%s\\n' "$tab" "$(basename "$dir")"; done < "$dir/tabs"`,
    'done 2>/dev/null',
    'true',
  ].join('\n');
}

/** Processes started by bots, tagged `MOWBOT_BOT` by the bash tool: pid, bot id, command. */
export function processesScript(): string {
  return [
    'for p in /proc/[0-9]*; do',
    `  bot=$(tr '\\0' '\\n' < "$p/environ" 2>/dev/null | sed -n 's/^MOWBOT_BOT=//p')`,
    `  [ -n "$bot" ] && printf '%s\\t%s\\t%s\\n' "\${p#/proc/}" "$bot" "$(tr '\\0\\n' '  ' < "$p/cmdline" | cut -c1-150)"`,
    'done',
    'true',
  ].join('\n');
}

export function parseProcesses(stdout: string): { pid: string; botId: string; command: string }[] {
  return (
    stdout
      .split('\n')
      .map((line) => line.split('\t'))
      .filter(([pid, botId, command]) => pid && botId && command?.trim())
      .map(([pid = '', botId = '', command = '']) => ({ pid, botId, command: command.trim() }))
      // The shell that runs a tagged command is not worth listing.
      .filter((p) => !p.command.startsWith('bash -lc export MOWBOT_BOT='))
  );
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };

/** DevTools escapes page titles as HTML. */
const unescapeHtml = (text: string) =>
  text.replace(/&(amp|lt|gt|quot|#39);/g, (_, name: string) => ENTITIES[name] ?? '');

export function parseInventory(stdout: string): Inventory {
  const inventory: Inventory = { tabs: [], windows: [], mine: new Set(), owners: new Map() };
  let section = '';
  for (const line of stdout.split('\n')) {
    if (line.startsWith('#')) {
      section = line.slice(1).trim();
      continue;
    }
    if (!line.trim()) continue;
    const [id = '', a = '', b = ''] = line.split('\t');
    if (section === 'tabs' && isTabId(id)) {
      inventory.tabs.push({ id, title: unescapeHtml(a), url: b });
    }
    if (section === 'windows' && isWindowId(id) && !SYSTEM_WINDOWS.has(a.toLowerCase())) {
      inventory.windows.push({ id, className: a, name: b });
    }
    if (section === 'mine') inventory.mine.add(id.trim());
    if (section === 'owners' && isTabId(id)) inventory.owners.set(id, a.trim());
  }
  return inventory;
}

/**
 * Closes tabs and windows, then forgets them. Chrome quits with its last tab, so a new tab is
 * left behind when needed. Windows get a polite alt+F4: an app asking to save stays open.
 * Prints `closed <id>` for each one that is gone.
 */
export function closeScript(botId: string, tabs: string[], windows: string[]): string {
  if (!tabs.every(isTabId) || !windows.every(isWindowId)) throw new Error('Invalid id');
  return [
    prelude(botId),
    `TABS="${tabs.join(' ')}"`,
    `WINDOWS="${windows.join(' ')}"`,
    'CLOSED=""',
    'if [ -n "$TABS" ] && devtools; then',
    `  LEFT=$(pages | grep -Fvxf <(printf '%s\\n' $TABS) | grep -c . || true)`,
    `  [ "$LEFT" = 0 ] && curl -fs -o /dev/null -X PUT "$DEVTOOLS/json/new?chrome://newtab/"`,
    '  for id in $TABS; do curl -fs -o /dev/null "$DEVTOOLS/json/close/$id" && CLOSED="$CLOSED $id"; done',
    'fi',
    'for w in $WINDOWS; do',
    '  xdotool windowactivate --sync "$w" key --clearmodifiers alt+F4 >/dev/null 2>&1 || true',
    '  for i in $(seq 1 10); do',
    '    xdotool search --onlyvisible --name . 2>/dev/null | grep -qx "$w" || { CLOSED="$CLOSED $w"; break; }',
    '    sleep 0.2',
    '  done',
    'done',
    'for f in tabs windows; do',
    `  grep -Fvxf <(printf '%s\\n' $CLOSED) "$STATE/$f" > "$STATE/$f.next" || true`,
    '  mv "$STATE/$f.next" "$STATE/$f"',
    'done',
    `for id in $CLOSED; do echo "closed $id"; done`,
  ].join('\n');
}

export async function inventory(agent: AgentClient, botId: string): Promise<Inventory> {
  const result = await agent.exec(inventoryScript(botId), { timeoutMs: 20_000 });
  return parseInventory(result.stdout);
}

/** Closes what is given (or, by default, everything the bot opened); returns what closed. */
export async function closeOpened(
  agent: AgentClient,
  botId: string,
  target: { tabs: string[]; windows: string[] },
): Promise<Set<string>> {
  if (target.tabs.length === 0 && target.windows.length === 0) return new Set();
  const result = await agent.exec(closeScript(botId, target.tabs, target.windows), {
    timeoutMs: 30_000 + target.windows.length * 3_000,
  });
  return new Set(
    result.stdout
      .split('\n')
      .filter((line) => line.startsWith('closed '))
      .map((line) => line.slice('closed '.length).trim()),
  );
}

/** What the bot opened and is still open. */
export function openedBy(inv: Inventory): { tabs: string[]; windows: string[] } {
  return {
    tabs: inv.tabs.filter((t) => inv.mine.has(t.id)).map((t) => t.id),
    windows: inv.windows.filter((w) => inv.mine.has(w.id)).map((w) => w.id),
  };
}

/** Records windows as opened by the bot (seen appearing while it worked). */
export async function rememberWindows(
  agent: AgentClient,
  botId: string,
  ids: string[],
): Promise<void> {
  const valid = ids.filter(isWindowId);
  if (valid.length === 0) return;
  await agent.exec(`${prelude(botId)}\nprintf '%s\\n' ${valid.join(' ')} >> "$STATE/windows"`, {
    timeoutMs: 10_000,
  });
}
