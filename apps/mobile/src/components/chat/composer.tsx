import type { Bot } from '@mowbot/contract';
import * as Haptics from 'expo-haptics';
import { ArrowUp, Square } from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, TextInput, View } from 'react-native';
import { isAndroid, isIOS } from '../../lib/platform';
import { useStopBot } from '../../lib/queries';
import { colors, shape, type } from '../../theme';
import { Surface } from '../ui/surface';
import { Touchable } from '../ui/touchable';

const MAX_LENGTH = 20_000;

interface Props {
  bot: Bot;
  onSend(text: string): void;
}

/** The message field: send when there is text, stop while the bot works. */
export function Composer({ bot, onSend }: Props) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const stop = useStopBot(bot.id);
  const working = bot.status === 'working';
  const empty = text.trim().length === 0;

  const submit = () => {
    const value = text.trim();
    if (!value) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onSend(value);
    setText('');
  };

  return (
    <Surface variant="bar" interactive radius={shape.bar} style={styles.bar}>
      <TextInput
        value={text}
        onChangeText={setText}
        multiline
        maxLength={MAX_LENGTH}
        placeholder={t('chat.placeholder', { name: bot.name })}
        placeholderTextColor={colors.textFaint}
        selectionColor={isIOS ? colors.accentStrong : 'rgba(255, 255, 255, 0.35)'}
        cursorColor={colors.accentStrong}
        selectionHandleColor={colors.accentStrong}
        keyboardAppearance="dark"
        style={styles.input}
        accessibilityLabel={t('chat.placeholder', { name: bot.name })}
      />
      <View style={styles.action}>
        {working && empty ? (
          <Touchable
            accessibilityRole="button"
            accessibilityLabel={t('chat.stop')}
            onPress={() => stop.mutate()}
            disabled={stop.isPending}
            style={[styles.round, styles.stop]}
          >
            <Square size={13} color={colors.text} fill={colors.text} />
          </Touchable>
        ) : (
          <Touchable
            accessibilityRole="button"
            accessibilityLabel={t('chat.send')}
            onPress={submit}
            disabled={empty}
            onAccent
            style={[styles.round, styles.send, empty && styles.sendIdle]}
          >
            <ArrowUp size={19} color={colors.accentInk} strokeWidth={2.4} />
          </Touchable>
        )}
      </View>
    </Surface>
  );
}

const SIZE = isAndroid ? 40 : 36;

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingLeft: 6,
    paddingRight: 6,
    paddingVertical: 6,
    minHeight: SIZE + 12,
  },
  input: {
    ...type.body,
    flex: 1,
    color: colors.text,
    maxHeight: 150,
    paddingHorizontal: 12,
    paddingTop: isIOS ? 8 : 6,
    paddingBottom: isIOS ? 8 : 6,
    textAlignVertical: 'center',
  },
  action: { height: SIZE, justifyContent: 'center' },
  round: {
    width: SIZE,
    height: SIZE,
    // Material 3: a small square-ish FAB shape; iOS: a circle.
    borderRadius: isAndroid ? 14 : SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  send: { backgroundColor: colors.accentStrong },
  sendIdle: { backgroundColor: 'rgba(243, 244, 246, 0.35)' },
  stop: { borderWidth: 1, borderColor: colors.borderStrong },
});
