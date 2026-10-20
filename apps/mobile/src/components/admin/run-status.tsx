import type { RoutineRunStatus } from '@mowbot/contract';
import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleSlash,
  LoaderCircle,
  type LucideIcon,
} from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { colors } from '../../theme';
import { StatusText } from './parts';

/** Run outcomes as lights: white while running, red on failure, dim otherwise. */
export const RUN_COLORS: Record<RoutineRunStatus, string> = {
  running: colors.accentStrong,
  done: colors.textMuted,
  idle: colors.textFaint,
  skipped: colors.textFaint,
  error: colors.danger,
};

/** Run outcomes as row icons (history). */
export const RUN_ICONS: Record<RoutineRunStatus, LucideIcon> = {
  running: LoaderCircle,
  done: CircleCheck,
  idle: CircleDashed,
  skipped: CircleSlash,
  error: CircleAlert,
};

export function RunStatus({ status }: { status: RoutineRunStatus }) {
  const { t } = useTranslation();
  return <StatusText color={RUN_COLORS[status]} label={t(`appAdmin.routines.status.${status}`)} />;
}
