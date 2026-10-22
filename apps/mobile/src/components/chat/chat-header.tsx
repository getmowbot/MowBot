import type { Bot, Message } from '@mowbot/contract';
import { router } from 'expo-router';
import { ArrowLeft, ChevronLeft, Ellipsis, EllipsisVertical } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type LayoutChangeEvent, StyleSheet, View } from 'react-native';
import Animated, {
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { type BotMood, statusLabel } from '../../lib/bot-mood';
import { isAndroid, useLiquidGlass } from '../../lib/platform';
import { colors, springs, themed } from '../../theme';
import { BotAvatar } from '../bot-avatar';
import { IconButton } from '../ui/button';
import { EdgeFade } from '../ui/edge-fade';
import { ShimmerText } from '../ui/shimmer-text';
import { Surface } from '../ui/surface';
import { T } from '../ui/text';
import { useBotMenu } from './bot-menu';

/** The bot's face in the floating header: big, as in a group chat. */
const FACE = 64;
/** The widest the name capsule grows, what the bot does included. */
const PILL_MAX = 240;

interface Props {
  bot: Bot;
  mood: BotMood;
  /** The answer being written: what it runs shows at once. */
  live?: Message | null;
  onLayout(event: LayoutChangeEvent): void;
}

/** The bot's name, and what it is doing · its role (the model is in its settings). */
function Identity({ bot, mood, live }: { bot: Bot; mood: BotMood; live?: Message | null }) {
  const { t } = useTranslation();
  return (
    <>
      <BotAvatar seed={bot.avatarSeed} size={34} mood={mood} />
      <View style={styles.names}>
        <T variant="callout" numberOfLines={1} style={styles.name}>
          {bot.name}
        </T>
        <ShimmerText active={mood !== 'idle'} style={styles.status} numberOfLines={1}>
          {`${statusLabel(bot, mood, t, live)} · ${bot.role}`}
        </ShimmerText>
      </View>
    </>
  );
}

/** What the capsule holds: the name, and under it what the bot does right now. */
function PillContent({ name, doing }: { name: string; doing: string | null }) {
  return (
    <View style={styles.pillContent}>
      <T variant="footnote" numberOfLines={1} style={styles.name}>
        {name}
      </T>
      {doing !== null && (
        <Animated.View entering={FadeIn.duration(220).delay(90)} exiting={FadeOut.duration(120)}>
          <ShimmerText active style={styles.doing} numberOfLines={1}>
            {doing}
          </ShimmerText>
        </Animated.View>
      )}
    </View>
  );
}

/**
 * Who you talk to, as in a group chat: the bot's face, its name in a glass capsule tucked under
 * it. While the bot works, the capsule grows (a spring, the glass with it) to say what it does
 * under its name.
 */
function Face({ bot, mood, live }: { bot: Bot; mood: BotMood; live?: Message | null }) {
  const { t } = useTranslation();
  const glass = useLiquidGlass();
  const reduced = useReducedMotion();
  const doing = mood === 'idle' ? null : statusLabel(bot, mood, t, live);
  // The content's own size, measured out of sight; the glass springs to it.
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const width = useSharedValue(0);
  const height = useSharedValue(0);
  const target = useSharedValue(0);
  useEffect(() => {
    if (!size) return;
    const first = width.get() === 0;
    target.set(size.width);
    width.set(first || reduced ? size.width : withSpring(size.width, springs.soft));
    height.set(first || reduced ? size.height : withSpring(size.height, springs.soft));
  }, [size, reduced, width, height, target]);
  const sized = useAnimatedStyle(() =>
    width.get() === 0 ? {} : { width: width.get(), height: height.get() },
  );
  // The content stays centered in the glass while it grows or shrinks.
  const centered = useAnimatedStyle(() => ({
    transform: [{ translateX: (width.get() - target.get()) / 2 }],
  }));
  return (
    <View style={styles.face} accessible accessibilityLabel={`${bot.name}, ${bot.role}`}>
      <BotAvatar seed={bot.avatarSeed} size={FACE} mood={mood} />
      <View style={styles.measure} pointerEvents="none">
        <View
          onLayout={(event) => {
            const { width: w, height: h } = event.nativeEvent.layout;
            setSize((was) =>
              was?.width === w && was.height === h ? was : { width: w, height: h },
            );
          }}
        >
          <PillContent name={bot.name} doing={doing} />
        </View>
      </View>
      <Animated.View style={[styles.pill, { borderRadius: glass ? 16 : 14 }, sized]}>
        <Surface variant="bar" radius={glass ? 16 : 14} style={StyleSheet.absoluteFill} />
        <Animated.View
          style={size ? [styles.pillInside, { width: size.width }, centered] : undefined}
        >
          <PillContent name={bot.name} doing={doing} />
        </Animated.View>
      </Animated.View>
    </View>
  );
}

/**
 * The chat's top bar, floating over the conversation: back on the left, ⋯ on the right, round,
 * and the bot's face and name centered between them. iOS 26: Liquid Glass over a fade; older
 * iOS: the same in blur; Android: a center-aligned Material 3 top app bar.
 */
export function ChatHeader({ bot, mood, live, onLayout }: Props) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const openMenu = useBotMenu(bot);
  const back = () => (router.canGoBack() ? router.back() : router.replace('/'));
  const optionsLabel = t('chat.options', { name: bot.name });

  if (isAndroid) {
    return (
      <View onLayout={onLayout} style={[styles.appBar, { paddingTop: insets.top }]}>
        <View style={styles.appBarRow}>
          <IconButton icon={ArrowLeft} label={t('common.back')} onPress={back} size={44} />
          <View style={styles.center}>
            <View style={styles.identity}>
              <Identity bot={bot} mood={mood} live={live} />
            </View>
          </View>
          <IconButton icon={EllipsisVertical} label={optionsLabel} onPress={openMenu} size={44} />
        </View>
      </View>
    );
  }

  return (
    <View onLayout={onLayout} style={[styles.floating, { paddingTop: insets.top + 4 }]}>
      <EdgeFade edge="top" style={styles.fade} />
      <View style={styles.side}>
        <IconButton icon={ChevronLeft} label={t('common.back')} onPress={back} raised size={44} />
      </View>
      <View style={styles.center}>
        <Face bot={bot} mood={mood} live={live} />
      </View>
      <View style={styles.side}>
        <IconButton icon={Ellipsis} label={optionsLabel} onPress={openMenu} raised size={44} />
      </View>
    </View>
  );
}

