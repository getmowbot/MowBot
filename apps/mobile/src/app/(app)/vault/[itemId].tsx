import type { Bot, Computer, VaultField, VaultItem } from '@mowbot/contract';
import { useQueryClient } from '@tanstack/react-query';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import { RefreshCw, Trash2, X } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { Caption, FormError, LoadError, Loading, Note } from '../../../components/admin/parts';
import { ListCard } from '../../../components/list-card';
import { TextArea } from '../../../components/org/field-group';
import { FormActions, Screen } from '../../../components/screen';
import { Section } from '../../../components/tab-scroll';
import { Button } from '../../../components/ui/button';
import { Field } from '../../../components/ui/field';
import { ICON_ROW_INSET, ListRow, ROW_INSET, SwitchRow } from '../../../components/ui/rows';
import { T } from '../../../components/ui/text';
import { ACTION_ICONS, SECRET_INPUT } from '../../../components/vault/parts';
import { alertError, confirm } from '../../../lib/options-menu';
import { botsById, keys, useBots, useComputers } from '../../../lib/queries';
import { timeAgo } from '../../../lib/time';
import {
  capitalize,
  computerName,
  EMPTY_VALUES,
  eventText,
  itemChanges,
  itemLabel,
  type LabelDraft,
  type LoginField,
  labelDraft,
  labelsProblem,
  placeholders,
  removableFields,
  removeFieldBody,
  sessionContents,
  type ValueDraft,
} from '../../../lib/vault';
import {
  useCaptureSession,
  useDeleteVaultItem,
  useRevokeVaultGrant,
  useUpdateVaultItem,
  useVaultEvents,
  useVaultItem,
  vaultError,
} from '../../../lib/vault-queries';
import { colors, spacing } from '../../../theme';

const HISTORY_SHOWN = 10;

interface Names {
  bots: Map<string, Bot>;
  computers: Computer[] | undefined;
}

/** Kind, where a session comes from, when it was captured and used, who added it. */
function Info({ item, bots, computers }: { item: VaultItem } & Names) {
  const { t, i18n } = useTranslation();
  const capture = useCaptureSession();
  const ago = (iso: string) => timeAgo(iso, t, i18n.language);
  const pc = item.computerId ? computers?.find((c) => c.id === item.computerId) : undefined;
  // A session is captured again from its own PC and site.
  const site = item.kind === 'session' ? item.sites[0] : undefined;
  const addedBy = item.createdByBotId
    ? (bots.get(item.createdByBotId)?.name ?? t('common.deletedBot'))
    : capitalize(t('common.you'));

  const recapture = () => {
    if (!pc || !site) return;
    capture.mutate(
      { computerId: pc.id, site },
      { onError: (err) => alertError(vaultError(err, t('vault.session.notSaved'))) },
    );
  };

  return (
    <Section title={t('vault.info.title')}>
      <ListCard inset={ROW_INSET}>
        <ListRow label={t('vault.info.kind')} value={t(`vault.kinds.${item.kind}`)} />
        {item.kind === 'session' && (
          <ListRow
            label={t('vault.info.source')}
            value={computerName(item.computerId, computers, t)}
            onPress={pc ? () => router.push(`/pc/${pc.id}`) : undefined}
          />
        )}
        {item.capturedAt ? (
          <ListRow label={t('vault.info.capturedAt')} value={ago(item.capturedAt)} />
        ) : null}
        {item.session ? (
          <ListRow
            label={t('vault.info.contents')}
            value={sessionContents(item.session, t) ?? undefined}
          />
        ) : null}
        <ListRow
          label={t('vault.info.lastUsed')}
          value={item.lastUsedAt ? ago(item.lastUsedAt) : t('vault.info.never')}
        />
        <ListRow label={t('vault.info.addedBy')} hint={ago(item.createdAt)} value={addedBy} />
        {item.kind === 'session' && <ListRow label={t('vault.info.reference')} value={item.ref} />}
      </ListCard>
      {pc && site ? (
        <ListCard inset={ICON_ROW_INSET}>
          <ListRow
            icon={RefreshCw}
            label={t('vault.info.recapture')}
            hint={t('vault.info.recaptureHint', { pc: pc.name })}
            chevron={false}
            disabled={capture.isPending}
            accessory={
              capture.isPending ? (
                <ActivityIndicator size="small" color={colors.textMuted} />
              ) : undefined
            }
            onPress={recapture}
          />
        </ListCard>
      ) : null}
    </Section>
  );
}

