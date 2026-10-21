import { createMowbotClient } from '@mowbot/api-client';
import type { Problem } from '@mowbot/contract';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { currentLocale, i18n } from '../i18n';
import { guessDeviceName } from './utils';

export const apiBaseUrl: string = import.meta.env.VITE_MOWBOT_API_URL ?? '';

export const client = createMowbotClient({
  baseUrl: apiBaseUrl,
  mode: 'web',
});
export const api = client.api;

export type AuthStatus = 'loading' | 'setup' | 'anonymous' | 'authenticated' | 'offline';

export interface AuthContextValue {
  status: AuthStatus;
  setup(input: { setupToken: string; displayName: string; password: string }): Promise<void>;
  login(password: string): Promise<void>;
  logout(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** Problems worded in the app's language; the others show the hub's detail. */
const WORDED_PROBLEMS = [
  'wrong_password',
  'invalid_credentials',
  'invalid_setup_token',
  'already_set_up',
  'validation_failed',
  'rate_limited',
  'computer_not_running',
  'no_session',
  'invalid_totp',
  'empty_login',
  'invalid_site',
  'request_answered',
  'empty_answer',
  'mcp_url_required',
  'mcp_command_required',
  'mcp_unreachable',
  'mcp_needs_auth',
  'mcp_no_computer',
  'mcp_not_oauth',
  'mcp_oauth_state',
  'mcp_oauth_failed',
] as const;
type WordedProblem = (typeof WORDED_PROBLEMS)[number];

const isWorded = (code: string | undefined): code is WordedProblem =>
  WORDED_PROBLEMS.includes(code as WordedProblem);

export function problemMessage(error: unknown, fallback: string): string {
  const problem = error as Partial<Problem> | undefined;
  const code = problem?.type?.replace('urn:mowbot:problem:', '');
  if (isWorded(code)) return i18n.t(`problems.${code}`);
  return problem?.detail ?? fallback;
}

const device = () => ({ name: guessDeviceName(), kind: 'web' as const });

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await api.GET('/api/v1/auth/status');
      if (cancelled) return;
      if (error || !data) return setStatus('offline');
      if (data.setupRequired) return setStatus('setup');
      const restored = await client.refresh();
      if (!cancelled) setStatus(restored ? 'authenticated' : 'anonymous');
    })().catch(() => !cancelled && setStatus('offline'));
    return () => {
      cancelled = true;
    };
  }, []);

  const setup = useCallback<AuthContextValue['setup']>(async (input) => {
    const { data, error } = await api.POST('/api/v1/auth/setup', {
      body: { ...input, device: device() },
    });
    if (error || !data) throw error;
    client.setSession(data);
    // A new account starts in French: give it the language the owner set it up in.
    await api.PATCH('/api/v1/me', { body: { locale: currentLocale() } }).catch(() => undefined);
    setStatus('authenticated');
  }, []);

  const login = useCallback<AuthContextValue['login']>(async (password) => {
    const { data, error } = await api.POST('/api/v1/auth/login', {
      body: { password, device: device() },
    });
    if (error || !data) throw error;
    client.setSession(data);
    setStatus('authenticated');
  }, []);

  const logout = useCallback(async () => {
    await api.POST('/api/v1/auth/logout').catch(() => undefined);
    client.setSession(null);
    setStatus('anonymous');
  }, []);

  const value = useMemo(() => ({ status, setup, login, logout }), [status, setup, login, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>');
  return value;
}
