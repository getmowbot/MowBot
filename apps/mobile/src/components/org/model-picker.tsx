import type { Provider } from '@mowbot/contract';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Keyboard, StyleSheet, View } from 'react-native';
import { useProviderModels } from '../../lib/admin-queries';
import { openOptions } from '../../lib/options-menu';
import { type ModelDraft, matchModels } from '../../lib/org-forms';
import { ListCard } from '../list-card';
import { Field } from '../ui/field';
import { ListRow, ROW_INSET } from '../ui/rows';
import { FieldGroup } from './field-group';

/**
 * The model name, typed or picked among what the provider advertises: while the field has
 * focus, matching models show under it (a provider may list hundreds, too many for a menu).
 */
function ModelField({
  providerId,
  value,
  onChange,
  placeholder,
}: {
  providerId: string;
  value: string;
  onChange(model: string): void;
  placeholder: string;
}) {
  const { t } = useTranslation();
  const models = useProviderModels(providerId);
  const [focused, setFocused] = useState(false);
  // Blur lands before a tap on a suggestion on some platforms: hide the list a beat later.
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (blurTimer.current) clearTimeout(blurTimer.current);
    },
    [],
  );

  const list = models.data ?? [];
  const suggestions = focused ? matchModels(list, value).filter((id) => id !== value.trim()) : [];
  const hint = models.isPending
    ? t('orgAdmin.model.loading')
    : models.isError
      ? t('orgAdmin.model.unreachable')
      : t('orgAdmin.model.count', { count: list.length });

  return (
    <View style={styles.model}>
      <Field
        label={t('orgAdmin.model.model')}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        hint={hint}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        maxLength={200}
        onFocus={() => {
          if (blurTimer.current) clearTimeout(blurTimer.current);
          setFocused(true);
        }}
        onBlur={() => {
          blurTimer.current = setTimeout(() => setFocused(false), 200);
        }}
      />
      {suggestions.length > 0 && (
        <ListCard inset={ROW_INSET}>
          {suggestions.map((id) => (
            <ListRow
              key={id}
              label={id}
              chevron={false}
              onPress={() => {
                onChange(id);
                Keyboard.dismiss();
              }}
            />
          ))}
        </ListCard>
      )}
    </View>
  );
}

interface Props {
  label: string;
  hint?: string;
  value: ModelDraft;
  onChange(value: ModelDraft): void;
  providers: readonly Provider[];
  /** What an empty model name means here (the provider's default, or nothing). */
  modelPlaceholder?: string;
  /** Shows a "Remove" row (fallback models). */
  onRemove?(): void;
}

/** A provider (picked in a menu) and one of its models. */
export function ModelPicker({
  label,
  hint,
  value,
  onChange,
  providers,
  modelPlaceholder,
  onRemove,
}: Props) {
  const { t } = useTranslation();
  const provider = providers.find((p) => p.id === value.providerId);
  const choose = () =>
    openOptions({
      title: label,
      options: [
        {
          label: t('orgAdmin.model.none'),
          onPress: () => onChange({ providerId: null, model: '' }),
        },
        ...providers.map((option) => ({
          label: option.name,
          onPress: () => {
            // Another provider's models differ: start over from its default.
            if (option.id !== value.providerId) onChange({ providerId: option.id, model: '' });
          },
        })),
      ],
    });

  return (
    <View style={styles.root}>
      <FieldGroup
        label={label}
        hint={providers.length === 0 ? t('orgAdmin.model.noProviders') : hint}
      >
        <ListCard inset={ROW_INSET}>
          <ListRow
            label={t('orgAdmin.model.provider')}
            value={
              provider?.name ??
              (value.providerId ? t('orgAdmin.model.unknownProvider') : t('orgAdmin.model.none'))
            }
            onPress={choose}
            disabled={providers.length === 0 && !value.providerId}
          />
          {onRemove ? (
            <ListRow label={t('orgAdmin.model.remove')} destructive onPress={onRemove} />
          ) : null}
        </ListCard>
      </FieldGroup>
      {value.providerId ? (
        <ModelField
          providerId={value.providerId}
          value={value.model}
          onChange={(model) => onChange({ ...value, model })}
          placeholder={modelPlaceholder ?? t('orgAdmin.model.placeholder')}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 12 },
  model: { gap: 8 },
});
