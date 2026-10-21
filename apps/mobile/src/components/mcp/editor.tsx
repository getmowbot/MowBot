import type { McpServer, McpTransport } from '@mowbot/contract';
import { Plug } from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet } from 'react-native';
import {
  AUTH_CHOICES,
  authChoice,
  createBody,
  draftProblem,
  emptyDraft,
  type McpDraft,
  serverChanges,
  serverDraft,
} from '../../lib/mcp';
import { mcpError, useCreateMcpServer, useUpdateMcpServer } from '../../lib/mcp-queries';
import { useBots, useTeams } from '../../lib/queries';
import { fonts } from '../../theme';
import { Caption, FormError, Loading, Note } from '../admin/parts';
import { ListCard } from '../list-card';
import { FieldGroup } from '../org/field-group';
import { FormActions } from '../screen';
import { Section } from '../tab-scroll';
import { Button } from '../ui/button';
import { Field } from '../ui/field';
import { ChoiceRows, ROW_INSET } from '../ui/rows';
import { Segmented } from '../ui/segmented';
import { SECRET_INPUT } from '../vault/parts';
import { ScopePicker, SecretPairs } from './parts';

interface Props {
  /** Editing this server; otherwise a new one. */
  server?: McpServer;
  onDone(server: McpServer): void;
}

/**
 * A remote server (address, how it signs in, extra headers) or a local one (command run on the
 * bots' PCs, environment variables), and its bots. Editing changes the name, the address or
 * command and the sign-in; secrets and bots are managed from the server's page.
 */
export function McpEditor({ server, onDone }: Props) {
  const { t } = useTranslation();
  const create = useCreateMcpServer();
  const update = useUpdateMcpServer();
  const bots = useBots();
  const teams = useTeams();
  const [draft, setDraft] = useState<McpDraft>(() => (server ? serverDraft(server) : emptyDraft()));
  const [error, setError] = useState<string | null>(null);
  const edit = (patch: Partial<McpDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const remote = draft.transport === 'http';
  const changes = server ? serverChanges(server, draft) : null;
  const dirty = changes ? Object.keys(changes).length > 0 : Boolean(draft.name.trim());
  const tokenStored = server ? authChoice(server) === 'token' : false;

  const submit = () => {
    const problem = draftProblem(draft, server);
    if (problem) {
      setError(t(`mcp.formProblems.${problem}`));
      return;
    }
    setError(null);
    if (server && changes) {
      update.mutate(
        { id: server.id, body: changes },
        { onSuccess: onDone, onError: (err) => setError(mcpError(err, t('mcp.form.notSaved'))) },
      );
      return;
    }
    create.mutate(createBody(draft), {
      onSuccess: onDone,
      onError: (err) => setError(mcpError(err, t('mcp.form.notCreated'))),
    });
  };

  return (
    <>
      {server ? null : (
        <Segmented<McpTransport>
          label={t('mcp.form.kind')}
          options={[
            { value: 'http', label: t('mcp.transports.http') },
            { value: 'stdio', label: t('mcp.transports.stdio') },
          ]}
          value={draft.transport}
          onChange={(transport) => {
            // Headers and variables do not carry over.
            edit({ transport, secrets: [] });
            setError(null);
          }}
        />
      )}
      <Note>{remote ? t('mcp.form.remoteIntro') : t('mcp.form.localIntro')}</Note>

      <Field
        label={t('mcp.form.name')}
        value={draft.name}
        onChangeText={(name) => edit({ name })}
        placeholder={t('mcp.form.namePlaceholder')}
        maxLength={60}
        autoCorrect={false}
      />

      {remote ? (
        <>
          <Field
            label={t('mcp.form.url')}
            value={draft.url}
            onChangeText={(url) => edit({ url })}
            placeholder={t('mcp.form.urlPlaceholder')}
            keyboardType="url"
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={2_000}
            style={styles.mono}
          />
          <FieldGroup label={t('mcp.form.auth')}>
            <ListCard inset={ROW_INSET}>
              <ChoiceRows
                options={AUTH_CHOICES.map((choice) => ({
                  value: choice,
                  label: t(`mcp.auth.${choice}`),
                  hint: t(`mcp.authHints.${choice}`),
                }))}
                value={draft.auth}
                onChange={(auth) => edit({ auth })}
              />
            </ListCard>
          </FieldGroup>
          {draft.auth === 'token' && (
            <Field
              label={t('mcp.form.token')}
              value={draft.token}
              onChangeText={(token) => edit({ token })}
              placeholder={tokenStored ? t('mcp.form.tokenStored') : t('mcp.form.tokenPlaceholder')}
              hint={tokenStored ? t('mcp.form.tokenKeepHint') : t('mcp.form.tokenHint')}
              secureTextEntry
              maxLength={10_000}
              {...SECRET_INPUT}
            />
          )}
          {draft.auth === 'oauth' && server?.auth !== 'oauth' && (
            <Caption>{t('mcp.form.oauthNote')}</Caption>
          )}
        </>
      ) : (
        <Field
          label={t('mcp.form.command')}
          hint={t('mcp.form.localNote')}
          value={draft.command}
          onChangeText={(command) => edit({ command })}
          placeholder={t('mcp.form.commandPlaceholder')}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          maxLength={2_000}
          style={styles.mono}
        />
      )}

      {server ? (
        <Caption>{t('mcp.form.secretsLater')}</Caption>
      ) : (
        <>
          <Section title={remote ? t('mcp.form.extraHeaders') : t('mcp.secrets.env')}>
            <SecretPairs
              transport={draft.transport}
              rows={draft.secrets}
              onChange={(secrets) => edit({ secrets })}
            />
            <Caption>{remote ? t('mcp.secrets.headersNote') : t('mcp.secrets.envNote')}</Caption>
          </Section>
          <Section title={t('mcp.scope.title')}>
            {bots.isPending || teams.isPending ? (
              <Loading />
            ) : (
              <ScopePicker
                scope={draft.scope}
                onChange={(scope) => edit({ scope })}
                bots={bots.data ?? []}
                teams={teams.data ?? []}
              />
            )}
            {remote ? null : <Caption>{t('mcp.scope.localNote')}</Caption>}
          </Section>
        </>
      )}

      <FormError message={error} />
      <FormActions>
        <Button
          label={server ? t('common.save') : t('mcp.form.create')}
          icon={server ? undefined : Plug}
          onPress={submit}
          loading={create.isPending || update.isPending}
          disabled={!dirty}
        />
      </FormActions>
    </>
  );
}

const styles = StyleSheet.create({
  mono: { fontFamily: fonts.mono, fontSize: 14 },
});
