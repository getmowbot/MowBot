import { createMowbotClient } from '@mowbot/api-client';
import { describe, expect, it } from 'vitest';

/** Expo's native fetch answers with its own class, not `instanceof Response`. */
function expoLikeResponse(status: number, body: unknown) {
  const text = JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers({ 'content-type': 'application/json' }),
    text: async () => text,
    json: async () => body,
  } as unknown as Response;
}

const tokens = (accessToken: string) => ({
  accessToken,
  accessTokenExpiresAt: new Date(Date.now() + 600_000).toISOString(),
  refreshToken: `refresh-${accessToken}`,
});

describe('api client on a native fetch', () => {
  it('reads answers that are not standard Response objects', async () => {
    const client = createMowbotClient({
      baseUrl: 'http://192.168.1.10:8787',
      mode: 'native',
      fetch: async () => expoLikeResponse(200, { setupRequired: false }),
    });
    const status = await client.api.GET('/api/v1/auth/status');
    expect(status.data?.setupRequired).toBe(false);
  });

  it('refreshes the session once on 401 and retries', async () => {
    const seen: string[] = [];
    const client = createMowbotClient({
      baseUrl: 'http://192.168.1.10:8787',
      mode: 'native',
      loadRefreshToken: async () => 'refresh-old',
      fetch: async (input) => {
        const request = input instanceof Request ? input : new Request(input);
        const path = new URL(request.url).pathname;
        seen.push(`${path} ${request.headers.get('authorization') ?? '-'}`);
        if (path.endsWith('/auth/refresh')) return expoLikeResponse(200, tokens('new'));
        return request.headers.get('authorization') === 'Bearer new'
          ? expoLikeResponse(200, [])
          : expoLikeResponse(401, { type: 'urn:mowbot:problem:unauthorized' });
      },
    });
    client.setSession(tokens('old'));
    const devices = await client.api.GET('/api/v1/devices');
    expect(devices.data).toEqual([]);
    expect(seen).toEqual([
      '/api/v1/devices Bearer old',
      '/api/v1/auth/refresh -',
      '/api/v1/devices Bearer new',
    ]);
  });
});
