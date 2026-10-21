import type { Bot } from '@mowbot/contract';
import * as Haptics from 'expo-haptics';
import { ChevronDown, FolderCode, FolderX } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { Keyboard, StyleSheet } from 'react-native';
import { alertError, openOptions } from '../../lib/options-menu';
import { activeProject, projectChoices } from '../../lib/projects';
import {
  projectError,
  useConnectors,
  useProjects,
  useSetBotProject,
} from '../../lib/projects-queries';
import { colors } from '../../theme';
import { Dot } from '../admin/parts';
import { presenceColor } from '../projects/parts';
import { T } from '../ui/text';
import { Touchable } from '../ui/touchable';

/**
 * Opens the menu of the project the bot works in (the chip, `/project`); null while the bot may
 * use no project.
 */
export function useProjectMenu(bot: Bot): (() => void) | null {
  const { t } = useTranslation();
  const projects = useProjects();
  const connectors = useConnectors();
  const set = useSetBotProject(bot.id);
  const choices = projectChoices(bot, projects.data, connectors.data, t);
  if (choices.length === 0) return null;
  return () => {
    Keyboard.dismiss();
    const message = [
      t('projects.active.message', { name: bot.name }),
      choices.some((c) => c.offline) ? t('projects.active.offline', { name: bot.name }) : null,
    ]
      .filter(Boolean)
      .join('\n');
    openOptions({
      title: t('projects.active.title'),
      message,
      options: choices.map((choice) => ({
        label: choice.label,
        icon: choice.projectId ? FolderCode : FolderX,
        onPress: () => {
          if (choice.checked) return;
          void Haptics.selectionAsync();
          set.mutate(choice.projectId, {
            onError: (err) => alertError(projectError(err, t('projects.active.notSaved'))),
          });
        },
      })),
    });
  };
}

/**
 * Over the message field: the project the bot works in (a folder of the user's computer, its
 * computer online or not); a tap picks another one. Hidden while the bot may use no project.
 */
export function ProjectChip({ bot }: { bot: Bot }) {
  const { t } = useTranslation();
  const projects = useProjects();
  const open = useProjectMenu(bot);
  if (!open) return null;
  const current = activeProject(bot, projects.data);
  const name = current?.name ?? t('projects.active.none');
  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={t('projects.active.label', {
        project: current
          ? `${name}, ${current.online ? t('projects.online') : t('projects.offline')}`
          : name,
      })}
      onPress={open}
      style={styles.chip}
    >
      <FolderCode size={14} color={colors.textMuted} />
      <T
        variant="caption"
        tone={current ? 'default' : 'muted'}
        numberOfLines={1}
        style={styles.name}
      >
        {name}
      </T>
      {current ? <Dot color={presenceColor(current.online)} /> : null}
      {current && !current.online ? (
        <T variant="caption" tone="faint">
          {t('projects.offline')}
        </T>
      ) : null}
      <ChevronDown size={13} color={colors.textFaint} />
    </Touchable>
  );
}

const styles = StyleSheet.create({
  chip: {
    alignSelf: 'flex-start',
    maxWidth: '100%',
    marginLeft: 4,
    marginBottom: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 30,
    paddingHorizontal: 11,
    paddingVertical: 5,
    borderRadius: 15,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
    overflow: 'hidden',
  },
  name: { flexShrink: 1 },
});
