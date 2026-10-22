import { Image } from 'expo-image';
import {
  AppWindow,
  Brain,
  BrushCleaning,
  Camera,
  Check,
  ChevronDown,
  FilePen,
  FileText,
  FolderOpen,
  Globe,
  ListChecks,
  ListPlus,
  Lock,
  LockOpen,
  type LucideIcon,
  MessageCircleQuestion,
  Monitor,
  MousePointer2,
  Search,
  Send,
  SquareTerminal,
  UserPen,
  UserPlus,
  Users,
  Wrench,
} from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import {
  type ActivityIcon,
  type ActivityPart,
  activityHeadline,
  activitySteps,
  isTalk,
  type ReasoningPart,
  type ToolPart,
  talkOf,
  toolIcon,
  toolMechanics,
  toolTitle,
} from '../lib/activity';
import { useBots } from '../lib/queries';
import { authHeaders, hubUrl } from '../lib/session';
import { colors, fonts, springs, themed, tint } from '../theme';
import { chipsOf, type Talk, TalkSheet } from './chat/bot-talk';
import { ShimmerText } from './ui/shimmer-text';
import { T } from './ui/text';
import { Touchable } from './ui/touchable';

const ICONS: Record<ActivityIcon, LucideIcon> = {
  terminal: SquareTerminal,
  file: FileText,
  'file-pen': FilePen,
  folder: FolderOpen,
  search: Search,
  globe: Globe,
  camera: Camera,
  pointer: MousePointer2,
  window: AppWindow,
  tidy: BrushCleaning,
  monitor: Monitor,
  lock: Lock,
  unlock: LockOpen,
  users: Users,
  send: Send,
  question: MessageCircleQuestion,
  'task-new': ListPlus,
  tasks: ListChecks,
  'user-new': UserPlus,
  'user-edit': UserPen,
  tool: Wrench,
  brain: Brain,
  check: Check,
};

const enter = FadeIn.springify()
  .stiffness(springs.snappy.stiffness)
  .damping(springs.snappy.damping)
  .mass(springs.snappy.mass);

function Screenshot({ workspaceId, path }: { workspaceId: string; path: string }) {
  const { t } = useTranslation();
  const base = hubUrl();
  if (!base) return null;
  return (
    <Image
      source={{
        uri: `${base}/api/v1/workspaces/${workspaceId}/files/content?path=${encodeURIComponent(path)}`,
        headers: authHeaders(),
      }}
      accessibilityLabel={t('chat.screenshot')}
      contentFit="contain"
      transition={250}
      style={styles.screenshot}
    />
  );
}

/** A message or a question to another bot: opens large, with what came back. */
function TalkStep({ part }: { part: ToolPart }) {
  const { t } = useTranslation();
  const bots = useBots();
  const [open, setOpen] = useState(false);
  const Icon = ICONS[toolIcon(part)];
  const { to, asks, text, answer } = talkOf(part);
  const bot = bots.data?.find((b) => b.id === to || b.name.toLowerCase() === to.toLowerCase()) ?? {
    id: null,
    name: to,
    avatarSeed: to,
  };
  const talk: Talk = {
    title: t(asks ? 'chat.talk.to.ask' : 'chat.talk.to.chat', { name: bot.name }),
    bot,
    text,
    answer: answer
      ? {
          title: answer.fromBot
            ? t('chat.talk.answerFrom', { name: bot.name })
            : t('chat.talk.outcome'),
          text: answer.text,
        }
      : undefined,
  };
  return (
    <View>
      <Touchable disabled={!text} onPress={() => setOpen(true)} style={styles.stepRow}>
        <Icon size={13} color={part.state === 'error' ? colors.danger : colors.textFaint} />
        <ShimmerText active={part.state === 'running'} color={colors.textFaint}>
          {toolTitle(part, t)}
        </ShimmerText>
      </Touchable>
      <TalkSheet
        talk={talk}
        chips={chipsOf(bots.data)}
        visible={open}
        onClose={() => setOpen(false)}
      />
    </View>
  );
}

