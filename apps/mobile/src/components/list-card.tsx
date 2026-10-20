import { Children, Fragment, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { colors } from '../theme';
import { Surface } from './ui/surface';

/** Rows grouped on one surface, separated by hairlines inset past the avatar. */
export function ListCard({ children, inset = 64 }: { children: ReactNode; inset?: number }) {
  const rows = Children.toArray(children).filter(Boolean);
  return (
    <Surface>
      {rows.map((row, index) => (
        <Fragment key={(row as { key?: string }).key ?? index}>
          {index > 0 && <View style={[styles.divider, { marginLeft: inset }]} />}
          {row}
        </Fragment>
      ))}
    </Surface>
  );
}

const styles = StyleSheet.create({
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
});
