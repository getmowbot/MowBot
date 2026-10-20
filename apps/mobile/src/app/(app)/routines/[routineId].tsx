import type { Bot, Routine } from '@mowbot/contract';
import { useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { Gauge, Pencil, Play, Share2, Trash2 } from 'lucide-react-native';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Share, StyleSheet } from 'react-native';
import { Caption, LoadError, Loading, Note } from '../../../components/admin/parts';
import { RUN_ICONS, RunStatus } from '../../../components/admin/run-status';
import { openChat } from '../../../components/bot-row';
import { ListCard } from '../../../components/list-card';
import { FormActions, Screen } from '../../../components/screen';
import { Section } from '../../../components/tab-scroll';
import { Button, IconButton } from '../../../components/ui/button';
import { ICON_ROW_INSET, ListRow, ROW_INSET, SwitchRow } from '../../../components/ui/rows';
import { Surface } from '../../../components/ui/surface';
import { T } from '../../../components/ui/text';
import {
  adminError,
  useDeleteRoutine,
  useRoutine,
  useRoutineRuns,
  useRunRoutine,
  useUpdateRoutine,
} from '../../../lib/admin-queries';
import { alertError, confirm } from '../../../lib/options-menu';
import { keys, useBots } from '../../../lib/queries';
import { describeTrigger, nextRunText } from '../../../lib/routine-form';
import { hubUrl } from '../../../lib/session';
import { timeAgo } from '../../../lib/time';
import { fonts } from '../../../theme';

function History({ routine, bot }: { routine: Routine; bot: Bot | undefined }) {
  const { t, i18n } = useTranslation();
  const client = useQueryClient();
  const runs = useRoutineRuns(routine.id);
  // Events only refresh the routine itself: when its last run changes, refresh the history.
  const lastRun = `${routine.lastRunAt}|${routine.lastStatus}`;
  const seen = useRef(lastRun);
  useEffect(() => {
    if (seen.current === lastRun) return;
    seen.current = lastRun;
    void client.invalidateQueries({ queryKey: keys.routineRuns(routine.id) });
  }, [client, routine.id, lastRun]);

  return (
    <Section title={t('appAdmin.routines.history')}>
      {runs.isPending ? (
        <Loading />
      ) : runs.isError ? (
        <LoadError onRetry={() => void runs.refetch()} />
      ) : runs.data.length === 0 ? (
        <Note>{t('appAdmin.routines.noRuns')}</Note>
      ) : (
        <ListCard inset={ICON_ROW_INSET}>
          {runs.data.map((run) => (
            <ListRow
              key={run.id}
              icon={RUN_ICONS[run.status]}
              label={t(`appAdmin.routines.status.${run.status}`)}
              hint={run.detail ?? (run.messageId ? t('appAdmin.routines.seeAnswer') : undefined)}
              value={timeAgo(run.startedAt, t, i18n.language)}
              destructive={run.status === 'error'}
              chevron={Boolean(run.messageId && bot)}
              onPress={run.messageId && bot ? () => openChat(bot) : undefined}
            />
          ))}
        </ListCard>
      )}
    </Section>
  );
}

function Webhook({ path }: { path: string }) {
  const { t } = useTranslation();
  const url = `${hubUrl() ?? ''}${path}`;
  return (
    <Section title={t('appAdmin.routines.webhook')}>
      <Surface style={styles.box}>
        <T variant="footnote" selectable style={styles.mono}>
          {url}
        </T>
      </Surface>
      <Button
        label={t('appAdmin.routines.webhookShare')}
        icon={Share2}
        variant="secondary"
        // The share sheet has Copy on iOS and Android: no clipboard module needed.
        onPress={() => void Share.share({ message: url }).catch(() => undefined)}
      />
      <Caption>{t('appAdmin.routines.webhookHint')}</Caption>
    </Section>
  );
}

