import * as Haptics from 'expo-haptics';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  CornerDownLeft,
  Delete,
  KeyboardOff,
  type LucideIcon,
} from 'lucide-react-native';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Keyboard, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useKeyboardState } from 'react-native-keyboard-controller';
import { CTRL_C, KEYS, type KeyPress, keysForEdit } from '../../lib/keysyms';
import { isAndroid, isIOS } from '../../lib/platform';
import { colors, currentScheme, shape, spacing, themed, tint, type } from '../../theme';
import { T } from '../ui/text';
import { Touchable } from '../ui/touchable';

interface Props {
  /** Typed one after the other. */
  onKeys(keys: KeyPress[]): void;
  /** Held together. */
  onCombo(keys: KeyPress[]): void;
  /** Pastes the phone's clipboard on the PC. */
  onPaste(): void;
}

interface KeyButton {
  id: string;
  label: string;
  /** Shown instead of the label (the label stays for screen readers). */
  icon?: LucideIcon;
  press(): void;
}

/**
 * The phone's keyboard for the PC, while the user has control: what is typed in the field goes
 * to the PC as it is typed (corrections included), Return sends Enter; the keys below cover what
 * a phone keyboard lacks.
 */
export function KeyboardBar({ onKeys, onCombo, onPaste }: Props) {
  const { t } = useTranslation();
  const keyboardVisible = useKeyboardState((state) => state.isVisible);
  const input = useRef<TextInput>(null);
  // What the PC received from the field so far (its cursor is at the end of it).
  const typed = useRef('');

  const keys: KeyButton[] = [
    {
      id: 'enter',
      label: t('pcView.keyboard.enter'),
      icon: CornerDownLeft,
      press: () => onKeys([KEYS.enter]),
    },
    {
      id: 'backspace',
      label: t('pcView.keyboard.backspace'),
      icon: Delete,
      press: () => onKeys([KEYS.backspace]),
    },
    { id: 'escape', label: t('pcView.keyboard.escape'), press: () => onKeys([KEYS.escape]) },
    { id: 'tab', label: t('pcView.keyboard.tab'), press: () => onKeys([KEYS.tab]) },
    {
      id: 'left',
      label: t('pcView.keyboard.left'),
      icon: ArrowLeft,
      press: () => onKeys([KEYS.left]),
    },
    { id: 'up', label: t('pcView.keyboard.up'), icon: ArrowUp, press: () => onKeys([KEYS.up]) },
    {
      id: 'down',
      label: t('pcView.keyboard.down'),
      icon: ArrowDown,
      press: () => onKeys([KEYS.down]),
    },
    {
      id: 'right',
      label: t('pcView.keyboard.right'),
      icon: ArrowRight,
      press: () => onKeys([KEYS.right]),
    },
    { id: 'copy', label: t('pcView.keyboard.copy'), press: () => onCombo(CTRL_C) },
    { id: 'paste', label: t('pcView.keyboard.paste'), press: onPaste },
  ];

  const clearField = () => {
    // Forget first: clearing may report an empty text, which must not erase anything on the PC.
    typed.current = '';
    input.current?.clear();
  };

  return (
    <View style={styles.root} accessibilityLabel={t('pcView.keyboard.label')}>
      <View style={styles.fieldRow}>
        <TextInput
          ref={input}
          placeholder={t('pcView.keyboard.placeholder')}
          accessibilityLabel={t('pcView.keyboard.placeholder')}
          placeholderTextColor={colors.textFaint}
          selectionColor={isIOS ? colors.accentStrong : tint.ink(0.35)}
          cursorColor={colors.accentStrong}
          keyboardAppearance={currentScheme()}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          spellCheck={false}
          smartInsertDelete={false}
          importantForAutofill="no"
          returnKeyType="default"
          submitBehavior="submit"
          onChangeText={(text) => {
            onKeys(keysForEdit(typed.current, text));
            typed.current = text;
          }}
          onKeyPress={(event) => {
            // Backspace in an empty field changes no text: still erase on the PC.
            if (event.nativeEvent.key === 'Backspace' && typed.current === '') {
              onKeys([KEYS.backspace]);
            }
          }}
          onSubmitEditing={() => {
            onKeys([KEYS.enter]);
            clearField();
          }}
          style={[styles.input, isAndroid ? styles.outlined : styles.filled]}
        />
        {keyboardVisible ? (
          <Touchable
            accessibilityRole="button"
            accessibilityLabel={t('pcView.keyboard.hide')}
            onPress={() => Keyboard.dismiss()}
            hitSlop={6}
            style={styles.hide}
          >
            <KeyboardOff size={20} color={colors.text} strokeWidth={2} />
          </Touchable>
        ) : null}
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="always"
        contentContainerStyle={styles.keys}
      >
        {keys.map(({ id, label, icon: Icon, press }) => (
          <Touchable
            key={id}
            accessibilityRole="button"
            accessibilityLabel={label}
            onPress={() => {
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              press();
            }}
            style={styles.key}
          >
            {Icon ? (
              <Icon size={18} color={colors.text} strokeWidth={2} />
            ) : (
              <T variant="footnote" style={styles.keyLabel}>
                {label}
              </T>
            )}
          </Touchable>
        ))}
      </ScrollView>
    </View>
  );
}

const KEY_HEIGHT = 38;
const FIELD_HEIGHT = isAndroid ? 48 : 44;

const styles = themed(() =>
  StyleSheet.create({
    root: { gap: spacing.sm },
    fieldRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
    },
    input: {
      ...type.body,
      flex: 1,
      color: colors.text,
      height: FIELD_HEIGHT,
      paddingVertical: 0,
      paddingHorizontal: 14,
      borderRadius: shape.field,
      borderCurve: 'continuous',
    },
    filled: {
      backgroundColor: colors.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.borderStrong,
    },
    outlined: { borderWidth: 1, borderColor: tint.ink(0.22) },
    hide: {
      width: FIELD_HEIGHT,
      height: FIELD_HEIGHT,
      borderRadius: FIELD_HEIGHT / 2,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.borderStrong,
      overflow: 'hidden',
    },
    keys: { gap: spacing.sm, paddingHorizontal: spacing.lg },
    key: {
      height: KEY_HEIGHT,
      minWidth: 48,
      paddingHorizontal: 14,
      borderRadius: KEY_HEIGHT / 2,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: isAndroid ? colors.surfaceContainerHigh : colors.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.borderStrong,
      overflow: 'hidden',
    },
    keyLabel: { fontWeight: '600' },
  }),
);
