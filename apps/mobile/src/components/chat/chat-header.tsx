import type { Bot } from '@mowbot/contract';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { ArrowLeft, ChevronLeft } from 'lucide-react-native';
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

interface Props {
  bot: Bot;
  mood: BotMood;
  onLayout(event: LayoutChangeEvent): void;
}

function Identity({ bot, mood }: { bot: Bot; mood: BotMood }) {
  const { t } = useTranslation();
  const status = statusLabel(bot, mood, t);
  return (
    <>
      <BotAvatar seed={bot.avatarSeed} size={38} mood={mood} />
      <View style={styles.names}>
        <T variant="headline" numberOfLines={1}>
          {bot.name}
        </T>
        <ShimmerText active={mood !== 'idle'} style={styles.status}>
          {bot.model ? `${status} · ${bot.model}` : status}
        </ShimmerText>
      </View>
    </>
  );
}

/**
 * The chat's top bar, floating over the conversation. iOS 26: a Liquid Glass back button and
 * identity capsule over a fade; older iOS: the same in blur; Android: a Material 3 top app bar.
 */
export function ChatHeader({ bot, mood, onLayout }: Props) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const glass = useLiquidGlass();
  const back = () => (router.canGoBack() ? router.back() : router.replace('/'));

  if (isAndroid) {
    return (
      <View onLayout={onLayout} style={[styles.appBar, { paddingTop: insets.top }]}>
        <View style={styles.appBarRow}>
          <IconButton icon={ArrowLeft} label={t('common.back')} onPress={back} size={44} />
          <Identity bot={bot} mood={mood} />
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
      <Surface variant="bar" radius={glass ? 24 : 22} style={styles.capsule}>
        <Identity bot={bot} mood={mood} />
      </Surface>
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
    gap: 10,
    paddingHorizontal: 6,
  },
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
  capsule: {
    flexShrink: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingLeft: 6,
    paddingRight: 16,
    paddingVertical: 4,
  },
  names: { flexShrink: 1, minWidth: 0 },
  status: { fontSize: 12.5, lineHeight: 16 },
});
