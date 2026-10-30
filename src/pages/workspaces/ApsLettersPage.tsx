import { useQueryClient } from '@tanstack/react-query';
import { ChevronDown, FileSearch, Filter, LoaderCircle, RotateCcw, X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { NavigationType, useLocation, useNavigationType, useSearchParams } from 'react-router';
import { useAuth } from '@/context/AuthContext';
import { apsLettersQueryKey, useApsLetters } from '@/hooks/useApsLetters';
import { useI18n, type TranslationKey } from '@/i18n/I18nContext';
import {
  activeLetterFilterCount,
  EMPTY_LETTER_FILTERS,
  encodeLetterCursor,
  formatLetterDate,
  isLetterDate,
  readLetterSearch,
  writeLetterFilters,
  type LetterFilters,
  type LetterStatusFilter,
  type LetterTypeFilter,
} from '@/lib/apsLetters';
import { LetterCard, LettersError, LettersLoading } from './ApsLetterUi';

const FIELD_CLASS =
  'border-input bg-card text-foreground focus:border-primary/60 focus:ring-primary/25 h-11 w-full min-w-0 max-w-full rounded-xl border px-3 text-sm outline-none focus:ring-2';

interface FilterFieldsProps {
  readonly value: LetterFilters;
  readonly onChange: (patch: Partial<LetterFilters>) => void;
}

function FilterFields({ value, onChange }: FilterFieldsProps) {
  const { t } = useI18n();
  const prefix = useId();
  return (
    <div className="grid min-w-0 grid-cols-1 gap-3 @md:grid-cols-2 @4xl:grid-cols-4">
      <label
        className="text-foreground min-w-0 space-y-1.5 text-xs font-semibold"
        htmlFor={`${prefix}-type`}
      >
        <span>{t('aps.letters.filterType')}</span>
        <span className="relative block">
          <select
            id={`${prefix}-type`}
            className={`${FIELD_CLASS} appearance-none pe-9`}
            value={value.type}
            onChange={(event) => onChange({ type: event.target.value as LetterTypeFilter })}
          >
            <option value="">{t('aps.letters.allTypes')}</option>
            <option value="inbound">{t('aps.letters.type.inbound')}</option>
            <option value="outbound">{t('aps.letters.type.outbound')}</option>
            <option value="transfer">{t('aps.letters.type.transfer')}</option>
            <option value="settlement">{t('aps.letters.type.settlement')}</option>
          </select>
          <ChevronDown
            className="text-muted-foreground pointer-events-none absolute end-3 top-3.5 size-4"
            aria-hidden="true"
          />
        </span>
      </label>
      <label
        className="text-foreground min-w-0 space-y-1.5 text-xs font-semibold"
        htmlFor={`${prefix}-status`}
      >
        <span>{t('aps.letters.filterStatus')}</span>
        <span className="relative block">
          <select
            id={`${prefix}-status`}
            className={`${FIELD_CLASS} appearance-none pe-9`}
            value={value.status}
            onChange={(event) => onChange({ status: event.target.value as LetterStatusFilter })}
          >
            <option value="">{t('aps.letters.allStatuses')}</option>
            <option value="draft">{t('aps.letters.status.draft')}</option>
            <option value="approved">{t('aps.letters.status.approved')}</option>
            <option value="cancelled">{t('aps.letters.status.cancelled')}</option>
          </select>
          <ChevronDown
            className="text-muted-foreground pointer-events-none absolute end-3 top-3.5 size-4"
            aria-hidden="true"
          />
        </span>
      </label>
      <label
        className="text-foreground min-w-0 space-y-1.5 text-xs font-semibold"
        htmlFor={`${prefix}-from`}
      >
        <span>{t('aps.letters.filterFrom')}</span>
        <input
          id={`${prefix}-from`}
          className={FIELD_CLASS}
          dir="ltr"
          type="date"
          value={value.from}
          onChange={(event) => onChange({ from: event.target.value })}
        />
      </label>
      <label
        className="text-foreground min-w-0 space-y-1.5 text-xs font-semibold"
        htmlFor={`${prefix}-to`}
      >
        <span>{t('aps.letters.filterTo')}</span>
        <input
          id={`${prefix}-to`}
          className={FIELD_CLASS}
          dir="ltr"
          type="date"
          value={value.to}
          onChange={(event) => onChange({ to: event.target.value })}
        />
      </label>
    </div>
  );
}

function FilterSheet({
  initial,
  onApply,
  onClose,
}: {
  readonly initial: LetterFilters;
  readonly onApply: (filters: LetterFilters) => void;
  readonly onClose: () => void;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const panelRef = useRef<HTMLElement>(null);
  const [draft, setDraft] = useState(initial);
  const invalidRange = draft.from !== '' && draft.to !== '' && draft.from > draft.to;

  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panelRef.current?.querySelector<HTMLElement>('select')?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const controls = Array.from(
      panelRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), select:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    );
    const first = controls[0];
    const last = controls.at(-1);
    if (first === undefined || last === undefined) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
        className="border-border bg-card @container max-h-[90dvh] w-full max-w-xl overflow-y-auto rounded-t-3xl border p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-2xl"
      >
        <div className="bg-border mx-auto mb-5 h-1 w-10 rounded-full" aria-hidden="true" />
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <h2 id={titleId} className="text-foreground text-lg font-bold">
              {t('aps.letters.filterTitle')}
            </h2>
            <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
              {t('aps.letters.filterHint')}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="text-muted-foreground hover:bg-muted grid size-11 shrink-0 place-items-center rounded-xl"
          >
            <X className="size-5" aria-hidden="true" />
          </button>
        </div>
        <FilterFields
          value={draft}
          onChange={(patch) => setDraft((current) => ({ ...current, ...patch }))}
        />
        {invalidRange && (
          <p role="alert" className="text-destructive mt-3 text-xs">
            {t('aps.letters.invalidFilters')}
          </p>
        )}
        <div className="mt-6 flex gap-3">
          <button
            type="button"
            onClick={() => setDraft(EMPTY_LETTER_FILTERS)}
            className="border-border text-foreground hover:bg-muted min-h-11 flex-1 rounded-xl border px-3 text-sm font-semibold"
          >
            {t('aps.letters.clearFilters')}
          </button>
          <button
            type="button"
            disabled={invalidRange}
            onClick={() => onApply(draft)}
            className="bg-primary text-primary-foreground min-h-11 flex-1 rounded-xl px-3 text-sm font-semibold hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('aps.letters.applyFilters')}
          </button>
        </div>
      </section>
    </div>,
    document.body,
  );
}

