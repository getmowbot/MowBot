/**
 * Push notifications, the parts that need no phone: where a notification leads, whether it
 * shows while the app is open, and what to tell the hub at launch. Used by `push.ts`.
 */

/**
 * Whether this app can receive pushes: only on a real phone (not the web preview, not a
 * simulator), and not in Expo Go on Android (remote pushes left it with SDK 53).
 */
export type PushAvailability = 'available' | 'web' | 'simulator' | 'expoGoAndroid';

export function pushAvailabilityOf(env: {
  os: string;
  isDevice: boolean;
  expoGo: boolean;
}): PushAvailability {
  if (env.os !== 'ios' && env.os !== 'android') return 'web';
  if (!env.isDevice) return 'simulator';
  if (env.os === 'android' && env.expoGo) return 'expoGoAndroid';
  return 'available';
}

/** Where the hub sends the user (`data.url`): a bot's conversation, or the activity tab. */
export type PushTarget =
  | { kind: 'chat'; botId: string; url: string }
  | { kind: 'activity'; url: '/activity' };

const CHAT_URL = /^\/chat\/([A-Za-z0-9-]{1,64})$/;

/** The notification's destination, if it is one the app knows (anything else is ignored). */
export function pushTarget(data: unknown): PushTarget | null {
  const url = (data as { url?: unknown } | null | undefined)?.url;
  if (typeof url !== 'string') return null;
  if (url === '/activity') return { kind: 'activity', url };
  const botId = CHAT_URL.exec(url)?.[1];
  return botId ? { kind: 'chat', botId, url } : null;
}

/**
 * Whether the user already looks at what the notification is about (`pathname`: expo-router's,
 * null when the app is not in front).
 */
export function isViewing(target: PushTarget | null, pathname: string | null | undefined) {
  return target !== null && pathname?.replace(/\/+$/, '') === target.url;
}

/** Same fields as expo-notifications' `NotificationBehavior`. */
export interface ForegroundBehavior {
  shouldShowBanner: boolean;
  shouldShowList: boolean;
  shouldPlaySound: boolean;
  shouldSetBadge: boolean;
}

/**
 * A notification arriving while the app is open: silent when the user is already on its chat
 * (or on the activity), shown like any other otherwise.
 */
export function foregroundBehavior(
  target: PushTarget | null,
  pathname: string | null | undefined,
): ForegroundBehavior {
  const show = !isViewing(target, pathname);
  return {
    shouldShowBanner: show,
    shouldShowList: show,
    shouldPlaySound: show,
    shouldSetBadge: false,
  };
}

/** What this phone remembers about push, across launches. */
export interface PushMemory {
  /** The system prompt was shown (it is shown once, after signing in). */
  asked: boolean;
  /** The user turned notifications off on this phone. */
  off: boolean;
  /** The Expo push token last given to the hub. */
  token: string | null;
}

export const NO_PUSH_MEMORY: PushMemory = { asked: false, off: false, token: null };

export function parsePushMemory(raw: string | null): PushMemory {
  if (!raw) return NO_PUSH_MEMORY;
  try {
    const value = JSON.parse(raw) as Partial<PushMemory> | null;
    return {
      asked: value?.asked === true,
      off: value?.off === true,
      token: typeof value?.token === 'string' ? value.token : null,
    };
  } catch {
    return NO_PUSH_MEMORY;
  }
}

export interface PermissionState {
  granted: boolean;
  canAskAgain: boolean;
}

/** Launch with a session: the system prompt, once, unless notifications were turned off. */
export function shouldAskOnLaunch(memory: PushMemory, permission: PermissionState): boolean {
  return !memory.off && !memory.asked && !permission.granted && permission.canAskAgain;
}

/**
 * Launch with a session, once the permission (and, when granted, the token) is known: the
 * token to give the hub, `null` to make it stop, or `undefined` when it is up to date.
 */
export function launchTokenUpdate(input: {
  memory: PushMemory;
  granted: boolean;
  token: string | null;
  /** Whether the hub has a token for this device (a new sign-in starts without one). */
  hubEnabled: boolean;
}): string | null | undefined {
  const { memory, granted, token, hubEnabled } = input;
  if (memory.off) return undefined;
  // Turned off in the phone's settings: the hub stops pushing (and starts again once allowed).
  if (!granted) return hubEnabled ? null : undefined;
  if (token && (token !== memory.token || !hubEnabled)) return token;
  return undefined;
}

/** The master switch: on when the hub has a token and the phone lets the app notify. */
export function pushIsOn(hubEnabled: boolean, permission: PermissionState | undefined): boolean {
  return hubEnabled && permission?.granted !== false;
}

/** Notifications refused in the phone's settings: only the user can allow them, there. */
export function pushIsBlocked(permission: PermissionState | undefined): boolean {
  return permission !== undefined && !permission.granted && !permission.canAskAgain;
}
