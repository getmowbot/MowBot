import { useState } from 'react';
import { StyleSheet, TextInput, type TextInputProps, View } from 'react-native';
import { isAndroid, isIOS } from '../../lib/platform';
import { colors, shape, type } from '../../theme';
import { T } from './text';

interface Props extends TextInputProps {
  label: string;
  hint?: string;
}

/** A labelled text field: filled on iOS, Material 3 outlined on Android. */
export function Field({ label, hint, style, onFocus, onBlur, ...props }: Props) {
  const [focused, setFocused] = useState(false);
  return (
    <View style={styles.root}>
      <T variant="footnote" tone="muted" style={styles.label}>
        {label}
      </T>
      <TextInput
        {...props}
        accessibilityLabel={label}
        placeholderTextColor={colors.textFaint}
        selectionColor={isIOS ? colors.accentStrong : 'rgba(255, 255, 255, 0.35)'}
        cursorColor={colors.accentStrong}
        selectionHandleColor={colors.accentStrong}
        keyboardAppearance="dark"
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
          style,
        ]}
      />
      {hint ? (
        <T variant="caption" tone="faint" style={styles.label}>
          {hint}
        </T>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 6 },
  label: { paddingHorizontal: 4 },
  input: {
    ...type.body,
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
  outlined: { borderWidth: 1, borderColor: 'rgba(255, 255, 255, 0.22)' },
  focused: { borderColor: 'rgba(255, 255, 255, 0.6)' },
});
