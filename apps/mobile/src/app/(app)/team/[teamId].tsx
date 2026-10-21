import type { Bot, Computer, Team } from '@mowbot/contract';
import { router, useLocalSearchParams } from 'expo-router';
import {
  ArrowRightLeft,
  Eraser,
  FolderOpen,
  Lock,
  Monitor,
  Trash2,
  UserPlus,
} from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { TeamAvatar } from '../../../components/bot-avatar';
import { ListCard } from '../../../components/list-card';
import { BotPickRow, PICK_ROW_INSET } from '../../../components/org/bot-pick-row';
import { FieldGroup, TextArea } from '../../../components/org/field-group';
import { FormError } from '../../../components/org/form-error';
import { MemberRow } from '../../../components/org/member-row';
import { FormActions, Screen } from '../../../components/screen';
import { Section } from '../../../components/tab-scroll';
import { Button } from '../../../components/ui/button';
import { Field } from '../../../components/ui/field';
import { ChoiceRows, ICON_ROW_INSET, ListRow, SwitchRow } from '../../../components/ui/rows';
import { T } from '../../../components/ui/text';
import { confirm } from '../../../lib/options-menu';
import {
  problemMessage,
  type TeamForm,
  teamChanges,
  teamDeleteBlock,
  teamForm,
  teamMembers,
} from '../../../lib/org-forms';
import { useClearTeam, useDeleteTeam, useUpdateTeam } from '../../../lib/org-queries';
import { useBots, useComputers, useTeams } from '../../../lib/queries';
import { colors } from '../../../theme';

const NO_LEAD = 'none';

