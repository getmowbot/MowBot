import { router, useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Loading } from '../../../components/admin/parts';
import { RoutineEditor } from '../../../components/admin/routine-editor';
import { Screen } from '../../../components/screen';
import { useBots } from '../../../lib/queries';

/** A routine created by the user (`?bot=` picks the bot beforehand). */
export default function NewRoutineScreen() {
  const { t } = useTranslation();
  const { bot } = useLocalSearchParams<{ bot?: string }>();
  const bots = useBots();
  return (
    <Screen title={t('appAdmin.routines.new')}>
      {bots.isPending ? (
        <Loading />
      ) : (
        <RoutineEditor
          bots={bots.data ?? []}
          botId={bot}
          // Its page shows the webhook URL, if any, and lets it run right away.
          onDone={(routine) => router.replace(`/routines/${routine.id}`)}
        />
      )}
    </Screen>
  );
}
