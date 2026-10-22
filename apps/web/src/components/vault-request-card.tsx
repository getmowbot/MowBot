import type {
  Message,
  MessagePart,
  Problem,
  VaultField,
  VaultRequestAnswer,
} from '@mowbot/contract';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowRight, LockKeyhole } from 'lucide-react';
import { type FormEvent, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, problemMessage } from '../lib/auth';
import { Button } from './ui/button';
import { FormError, Input, Label, SecretInput } from './ui/form';

type VaultRequestPart = Extract<MessagePart, { type: 'vault_request' }>;

/**
 * A bot asks for a login or a secret: what the user types goes straight into the vault. The
 * values are read from the form when sent, then the inputs are cleared: the app keeps them
 * nowhere (no state, no query cache), and the conversation never holds them.
 */
export function VaultRequestCard({
  message,
  part,
  index,
  onAnswer,
}: {
  message: Message;
  part: VaultRequestPart;
  index: number;
  /** Being answered: the bot hears about it in the conversation. */
  onAnswer(): void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const id = useId();
  const [sending, setSending] = useState<'save' | 'decline' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const label = part.account ? `${part.service} (${part.account})` : part.service;

  const answer = async (body: VaultRequestAnswer) => {
    setSending(body.declined ? 'decline' : 'save');
    setError(null);
    onAnswer();
    try {
      const { data, error } = await api.POST(
        '/api/v1/bots/{id}/messages/{messageId}/vault-request',
        { params: { path: { id: message.botId, messageId: message.id } }, body },
      );
      if (error || !data) throw error;
      queryClient.setQueryData<Message[]>(['messages', data.botId], (list) =>
        list?.map((m) => (m.id === data.id ? data : m)),
      );
    } catch (err) {
      // Answered meanwhile (another device): the hub has the truth.
      if ((err as Partial<Problem> | undefined)?.status === 409) {
        void queryClient.invalidateQueries({ queryKey: ['messages', message.botId] });
      } else {
        setError(problemMessage(err, t('chat.vault.failed')));
      }
    } finally {
      setSending(null);
    }
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const typed = new FormData(form);
    const values: Partial<Record<VaultField, string>> = {};
    for (const field of part.fields) {
      const value = String(typed.get(field) ?? '');
      if (value.trim()) values[field] = value;
    }
    form.reset();
    if (Object.keys(values).length === 0) {
      setError(t('problems.empty_answer'));
      return;
    }
    void answer({ part: index, values });
  };

  if (part.status !== 'pending') {
    return (
      <div className="flex max-w-md flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-border px-3 py-2 text-[13px]">
        <LockKeyhole className="size-3.5 shrink-0 text-faint" />
        <span className="min-w-0 truncate font-medium">{label}</span>
        <span className="text-muted-foreground">
          · {part.status === 'saved' ? t('chat.vault.saved') : t('chat.vault.declined')}
        </span>
        {part.status === 'saved' && (
          <Link
            to="/vault"
            className="ml-auto flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            {t('chat.vault.open')} <ArrowRight className="size-3" />
          </Link>
        )}
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="glass max-w-md space-y-4 rounded-2xl p-4">
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-ink/[0.06]">
          <LockKeyhole className="size-4" />
        </span>
        <div className="min-w-0 space-y-0.5">
          <p className="font-medium leading-snug">{label}</p>
          {part.reason && <p className="text-[13px] text-muted-foreground">{part.reason}</p>}
        </div>
      </div>
      <div className="space-y-3">
        {part.fields.map((field) => (
          <div key={field} className="space-y-1.5">
            <Label htmlFor={`${id}-${field}`}>
              {field === 'totp' ? t('chat.vault.totp') : t(`vault.fields.${field}`)}
            </Label>
            {field === 'username' ? (
              <Input
                id={`${id}-${field}`}
                name={field}
                autoComplete="off"
                spellCheck={false}
                maxLength={500}
                disabled={sending !== null}
              />
            ) : (
              <SecretInput
                id={`${id}-${field}`}
                name={field}
                maxLength={field === 'totp' ? 500 : 10_000}
                disabled={sending !== null}
              />
            )}
          </div>
        ))}
      </div>
      <p className="text-xs text-faint">{t('chat.vault.note')}</p>
      <FormError message={error} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={sending !== null}>
          {sending === 'save' ? t('common.saving') : t('chat.vault.save')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={sending !== null}
          onClick={() => void answer({ part: index, declined: true })}
        >
          {t('chat.vault.decline')}
        </Button>
      </div>
    </form>
  );
}
