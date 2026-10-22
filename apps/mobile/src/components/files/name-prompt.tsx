import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Modal, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import i18n from '../../i18n';
import { isIOS } from '../../lib/platform';
import { colors, currentScheme, themed, tint, type } from '../../theme';
import { T } from '../ui/text';
import { Touchable } from '../ui/touchable';

export interface NameRequest {
  title: string;
  message?: string;
  /** Pre-filled value (a rename). */
  initial?: string;
  placeholder?: string;
  confirmLabel: string;
  onSubmit(value: string): void;
}

/**
 * Asks for a name (new folder, rename): the system prompt on iOS, a Material 3 dialog on Android
 * (which has no text prompt). Render `element` once in the screen.
 */
export function useNamePrompt(): { ask(request: NameRequest): void; element: ReactNode } {
  const [request, setRequest] = useState<NameRequest | null>(null);

  const ask = (next: NameRequest) => {
    if (isIOS) {
      Alert.prompt(
        next.title,
        next.message,
        [
          { text: i18n.t('common.cancel'), style: 'cancel' },
          { text: next.confirmLabel, onPress: (value?: string) => next.onSubmit(value ?? '') },
        ],
        'plain-text',
        next.initial ?? '',
        'default',
        { userInterfaceStyle: currentScheme() },
      );
      return;
    }
    setRequest(next);
  };

  return {
    ask,
    element: request ? (
      <NameDialog key={request.title} request={request} onClose={() => setRequest(null)} />
    ) : null,
  };
}

function NameDialog({ request, onClose }: { request: NameRequest; onClose(): void }) {
  const { t } = useTranslation();
  const [value, setValue] = useState(request.initial ?? '');
  const submit = () => {
    onClose();
    request.onSubmit(value);
  };
  return (
    <Modal
      visible
      transparent
      animationType="fade"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onClose}
    >
      <Pressable style={styles.scrim} onPress={onClose} accessibilityLabel={t('common.close')} />
      <KeyboardAvoidingView behavior="padding" style={styles.center} pointerEvents="box-none">
        <View style={styles.dialog} accessibilityViewIsModal>
          <T variant="title" style={styles.title}>
            {request.title}
          </T>
          {request.message ? (
            <T variant="callout" tone="muted">
              {request.message}
            </T>
          ) : null}
          <TextInput
            value={value}
            onChangeText={setValue}
            onSubmitEditing={submit}
            autoFocus
            selectTextOnFocus
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="done"
            accessibilityLabel={request.title}
            placeholder={request.placeholder}
            placeholderTextColor={colors.textFaint}
            selectionColor={tint.ink(0.35)}
            cursorColor={colors.accentStrong}
            selectionHandleColor={colors.accentStrong}
            keyboardAppearance={currentScheme()}
            style={styles.input}
          />
          <View style={styles.actions}>
            <Touchable accessibilityRole="button" onPress={onClose} style={styles.action}>
              <T variant="callout" style={styles.actionLabel}>
                {t('common.cancel')}
              </T>
            </Touchable>
            <Touchable
              accessibilityRole="button"
              onPress={submit}
              disabled={!value.trim()}
              style={[styles.action, !value.trim() && styles.disabled]}
            >
              <T variant="callout" style={styles.actionLabel}>
                {request.confirmLabel}
              </T>
            </Touchable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = themed(() =>
  StyleSheet.create({
    scrim: { ...StyleSheet.absoluteFill, backgroundColor: colors.scrim },
    center: { flex: 1, justifyContent: 'center', paddingHorizontal: 24 },
    dialog: {
      gap: 16,
      paddingTop: 24,
      paddingHorizontal: 24,
      paddingBottom: 12,
      borderRadius: 28,
      backgroundColor: colors.surfaceContainerHigh,
    },
    title: { fontSize: 22, lineHeight: 28 },
    input: {
      ...type.body,
      color: colors.text,
      minHeight: 56,
      paddingHorizontal: 16,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: tint.ink(0.6),
    },
    actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
    action: {
      minHeight: 40,
      paddingHorizontal: 12,
      borderRadius: 20,
      justifyContent: 'center',
      overflow: 'hidden',
    },
    actionLabel: { fontWeight: '600' },
    disabled: { opacity: 0.4 },
  }),
);
