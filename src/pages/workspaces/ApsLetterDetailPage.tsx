import { ArrowDownLeft, ArrowLeft, ArrowUpRight, Boxes, Layers3 } from 'lucide-react';
import { Link, useLocation, useParams } from 'react-router';
import { useApsLetterDetail } from '@/hooks/useApsLetters';
import { useI18n } from '@/i18n/I18nContext';
import { APS_LETTERS_PATH, isLetterId } from '@/lib/apsLetters';
import {
  Counterparty,
  LetterAmount,
  LetterDate,
  LetterStatusBadge,
  LetterTypeBadge,
  LettersError,
  LettersLoading,
} from './ApsLetterUi';

export default function ApsLetterDetailPage() {
  const { t, dir } = useI18n();
  const { letterId = '' } = useParams();
  const location = useLocation();
  const query = useApsLetterDetail(letterId);
  const back = (
    <Link
      to={{ pathname: APS_LETTERS_PATH, search: location.search }}
      className="text-muted-foreground hover:text-primary focus-visible:ring-ring inline-flex min-h-11 items-center gap-2 rounded-lg text-sm font-semibold focus-visible:ring-2 focus-visible:outline-none"
    >
      <ArrowLeft className={`size-4 ${dir === 'rtl' ? 'rotate-180' : ''}`} aria-hidden="true" />
      {t('aps.letters.back')}
    </Link>
  );

  if (!isLetterId(letterId) || (query.isSuccess && query.data === null)) {
    return (
      <div className="space-y-4">
        {back}
        <section className="border-border bg-card rounded-2xl border p-8 text-center">
          <h2 className="text-foreground text-base font-bold">{t('aps.letters.notFoundTitle')}</h2>
          <p className="text-muted-foreground mt-2 text-sm">{t('aps.letters.notFoundBody')}</p>
        </section>
      </div>
    );
  }
  if (query.isPending)
    return (
      <div className="space-y-4">
        {back}
        <LettersLoading details />
      </div>
    );
  if (query.isError)
    return (
      <div className="space-y-4">
        {back}
        <LettersError error={query.error} onRetry={() => void query.refetch()} />
      </div>
    );
  if (query.data === undefined || query.data === null) return null;

  const { letter, lines } = query.data;

  return (
    <div className="min-w-0 space-y-5">
      {back}
      <section className="border-border bg-card min-w-0 rounded-2xl border p-5 shadow-[0_2px_12px_rgb(15_23_42/0.035)] sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-primary text-xs font-bold tracking-wide">
              {t('aps.letters.detailEyebrow')}
            </p>
            <h2 className="text-foreground mt-2 text-xl font-bold break-all sm:text-2xl">
              {t('aps.letters.detailTitle', { number: letter.number })}
            </h2>
          </div>
          <LetterStatusBadge status={letter.status} />
        </div>
        <div className="border-border mt-5 grid min-w-0 grid-cols-1 gap-4 border-t pt-5 @md:grid-cols-3">
          <div className="min-w-0">
            <p className="text-muted-foreground mb-2 text-xs">{t('aps.letters.filterType')}</p>
            <LetterTypeBadge type={letter.type} />
          </div>
          <div className="min-w-0">
            <p className="text-muted-foreground mb-2 text-xs">{t('aps.letters.date')}</p>
            <p className="text-foreground text-sm font-semibold">
              <LetterDate date={letter.date} />
            </p>
          </div>
          <div className="min-w-0">
            <p className="text-muted-foreground mb-2 text-xs">{t('aps.letters.counterparty')}</p>
            <div className="text-foreground text-sm font-semibold">
              <Counterparty letter={letter} />
            </div>
          </div>
        </div>
        <div className="bg-muted/55 mt-5 grid min-w-0 grid-cols-2 gap-4 rounded-xl p-4">
          <div className="min-w-0">
            <p className="text-muted-foreground text-xs">{t('aps.letters.inTotal')}</p>
            <p className="text-foreground mt-1 text-base font-bold break-all">
              <LetterAmount amount={letter.totalIn} />
            </p>
          </div>
          <div className="border-border min-w-0 border-s ps-4">
            <p className="text-muted-foreground text-xs">{t('aps.letters.outTotal')}</p>
            <p className="text-foreground mt-1 text-base font-bold break-all">
              <LetterAmount amount={letter.totalOut} />
            </p>
          </div>
        </div>
        {(letter.cancellationReason !== null || letter.settlementReason !== null) && (
          <div className="border-border mt-5 grid gap-3 border-t pt-4 text-sm">
            {letter.cancellationReason !== null && (
              <div>
                <p className="text-muted-foreground text-xs">{t('aps.letters.cancelReason')}</p>
                <p className="text-foreground mt-1 break-words whitespace-pre-wrap">
                  {letter.cancellationReason}
                </p>
              </div>
            )}
            {letter.settlementReason !== null && (
              <div>
                <p className="text-muted-foreground text-xs">{t('aps.letters.settlementReason')}</p>
                <p className="text-foreground mt-1 break-words whitespace-pre-wrap">
                  {letter.settlementReason}
                </p>
              </div>
            )}
          </div>
        )}
      </section>

      <section className="min-w-0 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-foreground text-lg font-bold">{t('aps.letters.linesTitle')}</h3>
          <span className="text-muted-foreground text-xs">
            {t('aps.letters.linesCount', { count: lines.length })}
          </span>
        </div>
        {lines.length === 0 ? (
          <p className="border-border bg-card text-muted-foreground rounded-2xl border p-6 text-center text-sm">
            {t('aps.letters.noLines')}
          </p>
        ) : (
          <ol className="space-y-3">
            {lines.map((line) => (
              <li
                key={line.id}
                className="border-border bg-card min-w-0 rounded-2xl border p-4 sm:p-5"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span className="text-muted-foreground text-xs font-semibold">
                    {t('aps.letters.lineNumber', { number: line.lineNumber })}
                  </span>
                  <span
                    className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${line.direction === 'in' ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'bg-orange-500/10 text-orange-700 dark:text-orange-300'}`}
                  >
                    {line.direction === 'in' ? (
                      <ArrowDownLeft className="size-3.5" aria-hidden="true" />
                    ) : (
                      <ArrowUpRight className="size-3.5" aria-hidden="true" />
                    )}
                    {t(`aps.letters.direction.${line.direction}`)}
                  </span>
                </div>
                <div className="border-border mt-3 grid min-w-0 grid-cols-1 gap-4 border-t pt-4 @md:grid-cols-2 @3xl:grid-cols-[1fr_1fr_auto]">
                  <div className="flex min-w-0 items-start gap-2.5">
                    <Boxes className="text-primary mt-0.5 size-4 shrink-0" aria-hidden="true" />
                    <div className="min-w-0">
                      <p className="text-muted-foreground mb-1 text-xs">
                        {t('aps.letters.warehouse')}
                      </p>
                      <p className="text-foreground text-sm font-semibold break-words">
                        {line.warehouseName}
                      </p>
                    </div>
                  </div>
                  <div className="flex min-w-0 items-start gap-2.5">
                    <Layers3 className="text-primary mt-0.5 size-4 shrink-0" aria-hidden="true" />
                    <div className="min-w-0">
                      <p className="text-muted-foreground mb-1 text-xs">
                        {t('aps.letters.classification')}
                      </p>
                      <p className="text-foreground text-sm font-semibold break-words">
                        {line.classificationName}
                      </p>
                    </div>
                  </div>
                  <div className="min-w-0">
                    <p className="text-muted-foreground mb-1 text-xs">{t('aps.letters.amount')}</p>
                    <p className="text-foreground text-sm font-bold break-all">
                      <LetterAmount amount={line.amount} />
                    </p>
                  </div>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
