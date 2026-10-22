import type { Bot, Message } from '@mowbot/contract';
import { router } from 'expo-router';
import { ArrowLeft, ChevronLeft, Ellipsis, EllipsisVertical } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { type LayoutChangeEvent, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { type BotMood, statusLabel } from '../../lib/bot-mood';
import { isAndroid, useLiquidGlass } from '../../lib/platform';
import { colors, themed } from '../../theme';
import { BotAvatar } from '../bot-avatar';
import { IconButton } from '../ui/button';
import { EdgeFade } from '../ui/edge-fade';
import { ShimmerText } from '../ui/shimmer-text';
import { Surface } from '../ui/surface';
import { T } from '../ui/text';
import { useBotMenu } from './bot-menu';

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
      <BotAvatar seed={bot.avatarSeed} size={26} mood={mood} />
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

/**
 * Who you talk to, as in a group chat: the bot's face, its name in a capsule tucked under it,
 * and what it does right now while it works.
 */
function Face({ bot, mood, live }: { bot: Bot; mood: BotMood; live?: Message | null }) {
  const { t } = useTranslation();
  const glass = useLiquidGlass();
  return (
    <View style={styles.face} accessible accessibilityLabel={`${bot.name}, ${bot.role}`}>
      <BotAvatar seed={bot.avatarSeed} size={44} mood={mood} />
      <Surface variant="bar" radius={glass ? 16 : 14} style={styles.namePill}>
        <T variant="footnote" numberOfLines={1} style={styles.name}>
          {bot.name}
        </T>
      </Surface>
      {mood !== 'idle' && (
        <ShimmerText active style={styles.doing} numberOfLines={1}>
          {statusLabel(bot, mood, t, live)}
        </ShimmerText>
      )}
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
      <IconButton icon={ChevronLeft} label={t('common.back')} onPress={back} raised size={44} />
      <View style={styles.center}>
        <Face bot={bot} mood={mood} live={live} />
      </View>
      <IconButton icon={Ellipsis} label={optionsLabel} onPress={openMenu} raised size={44} />
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
    face: { maxWidth: '100%', alignItems: 'center' },
    // Tucked under the face, overlapping it a little; as wide as the name needs.
    namePill: {
      marginTop: -8,
      maxWidth: '100%',
      height: 28,
      paddingHorizontal: 12,
      justifyContent: 'center',
    },
    doing: { marginTop: 3, fontSize: 11.5, lineHeight: 14, maxWidth: 220 },
    name: { fontWeight: '600', lineHeight: 18 },
    status: { fontSize: 11.5, lineHeight: 14 },
  }),
);
