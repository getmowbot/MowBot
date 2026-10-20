import type { LucideIcon } from 'lucide-react-native';
import { useSyncExternalStore } from 'react';
import { ActionSheetIOS, Alert, Platform } from 'react-native';
import i18n from '../i18n';

export interface MenuOption {
  label: string;
  onPress(): void;
  destructive?: boolean;
  /** Shown on Android and the web (the iOS action sheet has no icons). */
  icon?: LucideIcon;
}

export interface Menu {
  title?: string;
  message?: string;
  options: MenuOption[];
}

// Android and the web draw the menu themselves (OptionsHost): this is the menu on screen.
let current: Menu | null = null;
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};

export function useOpenMenu(): Menu | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}

export function closeMenu(): void {
  current = null;
  emit();
}

/** A list of actions: the native action sheet on iOS, a bottom sheet elsewhere. */
export function openOptions(menu: Menu): void {
  if (Platform.OS === 'ios') {
    const labels = [...menu.options.map((o) => o.label), i18n.t('common.cancel')];
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: menu.title,
        message: menu.message,
        options: labels,
        cancelButtonIndex: labels.length - 1,
        destructiveButtonIndex: menu.options.flatMap((o, i) => (o.destructive ? [i] : [])),
        userInterfaceStyle: 'dark',
      },
      (index) => menu.options[index]?.onPress(),
    );
    return;
  }
  current = menu;
  emit();
}

/** Asks before doing something; resolves to the answer. */
export function confirm(
  title: string,
  message?: string,
  action: { label?: string; destructive?: boolean } = {},
): Promise<boolean> {
  if (Platform.OS === 'web') {
    return Promise.resolve(globalThis.confirm([title, message].filter(Boolean).join('\n\n')));
  }
  return new Promise((resolve) => {
    Alert.alert(
      title,
      message,
      [
        { text: i18n.t('common.cancel'), style: 'cancel', onPress: () => resolve(false) },
        {
          text: action.label ?? i18n.t('common.confirm'),
          style: action.destructive ? 'destructive' : 'default',
          onPress: () => resolve(true),
        },
      ],
      { cancelable: true, onDismiss: () => resolve(false), userInterfaceStyle: 'dark' },
    );
  });
}

/** Shows an error the user should see (a failed action). */
export function alertError(message: string): void {
  if (Platform.OS === 'web') globalThis.alert(message);
  else Alert.alert(message, undefined, undefined, { userInterfaceStyle: 'dark' });
}
