import { AlertCircle, CheckCircle2, LoaderCircle, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useI18n } from '@/i18n/I18nContext';

export function FiscalBanner({
  tone,
  children,
  onDismiss,
}: {
  readonly tone: 'error' | 'success';
  readonly children: ReactNode;
  readonly onDismiss?: () => void;
}) {
  const { t } = useI18n();
  const Icon = tone === 'success' ? CheckCircle2 : AlertCircle;
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={[
        'flex items-start gap-2 rounded-xl border px-3.5 py-3 text-sm',
        tone === 'success'
          ? 'border-success/25 bg-success/5 text-success'
          : 'border-destructive/25 bg-destructive/5 text-destructive',
      ].join(' ')}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">{children}</div>
      {onDismiss !== undefined ? (
        <button
          type="button"
          aria-label={t('settings.project.fiscal.dismiss')}
          onClick={onDismiss}
          className="shrink-0 rounded p-0.5 opacity-70 transition-opacity hover:opacity-100"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

export function FiscalLoading({ label }: { readonly label: string }) {
  return (
    <div role="status" className="text-muted-foreground flex items-center gap-2 py-8 text-sm">
      <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}
