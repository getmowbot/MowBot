import * as SecureStore from 'expo-secure-store';

/**
 * Everything the app keeps on the device, in the Keychain / Keystore. The refresh token must
 * live there; the hub URL, language and push state ride along so they can be read
 * synchronously at launch.
 */
const KEYS = {
  hubUrl: 'mowbot.hubUrl',
  refreshToken: 'mowbot.refreshToken',
  language: 'mowbot.language',
  push: 'mowbot.push',
} as const;

export type StorageKey = keyof typeof KEYS;

const options: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
};

export function readSync(key: StorageKey): string | null {
  try {
    return SecureStore.getItem(KEYS[key], options);
  } catch {
    // An unreadable item (e.g. Keystore reset) is as good as absent.
    return null;
  }
}

/** Writes are serialized so a slow write can never land after a newer one. */
let queue: Promise<void> = Promise.resolve();

export function write(key: StorageKey, value: string | null): Promise<void> {
  queue = queue
    .then(() =>
      value === null
        ? SecureStore.deleteItemAsync(KEYS[key], options)
        : SecureStore.setItemAsync(KEYS[key], value, options),
    )
    .catch(() => undefined);
  return queue;
}
