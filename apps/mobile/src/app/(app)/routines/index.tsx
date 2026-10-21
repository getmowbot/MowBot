import type { Bot, Routine } from '@mowbot/contract';
import { router, useLocalSearchParams } from 'expo-router';
import { Plus } from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { AUTOMATION_ROW_INSET, AutomationRow } from '../../../components/admin/automation-row';
import { LoadError, Loading, Note, StatusText } from '../../../components/admin/parts';
import { RunStatus } from '../../../components/admin/run-status';
import { ListCard } from '../../../components/list-card';
import { Screen } from '../../../components/screen';
import { Section } from '../../../components/tab-scroll';
import { Button, IconButton } from '../../../components/ui/button';
import { ListRow, ROW_INSET } from '../../../components/ui/rows';
import { Segmented } from '../../../components/ui/segmented';
import { useAutomations, useRoutines } from '../../../lib/admin-queries';
import { sortAutomations } from '../../../lib/automations';
import { useCanvases } from '../../../lib/board-queries';
import { botsById, useBots } from '../../../lib/queries';
import { describeTrigger, nextRunText } from '../../../lib/routine-form';
import { colors } from '../../../theme';

type Tab = 'routines' | 'automations';

function RoutineRow({ routine }: { routine: Routine }) {
  const { t, i18n } = useTranslation();
  const summary = [
    describeTrigger(routine.trigger, t, i18n.language),
    routine.enabled && routine.nextRunAt
      ? t('appAdmin.routines.next', {
          time: nextRunText(routine.nextRunAt, t, i18n.language),
        })
      : null,
    routine.silent ? null : t('appAdmin.routines.notifies'),
  ]
    .filter(Boolean)
    .join(' · ');
  const status = !routine.enabled ? (
    <StatusText color={colors.textFaint} label={t('appAdmin.routines.off')} />
  ) : routine.lastStatus ? (
    <RunStatus status={routine.lastStatus} />
  ) : null;
  return (
    <ListRow
      label={routine.name}
      hint={summary}
      accessory={status}
      onPress={() => router.push(`/routines/${routine.id}`)}
    />
  );
}

/** Bots' scripts run by the hub (one bot's with `?bot=`), running ones first. */
function Automations({
  bots,
  botFilter,
  filtered,
}: {
  bots: Bot[] | undefined;
  botFilter: string | undefined;
  filtered: Bot | undefined;
}) {
  const { t } = useTranslation();
  const automations = useAutomations();
  const canvases = useCanvases();
  const byId = botsById(bots);
  const titles = new Map((canvases.data ?? []).map((canvas) => [canvas.id, canvas.title]));
  const items = sortAutomations(
    (automations.data ?? []).filter((a) => !botFilter || a.botId === botFilter),
  );

  if (automations.isPending) return <Loading />;
  if (automations.isError) return <LoadError onRetry={() => void automations.refetch()} />;
  if (items.length === 0) {
    return (
      <Note>
        {filtered
          ? t('appAdmin.automations.emptyBot', { name: filtered.name })
          : t('appAdmin.automations.empty')}
      </Note>
    );
  }
  return (
    <ListCard inset={AUTOMATION_ROW_INSET}>
      {items.map((automation) => (
        <AutomationRow
          key={automation.id}
          automation={automation}
          bot={byId.get(automation.botId)}
          canvasTitle={automation.canvasId ? titles.get(automation.canvasId) : undefined}
        />
      ))}
    </ListCard>
  );
}

/**
 * Every routine and check-in, grouped by bot, and the bots' automations (`?bot=` shows one
 * bot's, `?tab=automations` opens on them).
 */
export default function RoutinesScreen() {
  const { t } = useTranslation();
  const { bot: botFilter, tab: initialTab } = useLocalSearchParams<{
    bot?: string;
    tab?: string;
  }>();
  const [tab, setTab] = useState<Tab>(initialTab === 'automations' ? 'automations' : 'routines');
  const routines = useRoutines();
  const automations = useAutomations();
  const canvases = useCanvases();
  const bots = useBots();
  const all = routines.data ?? [];
  const groups = (bots.data ?? [])
    .filter((bot) => !botFilter || bot.id === botFilter)
    .sort((a, b) => Number(b.isChef) - Number(a.isChef))
    .map((bot) => ({ bot, items: all.filter((r) => r.botId === bot.id) }))
    .filter((group) => group.items.length > 0);
  const filtered = botFilter ? bots.data?.find((b) => b.id === botFilter) : undefined;
  const create = () => router.push(botFilter ? `/routines/new?bot=${botFilter}` : '/routines/new');
  // Bots write their automations themselves: only routines are added here.
  const headerRight =
    tab === 'routines'
      ? () => <IconButton icon={Plus} label={t('appAdmin.routines.new')} onPress={create} />
      : undefined;

  return (
    <Screen
      title={
        filtered
          ? `${t('appAdmin.routines.title')} · ${filtered.name}`
          : t('appAdmin.routines.title')
      }
      headerRight={headerRight}
      onRefresh={() =>
        Promise.all([routines.refetch(), automations.refetch(), canvases.refetch(), bots.refetch()])
      }
    >
      <View style={styles.head}>
        <Segmented<Tab>
          label={t('appAdmin.routines.title')}
          options={[
            { value: 'routines', label: t('appAdmin.routines.title') },
            { value: 'automations', label: t('appAdmin.automations.title') },
          ]}
          value={tab}
          onChange={setTab}
        />
        <Note>
          {tab === 'routines'
            ? t('appAdmin.routines.subtitle')
            : t('appAdmin.automations.subtitle')}
        </Note>
      </View>
      {tab === 'automations' ? (
        bots.isPending ? (
          <Loading />
        ) : (
          <Automations bots={bots.data} botFilter={botFilter} filtered={filtered} />
        )
      ) : routines.isPending || bots.isPending ? (
        <Loading />
      ) : routines.isError ? (
        <LoadError onRetry={() => void routines.refetch()} />
      ) : groups.length === 0 ? (
        <>
          <Note>
            {filtered
              ? t('appAdmin.routines.emptyBot', { name: filtered.name })
              : t('appAdmin.routines.empty')}
          </Note>
          <Button label={t('appAdmin.routines.new')} icon={Plus} onPress={create} />
        </>
      ) : (
        groups.map(({ bot, items }) => (
          <Section key={bot.id} title={bot.name}>
            <ListCard inset={ROW_INSET}>
              {items.map((routine) => (
                <RoutineRow key={routine.id} routine={routine} />
              ))}
            </ListCard>
          </Section>
        ))
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { gap: 14 },
});
