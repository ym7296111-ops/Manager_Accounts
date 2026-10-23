import type { LucideIcon } from 'lucide-react';
import { useI18n } from '@/i18n/I18nContext';
import { formatDashboardNumber } from '@/lib/dashboardFormat';

/**
 * One KPI tile of the executive dashboard.
 *
 * Presentation-only: the number, label and hint arrive already resolved by the
 * screen (the hint carries the definition, so a figure never appears without
 * telling the reader what it measures). `null` renders an em dash instead of a
 * misleading zero.
 */

export type KpiTone = 'primary' | 'warning' | 'success' | 'neutral';

const TONE_CLASSES: Record<KpiTone, string> = {
  primary: 'bg-primary/10 text-primary',
  warning: 'bg-warning/15 text-warning-foreground dark:text-warning',
  success: 'bg-success/15 text-success',
  neutral: 'bg-muted text-muted-foreground',
};

export interface KPICardProps {
  readonly label: string;
  /** `null` = the indicator could not be computed; render an em dash. */
  readonly value: number | null;
  readonly hint: string;
  /** Optional explanation shown on hover/focus for the whole tile. */
  readonly definition?: string;
  readonly icon: LucideIcon;
  readonly tone?: KpiTone;
  readonly testId?: string;
}

export function KPICard({
  label,
  value,
  hint,
  definition,
  icon: Icon,
  tone = 'primary',
  testId,
}: KPICardProps) {
  const { locale } = useI18n();
  const display = value === null ? '—' : formatDashboardNumber(value, locale);

  return (
    <article
      className="bg-card text-card-foreground flex flex-col gap-4 rounded-2xl border p-5 shadow-sm"
      data-testid={testId}
      title={definition}
    >
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-muted-foreground text-sm font-medium">{label}</h3>
        <span
          className={`grid size-9 shrink-0 place-items-center rounded-lg ${TONE_CLASSES[tone]}`}
        >
          <Icon className="size-[18px]" aria-hidden="true" />
        </span>
      </div>

      <div className="space-y-1">
        <p className="text-card-foreground text-3xl font-bold tracking-tight tabular-nums">
          {display}
        </p>
        <p className="text-muted-foreground text-xs leading-relaxed">{hint}</p>
      </div>
    </article>
  );
}
