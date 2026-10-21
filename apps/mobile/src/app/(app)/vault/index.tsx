import type { Computer, VaultItem } from '@mowbot/contract';
import { router } from 'expo-router';
import { Plus, Vault } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { StyleSheet } from 'react-native';
import { LoadError, Loading, Note } from '../../../components/admin/parts';
import { ListCard } from '../../../components/list-card';
import { Screen } from '../../../components/screen';
import { Section } from '../../../components/tab-scroll';
import { Button, IconButton } from '../../../components/ui/button';
import { ICON_ROW_INSET, ListRow } from '../../../components/ui/rows';
import { Surface } from '../../../components/ui/surface';
import { T } from '../../../components/ui/text';
import { AskBadge, KIND_ICONS, useVaultAddMenu } from '../../../components/vault/parts';
import { useComputers } from '../../../lib/queries';
import { groupVault, itemHint } from '../../../lib/vault';
import { useVault } from '../../../lib/vault-queries';
import { colors } from '../../../theme';

function VaultRow({ item, computers }: { item: VaultItem; computers: Computer[] | undefined }) {
  const { t, i18n } = useTranslation();
  return (
    <ListRow
      icon={KIND_ICONS[item.kind]}
      label={item.service}
      hint={itemHint(item, { computers, t, language: i18n.language })}
      accessory={item.policy === 'ask' ? <AskBadge /> : undefined}
      onPress={() => router.push(`/vault/${item.id}`)}
    />
  );
}

/** How entries get here: a takeover, the bots, or the "+". */
function EmptyVault({ onAdd }: { onAdd(): void }) {
  const { t } = useTranslation();
  return (
    <>
      <Surface style={styles.empty}>
        <Vault size={28} color={colors.textMuted} strokeWidth={1.8} />
        <T variant="headline">{t('vault.emptyState.title')}</T>
        <T variant="footnote" tone="muted">
          {t('vault.emptyState.takeover')}
        </T>
        <T variant="footnote" tone="muted">
          {t('vault.emptyState.bots')}
        </T>
        <T variant="footnote" tone="muted">
          {t('vault.emptyState.manual')}
        </T>
      </Surface>
      <Button label={t('vault.add')} icon={Plus} onPress={onAdd} />
    </>
  );
}

/** Sessions, logins and secrets the bots use, grouped by kind. */
export default function VaultScreen() {
  const { t } = useTranslation();
  const vault = useVault();
  const computers = useComputers();
  const add = useVaultAddMenu();
  const groups = groupVault(vault.data ?? []);

  return (
    <Screen
      title={t('vault.title')}
      headerRight={() => <IconButton icon={Plus} label={t('vault.add')} onPress={add} />}
      onRefresh={() => Promise.all([vault.refetch(), computers.refetch()])}
    >
      <Note>{t('vault.subtitle')}</Note>
      {vault.isPending ? (
        <Loading />
      ) : vault.isError ? (
        <LoadError message={t('vault.loadFailed')} onRetry={() => void vault.refetch()} />
      ) : groups.length === 0 ? (
        <EmptyVault onAdd={add} />
      ) : (
        groups.map((group) => (
          <Section
            key={group.kind}
            title={t(`vault.groups.${group.kind}`)}
            accessory={
              <T variant="caption" tone="faint">
                {group.items.length}
              </T>
            }
          >
            <ListCard inset={ICON_ROW_INSET}>
              {group.items.map((item) => (
                <VaultRow key={item.id} item={item} computers={computers.data} />
              ))}
            </ListCard>
          </Section>
        ))
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  empty: { padding: 20, gap: 10 },
});
