import type { Provider } from '@mowbot/contract';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { useProviderModels } from '../../lib/admin-queries';
import { fonts } from '../../theme';
import { ListCard } from '../list-card';
import { Field } from '../ui/field';
import { ListRow, ROW_INSET } from '../ui/rows';
import { InlinePicker } from './inline-picker';
import { Caption } from './parts';

export interface ModelChoice {
  providerId: string | null;
  model: string;
}

interface Props {
  providers: Provider[];
  value: ModelChoice;
  onChange(value: ModelChoice): void;
  /** The "no provider" choice ("None", "No provider"). */
  noneLabel: string;
  /** Under the picker (what an empty choice means…). */
  hint?: string;
}

const SUGGESTIONS = 6;
const NONE = 'none';

/**
 * A provider, then one of its models: the provider picked inline, the model typed with the
 * provider's own list as suggestions (some list hundreds, so no long picker).
 */
export function ModelRefInput({ providers, value, onChange, noneLabel, hint }: Props) {
  const { t } = useTranslation();
  const [typing, setTyping] = useState(false);
  const { providerId, model } = value;
  const provider = providers.find((p) => p.id === providerId);
  const models = useProviderModels(provider?.id);

  const pickProvider = (id: string) => {
    const next = providers.find((p) => p.id === id);
    if (!next) {
      onChange({ providerId: null, model });
      return;
    }
    onChange({
      providerId: next.id,
      model: next.id === providerId ? model : (next.defaultModel ?? ''),
    });
  };

  const query = model.trim().toLowerCase();
  // While typing (or before anything is typed): never once a model is settled.
  const matches =
    typing || !query
      ? (models.data ?? [])
          .filter((id) => id !== model.trim() && id.toLowerCase().includes(query))
          .slice(0, SUGGESTIONS)
      : [];
  const status = models.isError
    ? t('appAdmin.models.modelsUnavailable')
    : models.isPending && provider
      ? t('appAdmin.models.modelsLoading')
      : undefined;

  return (
    <View style={styles.root}>
      <InlinePicker
        label={t('appAdmin.models.provider')}
        options={[
          { value: NONE, label: noneLabel },
          ...providers.map((p) => ({ value: p.id, label: p.name })),
        ]}
        value={provider?.id ?? NONE}
        placeholder={noneLabel}
        onChange={pickProvider}
      />
      {provider ? (
        <>
          <Field
            label={t('appAdmin.models.model')}
            value={model}
            onChangeText={(text) => onChange({ providerId: provider.id, model: text })}
            onFocus={() => setTyping(true)}
            onBlur={() => setTyping(false)}
            placeholder={provider.defaultModel ?? t('appAdmin.models.modelPlaceholder')}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            hint={status}
            style={styles.mono}
          />
          {matches.length > 0 && (
            <ListCard inset={ROW_INSET}>
              {matches.map((id) => (
                <ListRow
                  key={id}
                  label={id}
                  chevron={false}
                  onPress={() => onChange({ providerId: provider.id, model: id })}
                />
              ))}
            </ListCard>
          )}
        </>
      ) : null}
      {hint ? <Caption>{hint}</Caption> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 8 },
  mono: { fontFamily: fonts.mono, fontSize: 14 },
});
