import { Eye, EyeOff } from 'lucide-react';
import {
  type HTMLAttributes,
  type InputHTMLAttributes,
  type LabelHTMLAttributes,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/utils';

const field =
  'w-full rounded-xl border border-border-strong bg-sunken px-3 text-sm text-foreground outline-none transition-[border-color,box-shadow] duration-200 placeholder:text-faint hover:border-ink/20 focus:border-ink/50';

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(field, 'h-10', className)} {...props} />;
}

/** A masked field; the eye shows what is being typed (stored values never come back). */
export function SecretInput({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  const { t } = useTranslation();
  const [shown, setShown] = useState(false);
  return (
    <div className="relative min-w-0 flex-1">
      <Input
        {...props}
        type={shown ? 'text' : 'password'}
        autoComplete="new-password"
        spellCheck={false}
        className={cn('pr-10', className)}
      />
      <button
        type="button"
        onClick={() => setShown((v) => !v)}
        disabled={props.disabled}
        aria-pressed={shown}
        aria-label={shown ? t('vault.hideTyping') : t('vault.showTyping')}
        className="absolute inset-y-0 right-0 grid w-10 place-items-center text-faint transition-colors hover:text-foreground disabled:opacity-40"
      >
        {shown ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </button>
    </div>
  );
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(field, 'py-2.5', className)} {...props} />;
}

export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(field, 'select-chevron h-10 appearance-none pr-9', className)}
      {...props}
    />
  );
}

export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: callers pass htmlFor
    <label className={cn('text-[13px] font-medium text-muted-foreground', className)} {...props} />
  );
}

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('glass rounded-2xl p-6', className)} {...props} />;
}

export function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="text-sm text-destructive">
      {message}
    </p>
  );
}
