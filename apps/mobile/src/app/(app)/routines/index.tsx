import type { Routine } from '@mowbot/contract';
import { router, useLocalSearchParams } from 'expo-router';
import { Plus } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { LoadError, Loading, Note, StatusText } from '../../../components/admin/parts';
import { RunStatus } from '../../../components/admin/run-status';
import { ListCard } from '../../../components/list-card';
import { Screen } from '../../../components/screen';
import { Section } from '../../../components/tab-scroll';
import { Button, IconButton } from '../../../components/ui/button';
import { ListRow, ROW_INSET } from '../../../components/ui/rows';
import { useRoutines } from '../../../lib/admin-queries';
import { useBots } from '../../../lib/queries';
import { describeTrigger, nextRunText } from '../../../lib/routine-form';
import { colors } from '../../../theme';

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

/** Every routine and check-in, grouped by bot (`?bot=` shows one bot's). */
export default function RoutinesScreen() {
  const { t } = useTranslation();
  const { bot: botFilter } = useLocalSearchParams<{ bot?: string }>();
  const routines = useRoutines();
  const bots = useBots();
  const all = routines.data ?? [];
  const groups = (bots.data ?? [])
    .filter((bot) => !botFilter || bot.id === botFilter)
    .sort((a, b) => Number(b.isChef) - Number(a.isChef))
    .map((bot) => ({ bot, items: all.filter((r) => r.botId === bot.id) }))
    .filter((group) => group.items.length > 0);
  const filtered = botFilter ? bots.data?.find((b) => b.id === botFilter) : undefined;
  const create = () => router.push(botFilter ? `/routines/new?bot=${botFilter}` : '/routines/new');

  return (
    <Screen
      title={
        filtered
          ? `${t('appAdmin.routines.title')} · ${filtered.name}`
          : t('appAdmin.routines.title')
      }
      headerRight={() => (
        <IconButton icon={Plus} label={t('appAdmin.routines.new')} onPress={create} />
      )}
      onRefresh={() => Promise.all([routines.refetch(), bots.refetch()])}
    >
      <Note>{t('appAdmin.routines.subtitle')}</Note>
      {routines.isPending || bots.isPending ? (
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
