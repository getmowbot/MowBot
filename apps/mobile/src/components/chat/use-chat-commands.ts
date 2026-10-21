import type { Bot } from '@mowbot/contract';
import { router } from 'expo-router';
import {
  CalendarClock,
  Eraser,
  FolderOpen,
  type LucideIcon,
  Monitor,
  Plug,
  Settings2,
  Square,
  Vault,
} from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { Keyboard } from 'react-native';
import { botCommands, type CommandName } from '../../lib/chat-input';
import { useStopBot } from '../../lib/queries';
import { useClearConversation } from './bot-menu';

export interface ChatCommand {
  name: CommandName;
  title: string;
  hint: string;
  icon: LucideIcon;
}

const ICONS: Record<CommandName, LucideIcon> = {
  stop: Square,
  clear: Eraser,
  pc: Monitor,
  files: FolderOpen,
  settings: Settings2,
  mcp: Plug,
  vault: Vault,
  routines: CalendarClock,
};

/** The `/` commands of a conversation (titled in the user's language), and running one. */
export function useChatCommands(bot: Bot): {
  commands: ChatCommand[];
  run(name: CommandName): void;
} {
  const { t } = useTranslation();
  const stop = useStopBot(bot.id);
  const clear = useClearConversation();

  const commands = botCommands(bot).map((name) => ({
    name,
    title: t(`chatInput.commands.${name}.title`),
    hint: t(`chatInput.commands.${name}.hint`, { name: bot.name }),
    icon: ICONS[name],
  }));

  // Another screen opens: the keyboard goes down first.
  const open = (href: Parameters<typeof router.push>[0]) => {
    Keyboard.dismiss();
    router.push(href);
  };

  const run = (name: CommandName) => {
    switch (name) {
      case 'stop':
        stop.mutate();
        return;
      case 'clear':
        clear(bot);
        return;
      case 'pc':
        if (bot.computerId) open(`/pc/${bot.computerId}?bot=${bot.id}`);
        return;
      case 'files':
        if (bot.workspaceId) open(`/files/${bot.workspaceId}`);
        return;
      case 'settings':
        open(`/bot/${bot.id}`);
        return;
      case 'mcp':
        open('/mcp');
        return;
      case 'vault':
        open('/vault');
        return;
      case 'routines':
        open(`/routines?bot=${bot.id}`);
        return;
    }
  };

  return { commands, run };
}
