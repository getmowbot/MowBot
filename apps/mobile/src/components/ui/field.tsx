import { type ReactNode, type Ref, useState } from 'react';
import { StyleSheet, TextInput, type TextInputProps, View } from 'react-native';
import { isAndroid, isIOS } from '../../lib/platform';
import { colors, currentScheme, fieldType, shape, themed, tint, type } from '../../theme';
import { T } from './text';

interface Props extends TextInputProps {
  label: string;
  hint?: string;
  /** A small button inside the field, at its right (e.g. show a masked value). */
  accessory?: ReactNode;
  /** The field itself (to measure it, or focus it). */
  inputRef?: Ref<TextInput>;
}

/** A labelled text field: filled on iOS, Material 3 outlined on Android. */
export function Field({
  label,
  hint,
  accessory,
  inputRef,
  style,
  onFocus,
  onBlur,
  ...props
}: Props) {
  const [focused, setFocused] = useState(false);
  return (
    <View style={styles.root}>
      <T variant="footnote" tone="muted" style={styles.label}>
        {label}
      </T>
      <View>
        <TextInput
          {...props}
          ref={inputRef}
          accessibilityLabel={label}
          placeholderTextColor={colors.textFaint}
          selectionColor={isIOS ? colors.accentStrong : tint.ink(0.35)}
          cursorColor={colors.accentStrong}
          selectionHandleColor={colors.accentStrong}
          keyboardAppearance={currentScheme()}
          onFocus={(event) => {
            setFocused(true);
            onFocus?.(event);
          }}
          onBlur={(event) => {
            setFocused(false);
            onBlur?.(event);
          }}
          style={[
            styles.input,
            isAndroid ? styles.outlined : styles.filled,
            focused && styles.focused,
            accessory ? styles.withAccessory : null,
            style,
          ]}
        />
        {accessory ? <View style={styles.accessory}>{accessory}</View> : null}
      </View>
      {hint ? (
        <T variant="caption" tone="faint" style={styles.label}>
          {hint}
        </T>
      ) : null}
    </View>
  );
}

const styles = themed(() =>
  StyleSheet.create({
    root: { gap: 6 },
    label: { paddingHorizontal: 4 },
    input: {
      ...fieldType(type.body),
      color: colors.text,
      minHeight: isAndroid ? 56 : 50,
      paddingHorizontal: 16,
      borderRadius: shape.field,
      borderCurve: 'continuous',
    },
    filled: {
      backgroundColor: colors.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.borderStrong,
    },
    outlined: { borderWidth: 1, borderColor: tint.ink(0.22) },
    focused: { borderColor: tint.ink(0.6) },
    withAccessory: { paddingRight: 48 },
    accessory: {
      position: 'absolute',
      top: 0,
      bottom: 0,
      right: 4,
      justifyContent: 'center',
    },
  }),
);
