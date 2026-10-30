import {
  ArrowDownLeft,
  ArrowLeftRight,
  ArrowRight,
  ArrowUpRight,
  CalendarDays,
  CheckCircle2,
  CircleAlert,
  CircleSlash,
  ClipboardList,
  FileText,
  LoaderCircle,
  RefreshCw,
  ShieldAlert,
  type LucideIcon,
} from 'lucide-react';
import { Link } from 'react-router';
import { classifyApsLettersError, type ApsLetter } from '@/hooks/useApsLetters';
import { useI18n, type TranslationKey } from '@/i18n/I18nContext';
import {
  APS_LETTERS_PATH,
  formatLetterAmount,
  formatLetterDate,
  type LetterStatus,
  type LetterType,
} from '@/lib/apsLetters';

const TYPE_STYLE: Record<LetterType, { icon: LucideIcon; className: string }> = {
  inbound: {
    icon: ArrowDownLeft,
    className: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  },
  outbound: {
    icon: ArrowUpRight,
    className: 'bg-orange-500/10 text-orange-700 dark:text-orange-300',
  },
  internal_transfer: {
    icon: ArrowLeftRight,
    className: 'bg-violet-500/10 text-violet-700 dark:text-violet-300',
  },
  external_transfer: {
    icon: ArrowLeftRight,
    className: 'bg-violet-500/10 text-violet-700 dark:text-violet-300',
  },
  settlement: { icon: ClipboardList, className: 'bg-sky-500/10 text-sky-700 dark:text-sky-300' },
};

const STATUS_STYLE: Record<LetterStatus, { icon: LucideIcon; className: string }> = {
  draft: { icon: FileText, className: 'bg-amber-500/10 text-amber-800 dark:text-amber-300' },
  approved: {
    icon: CheckCircle2,
    className: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  },
  cancelled: { icon: CircleSlash, className: 'bg-rose-500/10 text-rose-700 dark:text-rose-300' },
};

export function LetterTypeBadge({ type }: { readonly type: LetterType }) {
  const { t } = useI18n();
  const { icon: Icon, className } = TYPE_STYLE[type];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-semibold ${className}`}
    >
      <Icon className="size-3.5" aria-hidden="true" />
      {t(`aps.letters.type.${type}`)}
    </span>
  );
}

export function LetterStatusBadge({ status }: { readonly status: LetterStatus }) {
  const { t } = useI18n();
  const { icon: Icon, className } = STATUS_STYLE[status];
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${className}`}
    >
      <Icon className="size-3.5" aria-hidden="true" />
      {t(`aps.letters.status.${status}`)}
    </span>
  );
}

export function LetterAmount({
  amount,
  className = '',
}: {
  readonly amount: string;
  readonly className?: string;
}) {
  const { locale } = useI18n();
  return (
    <bdi dir="ltr" className={`tabular-nums ${className}`}>
      {formatLetterAmount(amount, locale)}
    </bdi>
  );
}

export function LetterDate({ date }: { readonly date: string }) {
  const { locale } = useI18n();
  return <time dateTime={date}>{formatLetterDate(date, locale)}</time>;
}

export function Counterparty({ letter }: { readonly letter: ApsLetter }) {
  const { t } = useI18n();
  if (letter.counterpartyName === null && letter.counterpartyCode === null) {
    return (
      <span className="text-muted-foreground">
        {t(
          letter.type === 'internal_transfer'
            ? 'aps.letters.internalParty'
            : letter.type === 'settlement'
              ? 'aps.letters.noCounterparty'
              : 'aps.letters.counterpartyUnavailable',
        )}
      </span>
    );
  }
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      {letter.counterpartyName !== null && (
        <span className="min-w-0 break-words">{letter.counterpartyName}</span>
      )}
      {letter.counterpartyCode !== null && (
        <bdi
          dir="ltr"
          className="bg-muted text-muted-foreground rounded-md px-1.5 py-0.5 font-mono text-[11px]"
        >
          {letter.counterpartyCode}
        </bdi>
      )}
    </span>
  );
}

