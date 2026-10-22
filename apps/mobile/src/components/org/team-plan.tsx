import type { Bot, PlanStep, PlanStepStatus, Team } from '@mowbot/contract';
import {
  Circle,
  CircleAlert,
  CircleCheck,
  CircleDot,
  Eraser,
  FolderGit2,
  type LucideIcon,
} from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { confirm } from '../../lib/options-menu';
import { problemMessage } from '../../lib/org-forms';
import { useClearPlan, usePlan } from '../../lib/org-queries';
import { planProgress } from '../../lib/plan';
import { useProjects } from '../../lib/projects-queries';
import { colors } from '../../theme';
import { BotAvatar } from '../bot-avatar';
import { openChat } from '../bot-row';
import { Section } from '../tab-scroll';
import { IconButton } from '../ui/button';
import { Surface } from '../ui/surface';
import { T } from '../ui/text';
import { Touchable } from '../ui/touchable';
import { FormError } from './form-error';

const STATUS: Record<PlanStepStatus, { icon: LucideIcon; color: string }> = {
  todo: { icon: Circle, color: colors.textFaint },
  doing: { icon: CircleDot, color: colors.text },
  done: { icon: CircleCheck, color: colors.textMuted },
  blocked: { icon: CircleAlert, color: colors.warning },
};

/** A step: where it stands, what it is, who does it (a tap opens their chat). */
function StepRow({ step, index, owner }: { step: PlanStep; index: number; owner?: Bot }) {
  const { t } = useTranslation();
  const { icon: Icon, color } = STATUS[step.status];
  const label = t('orgAdmin.team.plan.step', {
    n: index + 1,
    status: t(`orgAdmin.team.plan.status.${step.status}`),
    title: step.title,
    owner: owner?.name ?? t('orgAdmin.team.plan.nobody'),
  });
  const body = (
    <>
      <Icon size={17} color={color} strokeWidth={2} />
      <T variant="caption" tone="faint" style={styles.number}>
        {index + 1}
      </T>
      <T
        variant="callout"
        tone={step.status === 'done' ? 'muted' : 'default'}
        numberOfLines={2}
        style={[styles.title, step.status === 'doing' && styles.current]}
      >
        {step.title}
      </T>
      {owner ? (
        <BotAvatar seed={owner.avatarSeed} size={22} still />
      ) : (
        <T variant="caption" tone="faint" style={styles.nobody}>
          —
        </T>
      )}
    </>
  );
  const style = [styles.step, step.status === 'doing' && styles.doing];
  return owner ? (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={() => openChat(owner)}
      style={style}
    >
      {body}
    </Touchable>
  ) : (
    <View accessible accessibilityLabel={label} style={style}>
      {body}
    </View>
  );
}

/** The team's plan of attack: its goal, how far it got, and each step with who does it. */
export function TeamPlanSection({ team, bots }: { team: Team; bots: Bot[] }) {
  const { t } = useTranslation();
  const plan = usePlan(team.id);
  const projects = useProjects();
  const clear = useClearPlan();
  const [error, setError] = useState<string | null>(null);

  if (plan.isPending) return null;
  const current = plan.data ?? null;
  const { done, total } = current ? planProgress(current) : { done: 0, total: 0 };
  const progress = t('orgAdmin.team.plan.progress', { done, total });
  const project = current?.projectId
    ? projects.data?.find((p) => p.id === current.projectId)
    : undefined;
  const byId = new Map(bots.map((bot) => [bot.id, bot]));

  const confirmClear = async () => {
    const ok = await confirm(
      t('orgAdmin.team.plan.clear'),
      t('orgAdmin.team.plan.confirmClear', { name: team.name }),
      { label: t('orgAdmin.team.plan.clear'), destructive: true },
    );
    if (!ok) return;
    setError(null);
    clear.mutate(team.id, {
      onError: (err) => setError(problemMessage(err, t('orgAdmin.team.plan.notCleared'), t)),
    });
  };

  return (
    <Section
      title={t('orgAdmin.team.plan.title')}
      accessory={
        current ? (
          <View style={styles.accessory}>
            {total > 0 ? (
              <T variant="caption" tone="faint" accessibilityLabel={progress}>
                {done}/{total}
              </T>
            ) : null}
            <IconButton
              icon={Eraser}
              size={32}
              color={colors.textMuted}
              label={t('orgAdmin.team.plan.clear')}
              onPress={() => void confirmClear()}
            />
          </View>
        ) : null
      }
    >
      {current ? (
        <Surface style={styles.card}>
          <View style={styles.goal}>
            <T variant="callout" selectable>
              {current.goal}
            </T>
            {project ? (
              <View style={styles.project}>
                <FolderGit2 size={13} color={colors.textMuted} />
                <T variant="caption" tone="muted" numberOfLines={1}>
                  {t('orgAdmin.team.plan.project', { name: project.name })}
                </T>
              </View>
            ) : null}
          </View>
          {total > 0 ? (
            <>
              <View
                accessibilityRole="progressbar"
                accessibilityLabel={progress}
                accessibilityValue={{ min: 0, max: total, now: done }}
                style={styles.track}
              >
                <View style={[styles.fill, { width: `${(done / total) * 100}%` }]} />
              </View>
              <View>
                {current.steps.map((step, index) => (
                  <StepRow
                    key={step.id}
                    step={step}
                    index={index}
                    owner={step.ownerBotId ? byId.get(step.ownerBotId) : undefined}
                  />
                ))}
              </View>
            </>
          ) : null}
        </Surface>
      ) : (
        <T variant="footnote" tone="faint" style={styles.indent}>
          {t('orgAdmin.team.plan.empty')}
        </T>
      )}
      <FormError message={error} />
    </Section>
  );
}

const styles = StyleSheet.create({
  accessory: { flexDirection: 'row', alignItems: 'center', gap: 4, marginVertical: -8 },
  card: { padding: 14, gap: 12 },
  goal: { gap: 6 },
  project: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  track: {
    height: 4,
    borderRadius: 2,
    overflow: 'hidden',
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
  },
  fill: { height: '100%', borderRadius: 2, backgroundColor: colors.text, opacity: 0.7 },
  step: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginHorizontal: -8,
    paddingHorizontal: 8,
    paddingVertical: 7,
    borderRadius: 10,
  },
  doing: { backgroundColor: 'rgba(255, 255, 255, 0.05)' },
  number: { width: 14, textAlign: 'right' },
  title: { flex: 1, minWidth: 0 },
  current: { fontWeight: '500' },
  nobody: { width: 22, textAlign: 'center' },
  indent: { paddingHorizontal: 4 },
});
