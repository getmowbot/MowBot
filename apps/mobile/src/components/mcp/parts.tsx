import type { Bot, McpScope, McpTransport, Team } from '@mowbot/contract';
import {
  Check,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CirclePause,
  Eye,
  KeyRound,
  type LucideIcon,
  PenLine,
  Plus,
  X,
} from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { type McpState, scopeWithKind, type ToolAccess, toggleScopeId } from '../../lib/mcp';
import { isAndroid } from '../../lib/platform';
import { type HeaderRow, headerRow } from '../../lib/provider-form';
import { colors, fonts } from '../../theme';
import { Note } from '../admin/parts';
import { TeamAvatar } from '../bot-avatar';
import { ListCard } from '../list-card';
import { BotPickRow, PICK_ROW_INSET } from '../org/bot-pick-row';
import { Button, IconButton } from '../ui/button';
import { Field } from '../ui/field';
import { ChoiceRows, ROW_INSET } from '../ui/rows';
import { T } from '../ui/text';
import { Touchable } from '../ui/touchable';
import { SECRET_INPUT } from '../vault/parts';

export const STATE_COLORS: Record<McpState, string> = {
  ok: colors.accentStrong,
  error: colors.danger,
  needsAuth: colors.warning,
  pending: colors.textMuted,
  disabled: colors.textFaint,
};

export const STATE_ICONS: Record<McpState, LucideIcon> = {
  ok: CircleCheck,
  error: CircleAlert,
  needsAuth: KeyRound,
  pending: CircleDashed,
  disabled: CirclePause,
};

const ACCESS_ICONS: Record<ToolAccess, LucideIcon> = { readOnly: Eye, writes: PenLine };

/** "Lecture seule" or "Peut modifier", as the server describes a tool. */
export function AccessBadge({ access }: { access: ToolAccess }) {
  const { t } = useTranslation();
  const Icon = ACCESS_ICONS[access];
  return (
    <View style={styles.badge}>
      <Icon size={13} color={colors.textMuted} strokeWidth={2.2} />
      <T variant="caption" tone="muted" numberOfLines={1}>
        {t(`mcp.tools.${access}`)}
      </T>
    </View>
  );
}

/** A team to tick in a list: its members' faces, its name, a check mark when picked. */
function TeamCheckRow({
  team,
  seeds,
  checked,
  onPress,
}: {
  team: Team;
  seeds: string[];
  checked: boolean;
  onPress(): void;
}) {
  return (
    <Touchable
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      onPress={onPress}
      style={styles.row}
    >
      <TeamAvatar seeds={seeds} size={32} />
      <T variant="body" numberOfLines={1} style={styles.rowText}>
        {team.name}
      </T>
      <View style={styles.check}>
        {checked ? <Check size={20} color={colors.text} strokeWidth={2.4} /> : null}
      </View>
    </Touchable>
  );
}

/** All bots, some teams or some bots: who gets a server's tools. */
export function ScopePicker({
  scope,
  onChange,
  bots,
  teams,
}: {
  scope: McpScope;
  onChange(scope: McpScope): void;
  bots: Bot[];
  teams: Team[];
}) {
  const { t } = useTranslation();
  return (
    <>
      <ListCard inset={ROW_INSET}>
        <ChoiceRows<McpScope['kind']>
          options={[
            { value: 'all', label: t('mcp.scope.all'), hint: t('mcp.scope.allHint') },
            { value: 'teams', label: t('mcp.scope.teams'), hint: t('mcp.scope.teamsHint') },
            { value: 'bots', label: t('mcp.scope.bots') },
          ]}
          value={scope.kind}
          onChange={(kind) => onChange(scopeWithKind(scope, kind))}
        />
      </ListCard>
      {scope.kind === 'teams' &&
        (teams.length === 0 ? (
          <Note>{t('mcp.scope.noTeams')}</Note>
        ) : (
          <ListCard inset={PICK_ROW_INSET}>
            {teams.map((team) => (
              <TeamCheckRow
                key={team.id}
                team={team}
                seeds={bots.filter((bot) => bot.teamId === team.id).map((bot) => bot.avatarSeed)}
                checked={scope.ids.includes(team.id)}
                onPress={() => onChange(toggleScopeId(scope, team.id))}
              />
            ))}
          </ListCard>
        ))}
      {scope.kind === 'bots' &&
        (bots.length === 0 ? (
          <Note>{t('mcp.scope.noBots')}</Note>
        ) : (
          <ListCard inset={PICK_ROW_INSET}>
            {bots.map((bot) => (
              <BotPickRow
                key={bot.id}
                bot={bot}
                hint={bot.role}
                selected={scope.ids.includes(bot.id)}
                onPress={() => onChange(toggleScopeId(scope, bot.id))}
              />
            ))}
          </ListCard>
        ))}
    </>
  );
}

/**
 * New headers (remote) or environment variables (local), as name / value pairs: the value is
 * masked and never shown back once saved.
 */
export function SecretPairs({
  transport,
  rows,
  onChange,
}: {
  transport: McpTransport;
  rows: HeaderRow[];
  onChange(rows: HeaderRow[]): void;
}) {
  const { t } = useTranslation();
  const set = (key: string, patch: Partial<HeaderRow>) =>
    onChange(rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  const remote = transport === 'http';

  return (
    <>
      {rows.map((row) => (
        <View key={row.key} style={styles.pair}>
          <View style={styles.name}>
            <Field
              label={t('mcp.secrets.name')}
              value={row.name}
              onChangeText={(name) => set(row.key, { name })}
              placeholder={remote ? 'X-Api-Key' : 'API_KEY'}
              autoCapitalize={remote ? 'none' : 'characters'}
              autoCorrect={false}
              spellCheck={false}
              maxLength={100}
              style={styles.mono}
            />
          </View>
          <View style={styles.value}>
            <Field
              label={t('mcp.secrets.value')}
              value={row.value}
              onChangeText={(value) => set(row.key, { value })}
              secureTextEntry
              maxLength={10_000}
              {...SECRET_INPUT}
              style={styles.mono}
            />
          </View>
          <View style={styles.remove}>
            <IconButton
              icon={X}
              label={t('mcp.secrets.removeRow', { name: row.name.trim() || '…' })}
              onPress={() => onChange(rows.filter((r) => r.key !== row.key))}
              color={colors.textMuted}
            />
          </View>
        </View>
      ))}
      <Button
        label={remote ? t('mcp.secrets.addHeader') : t('mcp.secrets.addEnv')}
        icon={Plus}
        variant="secondary"
        onPress={() => onChange([...rows, headerRow()])}
      />
    </>
  );
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 9999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
    flexShrink: 0,
  },
  row: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  rowText: { flex: 1, minWidth: 0 },
  check: { width: 20, alignItems: 'center' },
  pair: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  name: { flex: 2, minWidth: 0 },
  value: { flex: 3, minWidth: 0 },
  // Centered on the input, not on its label.
  remove: { height: isAndroid ? 56 : 50, justifyContent: 'center' },
  mono: { fontFamily: fonts.mono, fontSize: 13.5, paddingHorizontal: 12 },
});
