import { describe, expect, it } from 'vitest';
import {
  foregroundBehavior,
  isViewing,
  launchTokenUpdate,
  NO_PUSH_MEMORY,
  type PushMemory,
  parsePushMemory,
  pushAvailabilityOf,
  pushIsBlocked,
  pushIsOn,
  pushTarget,
  shouldAskOnLaunch,
} from './push-rules';

const TOKEN = 'ExponentPushToken[abc]';
const BOT = '0b6a2f5e-3c1d-4e8a-9f00-123456789abc';

describe('push availability', () => {
  it('needs a real phone, and a build on Android', () => {
    expect(pushAvailabilityOf({ os: 'ios', isDevice: true, expoGo: true })).toBe('available');
    expect(pushAvailabilityOf({ os: 'android', isDevice: true, expoGo: false })).toBe('available');
    expect(pushAvailabilityOf({ os: 'android', isDevice: true, expoGo: true })).toBe(
      'expoGoAndroid',
    );
    expect(pushAvailabilityOf({ os: 'ios', isDevice: false, expoGo: true })).toBe('simulator');
    expect(pushAvailabilityOf({ os: 'web', isDevice: true, expoGo: false })).toBe('web');
  });
});

describe('push target', () => {
  it('reads the hub’s chat and activity URLs', () => {
    expect(pushTarget({ url: `/chat/${BOT}` })).toEqual({
      kind: 'chat',
      botId: BOT,
      url: `/chat/${BOT}`,
    });
    expect(pushTarget({ url: '/activity' })).toEqual({ kind: 'activity', url: '/activity' });
  });

  it('ignores anything else', () => {
    expect(pushTarget(undefined)).toBeNull();
    expect(pushTarget(null)).toBeNull();
    expect(pushTarget({})).toBeNull();
    expect(pushTarget({ url: 42 })).toBeNull();
    expect(pushTarget({ url: 'https://evil.example/chat/x' })).toBeNull();
    expect(pushTarget({ url: '/chat/' })).toBeNull();
    expect(pushTarget({ url: '/chat/a/b' })).toBeNull();
    expect(pushTarget({ url: '/chat/../settings' })).toBeNull();
    expect(pushTarget({ url: '/vault' })).toBeNull();
  });
});

describe('foreground notifications', () => {
  const chat = pushTarget({ url: `/chat/${BOT}` });
  const activity = pushTarget({ url: '/activity' });
  const silent = {
    shouldShowBanner: false,
    shouldShowList: false,
    shouldPlaySound: false,
    shouldSetBadge: false,
  };
  const shown = { ...silent, shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true };

  it('stay quiet about the chat the user is reading', () => {
    expect(isViewing(chat, `/chat/${BOT}`)).toBe(true);
    expect(isViewing(chat, `/chat/${BOT}/`)).toBe(true);
    expect(foregroundBehavior(chat, `/chat/${BOT}`)).toEqual(silent);
    expect(foregroundBehavior(activity, '/activity')).toEqual(silent);
  });

  it('show anywhere else', () => {
    expect(foregroundBehavior(chat, '/chat/another-bot')).toEqual(shown);
    expect(foregroundBehavior(chat, '/')).toEqual(shown);
    expect(foregroundBehavior(activity, `/chat/${BOT}`)).toEqual(shown);
    expect(foregroundBehavior(null, '/activity')).toEqual(shown);
    expect(foregroundBehavior(chat, null)).toEqual(shown);
  });
});

describe('push memory', () => {
  it('reads what was stored, and survives garbage', () => {
    const memory: PushMemory = { asked: true, off: false, token: TOKEN };
    expect(parsePushMemory(JSON.stringify(memory))).toEqual(memory);
    expect(parsePushMemory(null)).toEqual(NO_PUSH_MEMORY);
    expect(parsePushMemory('not json')).toEqual(NO_PUSH_MEMORY);
    expect(parsePushMemory('null')).toEqual(NO_PUSH_MEMORY);
    expect(parsePushMemory('{"asked":"yes","token":3}')).toEqual(NO_PUSH_MEMORY);
  });
});

describe('push at launch', () => {
  const fresh = NO_PUSH_MEMORY;
  const registered: PushMemory = { asked: true, off: false, token: TOKEN };
  const off: PushMemory = { asked: true, off: true, token: null };
  const undecided = { granted: false, canAskAgain: true };
  const denied = { granted: false, canAskAgain: false };
  const granted = { granted: true, canAskAgain: true };

  it('shows the system prompt once, unless turned off', () => {
    expect(shouldAskOnLaunch(fresh, undecided)).toBe(true);
    expect(shouldAskOnLaunch({ ...fresh, asked: true }, undecided)).toBe(false);
    expect(shouldAskOnLaunch(off, undecided)).toBe(false);
    expect(shouldAskOnLaunch(fresh, granted)).toBe(false);
    expect(shouldAskOnLaunch(fresh, denied)).toBe(false);
  });

  it('registers a new or changed token', () => {
    const update = (memory: PushMemory, token: string, hubEnabled: boolean) =>
      launchTokenUpdate({ memory, granted: true, token, hubEnabled });
    expect(update(fresh, TOKEN, false)).toBe(TOKEN);
    expect(update(registered, TOKEN, true)).toBeUndefined();
    expect(update(registered, 'ExponentPushToken[new]', true)).toBe('ExponentPushToken[new]');
    // Signed in again (a new device on the hub), or the hub forgot the token.
    expect(update(registered, TOKEN, false)).toBe(TOKEN);
  });

  it('stops the hub when the phone no longer allows notifications', () => {
    expect(
      launchTokenUpdate({ memory: registered, granted: false, token: null, hubEnabled: true }),
    ).toBeNull();
    expect(
      launchTokenUpdate({ memory: registered, granted: false, token: null, hubEnabled: false }),
    ).toBeUndefined();
  });

  it('leaves notifications turned off alone', () => {
    expect(launchTokenUpdate({ memory: off, granted: true, token: TOKEN, hubEnabled: false })).toBe(
      undefined,
    );
  });
});

describe('push switch', () => {
  it('is on when the hub has a token and the phone allows', () => {
    expect(pushIsOn(true, { granted: true, canAskAgain: true })).toBe(true);
    expect(pushIsOn(true, undefined)).toBe(true);
    expect(pushIsOn(true, { granted: false, canAskAgain: false })).toBe(false);
    expect(pushIsOn(false, { granted: true, canAskAgain: true })).toBe(false);
  });

  it('is blocked only when the phone refuses for good', () => {
    expect(pushIsBlocked({ granted: false, canAskAgain: false })).toBe(true);
    expect(pushIsBlocked({ granted: false, canAskAgain: true })).toBe(false);
    expect(pushIsBlocked({ granted: true, canAskAgain: false })).toBe(false);
    expect(pushIsBlocked(undefined)).toBe(false);
  });
});
