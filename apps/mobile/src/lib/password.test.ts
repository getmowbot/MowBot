import type { TFunction } from 'i18next';
import { beforeAll, describe, expect, it } from 'vitest';
import { translator } from '../test/fixtures';
import {
  EMPTY_PASSWORD_DRAFT,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  type PasswordDraft,
  type PasswordProblem,
  passwordChangeBody,
  passwordError,
  passwordProblem,
} from './password';

let fr: TFunction;
let en: TFunction;
beforeAll(async () => {
  fr = await translator('fr');
  en = await translator('en');
});

const NEW = 'correct horse battery';
const draft = (patch: Partial<PasswordDraft> = {}): PasswordDraft => ({
  ...EMPTY_PASSWORD_DRAFT,
  current: 'old one',
  next: NEW,
  confirm: NEW,
  ...patch,
});

describe('password form', () => {
  it('starts empty, without signing out the other devices', () => {
    expect(EMPTY_PASSWORD_DRAFT).toEqual({
      current: '',
      next: '',
      confirm: '',
      signOutOthers: false,
    });
  });

  it('accepts a filled form whose confirmation matches', () => {
    expect(passwordProblem(draft())).toBeNull();
  });

  it('needs the current password first', () => {
    expect(passwordProblem(draft({ current: '' }))).toBe('current');
    expect(passwordProblem({ ...EMPTY_PASSWORD_DRAFT })).toBe('current');
  });

  it('holds the new one to the hub’s length limits', () => {
    const min = 'a'.repeat(PASSWORD_MIN_LENGTH);
    expect(passwordProblem(draft({ next: min, confirm: min }))).toBeNull();
    const short = min.slice(1);
    expect(passwordProblem(draft({ next: short, confirm: short }))).toBe('short');
    const max = 'a'.repeat(PASSWORD_MAX_LENGTH);
    expect(passwordProblem(draft({ next: max, confirm: max }))).toBeNull();
    const long = `${max}a`;
    expect(passwordProblem(draft({ next: long, confirm: long }))).toBe('long');
  });

  it('never trims: spaces count, and must match too', () => {
    const padded = `  ${'a'.repeat(PASSWORD_MIN_LENGTH - 2)}`;
    expect(passwordProblem(draft({ next: padded, confirm: padded }))).toBeNull();
    expect(passwordProblem(draft({ confirm: `${NEW} ` }))).toBe('mismatch');
  });

  it('checks the confirmation after the length', () => {
    expect(passwordProblem(draft({ confirm: '' }))).toBe('mismatch');
    expect(passwordProblem(draft({ next: 'short', confirm: 'other' }))).toBe('short');
  });

  it('sends the passwords as typed, and the choice for the other devices', () => {
    expect(passwordChangeBody(draft())).toEqual({
      currentPassword: 'old one',
      newPassword: NEW,
      signOutOthers: false,
    });
    expect(passwordChangeBody(draft({ signOutOthers: true })).signOutOthers).toBe(true);
  });

  it('words every problem in both languages', () => {
    const problems: PasswordProblem[] = ['current', 'short', 'long', 'mismatch'];
    for (const t of [fr, en]) {
      for (const problem of problems) {
        const text = t(`appAdmin.password.problems.${problem}`, {
          min: PASSWORD_MIN_LENGTH,
          max: PASSWORD_MAX_LENGTH,
        });
        expect(text).not.toContain('appAdmin.');
        expect(text).not.toContain('{{');
      }
    }
    expect(fr('appAdmin.password.problems.short', { min: PASSWORD_MIN_LENGTH })).toContain('12');
  });
});

describe('password change errors', () => {
  const problem = (code: string) => ({ type: `urn:mowbot:problem:${code}`, status: 403 });

  it('says when the current password is wrong', () => {
    expect(passwordError(problem('wrong_password'), fr)).toBe('Mot de passe actuel incorrect.');
    expect(passwordError(problem('wrong_password'), en)).toBe('The current password is wrong.');
  });

  it('words the hub’s common refusals', () => {
    expect(passwordError(problem('rate_limited'), en)).toBe(en('errors.rate_limited'));
    expect(passwordError(problem('validation_failed'), en)).toBe(en('errors.validation_failed'));
    expect(passwordError(problem('forbidden'), fr)).toBe(fr('appAdmin.problems.forbidden'));
  });

  it('falls back to “not changed” for anything else', () => {
    expect(passwordError(problem('internal'), fr)).toBe('Mot de passe non changé.');
    expect(passwordError(new TypeError('Network request failed'), en)).toBe(
      'Password not changed.',
    );
  });
});
