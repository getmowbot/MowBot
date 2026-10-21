import type { Bot, FeedItem, Notification, Task } from '@mowbot/contract';
import { afterEach, describe, expect, it } from 'vitest';
import { messages } from '../src/db/schema';
import { bearer, createTestApp, setupOwner } from './helpers';

let t: Awaited<ReturnType<typeof createTestApp>> | undefined;

afterEach(async () => {
  await t?.close();
  t = undefined;
});

async function start() {
  t = await createTestApp();
  const { app, services } = t;
  const auth = bearer((await setupOwner(app)).accessToken);
  const inject = async <T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: unknown,
  ) => {
    const res = await app.inject({ method, url, headers: auth, payload: payload as object });
    return { status: res.statusCode, body: (res.body ? res.json() : null) as T };
  };
  const chef = (await inject<{ items: Bot[] }>('GET', '/api/v1/bots')).body.items[0] as Bot;
  return { inject, chef, services };
}

describe('clearing the activity tab and the notifications', () => {
  it('deletes finished tasks and starts the feed over, keeping the bots’ conversations', async () => {
    const { inject, chef, services } = await start();
    const give = async (title: string) =>
      (await inject<Task>('POST', '/api/v1/tasks', { assigneeBotId: chef.id, title })).body;
    const done = await give('Rapport');
    const ongoing = await give('Veille');
    await inject('PATCH', `/api/v1/tasks/${done.id}`, { status: 'done', result: 'Envoyé' });
    await services.runtime.settle();
    await services.db.insert(messages).values({
      botId: chef.id,
      fromBotId: chef.id,
      role: 'user',
      kind: 'chat',
      parts: [{ type: 'text', text: 'Note pour plus tard' }],
      modelMessages: [],
      status: 'done',
    });
    const feed = async () =>
      (await inject<{ items: FeedItem[] }>('GET', '/api/v1/feed')).body.items;
    expect(await feed()).toHaveLength(1);

    expect((await inject('POST', '/api/v1/activity/clear')).status).toBe(204);
    const left = (await inject<{ items: Task[] }>('GET', '/api/v1/tasks')).body.items;
    expect(left.map((task) => task.id)).toEqual([ongoing.id]);
    expect(await feed()).toEqual([]);
    const chat = await inject<{ items: unknown[] }>('GET', `/api/v1/bots/${chef.id}/messages`);
    expect(JSON.stringify(chat.body.items)).toContain('Note pour plus tard');
  });

  it('empties the notifications', async () => {
    const { inject, services } = await start();
    await services.notifications.create({ botId: null, priority: 'urgent', title: 'A' });
    await services.notifications.create({ botId: null, priority: 'digest', title: 'B' });
    expect((await inject('DELETE', '/api/v1/notifications')).status).toBe(204);
    const list = await inject<{ items: Notification[]; unread: number }>(
      'GET',
      '/api/v1/notifications',
    );
    expect(list.body).toEqual({ items: [], unread: 0 });
  });
});
