import type { Bot } from '@mowbot/contract';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import {
  ChevronDown,
  FolderCode,
  FolderPlus,
  FolderX,
  Laptop,
  TriangleAlert,
} from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { Keyboard, StyleSheet } from 'react-native';
import { alertError, type MenuOption, openOptions, showInfo } from '../../lib/options-menu';
import {
  activeProject,
  mirrorFor,
  mirrorShort,
  mirrorText,
  pickTargets,
  projectChoices,
  projectsFor,
} from '../../lib/projects';
import {
  projectError,
  useConnectors,
  usePickOnComputer,
  useProjects,
  useSetBotProject,
} from '../../lib/projects-queries';
import { colors, themed, tint } from '../../theme';
import { Dot } from '../admin/parts';
import { presenceColor } from '../projects/parts';
import { T } from '../ui/text';
import { Touchable } from '../ui/touchable';

/**
 * Opens the menu of the project the bot works in (the chip, `/project`): pick another, none, see
 * the mirror's conflicts, or add a folder. Null while there is nothing to pick nor any computer
 * to add a folder from.
 */
export function useProjectMenu(bot: Bot): (() => void) | null {
  const { t } = useTranslation();
  const projects = useProjects();
  const connectors = useConnectors();
  const set = useSetBotProject(bot.id);
  const pick = usePickOnComputer(bot.id);
  const choices = projectChoices(bot, projects.data, connectors.data, t);
  const canAdd = (connectors.data?.length ?? 0) > 0;
  if (choices.length === 0 && !canAdd) return null;

  /** A folder is added from a desktop app: this one asks a connected app to open its picker. */
  const addFolder = () => {
    const { able, outdated } = pickTargets(connectors.data);
    const name = (c: { hostname: string | null; name: string }) => c.hostname ?? c.name;
    const message = [
      t('projects.add.fromDesktop', { name: bot.name }),
      ...outdated.map((c) => t('projects.add.updateApp', { computer: name(c) })),
      able.length + outdated.length === 0 ? t('projects.add.noComputer') : null,
    ]
      .filter(Boolean)
      .join('\n\n');
    if (able.length === 0) {
      showInfo(t('projects.add.title'), message);
      return;
    }
    openOptions({
      title: t('projects.add.title'),
      message,
      options: able.map((computer) => ({
        label: t('projects.add.pickOn', { computer: name(computer) }),
        icon: Laptop,
        onPress: () => {
          showInfo(
            t('projects.add.title'),
            t('projects.add.picking', { computer: name(computer) }),
          );
          pick.mutate(computer.id, {
            onSuccess: (project) => {
              if (project) void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              else showInfo(t('projects.add.title'), t('projects.add.cancelled'));
            },
            onError: (err) => alertError(projectError(err, t('projects.add.failed'))),
          });
        },
      })),
    });
  };

  return () => {
    Keyboard.dismiss();
    const current = activeProject(bot, projects.data);
    const mirror = current ? mirrorFor(current, bot) : null;
    // Offline matters only for projects worked on directly (a mirror keeps working).
    const unreachable = projectsFor(bot, projects.data).some((p) => !p.online && !p.mirror);
    const message = [
      t('projects.active.message', { name: bot.name }),
      current && mirror
        ? t('projects.active.mirror', {
            folder: mirror.folder,
            state: mirrorText(mirror, current.online, t),
          })
        : null,
      unreachable ? t('projects.active.offline', { name: bot.name }) : null,
    ]
      .filter(Boolean)
      .join('\n');
    const options: MenuOption[] = [];
    if (current && mirror && mirror.conflicts.length > 0) {
      options.push({
        label: t('projects.active.conflicts'),
        icon: TriangleAlert,
        onPress: () => router.push(`/projects/${current.id}`),
      });
    }
    for (const choice of choices) {
      options.push({
        label: choice.label,
        icon: choice.projectId ? FolderCode : FolderX,
        onPress: () => {
          if (choice.checked) return;
          void Haptics.selectionAsync();
          set.mutate(choice.projectId, {
            onError: (err) => alertError(projectError(err, t('projects.active.notSaved'))),
          });
        },
      });
    }
    if (canAdd)
      options.push({ label: t('projects.add.label'), icon: FolderPlus, onPress: addFolder });
    openOptions({ title: t('projects.active.title'), message, options });
  };
}

/**
 * Over the message field: the project the bot works in (a folder of the user's computer, its
 * computer online or not, how its mirror stands); a tap opens the menu. Hidden while there is
 * nothing to pick nor any computer to add a folder from.
 */
export function ProjectChip({ bot }: { bot: Bot }) {
  const { t } = useTranslation();
  const projects = useProjects();
  const open = useProjectMenu(bot);
  if (!open) return null;
  const current = activeProject(bot, projects.data);
  const mirror = current ? mirrorFor(current, bot) : null;
  const state = mirror ? mirrorShort(mirror, t) : null;
  const name = current?.name ?? t('projects.active.none');
  const warn = Boolean(mirror && (mirror.conflicts.length > 0 || mirror.status === 'error'));
  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={t('projects.active.label', {
        project: current
          ? [name, current.online ? t('projects.online') : t('projects.offline'), state]
              .filter(Boolean)
              .join(', ')
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
      {current && !current.online && !mirror ? (
        <T variant="caption" tone="faint">
          {t('projects.offline')}
        </T>
      ) : null}
      {state ? (
        <T
          variant="caption"
          tone={warn ? undefined : 'faint'}
          numberOfLines={1}
          style={warn ? styles.warn : undefined}
        >
          {state}
        </T>
      ) : null}
      <ChevronDown size={13} color={colors.textFaint} />
    </Touchable>
  );
}

const styles = themed(() =>
  StyleSheet.create({
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
      backgroundColor: tint.ink(0.04),
      overflow: 'hidden',
    },
    name: { flexShrink: 1 },
    warn: { color: colors.warning },
  }),
);