/** How bots use it: placeholders to copy, or a session they load. */
function ForBots({ item, computers }: { item: VaultItem; computers: Computer[] | undefined }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState<VaultField | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = (field: VaultField, text: string) => {
    void Clipboard.setStringAsync(text).then(() => {
      void Haptics.selectionAsync();
      setCopied(field);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(null), 2_000);
    });
  };

  if (item.kind === 'session') {
    const source = computers?.find((c) => c.id === item.computerId);
    return (
      <Section title={t('vault.placeholders.title')}>
        <Note>{t('vault.placeholders.session')}</Note>
        {source ? (
          <Caption>{t('vault.placeholders.sessionSame', { pc: source.name })}</Caption>
        ) : null}
      </Section>
    );
  }

  return (
    <Section title={t('vault.placeholders.title')}>
      <ListCard inset={ROW_INSET}>
        {placeholders(item).map(({ field, text }) => (
          <ListRow
            key={field}
            label={text}
            hint={capitalize(
              field === 'totp' ? t('vault.placeholders.totp') : t(`vault.fieldNames.${field}`),
            )}
            chevron={false}
            accessory={
              <T variant="callout" tone={copied === field ? 'default' : 'muted'}>
                {copied === field ? t('vault.placeholders.copied') : t('vault.placeholders.copy')}
              </T>
            }
            onPress={() => copy(field, text)}
          />
        ))}
      </ListCard>
      <Caption>{t('vault.placeholders.note')}</Caption>
    </Section>
  );
}

/** Labels, then the values (write-only), saved together. */
function EditForm({ item }: { item: VaultItem }) {
  const { t } = useTranslation();
  const save = useUpdateVaultItem();
  const remove = useUpdateVaultItem();
  const [labels, setLabels] = useState<LabelDraft>(() => labelDraft(item));
  const [values, setValues] = useState<ValueDraft>(EMPTY_VALUES);
  const [error, setError] = useState<string | null>(null);
  const changes = itemChanges(item, labels, values);
  const dirty = Object.keys(changes).length > 0;
  const editLabels = (patch: Partial<LabelDraft>) => setLabels((draft) => ({ ...draft, ...patch }));
  const editValues = (patch: Partial<ValueDraft>) => setValues((draft) => ({ ...draft, ...patch }));
  const stored = (field: VaultField) =>
    item.fields.includes(field) ? t('vault.values.stored') : t('vault.values.none');

  const submit = () => {
    const problem = labelsProblem(labels);
    if (problem) {
      setError(t(`vault.formProblems.${problem}`));
      return;
    }
    setError(null);
    save.mutate(
      { id: item.id, body: changes },
      {
        onSuccess: (saved) => {
          setLabels(labelDraft(saved));
          setValues(EMPTY_VALUES);
        },
        onError: (err) => setError(vaultError(err, t('vault.notSaved'))),
      },
    );
  };

  const askRemove = async (field: LoginField) => {
    const ok = await confirm(
      t('vault.values.removeConfirm', { name: itemLabel(item) }),
      t('vault.values.removeHint'),
      { label: t('vault.values.removeAction'), destructive: true },
    );
    if (!ok) return;
    remove.mutate(
      { id: item.id, body: removeFieldBody(field) },
      { onError: (err) => alertError(vaultError(err, t('common.actionFailed'))) },
    );
  };

  const removable = removableFields(item);

  return (
    <>
      <Section title={t('vault.labels.title')}>
        <View style={styles.fields}>
          <Field
            label={t('vault.labels.service')}
            value={labels.service}
            onChangeText={(service) => editLabels({ service })}
            placeholder={t('vault.labels.servicePlaceholder')}
            maxLength={100}
            autoCorrect={false}
          />
          <Field
            label={t('vault.labels.account')}
            value={labels.account}
            onChangeText={(account) => editLabels({ account })}
            placeholder={t('vault.labels.accountPlaceholder')}
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={200}
          />
          <Field
            label={t('vault.labels.sites')}
            hint={t('vault.labels.sitesHint')}
            value={labels.sites}
            onChangeText={(sites) => editLabels({ sites })}
            placeholder={t('vault.labels.sitesPlaceholder')}
            keyboardType="url"
            autoCapitalize="none"
            autoCorrect={false}
          />
          <TextArea
            label={t('vault.labels.notes')}
            hint={t('vault.labels.notesHint')}
            value={labels.notes}
            onChangeText={(notes) => editLabels({ notes })}
            placeholder={t('vault.labels.notesPlaceholder')}
            maxLength={2_000}
          />
        </View>
      </Section>

      {item.kind !== 'session' && (
        <Section title={t('vault.values.title')}>
          <Note>{t('vault.values.note')}</Note>
          <View style={styles.fields}>
            {item.kind === 'login' ? (
              <>
                <Field
                  label={t('vault.values.username')}
                  value={values.username}
                  onChangeText={(username) => editValues({ username })}
                  placeholder={stored('username')}
                  maxLength={500}
                  {...SECRET_INPUT}
                />
                <Field
                  label={t('vault.values.password')}
                  value={values.password}
                  onChangeText={(password) => editValues({ password })}
                  placeholder={stored('password')}
                  secureTextEntry
                  maxLength={10_000}
                  {...SECRET_INPUT}
                />
                <Field
                  label={t('vault.values.totp')}
                  hint={t('vault.values.totpHint')}
                  value={values.totp}
                  onChangeText={(totp) => editValues({ totp })}
                  placeholder={stored('totp')}
                  secureTextEntry
                  maxLength={500}
                  {...SECRET_INPUT}
                />
              </>
            ) : (
              <Field
                label={t('vault.values.value')}
                value={values.value}
                onChangeText={(value) => editValues({ value })}
                placeholder={stored('value')}
                secureTextEntry
                maxLength={10_000}
                {...SECRET_INPUT}
              />
            )}
          </View>
          {removable.length > 0 && (
            <ListCard inset={ICON_ROW_INSET}>
              {removable.map((field) => (
                <ListRow
                  key={field}
                  icon={X}
                  label={t(`vault.values.remove.${field}`)}
                  destructive
                  disabled={remove.isPending}
                  onPress={() => void askRemove(field)}
                />
              ))}
            </ListCard>
          )}
          {item.kind === 'login' && item.fields.length === 1 && (
            <Caption>{t('vault.values.lastValue')}</Caption>
          )}
        </Section>
      )}

      <FormError message={error} />
      <FormActions>
        <Button
          label={t('common.save')}
          onPress={submit}
          loading={save.isPending}
          disabled={!dirty}
        />
      </FormActions>
    </>
  );
}