function ActiveFilters({
  filters,
  onChange,
}: {
  readonly filters: LetterFilters;
  readonly onChange: (patch: Partial<LetterFilters>) => void;
}) {
  const { t, locale } = useI18n();
  const typeKeys: Record<Exclude<LetterTypeFilter, ''>, TranslationKey> = {
    inbound: 'aps.letters.type.inbound',
    outbound: 'aps.letters.type.outbound',
    transfer: 'aps.letters.type.transfer',
    settlement: 'aps.letters.type.settlement',
  };
  const chips: { key: keyof LetterFilters; label: string; name: string }[] = [];
  if (filters.type !== '')
    chips.push({
      key: 'type',
      label: t(typeKeys[filters.type]),
      name: t('aps.letters.filterType'),
    });
  if (filters.status !== '')
    chips.push({
      key: 'status',
      label: t(`aps.letters.status.${filters.status}`),
      name: t('aps.letters.filterStatus'),
    });
  if (filters.from !== '')
    chips.push({
      key: 'from',
      label: `${t('aps.letters.filterFrom')}: ${isLetterDate(filters.from) ? formatLetterDate(filters.from, locale) : filters.from}`,
      name: t('aps.letters.filterFrom'),
    });
  if (filters.to !== '')
    chips.push({
      key: 'to',
      label: `${t('aps.letters.filterTo')}: ${isLetterDate(filters.to) ? formatLetterDate(filters.to, locale) : filters.to}`,
      name: t('aps.letters.filterTo'),
    });
  if (chips.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-wrap gap-2">
      {chips.map((chip) => (
        <button
          key={chip.key}
          type="button"
          onClick={() => onChange({ [chip.key]: '' })}
          aria-label={t('aps.letters.removeFilter', { name: chip.name })}
          className="border-primary/15 bg-primary/5 text-primary hover:bg-primary/10 inline-flex min-h-9 max-w-full items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold"
        >
          <span className="break-words">{chip.label}</span>
          <X className="size-3.5 shrink-0" aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}

export default function ApsLettersPage() {
  const { t } = useI18n();
  const { session } = useAuth();
  const location = useLocation();
  const navigationType = useNavigationType();
  const [searchParams, setSearchParams] = useSearchParams();
  const { filters, cursor, valid } = readLetterSearch(searchParams);
  const count = activeLetterFilterCount(filters);
  const queryClient = useQueryClient();
  const query = useApsLetters(filters, cursor, valid);
  const [sheetOpen, setSheetOpen] = useState(false);
  const latestSearch = useRef(location.search);
  const pendingSearches = useRef(new Set<string>());
  useEffect(() => {
    // A later edit may already be queued when an earlier navigation commits.
    // Do not let that intermediate render discard the more recent edit.
    if (navigationType !== NavigationType.Pop && pendingSearches.current.delete(location.search)) {
      if (location.search === latestSearch.current) pendingSearches.current.clear();
      return;
    }
    // Browser history and unrelated navigations remain the source of truth.
    pendingSearches.current.clear();
    latestSearch.current = location.search;
  }, [location.search, navigationType]);

  function updateSearch(next: URLSearchParams, replace = false) {
    const serialized = next.toString();
    // Keep the intended URL synchronously: React Router navigation can render
    // asynchronously, so rapid edits must not merge into an older location.
    latestSearch.current = serialized === '' ? '' : `?${serialized}`;
    pendingSearches.current.add(latestSearch.current);
    setSearchParams(next, { replace, preventScrollReset: true });
  }

  function changeFilters(next: LetterFilters) {
    updateSearch(writeLetterFilters(new URLSearchParams(latestSearch.current), next));
  }

  function changeFilterPart(patch: Partial<LetterFilters>) {
    const current = readLetterSearch(new URLSearchParams(latestSearch.current)).filters;
    changeFilters({ ...current, ...patch });
  }

  function showLatest() {
    const next = new URLSearchParams(latestSearch.current);
    next.delete('cursor');
    // The first page may be cached from before the user paged forward;
    // "latest" must start with a fresh server read.
    queryClient.removeQueries({
      queryKey: apsLettersQueryKey(session?.user.id ?? null, filters, null),
      exact: true,
    });
    updateSearch(next);
  }

  async function loadMore() {
    const startedAt = location.search;
    const result = await query.fetchNextPage();
    if (
      latestSearch.current !== startedAt ||
      result.isFetchNextPageError ||
      result.data === undefined
    )
      return;
    const pageCursor = result.data.pageParams.at(-1);
    if (pageCursor === null || pageCursor === undefined) return;
    // Copy the accumulated pages under the new URL cursor. A reload of that
    // deep link starts at the bookmarked page; returning from a detail view in
    // the same session keeps the already loaded cards in the query cache.
    queryClient.setQueryData(
      apsLettersQueryKey(session?.user.id ?? null, filters, pageCursor),
      result.data,
    );
    const next = new URLSearchParams(searchParams);
    next.set('cursor', encodeLetterCursor(pageCursor));
    updateSearch(next, true);
  }

  const entries = query.data?.pages.flatMap((page) => page.letters) ?? [];
  const letters = [...new Map(entries.map((letter) => [letter.id, letter])).values()];
  const invalidRange =
    filters.from !== '' &&
    filters.to !== '' &&
    isLetterDate(filters.from) &&
    isLetterDate(filters.to) &&
    filters.from > filters.to;

  return (
    <div className="min-w-0 space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-foreground text-lg font-bold">{t('aps.letters.title')}</h2>
          <p className="text-muted-foreground text-sm">{t('aps.letters.description')}</p>
        </div>
        <button
          type="button"
          onClick={() => setSheetOpen(true)}
          className="border-border bg-card text-foreground hover:bg-muted focus-visible:ring-ring inline-flex min-h-11 items-center gap-2 rounded-xl border px-4 text-sm font-semibold focus-visible:ring-2 focus-visible:outline-none @2xl:hidden"
        >
          <Filter className="size-4" aria-hidden="true" />
          {t('aps.letters.filters')}
          {count > 0 && (
            <span className="bg-primary/10 text-primary rounded-full px-2 py-0.5 text-xs">
              {t('aps.letters.filterCount', { count })}
            </span>
          )}
        </button>
      </div>

      <div className="border-border bg-card hidden min-w-0 rounded-2xl border p-4 @2xl:block">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-foreground flex items-center gap-2 text-sm font-bold">
              <Filter className="text-primary size-4" aria-hidden="true" />
              {t('aps.letters.filterTitle')}
            </p>
            <p className="text-muted-foreground mt-1 text-xs">{t('aps.letters.filterHint')}</p>
          </div>
          <button
            type="button"
            onClick={() => changeFilters(EMPTY_LETTER_FILTERS)}
            className="text-muted-foreground hover:text-primary inline-flex min-h-9 items-center gap-1.5 rounded-lg px-2 text-xs font-semibold"
          >
            <RotateCcw className="size-3.5" aria-hidden="true" />
            {t('aps.letters.clearFilters')}
          </button>
        </div>
        <FilterFields value={filters} onChange={changeFilterPart} />
      </div>

      <ActiveFilters filters={filters} onChange={changeFilterPart} />

      {!valid ? (
        <section role="alert" className="border-destructive/25 bg-card rounded-2xl border p-5">
          <p className="text-destructive text-sm font-semibold">
            {t(invalidRange ? 'aps.letters.invalidFilters' : 'aps.letters.invalidLink')}
          </p>
          <button
            type="button"
            onClick={() => changeFilters(EMPTY_LETTER_FILTERS)}
            className="text-primary mt-3 min-h-10 text-sm font-semibold"
          >
            {t('aps.letters.clearFilters')}
          </button>
        </section>
      ) : query.isPending ? (
        <LettersLoading />
      ) : query.isError && query.data === undefined ? (
        <LettersError error={query.error} onRetry={() => void query.refetch()} />
      ) : letters.length === 0 ? (
        <section className="border-border bg-card flex min-h-60 flex-col items-center justify-center rounded-2xl border px-6 py-10 text-center">
          <span className="bg-primary/8 text-primary grid size-14 place-items-center rounded-2xl">
            <FileSearch className="size-6" aria-hidden="true" />
          </span>
          <h3 className="text-foreground mt-4 text-base font-bold">
            {t(count > 0 ? 'aps.letters.emptyFilteredTitle' : 'aps.letters.emptyTitle')}
          </h3>
          <p className="text-muted-foreground mt-2 max-w-sm text-sm leading-relaxed">
            {t(count > 0 ? 'aps.letters.emptyFilteredBody' : 'aps.letters.emptyBody')}
          </p>
          {count > 0 && (
            <button
              type="button"
              onClick={() => changeFilters(EMPTY_LETTER_FILTERS)}
              className="text-primary mt-4 min-h-10 text-sm font-semibold"
            >
              {t('aps.letters.clearFilters')}
            </button>
          )}
          {cursor !== null && (
            <button
              type="button"
              onClick={showLatest}
              className="text-primary mt-4 min-h-10 text-sm font-semibold"
            >
              {t('aps.letters.showLatest')}
            </button>
          )}
        </section>
      ) : (
        <>
          <div
            className="text-muted-foreground flex flex-wrap items-center justify-between gap-2 text-xs"
            aria-live="polite"
          >
            <span>{t('aps.letters.visibleCount', { count: letters.length })}</span>
            {cursor !== null && (
              <button
                type="button"
                onClick={showLatest}
                className="text-primary min-h-9 font-semibold"
              >
                {t('aps.letters.showLatest')}
              </button>
            )}
          </div>
          <div className="grid min-w-0 grid-cols-1 gap-4 @xl:grid-cols-2">
            {letters.map((letter) => (
              <LetterCard key={letter.id} letter={letter} search={location.search} />
            ))}
          </div>
          {query.isFetchNextPageError && (
            <p role="alert" className="text-destructive text-sm">
              {t('aps.letters.moreError')}
            </p>
          )}
          {(query.hasNextPage || query.isFetchNextPageError) && (
            <div className="flex justify-center pt-2">
              <button
                type="button"
                disabled={query.isFetchingNextPage}
                onClick={() => void loadMore()}
                className="border-border bg-card text-foreground hover:border-primary/40 focus-visible:ring-ring inline-flex min-h-11 min-w-36 items-center justify-center gap-2 rounded-xl border px-5 text-sm font-semibold focus-visible:ring-2 focus-visible:outline-none disabled:opacity-60"
              >
                {query.isFetchingNextPage && (
                  <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                )}
                {t(query.isFetchingNextPage ? 'aps.letters.loadingMore' : 'aps.letters.loadMore')}
              </button>
            </div>
          )}
        </>
      )}

      {sheetOpen && (
        <FilterSheet
          initial={filters}
          onClose={() => setSheetOpen(false)}
          onApply={(next) => {
            changeFilters(next);
            setSheetOpen(false);
          }}
        />
      )}
    </div>
  );
}