function TeamDetails({
  team,
  teams,
  bots,
  computer,
}: {
  team: Team;
  teams: Team[];
  bots: Bot[];
  computer: Computer | undefined;
}) {
  const { t } = useTranslation();
  const update = useUpdateTeam();
  const remove = useDeleteTeam();
  const members = teamMembers(team, bots);
  const [base, setBase] = useState(team);
  const [form, setForm] = useState(() => teamForm(team));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [bringing, setBringing] = useState(false);

  // Changed elsewhere (another device, a bot) or just saved: follow it unless being edited.
  if (base !== team) {
    if (Object.keys(teamChanges(base, form)).length === 0) setForm(teamForm(team));
    setBase(team);
  }

  const changes = teamChanges(team, form);
  const changed = Object.keys(changes).length > 0;
  const set = (patch: Partial<TeamForm>) => {
    setForm((current) => ({ ...current, ...patch }));
    setSaved(false);
  };
  const others = bots.filter((bot) => !bot.isChef && bot.teamId !== team.id);
  const whereIs = (bot: Bot) =>
    teams.find((other) => other.id === bot.teamId)?.name ?? t('orgAdmin.fields.solo');
  const block = teamDeleteBlock(team);
  const clear = useClearTeam();
  const [cleared, setCleared] = useState(false);
  const names = members.map((bot) => bot.name).join(', ');

  const save = () => {
    setError(null);
    update.mutate(
      { id: team.id, body: changes },
      {
        onSuccess: () => setSaved(true),
        onError: (err) => setError(problemMessage(err, t('orgAdmin.notSaved'), t)),
      },
    );
  };

  const confirmDelete = async () => {
    const ok = await confirm(
      t('orgAdmin.team.delete'),
      members.length > 0
        ? t('orgAdmin.team.confirmDeleteWithBots', { name: team.name, bots: names })
        : t('orgAdmin.team.confirmDelete', { name: team.name }),
      { label: t('common.delete'), destructive: true },
    );
    if (!ok) return;
    setError(null);
    remove.mutate(team.id, {
      onSuccess: () => (router.canGoBack() ? router.back() : router.replace('/bots')),
      onError: (err) => setError(problemMessage(err, t('orgAdmin.team.notDeleted'), t)),
    });
  };

  const confirmClear = async () => {
    const ok = await confirm(
      t('orgAdmin.team.clear'),
      t('orgAdmin.team.confirmClear', { name: team.name, bots: names }),
      { label: t('orgAdmin.team.clear'), destructive: true },
    );
    if (!ok) return;
    setError(null);
    clear.mutate(team.id, {
      onSuccess: () => setCleared(true),
      onError: (err) => setError(problemMessage(err, t('orgAdmin.team.notCleared'), t)),
    });
  };

  return (
    <Screen title={team.name}>
      <View style={styles.hero}>
        <TeamAvatar seeds={members.map((b) => b.avatarSeed)} size={56} />
        <View style={styles.heroText}>
          <View style={styles.heroName}>
            <T variant="title" numberOfLines={2} style={styles.shrink}>
              {team.name}
            </T>
            {team.isolated && (
              <Lock size={15} color={colors.textMuted} accessibilityLabel={t('org.isolated')} />
            )}
          </View>
          <T variant="footnote" tone="muted" numberOfLines={4}>
            {team.mission ?? t('orgAdmin.team.noMission')}
          </T>
        </View>
      </View>

      <ListCard inset={ICON_ROW_INSET}>
        {team.computerId ? (
          <ListRow
            icon={Monitor}
            label={t('orgAdmin.links.teamPc')}
            value={computer ? t(`org.pc.${computer.status}`) : undefined}
            onPress={() => router.push(`/pc/${team.computerId}`)}
          />
        ) : null}
        <ListRow
          icon={FolderOpen}
          label={t('orgAdmin.links.files')}
          onPress={() => router.push(`/files/${team.workspaceId}`)}
        />
      </ListCard>

      <Section
        title={t('orgAdmin.team.members')}
        accessory={
          <T variant="caption" tone="faint">
            {members.length}
          </T>
        }
      >
        {members.length > 0 ? (
          <ListCard>
            {members.map((bot) => (
              <MemberRow key={bot.id} bot={bot} lead={bot.id === team.leadBotId} />
            ))}
          </ListCard>
        ) : (
          <T variant="footnote" tone="faint" style={styles.indent}>
            {t('orgAdmin.team.empty')}
          </T>
        )}
        <ListCard inset={ICON_ROW_INSET}>
          <ListRow
            icon={UserPlus}
            label={t('orgAdmin.team.newBot')}
            onPress={() => router.push(`/bot/new?team=${team.id}`)}
          />
          {others.length > 0 ? (
            <ListRow
              icon={ArrowRightLeft}
              label={t('orgAdmin.team.bringBot')}
              onPress={() => setBringing((value) => !value)}
              chevron={false}
              hint={bringing ? t('orgAdmin.team.bringHint') : undefined}
            />
          ) : null}
        </ListCard>
        {bringing && others.length > 0 ? (
          <ListCard inset={PICK_ROW_INSET}>
            {others.map((bot) => (
              <BotPickRow
                key={bot.id}
                bot={bot}
                hint={whereIs(bot)}
                onPress={() => router.push(`/bot/${bot.id}/move?team=${team.id}`)}
              />
            ))}
          </ListCard>
        ) : null}
      </Section>

      <Section title={t('orgAdmin.team.settings')}>
        <View style={styles.fields}>
          <Field
            label={t('orgAdmin.fields.name')}
            value={form.name}
            onChangeText={(name) => set({ name })}
            maxLength={60}
          />
          <TextArea
            label={t('orgAdmin.fields.mission')}
            value={form.mission}
            onChangeText={(mission) => set({ mission })}
            placeholder={t('orgAdmin.newTeam.missionPlaceholder')}
            maxLength={4000}
          />
          {members.length > 0 ? (
            <FieldGroup label={t('orgAdmin.fields.lead')} hint={t('orgAdmin.team.leadHint')}>
              <ListCard inset={16}>
                <ChoiceRows
                  options={[
                    { value: NO_LEAD, label: t('orgAdmin.team.noLead') },
                    ...members.map((bot) => ({ value: bot.id, label: bot.name, hint: bot.role })),
                  ]}
                  value={form.leadBotId ?? NO_LEAD}
                  onChange={(value) => set({ leadBotId: value === NO_LEAD ? null : value })}
                />
              </ListCard>
            </FieldGroup>
          ) : null}
          <ListCard inset={16}>
            <SwitchRow
              label={t('orgAdmin.fields.isolated')}
              hint={t('orgAdmin.team.isolatedHint')}
              value={form.isolated}
              onChange={(isolated) => set({ isolated })}
            />
          </ListCard>
        </View>
      </Section>

      <FormError message={error} />
      <FormActions>
        <Button
          label={saved && !changed ? t('orgAdmin.saved') : t('common.save')}
          onPress={save}
          loading={update.isPending}
          disabled={!changed || !form.name.trim()}
        />
        {members.length > 0 ? (
          <Button
            label={cleared ? t('orgAdmin.team.cleared') : t('orgAdmin.team.clear')}
            icon={Eraser}
            variant="secondary"
            onPress={() => void confirmClear()}
            loading={clear.isPending}
          />
        ) : null}
        {block !== 'main' ? (
          <Button
            label={t('orgAdmin.team.delete')}
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

/** A team: its members, its PC and files, its settings. */
export default function TeamScreen() {
  const { teamId } = useLocalSearchParams<{ teamId: string }>();
  const { t } = useTranslation();
  const teams = useTeams();
  const bots = useBots();
  const computers = useComputers();
  const team = teams.data?.find((item) => item.id === teamId);

  if (!team) {
    return (
      <Screen title={t('orgAdmin.team.title')}>
        {teams.isPending ? (
          <ActivityIndicator color={colors.textMuted} />
        ) : (
          <T tone="muted" style={styles.indent}>
            {t('orgAdmin.team.notFound')}
          </T>
        )}
      </Screen>
    );
  }
  return (
    <TeamDetails
      key={team.id}
      team={team}
      teams={teams.data ?? []}
      bots={bots.data ?? []}
      computer={computers.data?.find((c) => c.id === team.computerId)}
    />
  );
}

const styles = StyleSheet.create({
  hero: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 4 },
  heroText: { flex: 1, minWidth: 0, gap: 4 },
  heroName: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  shrink: { flexShrink: 1 },
  indent: { paddingHorizontal: 4 },
  fields: { gap: 16 },
  center: { textAlign: 'center' },
});
