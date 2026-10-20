import type { Bot } from '@mowbot/contract';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { ArrowLeft, ChevronLeft, Ellipsis, EllipsisVertical } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { type LayoutChangeEvent, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { type BotMood, statusLabel } from '../../lib/bot-mood';
import { isAndroid, useLiquidGlass } from '../../lib/platform';
import { colors } from '../../theme';
import { BotAvatar } from '../bot-avatar';
import { IconButton } from '../ui/button';
import { ShimmerText } from '../ui/shimmer-text';
import { Surface } from '../ui/surface';
import { T } from '../ui/text';
import { useBotMenu } from './bot-menu';

interface Props {
  bot: Bot;
  mood: BotMood;
  onLayout(event: LayoutChangeEvent): void;
}

function Identity({ bot, mood }: { bot: Bot; mood: BotMood }) {
  const { t } = useTranslation();
  return (
    <>
      <BotAvatar seed={bot.avatarSeed} size={34} mood={mood} />
      <View style={styles.names}>
        <T variant="headline" numberOfLines={1}>
          {bot.name}
        </T>
        <ShimmerText active={mood !== 'idle'} style={styles.status} numberOfLines={1}>
          {statusLabel(bot, mood, t)}
        </ShimmerText>
      </View>
    </>
  );
}

/**
 * The chat's top bar, floating over the conversation. iOS 26: Liquid Glass back button, title
 * capsule and ⋯ button over a fade; older iOS: the same in blur; Android: a Material 3 top app
 * bar with the overflow menu.
 */
export function ChatHeader({ bot, mood, onLayout }: Props) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const glass = useLiquidGlass();
  const openMenu = useBotMenu(bot);
  const back = () => (router.canGoBack() ? router.back() : router.replace('/'));
  const optionsLabel = t('chat.options', { name: bot.name });

  if (isAndroid) {
    return (
      <View onLayout={onLayout} style={[styles.appBar, { paddingTop: insets.top }]}>
        <View style={styles.appBarRow}>
          <IconButton icon={ArrowLeft} label={t('common.back')} onPress={back} size={44} />
          <View style={styles.identity}>
            <Identity bot={bot} mood={mood} />
          </View>
          <IconButton icon={EllipsisVertical} label={optionsLabel} onPress={openMenu} size={44} />
        </View>
      </View>
    );
  }

  return (
    <View onLayout={onLayout} style={[styles.floating, { paddingTop: insets.top + 4 }]}>
      <LinearGradient
        colors={['rgba(6, 7, 10, 0.92)', 'rgba(6, 7, 10, 0.6)', 'rgba(6, 7, 10, 0)']}
        locations={[0, 0.55, 1]}
        style={styles.fade}
        pointerEvents="none"
      />
      <IconButton icon={ChevronLeft} label={t('common.back')} onPress={back} raised size={44} />
      <Surface variant="bar" radius={glass ? 22 : 20} style={styles.capsule}>
        <Identity bot={bot} mood={mood} />
      </Surface>
      <IconButton icon={Ellipsis} label={optionsLabel} onPress={openMenu} raised size={44} />
    </View>
  );
}

const styles = StyleSheet.create({
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
  identity: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 10 },
  floating: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingBottom: 10,
  },
  fade: { position: 'absolute', top: 0, left: 0, right: 0, bottom: -24 },
  // Between the two round buttons, as wide as the name needs (centered when short).
  capsule: {
    flex: 1,
    minWidth: 0,
    height: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    paddingLeft: 5,
    paddingRight: 14,
  },
  names: { flexShrink: 1, minWidth: 0 },
  status: { fontSize: 12, lineHeight: 15 },
});