/** Ask before each new bot or not, and the bots already allowed. */
function Access({ item, bots }: { item: VaultItem; bots: Map<string, Bot> }) {
  const { t } = useTranslation();
  const setPolicy = useUpdateVaultItem();
  const revoke = useRevokeVaultGrant();
  // The switch follows the tap right away, then the hub's answer.
  const pending = setPolicy.isPending ? setPolicy.variables?.body.policy : undefined;
  const ask = (pending ?? item.policy) === 'ask';

  const toggle = (next: boolean) =>
    setPolicy.mutate(
      { id: item.id, body: { policy: next ? 'ask' : 'auto' } },
      { onError: (err) => alertError(vaultError(err, t('vault.notSaved'))) },
    );

  const askRevoke = async (botId: string, name: string) => {
    const ok = await confirm(
      t('vault.grants.confirmRevoke', { bot: name }),
      t('vault.grants.revokeHint'),
      { label: t('vault.grants.revoke'), destructive: true },
    );
    if (!ok) return;
    revoke.mutate(
      { id: item.id, botId },
      { onError: (err) => alertError(vaultError(err, t('common.actionFailed'))) },
    );
  };

  const granted = item.grantedBotIds;
  return (
    <>
      <Section title={t('vault.policy.title')}>
        <ListCard inset={ROW_INSET}>
          <SwitchRow
            label={t('vault.policy.label')}
            hint={t('vault.policy.hint')}
            value={ask}
            onChange={toggle}
            disabled={setPolicy.isPending}
          />
        </ListCard>
      </Section>
      {(ask || granted.length > 0) && (
        <Section title={t('vault.grants.title')}>
          {granted.length === 0 ? (
            <Note>{t('vault.grants.none')}</Note>
          ) : (
            <ListCard inset={ROW_INSET}>
              {granted.map((botId) => {
                const name = bots.get(botId)?.name ?? t('common.deletedBot');
                const revoking = revoke.isPending && revoke.variables?.botId === botId;
                return (
                  <ListRow
                    key={botId}
                    label={name}
                    chevron={false}
                    disabled={revoking}
                    accessory={
                      revoking ? (
                        <ActivityIndicator size="small" color={colors.textMuted} />
                      ) : (
                        <T variant="callout" tone="danger">
                          {t('vault.grants.revoke')}
                        </T>
                      )
                    }
                    onPress={() => void askRevoke(botId, name)}
                  />
                );
              })}
            </ListCard>
          )}
        </Section>
      )}
    </>
  );
}