export function LetterCard({
  letter,
  search,
}: {
  readonly letter: ApsLetter;
  readonly search: string;
}) {
  const { t, dir } = useI18n();
  return (
    <article className="min-w-0">
      <Link
        to={{ pathname: `${APS_LETTERS_PATH}/${letter.id}`, search }}
        aria-label={`${t('aps.letters.viewDetails')} ${letter.number}`}
        className="group border-border bg-card hover:border-primary/35 focus-visible:ring-ring flex h-full min-w-0 flex-col rounded-2xl border p-5 shadow-[0_2px_12px_rgb(15_23_42/0.035)] transition-[border-color,box-shadow,transform] hover:-translate-y-0.5 hover:shadow-[0_12px_28px_rgb(15_23_42/0.08)] focus-visible:ring-2 focus-visible:outline-none"
      >
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <span className="bg-primary/8 text-primary grid size-10 shrink-0 place-items-center rounded-xl">
              <FileText className="size-5" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <p className="text-muted-foreground text-xs">{t('aps.letters.number')}</p>
              <p className="text-foreground mt-1 text-base leading-6 font-bold break-all">
                <bdi dir="auto">{letter.number}</bdi>
              </p>
            </div>
          </div>
          <LetterStatusBadge status={letter.status} />
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-2">
          <LetterTypeBadge type={letter.type} />
          <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
            <CalendarDays className="size-3.5" aria-hidden="true" />
            <LetterDate date={letter.date} />
          </span>
        </div>

        <div className="border-border/75 mt-4 min-w-0 border-t pt-4">
          <p className="text-muted-foreground mb-1.5 text-xs">{t('aps.letters.counterparty')}</p>
          <div className="text-foreground text-sm font-semibold">
            <Counterparty letter={letter} />
          </div>
        </div>

        <div className="bg-muted/55 mt-4 grid min-w-0 grid-cols-2 gap-3 rounded-xl px-3.5 py-3">
          <div className="min-w-0">
            <p className="text-muted-foreground text-[11px]">{t('aps.letters.inTotal')}</p>
            <p className="text-foreground mt-1 text-sm font-bold break-all">
              <LetterAmount amount={letter.totalIn} />
            </p>
          </div>
          <div className="border-border min-w-0 border-s ps-3">
            <p className="text-muted-foreground text-[11px]">{t('aps.letters.outTotal')}</p>
            <p className="text-foreground mt-1 text-sm font-bold break-all">
              <LetterAmount amount={letter.totalOut} />
            </p>
          </div>
        </div>

        <div className="text-primary mt-auto flex items-center justify-between gap-2 pt-4 text-xs font-semibold">
          <span>{t('aps.letters.viewDetails')}</span>
          <ArrowRight
            className={`size-4 transition-transform group-hover:translate-x-1 ${dir === 'rtl' ? 'rotate-180' : ''}`}
            aria-hidden="true"
          />
        </div>
      </Link>
    </article>
  );
}

export function LettersLoading({ details = false }: { readonly details?: boolean }) {
  const { t } = useI18n();
  return (
    <div
      role="status"
      aria-live="polite"
      className="border-border bg-card flex min-h-48 flex-col items-center justify-center gap-3 rounded-2xl border p-8 text-center"
    >
      <LoaderCircle className="text-primary size-6 animate-spin" aria-hidden="true" />
      <p className="text-muted-foreground text-sm">
        {t(details ? 'aps.letters.loadingDetails' : 'aps.letters.loading')}
      </p>
    </div>
  );
}

export function LettersError({
  error,
  onRetry,
}: {
  readonly error: unknown;
  readonly onRetry: () => void;
}) {
  const { t } = useI18n();
  const kind = classifyApsLettersError(error);
  const titles: Record<typeof kind, TranslationKey> = {
    forbidden: 'aps.letters.forbiddenTitle',
    network: 'aps.letters.networkTitle',
    unavailable: 'aps.letters.unavailableTitle',
    invalid: 'aps.letters.errorTitle',
    unknown: 'aps.letters.errorTitle',
  };
  const bodies: Record<typeof kind, TranslationKey> = {
    forbidden: 'aps.letters.forbiddenBody',
    network: 'aps.letters.networkBody',
    unavailable: 'aps.letters.unavailableBody',
    invalid: 'aps.letters.errorBody',
    unknown: 'aps.letters.errorBody',
  };
  const Icon = kind === 'forbidden' ? ShieldAlert : CircleAlert;
  return (
    <section
      role="alert"
      className="border-border bg-card flex min-h-52 flex-col items-center justify-center rounded-2xl border px-6 py-10 text-center"
    >
      <span className="bg-destructive/10 text-destructive grid size-12 place-items-center rounded-2xl">
        <Icon className="size-6" aria-hidden="true" />
      </span>
      {kind === 'forbidden' && <span className="text-destructive mt-4 text-xs font-bold">403</span>}
      <h2 className="text-foreground mt-3 text-base font-bold">{t(titles[kind])}</h2>
      <p className="text-muted-foreground mt-2 max-w-md text-sm leading-relaxed">
        {t(bodies[kind])}
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="border-border text-foreground hover:bg-muted focus-visible:ring-ring mt-5 inline-flex min-h-11 items-center gap-2 rounded-xl border px-4 text-sm font-semibold focus-visible:ring-2 focus-visible:outline-none"
      >
        <RefreshCw className="size-4" aria-hidden="true" />
        {t('aps.letters.retry')}
      </button>
    </section>
  );
}
