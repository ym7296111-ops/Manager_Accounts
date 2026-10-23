import { Eye, EyeOff } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '@/i18n/I18nContext';

/**
 * Labelled password input with a show/hide toggle, optional hint and inline
 * error — the one field shape used by every password form of the product
 * (profile change password, reset password).
 */

const FIELD_CLASS =
  'w-full rounded-lg border border-input bg-background px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground outline-none transition-shadow focus:border-primary/60 focus:ring-2 focus:ring-primary/25';

export interface PasswordFieldProps {
  /** Stable id, also used to wire the hint/error through `aria-describedby`. */
  id: string;
  /** Visible label (already translated by the caller). */
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** Browser autofill hint: `current-password` or `new-password`. */
  autoComplete: 'current-password' | 'new-password';
  /** Optional helper line rendered under the input. */
  hint?: string;
  /** Optional inline error (already translated). */
  error?: string | null;
  /** Marks the field as visually optional (label suffix). */
  optional?: boolean;
  disabled?: boolean;
}

export function PasswordField({
  id,
  label,
  value,
  onChange,
  autoComplete,
  hint,
  error,
  optional = false,
  disabled = false,
}: PasswordFieldProps) {
  const { t } = useI18n();
  const [revealed, setRevealed] = useState(false);
  const hintId = hint === undefined ? undefined : `${id}-hint`;
  const errorId = error === undefined || error === null ? undefined : `${id}-error`;
  const describedBy = [hintId, errorId].filter((value) => value !== undefined).join(' ');

  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium">
        {label}
        {optional && (
          <span className="text-muted-foreground ms-1.5 text-xs font-normal">
            {t('password.optional')}
          </span>
        )}
      </label>
      <div className="relative">
        <input
          id={id}
          name={id}
          type={revealed ? 'text' : 'password'}
          autoComplete={autoComplete}
          dir="ltr"
          disabled={disabled}
          value={value}
          aria-invalid={error === undefined || error === null ? undefined : true}
          aria-describedby={describedBy === '' ? undefined : describedBy}
          onChange={(event) => onChange(event.target.value)}
          className={`${FIELD_CLASS} pe-11`}
        />
        <button
          type="button"
          disabled={disabled}
          onClick={() => setRevealed((previous) => !previous)}
          aria-label={revealed ? t('password.hide') : t('password.show')}
          aria-pressed={revealed}
          className="text-muted-foreground hover:text-foreground absolute inset-y-0 end-0 grid w-11 place-items-center transition-colors disabled:opacity-60"
        >
          {revealed ? (
            <EyeOff className="size-4" aria-hidden="true" />
          ) : (
            <Eye className="size-4" aria-hidden="true" />
          )}
        </button>
      </div>
      {hint !== undefined && (
        <p id={hintId} className="text-muted-foreground mt-1 text-xs">
          {hint}
        </p>
      )}
      {error !== undefined && error !== null && (
        <p id={errorId} role="alert" className="text-destructive mt-1 text-xs">
          {error}
        </p>
      )}
    </div>
  );
}
