import type { Bot, FileEntry, MessageMention, Project, Team } from '@mowbot/contract';
import { File as FileIcon, Folder, FolderCode, Users } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import type { CommandName } from '../../lib/chat-input';
import { colors, shape } from '../../theme';
import { BotAvatar } from '../bot-avatar';
import { Surface } from '../ui/surface';
import { T } from '../ui/text';
import { Touchable } from '../ui/touchable';
import type { ChatCommand } from './use-chat-commands';

/**
 * Just above the message field, in the flow: the conversation makes room for it (a list
 * floating outside its parent misses taps on Android). Glass like the field, as tall as a third
 * of the screen at most, scrolling past that.
 */
function Panel({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const { height } = useWindowDimensions();
  return (
    <Surface
      variant="bar"
      radius={shape.card}
      accessibilityLabel={t('chatInput.suggestions')}
      style={[styles.panel, { maxHeight: Math.min(320, height * 0.36) }]}
    >
      <ScrollView
        keyboardShouldPersistTaps="always"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.content}
      >
        {children}
      </ScrollView>
    </Surface>
  );
}

function Row({
  label,
  onPress,
  children,
}: {
  label: string;
  onPress(): void;
  children: ReactNode;
}) {
  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={styles.row}
    >
      {children}
    </Touchable>
  );
}

/** What `/` offers: each command, its title and what it does. */
export function CommandSuggestions({
  commands,
  onPick,
}: {
  commands: ChatCommand[];
  onPick(name: CommandName): void;
}) {
  return (
    <Panel>
      {commands.map(({ name, title, hint, icon: Icon }) => (
        <Row key={name} label={`/${name}, ${title}`} onPress={() => onPick(name)}>
          <View style={styles.icon}>
            <Icon size={18} color={colors.textMuted} />
          </View>
          <View style={styles.text}>
            <T variant="callout" numberOfLines={1}>
              <T variant="callout" style={styles.strong}>
                {`/${name}`}
              </T>
              <T variant="callout" tone="muted">{`  ${title}`}</T>
            </T>
            <T variant="caption" tone="faint" numberOfLines={1}>
              {hint}
            </T>
          </View>
        </Row>
      ))}
    </Panel>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View>
      <T variant="overline" tone="faint" style={styles.section}>
        {title}
      </T>
      {children}
    </View>
  );
}

interface MentionSuggestionsProps {
  bots: Bot[];
  teams: Team[];
  /** Folders of the user's computers this bot may work in. */
  projects: Project[];
  files: FileEntry[];
  /** Files still being looked up (nothing found yet). */
  searching: boolean;
  onPick(mention: MessageMention): void;
}

/** What `@` offers: other bots, teams, projects, and files of the bot's workspace. */
export function MentionSuggestions({
  bots,
  teams,
  projects,
  files,
  searching,
  onPick,
}: MentionSuggestionsProps) {
  const { t } = useTranslation();
  const empty = bots.length + teams.length + projects.length + files.length === 0;
  return (
    <Panel>
      {empty ? (
        <T variant="footnote" tone="faint" style={styles.none}>
          {searching ? t('chatInput.mentions.searching') : t('chatInput.mentions.none')}
        </T>
      ) : null}
      {bots.length > 0 ? (
        <Section title={t('chatInput.mentions.bots')}>
          {bots.map((bot) => (
            <Row
              key={bot.id}
              label={bot.name}
              onPress={() => onPick({ kind: 'bot', id: bot.id, label: bot.name })}
            >
              <View style={styles.icon}>
                <BotAvatar seed={bot.avatarSeed} size={22} still />
              </View>
              <T variant="callout" numberOfLines={1} style={styles.name}>
                {bot.name}
              </T>
              <T variant="caption" tone="faint" numberOfLines={1} style={styles.detail}>
                {bot.role}
              </T>
            </Row>
          ))}
        </Section>
      ) : null}
      {teams.length > 0 ? (
        <Section title={t('chatInput.mentions.teams')}>
          {teams.map((team) => (
            <Row
              key={team.id}
              label={team.name}
              onPress={() => onPick({ kind: 'team', id: team.id, label: team.name })}
            >
              <View style={styles.icon}>
                <Users size={18} color={colors.textMuted} />
              </View>
              <T variant="callout" numberOfLines={1} style={styles.name}>
                {team.name}
              </T>
              {team.mission ? (
                <T variant="caption" tone="faint" numberOfLines={1} style={styles.detail}>
                  {team.mission}
                </T>
              ) : null}
            </Row>
          ))}
        </Section>
      ) : null}
      {projects.length > 0 ? (
        <Section title={t('chatInput.mentions.projects')}>
          {projects.map((project) => (
            <Row
              key={project.id}
              label={project.name}
              onPress={() => onPick({ kind: 'project', id: project.id, label: project.name })}
            >
              <View style={styles.icon}>
                <FolderCode size={18} color={colors.textMuted} />
              </View>
              <T variant="callout" numberOfLines={1} style={styles.name}>
                {project.name}
              </T>
              <T variant="caption" tone="faint" numberOfLines={1} style={styles.detail}>
                {project.online ? t('projects.online') : t('projects.offline')}
              </T>
            </Row>
          ))}
        </Section>
      ) : null}
      {files.length > 0 ? (
        <Section title={t('chatInput.mentions.files')}>
          {files.map((entry) => {
            const Icon = entry.type === 'directory' ? Folder : FileIcon;
            return (
              <Row
                key={entry.path}
                label={entry.path}
                onPress={() => onPick({ kind: 'file', path: entry.path, label: entry.path })}
              >
                <View style={styles.icon}>
                  <Icon size={18} color={colors.textMuted} />
                </View>
                {/* Long paths keep their start and their name. */}
                <T variant="callout" numberOfLines={1} ellipsizeMode="middle" style={styles.text}>
                  {entry.path}
                </T>
              </Row>
            );
          })}
        </Section>
      ) : null}
    </Panel>
  );
}

const styles = StyleSheet.create({
  panel: { marginBottom: 8 },
  content: { paddingVertical: 6 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 44,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  icon: { width: 22, alignItems: 'center' },
  text: { flex: 1, minWidth: 0 },
  strong: { fontWeight: '600' },
  name: { flexShrink: 1 },
  // Takes what the name leaves, never pushes it out.
  detail: { flex: 1, minWidth: 0, textAlign: 'right' },
  section: { paddingHorizontal: 14, paddingTop: 8, paddingBottom: 2 },
  none: { paddingHorizontal: 14, paddingVertical: 10 },
});