const styles = themed(() =>
  StyleSheet.create({
    appBar: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      backgroundColor: colors.background,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    appBarRow: {
      height: 64,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingHorizontal: 4,
    },
    // Between the two buttons, which have the same width: the title sits in the middle.
    center: { flex: 1, minWidth: 0, alignItems: 'center' },
    identity: { maxWidth: '100%', flexDirection: 'row', alignItems: 'center', gap: 8 },
    floating: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      flexDirection: 'row',
      // The round buttons sit level with the face.
      alignItems: 'flex-start',
      gap: 10,
      paddingHorizontal: 12,
      paddingBottom: 8,
    },
    fade: { position: 'absolute', top: 0, left: 0, right: 0, bottom: -24 },
    names: { flexShrink: 1, minWidth: 0 },
    // The round buttons, level with the middle of the face.
    side: { marginTop: (FACE - 44) / 2 },
    face: { maxWidth: '100%', alignItems: 'center' },
    // Tucked under the face, overlapping it a little; as wide as its content needs.
    pill: { marginTop: -10, overflow: 'hidden' },
    pillContent: {
      minHeight: 28,
      maxWidth: PILL_MAX,
      paddingHorizontal: 12,
      paddingVertical: 5,
      alignItems: 'center',
      justifyContent: 'center',
    },
    // Laid out at its final size while the glass grows or shrinks around it.
    pillInside: { position: 'absolute', top: 0, left: 0 },
    // Where the capsule's content is measured: out of sight, as wide as it may grow.
    measure: {
      position: 'absolute',
      top: 0,
      width: PILL_MAX,
      alignItems: 'center',
      opacity: 0,
    },
    doing: { marginTop: 1, fontSize: 11.5, lineHeight: 14 },
    name: { fontWeight: '600', lineHeight: 18 },
    status: { fontSize: 11.5, lineHeight: 14 },
  }),
);
