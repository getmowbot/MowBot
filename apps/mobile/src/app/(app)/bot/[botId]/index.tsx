import type { Bot, Computer, Provider, Team } from '@mowbot/contract';
import { router, useLocalSearchParams } from 'expo-router';
import {
  ArrowRightLeft,
  BellRing,
  FolderOpen,
  ListPlus,
  MessageCircle,
  Monitor,
  Plus,
  Trash2,
  Users,
} from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { BotAvatar } from '../../../../components/bot-avatar';
import { BotStatusLine, useBotMood } from '../../../../components/bot-row';
import { ListCard } from '../../../../components/list-card';
import { TextArea } from '../../../../components/org/field-group';
import { FormError } from '../../../../components/org/form-error';
import { ModelPicker } from '../../../../components/org/model-picker';
import { FormActions, Screen } from '../../../../components/screen';
import { Section } from '../../../../components/tab-scroll';
import { Button } from '../../../../components/ui/button';
import { Field } from '../../../../components/ui/field';
import { ICON_ROW_INSET, ListRow, SwitchRow } from '../../../../components/ui/rows';
import { T } from '../../../../components/ui/text';
import { confirm, openOptions } from '../../../../lib/options-menu';
import {
  addFallback,
  type BotForm,
  botChanges,
  botForm,
  botFormChanged,
  botFormError,
  heartbeatChoices,
  heartbeatLabel,
  leadChange,
  MAX_FALLBACKS,
  problemMessage,
} from '../../../../lib/org-forms';
import { useDeleteBot, useSaveBot } from '../../../../lib/org-queries';
import { useBots, useComputers, useProviders, useTeams } from '../../../../lib/queries';
import { colors } from '../../../../theme';

function Hero({ bot }: { bot: Bot }) {
  const mood = useBotMood(bot);
  return (
    <View style={styles.hero}>
      <BotAvatar seed={bot.avatarSeed} size={56} mood={mood} />
      <View style={styles.heroText}>
        <T variant="title" numberOfLines={1}>
          {bot.name}
        </T>
        <BotStatusLine bot={bot} mood={mood} />
      </View>
    </View>
  );
}

