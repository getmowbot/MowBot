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
import { guessDeviceName } from './utils';

export const client = createMowbotClient({
  baseUrl: import.meta.env.VITE_MOWBOT_API_URL ?? '',
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

const PROBLEM_MESSAGES: Record<string, string> = {
  invalid_credentials: 'Mot de passe incorrect.',
  invalid_setup_token: 'Jeton de configuration invalide.',
  already_set_up: 'Cette instance est déjà configurée.',
  validation_failed: 'Certains champs sont invalides.',
  rate_limited: 'Trop de tentatives. Réessaie dans une minute.',
};

export function problemMessage(error: unknown, fallback: string): string {
  const problem = error as Partial<Problem> | undefined;
  const code = problem?.type?.replace('urn:mowbot:problem:', '');
  return (code && PROBLEM_MESSAGES[code]) ?? problem?.detail ?? fallback;
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
