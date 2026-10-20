import type { ComponentProps, ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { Field } from '../ui/field';
import { T } from '../ui/text';

/**
 * A label above something that is not a text field (a ListCard of choices, a picker row), laid
 * out exactly like `Field` so labels and hints line up down the form.
 */
export function FieldGroup({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string | null;
  children: ReactNode;
}) {
  return (
    <View style={styles.root}>
      <T variant="footnote" tone="muted" style={styles.text}>
        {label}
      </T>
      {children}
      {hint ? (
        <T variant="caption" tone="faint" style={styles.text}>
          {hint}
        </T>
      ) : null}
    </View>
  );
}

/** A `Field` for a few lines of text (a mission, task details). */
export function TextArea({ style, ...props }: ComponentProps<typeof Field>) {
  return <Field {...props} multiline style={[styles.area, style]} />;
}

const styles = StyleSheet.create({
  root: { gap: 6 },
  text: { paddingHorizontal: 4 },
  area: { minHeight: 110, paddingTop: 14, paddingBottom: 14, textAlignVertical: 'top' },
});