function BotSettings({
  bot,
  team,
  pc,
  providers,
  rename,
}: {
  bot: Bot;
  team: Team | undefined;
  pc: Computer | undefined;
  providers: Provider[];
  /** Opened from "Rename": the name field has focus. */
  rename: boolean;
}) {
  const { t } = useTranslation();
  const save = useSaveBot();
  const remove = useDeleteBot();
  const [base, setBase] = useState({ bot, team });
  const [form, setForm] = useState(() => botForm(bot, team));
  const [error, setError] = useState<string | null>(null);

  // Changed elsewhere (another device, a bot): follow it unless being edited.
  if (base.bot !== bot || base.team !== team) {
    if (!botFormChanged(base.bot, base.team, form, providers)) setForm(botForm(bot, team));
    setBase({ bot, team });
  }

  const set = (patch: Partial<BotForm>) => setForm((current) => ({ ...current, ...patch }));
  const changes = botChanges(bot, form, providers);
  const lead = leadChange(bot, team, form.lead);
  const changed = Object.keys(changes).length > 0 || lead !== undefined;
  const invalid = botFormError(form);
  const provider = providers.find((p) => p.id === form.providerId);

  const submit = () => {
    setError(null);
    save.mutate(
      {
        bot,
        changes,
        lead: team && lead !== undefined ? { teamId: team.id, leadBotId: lead } : undefined,
      },
      {
        onSuccess: () => {
          if (router.canGoBack()) router.back();
        },
        onError: (err) => setError(problemMessage(err, t('orgAdmin.notSaved'), t)),
      },
    );
  };

  const chooseHeartbeat = () =>
    openOptions({
      title: t('orgAdmin.bot.heartbeat'),
      options: heartbeatChoices(bot.heartbeatMinutes).map((minutes) => ({
        label: heartbeatLabel(minutes, t),
        onPress: () => set({ heartbeatMinutes: minutes }),
      })),
    });

  const confirmDelete = async () => {
    const question = t(
      pc?.kind === 'dedicated'
        ? 'orgAdmin.bot.confirmDeleteDedicated'
        : 'orgAdmin.bot.confirmDelete',
      { name: bot.name },
    );
    const ok = await confirm(
      t('chat.menuDelete', { name: bot.name }),
      team ? question : `${question} ${t('orgAdmin.bot.soloFilesNote')}`,
      { label: t('common.delete'), destructive: true },
    );
    if (!ok) return;
    setError(null);
    remove.mutate(bot.id, {
      // Its chat may be under this screen: back to the tabs.
      onSuccess: () => (router.canDismiss() ? router.dismissAll() : router.replace('/bots')),
      onError: (err) => setError(problemMessage(err, t('orgAdmin.bot.notDeleted'), t)),
    });
  };

  return (
    <Screen title={bot.name}>
      <Hero bot={bot} />

      <ListCard inset={ICON_ROW_INSET}>
        <ListRow
          icon={MessageCircle}
          label={t('orgAdmin.links.conversation')}
          onPress={() => router.dismissTo({ pathname: '/chat/[botId]', params: { botId: bot.id } })}
        />
        {bot.computerId ? (
          <ListRow
            icon={Monitor}
            label={
              pc?.kind === 'dedicated' ? t('orgAdmin.links.ownPc') : t('orgAdmin.links.teamPc')
            }
            value={pc ? t(`org.pc.${pc.status}`) : undefined}
            onPress={() => router.push(`/pc/${bot.computerId}?bot=${bot.id}`)}
          />
        ) : null}
        {bot.workspaceId ? (
          <ListRow
            icon={FolderOpen}
            label={t('orgAdmin.links.files')}
            onPress={() => router.push(`/files/${bot.workspaceId}`)}
          />
        ) : null}
        <ListRow
          icon={ListPlus}
          label={t('orgAdmin.links.giveTask')}
          onPress={() => router.push(`/task/new?bot=${bot.id}`)}
        />
      </ListCard>

      <Section title={t('orgAdmin.bot.identity')}>
        <View style={styles.fields}>
          <Field
            label={t('orgAdmin.fields.name')}
            value={form.name}
            onChangeText={(name) => set({ name })}
            maxLength={40}
            autoFocus={rename}
            selectTextOnFocus={rename}
            returnKeyType={rename ? 'done' : 'next'}
            onSubmitEditing={rename && changed && !invalid ? submit : undefined}
          />
          <Field
            label={t('orgAdmin.fields.role')}
            value={form.role}
            onChangeText={(role) => set({ role })}
            maxLength={120}
          />
          <TextArea
            label={t('orgAdmin.fields.mission')}
            value={form.mission}
            onChangeText={(mission) => set({ mission })}
            placeholder={t('orgAdmin.newBot.missionPlaceholder')}
            maxLength={4000}
          />
        </View>
      </Section>

      <Section title={t('orgAdmin.bot.model')}>
        <ModelPicker
          label={t('orgAdmin.bot.mainModel')}
          value={{ providerId: form.providerId, model: form.model }}
          onChange={(value) => set({ providerId: value.providerId, model: value.model })}
          providers={providers}
          modelPlaceholder={
            provider?.defaultModel
              ? t('orgAdmin.model.defaultIs', { model: provider.defaultModel })
              : undefined
          }
        />
      </Section>

      <Section title={t('orgAdmin.fields.team')}>
        <ListCard inset={ICON_ROW_INSET}>
          <ListRow
            icon={Users}
            label={team?.name ?? t('orgAdmin.fields.solo')}
            onPress={team ? () => router.push(`/team/${team.id}`) : undefined}
          />
          {!bot.isChef ? (
            <ListRow
              icon={ArrowRightLeft}
              label={t('chat.menuMove')}
              onPress={() => router.push(`/bot/${bot.id}/move`)}
            />
          ) : null}
        </ListCard>
        {team && !bot.isChef ? (
          <ListCard inset={16}>
            <SwitchRow
              label={t('orgAdmin.bot.leadOf', { team: team.name })}
              hint={t('orgAdmin.newBot.leadHint')}
              value={form.lead}
              onChange={(value) => set({ lead: value })}
            />
          </ListCard>
        ) : null}
      </Section>

      <Section title={t('orgAdmin.bot.proactivity')}>
        <T variant="footnote" tone="muted" style={styles.indent}>
          {t('orgAdmin.bot.proactivityHint')}
        </T>
        <View style={styles.fields}>
          <ListCard inset={ICON_ROW_INSET}>
            <ListRow
              icon={BellRing}
              label={t('orgAdmin.bot.heartbeat')}
              value={heartbeatLabel(form.heartbeatMinutes, t)}
              onPress={chooseHeartbeat}
            />
          </ListCard>
          <Field
            label={t('orgAdmin.bot.budget')}
            hint={t('orgAdmin.bot.budgetHint')}
            value={form.budget}
            onChangeText={(budget) => set({ budget })}
            placeholder={t('orgAdmin.bot.noLimit')}
            keyboardType="number-pad"
            maxLength={12}
          />
          <ModelPicker
            label={t('orgAdmin.bot.lightModel')}
            hint={t('orgAdmin.bot.lightModelHint')}
            value={form.lightModel}
            onChange={(lightModel) => set({ lightModel })}
            providers={providers}
          />
          {form.fallbacks.map((fallback, index) => (
            <ModelPicker
              key={fallback.id}
              label={t('orgAdmin.bot.fallback', { n: index + 1 })}
              hint={index === 0 ? t('orgAdmin.bot.fallbackHint') : undefined}
              value={fallback}
              onChange={(value) =>
                set({
                  fallbacks: form.fallbacks.map((f) =>
                    f.id === fallback.id ? { ...value, id: f.id } : f,
                  ),
                })
              }
              onRemove={() =>
                set({ fallbacks: form.fallbacks.filter((f) => f.id !== fallback.id) })
              }
              providers={providers}
            />
          ))}
          {form.fallbacks.length < MAX_FALLBACKS && providers.length > 0 ? (
            <Button
              label={t('orgAdmin.bot.addFallback')}
              icon={Plus}
              variant="secondary"
              onPress={() => set({ fallbacks: addFallback(form.fallbacks) })}
            />
          ) : null}
        </View>
      </Section>

      <FormError message={error ?? (invalid ? t(`orgAdmin.bot.invalid.${invalid}`) : null)} />
      <FormActions>
        <Button
          label={t('common.save')}
          onPress={submit}
          loading={save.isPending}
          disabled={!changed || invalid !== null}
        />
        {!bot.isChef ? (
          <Button
            label={t('chat.menuDelete', { name: bot.name })}
            icon={Trash2}
            variant="danger"
            onPress={() => void confirmDelete()}
            loading={remove.isPending}
          />
        ) : null}
      </FormActions>
    </Screen>
  );
}

