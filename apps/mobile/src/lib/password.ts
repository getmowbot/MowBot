import { PASSWORD_MIN_LENGTH, type PasswordChange } from '@mowbot/contract';
import type { TFunction } from 'i18next';
import { problemCode } from './hub-url';

export { PASSWORD_MIN_LENGTH };
/** The hub refuses longer ones (contract: `newPasswordSchema`). */
export const PASSWORD_MAX_LENGTH = 256;

/** The password form as typed. Never trimmed: spaces belong to a password. */
export interface PasswordDraft {
  current: string;
  next: string;
  confirm: string;
  /** Every other device signs in again; this one stays signed in. */
  signOutOthers: boolean;
}

export const EMPTY_PASSWORD_DRAFT: PasswordDraft = {
  current: '',
  next: '',
  confirm: '',
  signOutOthers: false,
};

export type PasswordProblem = 'current' | 'short' | 'long' | 'mismatch';

/** Why the form can't be sent yet, in the order of its fields; null when it can. */
export function passwordProblem(draft: PasswordDraft): PasswordProblem | null {
  if (!draft.current) return 'current';
  if (draft.next.length < PASSWORD_MIN_LENGTH) return 'short';
  if (draft.next.length > PASSWORD_MAX_LENGTH) return 'long';
  return draft.next === draft.confirm ? null : 'mismatch';
}

/** What `POST /api/v1/me/password` gets. */
export function passwordChangeBody(draft: PasswordDraft): PasswordChange {
  return {
    currentPassword: draft.current,
    newPassword: draft.next,
    signOutOthers: draft.signOutOthers,
  };
}

/** A failed change: a wrong current password, too many tries, or the generic "not changed". */
export function passwordError(error: unknown, t: TFunction): string {
  const code = problemCode(error);
  switch (code) {
    case 'wrong_password':
    case 'rate_limited':
    case 'validation_failed':
      return t(`errors.${code}`);
    case 'forbidden':
      return t('appAdmin.problems.forbidden');
    default:
      return t('appAdmin.password.notChanged');
  }
}
