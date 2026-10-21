import type { Me } from '@mowbot/contract';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isRunningInExpoGo } from 'expo';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { router, usePathname } from 'expo-router';
import { useEffect, useRef } from 'react';
import { AppState, Platform } from 'react-native';
import i18n from '../i18n';
import {
  foregroundBehavior,
  isViewing,
  launchTokenUpdate,
  type PermissionState,
  type PushMemory,
  parsePushMemory,
  pushAvailabilityOf,
  pushTarget,
  shouldAskOnLaunch,
} from './push-rules';
import { data, keys, queryClient } from './queries';
import { api, beforeSignOut, timeoutSignal } from './session';
import { readSync, write } from './storage';

/**
 * Push notifications on this phone: the system permission, the Expo push token given to the hub
 * (PUT /me/push), what shows while the app is open, and where a tapped notification leads. The
 * hub pushes through Expo's service with `data: { url }`. Nothing happens on the web preview.
 */

/** Whether pushes can reach this app at all (a real phone, not Expo Go on Android). */
export const pushAvailability = pushAvailabilityOf({
  os: Platform.OS,
  isDevice: Device.isDevice,
  expoGo: isRunningInExpoGo(),
});

const isNative = Platform.OS === 'ios' || Platform.OS === 'android';

let memory: PushMemory = parsePushMemory(readSync('push'));

function remember(patch: Partial<PushMemory>) {
  memory = { ...memory, ...patch };
  void write('push', JSON.stringify(memory));
}

/* ------------------------------------------------------------------ permission */

async function readPermission(): Promise<PermissionState> {
  const { granted, canAskAgain } = await Notifications.getPermissionsAsync();
  return { granted, canAskAgain };
}

/**
 * Android files notifications in channels (pushes without one land in "default"), and only asks
 * for the permission (13+) once one exists.
 */
async function ensureChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync('default', {
    name: i18n.t('push.channel'),
    importance: Notifications.AndroidImportance.HIGH,
  });
}

/** The system prompt. iOS shows it once: afterwards only the phone's settings can allow. */
async function askPermission(): Promise<PermissionState> {
  const { granted, canAskAgain } = await Notifications.requestPermissionsAsync();
  const permission = { granted, canAskAgain };
  remember({ asked: true });
  queryClient.setQueryData<PermissionState>(keys.pushPermission, permission);
  return permission;
}

/** Whether the phone lets the app notify, read again whenever the user comes back to the app. */
export function usePushPermission() {
  const client = useQueryClient();
  useEffect(() => {
    if (pushAvailability !== 'available') return;
    // Back from the phone's settings, where it may have changed.
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void client.invalidateQueries({ queryKey: keys.pushPermission });
    });
    return () => subscription.remove();
  }, [client]);
  return useQuery({
    queryKey: keys.pushPermission,
    enabled: pushAvailability === 'available',
    queryFn: readPermission,
  });
}

/* ------------------------------------------------------------------ token */

function projectId(): string | undefined {
  const id = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
  return typeof id === 'string' ? id : undefined;
}

/** Asks Expo's servers (online only). */
async function expoPushToken(): Promise<string> {
  return (await Notifications.getExpoPushTokenAsync({ projectId: projectId() })).data;
}

/** Gives the hub this phone's token; null makes it stop pushing here. */
async function sendToken(token: string | null, patch: Partial<PushMemory> = {}): Promise<void> {
  const me = await data(api().PUT('/api/v1/me/push', { body: { token } }));
  queryClient.setQueryData<Me>(keys.me, me);
  remember({ token, ...patch });
}

/** The master switch on: the system prompt if it may still show, then the token to the hub. */
async function turnOn(): Promise<'on' | 'denied'> {
  await ensureChannel();
  let permission = await readPermission();
  if (!permission.granted && permission.canAskAgain) permission = await askPermission();
  if (!permission.granted) return 'denied';
  await sendToken(await expoPushToken(), { off: false });
  return 'on';
}

/** "Notifications on this phone": on asks the phone and registers, off makes the hub stop. */
export function useSetPushEnabled() {
  return useMutation({
    mutationFn: async (on: boolean): Promise<'on' | 'off' | 'denied'> => {
      if (on) return turnOn();
      await sendToken(null, { off: true });
      return 'off';
    },
  });
}

/** Launch with a session: the prompt (once), then the hub's token for this phone kept current. */
async function syncPush(): Promise<void> {
  if (pushAvailability !== 'available' || memory.off) return;
  await ensureChannel();
  let permission = await readPermission();
  if (shouldAskOnLaunch(memory, permission)) permission = await askPermission();
  const me = await queryClient.fetchQuery({
    queryKey: keys.me,
    queryFn: () => data(api().GET('/api/v1/me')),
  });
  const token = permission.granted ? await expoPushToken() : null;
  const update = launchTokenUpdate({
    memory,
    granted: permission.granted,
    token,
    hubEnabled: me.device.push.enabled,
  });
  if (update !== undefined) await sendToken(update);
}

/** Signing out: the hub stops pushing to this phone first (a signed-out phone hears nothing). */
async function forgetToken(): Promise<void> {
  if (!memory.token && !queryClient.getQueryData<Me>(keys.me)?.device.push.enabled) return;
  try {
    await api().PUT('/api/v1/me/push', { body: { token: null }, signal: timeoutSignal(4_000) });
  } finally {
    remember({ token: null });
  }
}

/* ------------------------------------------------------------------ notifications */

/** The last notification opened, so the launch one and its listener event open it once. */
let opened: string | null = null;

function open(response: Notifications.NotificationResponse | null, pathname: string) {
  if (!response || response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
  const { request } = response.notification;
  if (request.identifier === opened) return;
  opened = request.identifier;
  Notifications.clearLastNotificationResponse();
  const target = pushTarget(request.content.data);
  if (!target || isViewing(target, pathname)) return;
  if (target.kind === 'chat') {
    router.push({ pathname: '/chat/[botId]', params: { botId: target.botId } });
    return;
  }
  // A tab: back to the tabs first.
  if (router.canDismiss()) router.dismissAll();
  router.navigate(target.url);
}

/**
 * While signed in: registers this phone at launch, keeps quiet about what the user is already
 * looking at, and opens what a tapped notification is about (also one that launched the app).
 */
export function usePushNotifications(): void {
  const pathname = usePathname();
  const viewing = useRef(pathname);

  useEffect(() => {
    viewing.current = pathname;
  }, [pathname]);

  useEffect(() => {
    if (!isNative) return;
    Notifications.setNotificationHandler({
      // The screen left open in the background is not being looked at.
      handleNotification: async (notification) =>
        foregroundBehavior(
          pushTarget(notification.request.content.data),
          AppState.currentState === 'active' ? viewing.current : null,
        ),
    });
    const onResponse = (response: Notifications.NotificationResponse | null) =>
      open(response, viewing.current);
    onResponse(Notifications.getLastNotificationResponse());
    const subscription = Notifications.addNotificationResponseReceivedListener(onResponse);
    const stopForgetting = beforeSignOut(forgetToken);
    // Offline, or Expo unreachable: tried again at the next launch.
    syncPush().catch(() => undefined);
    return () => {
      subscription.remove();
      stopForgetting();
      Notifications.setNotificationHandler(null);
    };
  }, []);
}