/** Everything about a bot: identity, models, team, check-ins and budget, its PC and files. */
export default function BotSettingsScreen() {
  const { botId, rename } = useLocalSearchParams<{ botId: string; rename?: string }>();
  const { t } = useTranslation();
  const bots = useBots();
  const teams = useTeams();
  const computers = useComputers();
  const providers = useProviders();
  const bot = bots.data?.find((item) => item.id === botId);

  if (!bot || teams.isPending || providers.isPending) {
    const loading = bots.isPending || teams.isPending || providers.isPending;
    return (
      <Screen title={t('chat.menuSettings')}>
        {loading ? (
          <ActivityIndicator color={colors.textMuted} />
        ) : (
          <T tone="muted" style={styles.indent}>
            {t('common.botNotFound')}
          </T>
        )}
      </Screen>
    );
  }
  return (
    <BotSettings
      key={bot.id}
      bot={bot}
      team={teams.data?.find((team) => team.id === bot.teamId)}
      pc={computers.data?.find((c) => c.id === bot.computerId)}
      providers={providers.data ?? []}
      rename={rename === '1'}
    />
  );
}

const styles = StyleSheet.create({
  hero: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 4 },
  heroText: { flex: 1, minWidth: 0, gap: 3 },
  indent: { paddingHorizontal: 4 },
  fields: { gap: 16 },
});
