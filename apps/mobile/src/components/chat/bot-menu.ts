import type { Bot } from '@mowbot/contract';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import {
  ArrowRightLeft,
  Eraser,
  FolderOpen,
  Monitor,
  Pencil,
  Settings2,
  Trash2,
} from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { alertError, confirm, type MenuOption, openOptions } from '../../lib/options-menu';
import { keys } from '../../lib/queries';
import { api } from '../../lib/session';

/** The ⋯ menu of a conversation: everything the user can do with this bot. */
export function useBotMenu(bot: Bot | undefined): () => void {
  const { t } = useTranslation();
  const client = useQueryClient();
  const clear = useMutation({
    mutationFn: async (botId: string) => {
      const { error } = await api().DELETE('/api/v1/bots/{id}/messages', {
        params: { path: { id: botId } },
      });
      if (error) throw error;
    },
    onSuccess: (_, botId) =>
      client.setQueryData(keys.messages(botId), { items: [], nextCursor: null }),
    onError: () => alertError(t('common.actionFailed')),
  });
  const remove = useMutation({
    mutationFn: async (botId: string) => {
      const { error } = await api().DELETE('/api/v1/bots/{id}', {
        params: { path: { id: botId } },
      });
      if (error) throw error;
    },
    onSuccess: (_, botId) => {
      client.setQueryData<Bot[]>(keys.bots, (list) => list?.filter((b) => b.id !== botId));
      if (router.canGoBack()) router.back();
      else router.replace('/');
    },
    onError: () => alertError(t('common.actionFailed')),
  });

  return () => {
    if (!bot) return;
    const options: MenuOption[] = [
      {
        label: t('chat.menuSettings'),
        icon: Settings2,
        onPress: () => router.push(`/bot/${bot.id}`),
      },
      {
        label: t('chat.menuRename'),
        icon: Pencil,
        onPress: () => router.push(`/bot/${bot.id}?rename=1`),
      },
    ];
    if (!bot.isChef) {
      options.push({
        label: t('chat.menuMove'),
        icon: ArrowRightLeft,
        onPress: () => router.push(`/bot/${bot.id}/move`),
      });
    }
    if (bot.computerId) {
      options.push({
        label: t('chat.menuPc'),
        icon: Monitor,
        onPress: () => router.push(`/pc/${bot.computerId}?bot=${bot.id}`),
      });
    }
    if (bot.workspaceId) {
      options.push({
        label: t('chat.menuFiles'),
        icon: FolderOpen,
        onPress: () => router.push(`/files/${bot.workspaceId}`),
      });
    }
    options.push({
      label: t('chat.menuClear'),
      icon: Eraser,
      destructive: true,
      onPress: () =>
        void confirm(t('chat.menuClear'), t('chat.clearConfirm', { name: bot.name }), {
          label: t('chat.menuClear'),
          destructive: true,
        }).then((ok) => ok && clear.mutate(bot.id)),
    });
    if (!bot.isChef) {
      options.push({
        label: t('chat.menuDelete', { name: bot.name }),
        icon: Trash2,
        destructive: true,
        onPress: () =>
          void confirm(
            t('chat.menuDelete', { name: bot.name }),
            t('chat.deleteConfirm', { name: bot.name }),
            { label: t('common.delete'), destructive: true },
          ).then((ok) => ok && remove.mutate(bot.id)),
      });
    }
    openOptions({ title: bot.name, options });
  };
}
