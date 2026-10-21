import type { Computer } from '@mowbot/contract';
import { useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { Monitor, MonitorDown, Play } from 'lucide-react-native';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { InlinePicker } from '../../../components/admin/inline-picker';
import { Caption, LoadError, Loading, Note } from '../../../components/admin/parts';
import { ListCard } from '../../../components/list-card';
import { FormActions, Screen } from '../../../components/screen';
import { Section } from '../../../components/tab-scroll';
import { Button } from '../../../components/ui/button';
import { Field } from '../../../components/ui/field';
import { ChoiceRows, ListRow, ROW_INSET } from '../../../components/ui/rows';
import { T } from '../../../components/ui/text';
import { alertError } from '../../../lib/options-menu';
import { pcProblem, useComputer, useComputerAction } from '../../../lib/pc-queries';
import { keys, useComputers } from '../../../lib/queries';
import { filterSites, serviceName, siteHint } from '../../../lib/vault';
import {
  useCaptureSession,
  useComputerSites,
  useVaultItem,
  vaultError,
} from '../../../lib/vault-queries';
import { colors } from '../../../theme';

/** A filter field once the list gets long (Chrome keeps cookies of many sites). */
const FILTER_FROM = 8;

/** Turns a stopped PC on: its Chrome can only be read while it runs. */
function PcOff({ computer }: { computer: Computer }) {
  const { t } = useTranslation();
  const action = useComputerAction(computer.id);
  if (computer.status === 'starting') {
    return (
      <View style={styles.starting}>
        <ActivityIndicator color={colors.textMuted} />
        <T variant="footnote" tone="muted">
          {t('vault.session.starting')}
        </T>
      </View>
    );
  }
  if (computer.status === 'stopping') return <Note>{t('vault.session.stopping')}</Note>;
  const start = () =>
    action.mutate('start', {
      onError: (err) => {
        const problem = pcProblem(err);
        alertError(
          problem === 'generic' ? t('common.actionFailed') : t(`pcView.errors.${problem}`),
        );
      },
    });
  return (
    <>
      <Note>{t('vault.session.off')}</Note>
      <Button
        label={t('vault.session.turnOn', { name: computer.name })}
        icon={Play}
        variant="secondary"
        loading={action.isPending}
        onPress={start}
      />
    </>
  );
}

/** The sites with cookies in a running PC's Chrome, the one picked, and how to save it. */
function SiteForm({ computer }: { computer: Computer }) {
  const { t } = useTranslation();
  const sites = useComputerSites(computer.id, true);
  const capture = useCaptureSession();
  const [site, setSite] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [service, setService] = useState('');
  const [account, setAccount] = useState('');
  const all = sites.data ?? [];
  const shown = filterSites(all, filter);
  const picked = all.find((s) => s.site === site);
  // Saved already: an empty service or account keeps the entry's own.
  const existing = useVaultItem(picked?.itemId ?? undefined).data;

  const save = () => {
    if (!picked) return;
    capture.mutate(
      {
        computerId: computer.id,
        site: picked.site,
        ...(service.trim() ? { service: service.trim() } : {}),
        ...(account.trim() ? { account: account.trim() } : {}),
      },
      {
        onSuccess: (item) => router.replace(`/vault/${item.id}`),
        onError: (err) => alertError(vaultError(err, t('vault.session.notSaved'))),
      },
    );
  };

  let list: ReactNode;
  if (sites.isPending) {
    list = <Loading />;
  } else if (sites.isError) {
    list = (
      <LoadError
        message={vaultError(sites.error, t('errors.generic'))}
        onRetry={() => void sites.refetch()}
      />
    );
  } else if (all.length === 0) {
    list = <Note>{t('vault.session.noSites')}</Note>;
  } else if (picked) {
    list = (
      <ListCard inset={ROW_INSET}>
        <ListRow
          label={picked.site}
          hint={siteHint(picked, t)}
          value={t('vault.session.change')}
          chevron={false}
          onPress={() => setSite(null)}
        />
      </ListCard>
    );
  } else {
    list = (
      <>
        {all.length > FILTER_FROM && (
          <Field
            label={t('vault.session.filter')}
            value={filter}
            onChangeText={setFilter}
            placeholder={t('vault.session.filterPlaceholder')}
            keyboardType="url"
            autoCapitalize="none"
            autoCorrect={false}
          />
        )}
        {shown.length === 0 ? (
          <Note>{t('vault.session.noMatch')}</Note>
        ) : (
          <ListCard inset={ROW_INSET}>
            <ChoiceRows
              options={shown.map((s) => ({ value: s.site, label: s.site, hint: siteHint(s, t) }))}
              value={site}
              onChange={setSite}
            />
          </ListCard>
        )}
      </>
    );
  }

  return (
    <>
      <Section
        title={t('vault.session.sites')}
        accessory={
          sites.data ? (
            <T variant="caption" tone="faint">
              {all.length}
            </T>
          ) : undefined
        }
      >
        {list}
        {!picked && (
          <Button
            label={t('vault.session.openPc')}
            icon={Monitor}
            variant="secondary"
            onPress={() => router.push(`/pc/${computer.id}`)}
          />
        )}
      </Section>

      {picked ? (
        <>
          <Field
            label={t('vault.labels.service')}
            value={service}
            onChangeText={setService}
            placeholder={existing?.service ?? serviceName(picked.site)}
            maxLength={100}
            autoCorrect={false}
          />
          <Field
            label={t('vault.labels.account')}
            value={account}
            onChangeText={setAccount}
            placeholder={existing?.account ?? t('vault.labels.accountPlaceholder')}
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={200}
          />
          {picked.itemId ? <Caption>{t('vault.session.savedHint')}</Caption> : null}
          <FormActions>
            <Button
              label={picked.itemId ? t('vault.session.update') : t('vault.session.save')}
              icon={MonitorDown}
              onPress={save}
              loading={capture.isPending}
            />
          </FormActions>
        </>
      ) : null}
    </>
  );
}

/**
 * Saves a site's session from a PC's Chrome: pick the PC (turned on if needed), then one of the
 * sites it is signed in to (`?computer=` picks the PC beforehand).
 */
export default function VaultSessionScreen() {
  const { t } = useTranslation();
  const params = useLocalSearchParams<{ computer?: string }>();
  const client = useQueryClient();
  const computers = useComputers();
  const list = computers.data ?? [];
  const [chosen, setChosen] = useState<string | null>(params.computer ?? null);
  // A single PC: nothing to choose.
  const computerId = chosen ?? (list.length === 1 ? (list[0]?.id ?? null) : null);
  // Polled while it starts, in case an event is missed.
  const computer = useComputer(computerId ?? undefined).data;

  return (
    <Screen
      title={t('vault.session.title')}
      onRefresh={() =>
        Promise.all([
          computers.refetch(),
          // Signed in on the PC meanwhile: read its Chrome again.
          computerId
            ? client.invalidateQueries({ queryKey: keys.computerSites(computerId) })
            : null,
        ])
      }
    >
      <Note>{t('vault.session.intro')}</Note>
      {computers.isPending ? (
        <Loading />
      ) : computers.isError ? (
        <LoadError onRetry={() => void computers.refetch()} />
      ) : list.length === 0 ? (
        <Note>{t('vault.session.noComputers')}</Note>
      ) : (
        <>
          <InlinePicker
            label={t('vault.session.computer')}
            options={list.map((c) => ({
              value: c.id,
              label: c.name,
              hint: t(`pcView.status.${c.status}`),
            }))}
            value={computerId}
            placeholder={t('vault.session.choose')}
            onChange={setChosen}
          />
          {computer ? (
            computer.status === 'running' ? (
              // A new PC starts over: its own sites, nothing picked.
              <SiteForm key={computer.id} computer={computer} />
            ) : (
              <PcOff computer={computer} />
            )
          ) : null}
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  starting: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 4 },
});
