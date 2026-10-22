import type { Message, VaultField, VaultRequestAnswer } from '@mowbot/contract';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { Ban, ChevronRight, Eye, EyeOff, LockKeyhole, ShieldCheck } from 'lucide-react-native';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Keyboard, StyleSheet, type TextInput, View } from 'react-native';
import {
  EMPTY_VALUES,
  itemLabel,
  REQUEST_INPUTS,
  type RequestProblem,
  requestFields,
  requestProblem,
  requestValues,
  sitesText,
  type ValueDraft,
  type VaultRequestPart,
} from '../../lib/vault';
import { useAnswerVaultRequest } from '../../lib/vault-queries';
import { colors, themed, tint } from '../../theme';
import { Pill } from '../board/pill';
import { IconButton } from '../ui/button';
import { Field } from '../ui/field';
import { Surface } from '../ui/surface';
import { T } from '../ui/text';
import { Touchable } from '../ui/touchable';
import { useKeepInView } from './keep-in-view';

/** One value the bot asked for: masked secrets get a toggle to show what was typed. */
function RequestField({
  field,
  value,
  onChange,
  disabled,
}: {
  field: VaultField;
  value: string;
  onChange(value: string): void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const keepInView = useKeepInView();
  const input = useRef<TextInput>(null);
  const [shown, setShown] = useState(false);
  const config = REQUEST_INPUTS[field];
  return (
    <Field
      inputRef={input}
      label={field === 'totp' ? t('chat.vaultRequest.totp') : t(`vault.values.${field}`)}
      value={value}
      onChangeText={onChange}
      onFocus={() => {
        if (input.current) keepInView(input.current);
      }}
      editable={!disabled}
      secureTextEntry={config.secure && !shown}
      textContentType={config.textContentType}
      autoComplete={config.autoComplete}
      importantForAutofill={config.autoComplete === 'off' ? 'no' : 'auto'}
      autoCapitalize="none"
      autoCorrect={false}
      spellCheck={false}
      maxLength={field === 'password' || field === 'value' ? 10_000 : 500}
      returnKeyType="done"
      accessory={
        config.secure ? (
          <IconButton
            icon={shown ? EyeOff : Eye}
            label={shown ? t('chat.vaultRequest.hide') : t('chat.vaultRequest.show')}
            onPress={() => setShown((value) => !value)}
            size={36}
            color={colors.textMuted}
          />
        ) : undefined
      }
    />
  );
}

interface Props {
  message: Message;
  part: VaultRequestPart;
  /** The part's position in the message (the answer names it). */
  index: number;
}

/**
 * A bot asks for a login or a secret: a small form whose values go straight into the hub's
 * vault (never into the conversation or to the model). Once answered, one line: saved (opens
 * the entry) or declined.
 */
export function VaultRequest({ message, part, index }: Props) {
  const { t } = useTranslation();
  const answer = useAnswerVaultRequest(message.botId);
  const [values, setValues] = useState<ValueDraft>(EMPTY_VALUES);
  const [busy, setBusy] = useState<'save' | 'decline' | null>(null);
  const [problem, setProblem] = useState<RequestProblem | null>(null);
  const title = itemLabel(part);
  const fields = requestFields(part);

  if (part.status === 'saved') {
    const { itemId } = part;
    return (
      <Touchable
        accessibilityRole="button"
        disabled={!itemId}
        onPress={() => itemId && router.push({ pathname: '/vault/[itemId]', params: { itemId } })}
        style={styles.answered}
      >
        <LockKeyhole size={16} color={colors.text} />
        <T variant="footnote" numberOfLines={1} style={styles.shrink}>
          {t('chat.vaultRequest.saved')}
          <T variant="footnote" tone="muted">
            {' '}
            · {title}
          </T>
        </T>
        {itemId ? <ChevronRight size={16} color={colors.textFaint} /> : null}
      </Touchable>
    );
  }

  if (part.status === 'declined') {
    return (
      <View style={styles.answered}>
        <Ban size={16} color={colors.textFaint} />
        <T variant="footnote" tone="muted" numberOfLines={1} style={styles.shrink}>
          {t('chat.vaultRequest.declined')} · {title}
        </T>
      </View>
    );
  }

  const send = async (body: Omit<VaultRequestAnswer, 'part'>, action: 'save' | 'decline') => {
    Keyboard.dismiss();
    setBusy(action);
    setProblem(null);
    try {
      await answer(message.id, { part: index, ...body });
      // Typed once, sent once: nothing stays in the app.
      setValues(EMPTY_VALUES);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (error) {
      const next = requestProblem(error);
      if (next === 'invalid_totp') setValues((current) => ({ ...current, totp: '' }));
      // Answered meanwhile (another device): the message refetches and shows how.
      if (next !== 'answered') setProblem(next);
    } finally {
      setBusy(null);
    }
  };

  const save = () => {
    const typed = requestValues(fields, values);
    if (!typed) {
      setProblem('empty_answer');
      return;
    }
    void send({ values: typed }, 'save');
  };

  const problemText =
    problem === 'invalid_totp'
      ? t('vault.problems.invalid_totp')
      : problem === 'empty_answer'
        ? t('chat.vaultRequest.empty')
        : problem
          ? t('common.actionFailed')
          : null;

  return (
    <Surface style={styles.card}>
      <View style={styles.head}>
        <View style={styles.lock}>
          <LockKeyhole size={18} color={colors.text} />
        </View>
        <View style={styles.headText}>
          <T variant="headline" numberOfLines={2}>
            {title}
          </T>
          <T variant="caption" tone="faint" numberOfLines={1}>
            {t(`vault.kinds.${part.kind}`)}
            {part.sites.length > 0 ? ` · ${sitesText(part.sites)}` : ''}
          </T>
        </View>
      </View>
      {part.reason ? (
        <T variant="callout" tone="muted" selectable>
          {part.reason}
        </T>
      ) : null}
      {fields.map((field) => (
        <RequestField
          key={field}
          field={field}
          value={values[field]}
          onChange={(value) => setValues((current) => ({ ...current, [field]: value }))}
          disabled={busy !== null}
        />
      ))}
      {problemText ? (
        <T variant="footnote" tone="danger" accessibilityRole="alert">
          {problemText}
        </T>
      ) : null}
      <View style={styles.note}>
        <ShieldCheck size={14} color={colors.textFaint} style={styles.noteIcon} />
        <T variant="caption" tone="faint" style={styles.shrink}>
          {t('chat.vaultRequest.note')}
        </T>
      </View>
      <View style={styles.actions}>
        <Pill
          variant="solid"
          icon={LockKeyhole}
          label={t('chat.vaultRequest.save')}
          loading={busy === 'save'}
          disabled={busy !== null}
          onPress={save}
        />
        <Pill
          label={t('chat.vaultRequest.decline')}
          loading={busy === 'decline'}
          disabled={busy !== null}
          onPress={() => void send({ declined: true }, 'decline')}
        />
      </View>
    </Surface>
  );
}

const styles = themed(() =>
  StyleSheet.create({
    card: { padding: 14, gap: 12 },
    head: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    lock: {
      width: 36,
      height: 36,
      borderRadius: 18,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: tint.ink(0.08),
    },
    headText: { flex: 1, minWidth: 0, gap: 1 },
    note: { flexDirection: 'row', alignItems: 'flex-start', gap: 6 },
    noteIcon: { marginTop: 1 },
    actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    answered: {
      flexDirection: 'row',
      alignItems: 'center',
      alignSelf: 'flex-start',
      maxWidth: '100%',
      gap: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      borderRadius: 14,
      borderCurve: 'continuous',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.borderStrong,
      overflow: 'hidden',
    },
    shrink: { flexShrink: 1 },
  }),
);