function RoutineDetail({ routine, bot }: { routine: Routine; bot: Bot | undefined }) {
  const { t, i18n } = useTranslation();
  const update = useUpdateRoutine();
  const run = useRunRoutine();
  const remove = useDeleteRoutine();
  // Switches follow the tap right away, then the hub's answer.
  const pending = update.isPending ? update.variables : undefined;
  const enabled = pending?.enabled ?? routine.enabled;
  const silent = pending?.silent ?? routine.silent;

  const set = (body: { enabled?: boolean; silent?: boolean }) =>
    update.mutate(
      { id: routine.id, ...body },
      { onError: (err) => alertError(adminError(err, t('appAdmin.routines.notSaved'))) },
    );

  const runNow = () =>
    run.mutate(routine.id, {
      onSuccess: (result) => {
        if (result.status === 'skipped' || result.status === 'error') {
          alertError(
            [t(`appAdmin.routines.status.${result.status}`), result.detail]
              .filter(Boolean)
              .join(' · '),
          );
        }
      },
      onError: (err) => alertError(adminError(err, t('appAdmin.routines.runFailed'))),
    });

  const askDelete = async () => {
    const ok = await confirm(
      t('appAdmin.routines.confirmDelete', { name: routine.name }),
      undefined,
      {
        label: t('common.delete'),
        destructive: true,
      },
    );
    if (!ok) return;
    remove.mutate(routine.id, {
      onSuccess: () => router.back(),
      onError: (err) => alertError(adminError(err, t('common.actionFailed'))),
    });
  };

  const createdBy = t(`appAdmin.routines.createdBy.${routine.createdBy}`, {
    bot: bot?.name ?? t('common.deletedBot'),
  });

  return (
    <>
      <ListCard inset={ROW_INSET}>
        <SwitchRow
          label={t('appAdmin.routines.enabled')}
          hint={
            routine.failures > 0
              ? t('appAdmin.routines.failures', { count: routine.failures })
              : undefined
          }
          value={enabled}
          onChange={(value) => set({ enabled: value })}
        />
        <SwitchRow
          label={t('appAdmin.routines.notify')}
          value={!silent}
          onChange={(value) => set({ silent: !value })}
        />
      </ListCard>

      <ListCard inset={ROW_INSET}>
        <ListRow
          label={t('appAdmin.routines.bot')}
          value={bot?.name ?? t('common.deletedBot')}
          onPress={bot ? () => openChat(bot) : undefined}
        />
        <ListRow
          label={t('appAdmin.routines.when')}
          hint={describeTrigger(routine.trigger, t, i18n.language)}
        />
        {enabled && routine.nextRunAt ? (
          <ListRow
            label={t('appAdmin.routines.nextRun')}
            hint={nextRunText(routine.nextRunAt, t, i18n.language)}
          />
        ) : null}
        {routine.lastRunAt ? (
          <ListRow
            label={t('appAdmin.routines.lastRun')}
            hint={timeAgo(routine.lastRunAt, t, i18n.language)}
            accessory={routine.lastStatus ? <RunStatus status={routine.lastStatus} /> : null}
          />
        ) : null}
        <ListRow label={createdBy} />
      </ListCard>

      <Section title={t('appAdmin.routines.instruction')}>
        <Surface style={styles.box}>
          <T variant="callout" selectable>
            {routine.prompt}
          </T>
        </Surface>
      </Section>

      {routine.webhookUrl ? <Webhook path={routine.webhookUrl} /> : null}

      {routine.kind === 'heartbeat' && bot ? (
        <Section title={t('appAdmin.proactivity.heartbeat')}>
          <Note>{t('appAdmin.routines.heartbeatHint', { name: bot.name })}</Note>
          <ListCard inset={ICON_ROW_INSET}>
            <ListRow
              icon={Gauge}
              label={t('appAdmin.routines.openProactivity')}
              onPress={() => router.push(`/proactivity/${bot.id}`)}
            />
          </ListCard>
        </Section>
      ) : null}

      <FormActions>
        <Button
          label={t('appAdmin.routines.runNow')}
          icon={Play}
          onPress={runNow}
          loading={run.isPending}
        />
      </FormActions>

      <History routine={routine} bot={bot} />

      {routine.kind === 'custom' && (
        <FormActions>
          <Button
            label={t('appAdmin.routines.delete')}
            icon={Trash2}
            variant="danger"
            loading={remove.isPending}
            onPress={() => void askDelete()}
          />
        </FormActions>
      )}
    </>
  );
}

/** One routine: switches, schedule, instruction, webhook, run now, history, delete. */
export default function RoutineScreen() {
  const { t } = useTranslation();
  const { routineId } = useLocalSearchParams<{ routineId: string }>();
  const routine = useRoutine(routineId);
  const bots = useBots();
  const client = useQueryClient();
  const data = routine.data;
  const bot = bots.data?.find((b) => b.id === data?.botId);

  return (
    <Screen
      title={data?.name ?? t('appAdmin.routines.title')}
      headerRight={
        data?.kind === 'custom'
          ? () => (
              <IconButton
                icon={Pencil}
                label={t('appAdmin.routines.edit')}
                onPress={() => router.push(`/routines/edit/${data.id}`)}
              />
            )
          : undefined
      }
      onRefresh={() =>
        Promise.all([
          routine.refetch(),
          client.invalidateQueries({ queryKey: keys.routineRuns(routineId) }),
        ])
      }
    >
      {routine.isPending ? (
        <Loading />
      ) : routine.isError ? (
        <LoadError onRetry={() => void routine.refetch()} />
      ) : data ? (
        <RoutineDetail routine={data} bot={bot} />
      ) : (
        <Note>{t('appAdmin.routines.notFound')}</Note>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  box: { padding: 16 },
  mono: { fontFamily: fonts.mono },
});
