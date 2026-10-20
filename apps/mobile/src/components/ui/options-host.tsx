import { useTranslation } from 'react-i18next';
import { Modal, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { closeMenu, useOpenMenu } from '../../lib/options-menu';
import { colors, shape } from '../../theme';
import { T } from './text';
import { Touchable } from './touchable';

/** Draws `openOptions` menus on Android and the web: a bottom sheet over a scrim. */
export function OptionsHost() {
  const { t } = useTranslation();
  const menu = useOpenMenu();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  return (
    <Modal
      visible={menu !== null}
      transparent
      animationType="fade"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={closeMenu}
    >
      <Pressable style={styles.scrim} onPress={closeMenu} accessibilityLabel={t('common.close')} />
      <View style={[styles.sheet, { paddingBottom: insets.bottom + 12 }]}>
        {(menu?.title || menu?.message) && (
          <View style={styles.head}>
            {menu.title ? (
              <T variant="footnote" tone="muted" numberOfLines={2}>
                {menu.title}
              </T>
            ) : null}
            {menu.message ? (
              <T variant="caption" tone="faint">
                {menu.message}
              </T>
            ) : null}
          </View>
        )}
        <ScrollView style={{ maxHeight: height * 0.6 }} bounces={false}>
          {menu?.options.map((option) => {
            const Icon = option.icon;
            const ink = option.destructive ? colors.danger : colors.text;
            return (
              <Touchable
                key={option.label}
                accessibilityRole="button"
                onPress={() => {
                  closeMenu();
                  option.onPress();
                }}
                style={styles.row}
              >
                {Icon ? <Icon size={20} color={ink} strokeWidth={2} /> : null}
                <T variant="body" style={{ color: ink }}>
                  {option.label}
                </T>
              </Touchable>
            );
          })}
        </ScrollView>
        <Touchable
          accessibilityRole="button"
          onPress={closeMenu}
          style={[styles.row, styles.cancel]}
        >
          <T variant="body" tone="muted">
            {t('common.cancel')}
          </T>
        </Touchable>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { ...StyleSheet.absoluteFill, backgroundColor: colors.scrim },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingTop: 8,
    paddingHorizontal: 8,
    backgroundColor: colors.surfaceContainerHigh,
    borderTopLeftRadius: shape.card + 6,
    borderTopRightRadius: shape.card + 6,
  },
  head: { paddingHorizontal: 16, paddingTop: 10, paddingBottom: 8, gap: 2 },
  row: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 16,
    borderRadius: 14,
    overflow: 'hidden',
  },
  cancel: { marginTop: 4, justifyContent: 'center' },
});