/** Captures, uses, requests and decisions, newest first. */
function History({ item, bots, computers }: { item: VaultItem } & Names) {
  const { t, i18n } = useTranslation();
  const events = useVaultEvents(item.id);
  const [all, setAll] = useState(false);
  const list = events.data ?? [];
  const shown = all ? list : list.slice(0, HISTORY_SHOWN);

  return (
    <Section title={t('vault.history.title')}>
      {events.isPending ? (
        <Loading />
      ) : events.isError ? (
        <LoadError onRetry={() => void events.refetch()} />
      ) : list.length === 0 ? (
        <Note>{t('vault.history.none')}</Note>
      ) : (
        <ListCard inset={ICON_ROW_INSET}>
          {shown.map((event) => {
            const text = eventText(event, { bots, computers }, t);
            return (
              <ListRow
                key={event.id}
                icon={ACTION_ICONS[event.action]}
                label={text.label}
                hint={text.hint ?? undefined}
                value={timeAgo(event.createdAt, t, i18n.language)}
              />
            );
          })}
          {list.length > HISTORY_SHOWN && (
            <ListRow
              key="more"
              label={
                all
                  ? t('vault.history.showLess')
                  : t('vault.history.showAll', { count: list.length })
              }
              chevron={false}
              onPress={() => setAll((value) => !value)}
            />
          )}
        </ListCard>
      )}
    </Section>
  );
}

function VaultDetail({ item, bots, computers }: { item: VaultItem } & Names) {
  const { t } = useTranslation();
  const remove = useDeleteVaultItem();

  const askDelete = async () => {
    const ok = await confirm(
      t('vault.confirmDelete', { name: itemLabel(item) }),
      item.kind === 'session' ? t('vault.deleteSessionHint') : t('vault.deleteHint'),
      { label: t('common.delete'), destructive: true },
    );
    if (!ok) return;
    remove.mutate(item.id, {
      onSuccess: () => router.back(),
      onError: (err) => alertError(vaultError(err, t('common.actionFailed'))),
    });
  };

  return (
    <>
      <Info item={item} bots={bots} computers={computers} />
      <ForBots item={item} computers={computers} />
      <EditForm item={item} />
      <Access item={item} bots={bots} />
      <History item={item} bots={bots} computers={computers} />
      <FormActions>
        <Button
          label={t('vault.delete')}
          icon={Trash2}
          variant="danger"
          loading={remove.isPending}
          onPress={() => void askDelete()}
        />
      </FormActions>
    </>
  );
}

/** One vault entry: details, placeholders, labels and values, access, history, delete. */
export default function VaultItemScreen() {
  const { t } = useTranslation();
  const { itemId } = useLocalSearchParams<{ itemId: string }>();
  const client = useQueryClient();
  const item = useVaultItem(itemId);
  const bots = useBots();
  const computers = useComputers();

  return (
    <Screen
      title={item.data?.service ?? t('vault.title')}
      onRefresh={() =>
        Promise.all([
          item.refetch(),
          computers.refetch(),
          client.invalidateQueries({ queryKey: keys.vaultEvents(itemId) }),
        ])
      }
    >
      {item.isPending ? (
        <Loading />
      ) : item.isError ? (
        <LoadError message={t('vault.loadFailed')} onRetry={() => void item.refetch()} />
      ) : item.data ? (
        <VaultDetail
          key={item.data.id}
          item={item.data}
          bots={botsById(bots.data)}
          computers={computers.data}
        />
      ) : (
        <Note>{t('vault.notFound')}</Note>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  fields: { gap: spacing.lg },
});
