import { router, useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Loading, Note } from '../../../../components/admin/parts';
import { RoutineEditor } from '../../../../components/admin/routine-editor';
import { Screen } from '../../../../components/screen';
import { useRoutine } from '../../../../lib/admin-queries';
import { useBots } from '../../../../lib/queries';

/** Changes a routine's name, instruction, trigger or notification. */
export default function EditRoutineScreen() {
  const { t } = useTranslation();
  const { routineId } = useLocalSearchParams<{ routineId: string }>();
  const routine = useRoutine(routineId);
  const bots = useBots();
  return (
    <Screen title={t('appAdmin.routines.editTitle')}>
      {routine.isPending || bots.isPending ? (
        <Loading />
      ) : routine.data ? (
        <RoutineEditor
          key={routine.data.id}
          bots={bots.data ?? []}
          routine={routine.data}
          onDone={() => router.back()}
        />
      ) : (
        <Note>{t('appAdmin.routines.notFound')}</Note>
      )}
    </Screen>
  );
}