function ToolStep({ part }: { part: ToolPart }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const Icon = ICONS[toolIcon(part)];
  const mechanics = toolMechanics(part, t);
  const hasDetails = Boolean(part.output || part.image || mechanics);
  return (
    <View>
      <Touchable
        disabled={!hasDetails}
        onPress={() => setOpen((value) => !value)}
        accessibilityState={{ expanded: open }}
        style={styles.stepRow}
      >
        <Icon size={13} color={part.state === 'error' ? colors.danger : colors.textFaint} />
        <ShimmerText active={part.state === 'running'} color={colors.textFaint}>
          {toolTitle(part, t)}
        </ShimmerText>
      </Touchable>
      {open && hasDetails && (
        <Animated.View entering={enter} exiting={FadeOut.duration(120)} style={styles.details}>
          {mechanics ? (
            <T variant="caption" tone="faint" style={styles.mono}>
              {mechanics}
            </T>
          ) : null}
          {part.image && <Screenshot workspaceId={part.image.workspaceId} path={part.image.path} />}
          {part.output && !part.image ? (
            <View style={styles.output}>
              <T variant="caption" tone="muted" style={styles.mono} selectable>
                {part.output}
              </T>
            </View>
          ) : null}
        </Animated.View>
      )}
    </View>
  );
}

function ReasoningStep({ part }: { part: ReasoningPart }) {
  const [open, setOpen] = useState(false);
  return (
    <Touchable onPress={() => setOpen((value) => !value)} style={styles.reasoning}>
      <Brain size={13} color={colors.textFaint} style={styles.reasoningIcon} />
      <T variant="footnote" tone="faint" style={styles.italic} numberOfLines={open ? undefined : 2}>
        {part.text.trim()}
      </T>
    </Touchable>
  );
}

/**
 * A run of actions as one quiet grey line: what the bot does right now while it works, a
 * summary once done ("2 recherches · 5 captures"). Tapping it opens the step history.
 */
export function ActivityLine({ parts, live }: { parts: ActivityPart[]; live: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const steps = activitySteps(parts);
  if (steps.length === 0 && !live) return null;
  const headline = activityHeadline(parts, live, t);
  const Icon = ICONS[headline.icon];

  return (
    <View>
      <Touchable
        disabled={steps.length === 0}
        onPress={() => setOpen((value) => !value)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        style={styles.headline}
      >
        <Animated.View key={headline.icon} entering={enter}>
          <Icon size={14} color={colors.textFaint} />
        </Animated.View>
        <Animated.View key={headline.title} entering={enter} style={styles.title}>
          <ShimmerText active={live} color={colors.textFaint}>
            {headline.title}
          </ShimmerText>
        </Animated.View>
        {!live && headline.errors > 0 && (
          <T variant="footnote" style={styles.errors}>
            · {t('activity.failures', { count: headline.errors })}
          </T>
        )}
        {steps.length > 0 && (
          <ChevronDown
            size={13}
            color={colors.textFaint}
            style={{ transform: [{ rotate: open ? '180deg' : '0deg' }] }}
          />
        )}
      </Touchable>
      {open && (
        <Animated.View entering={enter} style={styles.steps}>
          {steps.map((part, index) =>
            part.type === 'tool' ? (
              isTalk(part) ? (
                <TalkStep key={part.toolCallId} part={part} />
              ) : (
                <ToolStep key={part.toolCallId} part={part} />
              )
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: reasoning parts only ever append
              <ReasoningStep key={`reasoning-${index}`} part={part} />
            ),
          )}
        </Animated.View>
      )}
    </View>
  );
}

const styles = themed(() =>
  StyleSheet.create({
    headline: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingVertical: 3,
      alignSelf: 'flex-start',
      maxWidth: '100%',
      borderRadius: 8,
    },
    title: { flexShrink: 1 },
    errors: { color: tint.danger(0.8) },
    steps: {
      marginLeft: 6.5,
      marginTop: 4,
      paddingLeft: 12,
      borderLeftWidth: StyleSheet.hairlineWidth,
      borderLeftColor: colors.borderStrong,
      gap: 2,
    },
    stepRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingVertical: 4,
      alignSelf: 'flex-start',
      maxWidth: '100%',
      borderRadius: 8,
    },
    details: { gap: 8, paddingLeft: 21, paddingBottom: 8, paddingTop: 2 },
    mono: { fontFamily: fonts.mono },
    output: {
      maxHeight: 260,
      overflow: 'hidden',
      borderRadius: 10,
      backgroundColor: tint.ink(0.03),
      padding: 10,
    },
    screenshot: {
      width: '100%',
      aspectRatio: 16 / 10,
      borderRadius: 10,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      backgroundColor: tint.ink(0.03),
    },
    reasoning: { flexDirection: 'row', gap: 8, paddingVertical: 4, borderRadius: 8 },
    reasoningIcon: { marginTop: 3 },
    italic: { fontStyle: 'italic', flexShrink: 1 },
  }),
);
