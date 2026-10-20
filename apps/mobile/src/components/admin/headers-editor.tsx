import type { ProviderKind } from '@mowbot/contract';
import { Plus, X } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { isAndroid } from '../../lib/platform';
import { type HeaderRow, hasZdr, headerRow, MAX_HEADERS, toggleZdr } from '../../lib/provider-form';
import { colors, fonts } from '../../theme';
import { ListCard } from '../list-card';
import { Section } from '../tab-scroll';
import { Button, IconButton } from '../ui/button';
import { Field } from '../ui/field';
import { ROW_INSET, SwitchRow } from '../ui/rows';
import { Caption } from './parts';

/** Extra HTTP headers of a provider, as name / value pairs (and the ZDR switch for Command Code). */
export function HeadersEditor({
  kind,
  rows,
  onChange,
}: {
  kind: ProviderKind;
  rows: HeaderRow[];
  onChange(rows: HeaderRow[]): void;
}) {
  const { t } = useTranslation();
  const set = (key: string, patch: Partial<HeaderRow>) =>
    onChange(rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  return (
    <Section title={t('appAdmin.models.headers')}>
      {kind === 'command-code' && (
        <ListCard inset={ROW_INSET}>
          <SwitchRow
            label={t('appAdmin.models.zdr')}
            hint={t('appAdmin.models.zdrNote')}
            value={hasZdr(rows)}
            onChange={() => onChange(toggleZdr(rows))}
          />
        </ListCard>
      )}
      {rows.map((row) => (
        <View key={row.key} style={styles.pair}>
          <View style={styles.name}>
            <Field
              label={t('appAdmin.models.headerName')}
              value={row.name}
              onChangeText={(name) => set(row.key, { name })}
              placeholder="x-header"
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              style={styles.mono}
            />
          </View>
          <View style={styles.value}>
            <Field
              label={t('appAdmin.models.headerValue')}
              value={row.value}
              onChangeText={(value) => set(row.key, { value })}
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              style={styles.mono}
            />
          </View>
          <View style={styles.remove}>
            <IconButton
              icon={X}
              label={t('appAdmin.models.removeHeader', { name: row.name.trim() || '…' })}
              onPress={() => onChange(rows.filter((r) => r.key !== row.key))}
              color={colors.textMuted}
            />
          </View>
        </View>
      ))}
      <Button
        label={t('appAdmin.models.addHeader')}
        icon={Plus}
        variant="secondary"
        disabled={rows.length >= MAX_HEADERS}
        onPress={() => onChange([...rows, headerRow()])}
      />
      <Caption>{t('appAdmin.models.headersNote')}</Caption>
    </Section>
  );
}

const styles = StyleSheet.create({
  pair: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  name: { flex: 2, minWidth: 0 },
  value: { flex: 3, minWidth: 0 },
  // Centered on the input, not on its label.
  remove: { height: isAndroid ? 56 : 50, justifyContent: 'center' },
  mono: { fontFamily: fonts.mono, fontSize: 13.5, paddingHorizontal: 12 },
});
