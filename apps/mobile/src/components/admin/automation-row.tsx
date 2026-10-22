import type { Automation, Bot } from '@mowbot/contract';
import { CircleAlert, Pause, Play, SquareTerminal, Trash2 } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { useDeleteAutomation, useUpdateAutomation } from '../../lib/admin-queries';
import {
  type AutomationTone,
  automationDetail,
  automationStatusLabel,
  automationTone,
  errorDetail,
  outcomeText,
  rhythmText,
  untilText,
} from '../../lib/automations';
import {
  alertError,
  confirm,
  type MenuOption,
  openOptions,
  showInfo,
} from '../../lib/options-menu';
import { colors, themed } from '../../theme';
import { BotAvatar } from '../bot-avatar';
import { T } from '../ui/text';
import { Touchable } from '../ui/touchable';
import { StatusText } from './parts';

/** Divider inset of a ListCard of automations (past the avatar). */
export const AUTOMATION_ROW_INSET = 16 + 32 + 12;

/** White while it runs, amber when its last runs failed, dim when paused or over. */
const TONE_COLORS: Record<AutomationTone, string> = themed(() => ({
  live: colors.accentStrong,
  warning: colors.warning,
  off: colors.textFaint,
}));

interface Props {
  automation: Automation;
  bot: Bot | undefined;
  /** The home card it keeps up to date, while it exists. */
  canvasTitle: string | undefined;
}

/** One automation: whose, how often, what it last did; pause, command and delete on tap. */
export function AutomationRow({ automation, bot, canvasTitle }: Props) {
  const { t, i18n } = useTranslation();
  const update = useUpdateAutomation();
  const remove = useDeleteAutomation();
  const tone = automationTone(automation);
  const botName = bot?.name ?? t('board.canvas.someBot');
  const rhythm = rhythmText(automation.intervalSeconds, t);
  const summary = [
    botName,
    rhythm,
    automation.until && automation.status !== 'stopped'
      ? untilText(automation.until, t, i18n.language)
      : null,
    canvasTitle ? t('appAdmin.automations.canvas', { title: canvasTitle }) : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const failed = () => alertError(t('common.actionFailed'));

  const openMenu = () => {
    const options: MenuOption[] = [];
    if (automation.status === 'active') {
      options.push({
        label: t('appAdmin.automations.pause'),
        icon: Pause,
        onPress: () => update.mutate({ id: automation.id, status: 'paused' }, { onError: failed }),
      });
    } else if (automation.status === 'paused') {
      options.push({
        label: t('appAdmin.automations.resume'),
        icon: Play,
        onPress: () => update.mutate({ id: automation.id, status: 'active' }, { onError: failed }),
      });
    }
    options.push({
      label: t('appAdmin.automations.showCommand'),
      icon: SquareTerminal,
      onPress: () =>
        showInfo(
          t('appAdmin.automations.commandOf', { name: automation.name }),
          automation.command,
        ),
    });
    // A failed run: its label as the title, the script's own words below.
    const { lastOutcome } = automation;
    const error = errorDetail(lastOutcome);
    if (lastOutcome && error) {
      options.push({
        label: t('appAdmin.automations.showError'),
        icon: CircleAlert,
        onPress: () => showInfo(outcomeText(lastOutcome, t), error),
      });
    }
    options.push({
      label: t('appAdmin.automations.delete'),
      icon: Trash2,
      destructive: true,
      onPress: () =>
        void confirm(
          t('appAdmin.automations.confirmDelete', { name: automation.name }),
          t('appAdmin.automations.deleteHint', { bot: botName }),
          { label: t('common.delete'), destructive: true },
        ).then((ok) => ok && remove.mutate(automation.id, { onError: failed })),
    });
    openOptions({ title: automation.name, message: `${botName} · ${rhythm}`, options });
  };

  return (
    <Touchable
      accessibilityRole="button"
      accessibilityHint={t('common.options')}
      onPress={openMenu}
      style={styles.row}
    >
      <BotAvatar seed={bot?.avatarSeed ?? automation.botId} size={32} still />
      <View style={styles.text}>
        <View style={styles.head}>
          <T variant="body" numberOfLines={1} style={styles.name}>
            {automation.name}
          </T>
          <StatusText color={TONE_COLORS[tone]} label={automationStatusLabel(automation, t)} />
        </View>
        <T variant="footnote" tone="muted" numberOfLines={2}>
          {summary}
        </T>
        <T
          variant="footnote"
          tone="faint"
          numberOfLines={2}
          style={tone === 'warning' ? styles.warning : undefined}
        >
          {automationDetail(automation, t, i18n.language)}
        </T>
      </View>
    </Touchable>
  );
}

const styles = themed(() =>
  StyleSheet.create({
    row: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 12,
      paddingHorizontal: 16,
      paddingVertical: 12,
      overflow: 'hidden',
    },
    text: { flex: 1, minWidth: 0, gap: 2 },
    head: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    name: { flex: 1, minWidth: 0 },
    warning: { color: colors.warning },
  }),
);
