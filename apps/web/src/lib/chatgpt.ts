import type { ChatgptCredential } from '@mowbot/contract';
import { currentLocale, i18n } from '../i18n';
import { api, problemMessage } from './auth';
import { type ChatgptSignInError, desktop } from './projects';

/** Where to get the desktop app, which runs "Sign in with ChatGPT". */
export const DESKTOP_DOWNLOAD_URL = 'https://github.com/getmowbot/MowBot/releases/latest';

/** The first desktop app version that signs in with ChatGPT. */
const SIGN_IN_SINCE = [0, 2, 3];

function atLeast(version: string, minimum: number[]): boolean {
  const parts = version.split(/[.+-]/).map((part) => Number.parseInt(part, 10) || 0);
  for (const [index, wanted] of minimum.entries()) {
    const part = parts[index] ?? 0;
    if (part !== wanted) return part > wanted;
  }
  return true;
}

/** The desktop app is too old to sign in with ChatGPT. */
class OldDesktopApp extends Error {}

const isSignInError = (value: unknown): value is ChatgptSignInError =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { code?: unknown }).code === 'string' &&
  !('type' in value);

/** The client OpenAI issued during a sign-in that failed after its callback: retried with it. */
export function issuedClientOf(error: unknown): string | null {
  return isSignInError(error) ? error.clientId : null;
}

/**
 * Signs in with ChatGPT in the desktop app (in the user's browser) for this hub, or again for
 * `providerId`; resolves with what to hand to the hub.
 */
export async function chatgptCredential(
  providerId: string | undefined,
  issuedClient: string | null = null,
): Promise<ChatgptCredential> {
  const status = await desktop.status().catch(() => null);
  if (status && !atLeast(status.version, SIGN_IN_SINCE)) throw new OldDesktopApp();
  const { data, error } = await api.GET('/api/v1/providers/chatgpt/sign-in', {
    params: { query: providerId ? { providerId } : {} },
  });
  if (error || !data) throw error;
  return desktop.chatgptSignIn({
    hostId: data.hostId,
    agentName: data.agentName,
    clientId: data.clientId ?? issuedClient,
    loginHint: data.loginHint,
    lang: currentLocale(),
  });
}

function signInErrorText(code: string): string | null {
  switch (code) {
    case 'cancelled':
      return null;
    case 'timeout':
      return i18n.t('models.chatgpt.errors.timeout');
    case 'denied':
      return i18n.t('models.chatgpt.errors.denied');
    case 'browser':
      return i18n.t('models.chatgpt.errors.browser');
    case 'listen':
      return i18n.t('models.chatgpt.errors.listen');
    case 'plan_not_granted':
      return i18n.t('models.chatgpt.errors.planNotGranted');
    case 'other_client':
      return i18n.t('models.chatgpt.errors.otherClient');
    case 'incomplete':
      return i18n.t('models.chatgpt.errors.incomplete');
    case 'exchange':
      return i18n.t('models.chatgpt.errors.exchange');
    case 'unreachable':
      return i18n.t('models.chatgpt.errors.unreachable');
    case 'nonce':
      return i18n.t('models.chatgpt.errors.mismatch');
    default:
      return i18n.t('models.chatgpt.errors.failed');
  }
}

function hubErrorText(code: string | undefined): string | null {
  switch (code) {
    case 'chatgpt_plan_not_granted':
      return i18n.t('models.chatgpt.errors.planNotGranted');
    case 'chatgpt_incomplete':
      return i18n.t('models.chatgpt.errors.incomplete');
    case 'chatgpt_invalid_id_token':
      return i18n.t('models.chatgpt.errors.invalidIdToken');
    case 'chatgpt_other_account':
      return i18n.t('models.chatgpt.errors.otherAccount');
    case 'chatgpt_sign_in_required':
      return i18n.t('models.chatgpt.errors.signInRequired');
    default:
      return null;
  }
}

/**
 * What to tell the user about a failed sign-in (`null`: they cancelled it): the desktop app's
 * error, the hub's, or the fallback.
 */
export function chatgptErrorMessage(error: unknown, fallback: string): string | null {
  if (error instanceof OldDesktopApp) return i18n.t('models.chatgpt.errors.updateDesktop');
  if (isSignInError(error)) {
    const text = signInErrorText(error.code);
    return text && error.detail && ['exchange', 'failed'].includes(error.code)
      ? `${text.replace(/\.$/, '')} (${error.detail}).`
      : text;
  }
  // An app without the command (older than 0.2.3) refuses it with a sentence.
  if (typeof error === 'string') return i18n.t('models.chatgpt.errors.updateDesktop');
  const code = (error as { type?: string } | null)?.type?.replace('urn:mowbot:problem:', '');
  return hubErrorText(code) ?? problemMessage(error, fallback);
}
