import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowDownLeft,
  ArrowLeftRight,
  ArrowRight,
  ArrowUpRight,
  CalendarDays,
  CheckCircle2,
  ClipboardList,
  FilePlus2,
  LoaderCircle,
  Plus,
  Save,
  Trash2,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router';
import { useAuth } from '@/context/AuthContext';
import {
  approveEntryLetter,
  classifyEntryError,
  saveEntryDraft,
  useEntryDraft,
  useEntryOptions,
  useLetterBalances,
  type EntryErrorCode,
  type LoadedDraft,
} from '@/hooks/useApsLetterEntry';
import { ApsLetterTree } from '@/pages/workspaces/ApsLetterTree';
import { SearchCombobox } from '@/components/ui/SearchCombobox';
import { usePageHeaderOverride } from '@/context/PageHeaderContext';
import type { PageHeaderTone } from '@/lib/pageHeader';
import { useI18n, type TranslationKey } from '@/i18n/I18nContext';
import {
  APS_LETTER_NEW_PATH,
  entryHasReclassification,
  entryTotal,
  fiscalYearLabel,
  joinLetterCode,
  localToday,
  newEntryForm,
  newEntryLine,
  runningEntryPeriod,
  smallestCodeParty,
  splitLetterCode,
  validateEntry,
  warehouseLabel,
  type EntryForm,
  type EntryLetterType,
  type EntryLine,
  type EntryOption,
  type EntryOptions,
  type EntryValidationError,
  type EntryWarehouse,
} from '@/lib/apsLetterEntry';
import { APS_LETTERS_PATH, formatLetterAmount } from '@/lib/apsLetters';
import { issuerLabel } from '@/lib/issuers';

const CONTROL =
  'border-input bg-card text-foreground focus:border-primary/60 focus:ring-primary/25 min-h-11 w-full min-w-0 rounded-xl border px-3 text-sm outline-none focus:ring-2 disabled:opacity-60';
const CARD =
  'border-border bg-card min-w-0 rounded-2xl border p-4 shadow-[0_2px_12px_rgb(15_23_42/0.035)] sm:p-5';

/* The letter code is `[ YM ▼ ] : [ 63 ]`: two controls with the colon printed
   between them, so the separator is never typed and never wrong. Both are
   `dir="ltr"` — a code reordered by the RTL paragraph would read differently. */
const CODE_SELECT =
  'border-input bg-card text-foreground focus:border-primary/60 focus:ring-primary/25 min-h-11 min-w-0 flex-1 basis-0 rounded-xl border px-2 text-sm font-semibold outline-none focus:ring-2 disabled:cursor-not-allowed disabled:opacity-60';
const CODE_NUMBER =
  'border-input bg-card text-foreground focus:border-primary/60 focus:ring-primary/25 min-h-11 w-20 shrink-0 rounded-xl border px-2 text-center text-sm font-semibold tracking-wide tabular-nums outline-none focus:ring-2 disabled:cursor-not-allowed disabled:opacity-60 sm:w-28';
/**
 * One colour per letter type, used by the header band and by the type button
 * group. The header is the first thing the eye lands on, so the type is stated
 * three ways — colour, icon and title — rather than by colour alone.
 */
const TYPES: readonly {
  value: EntryLetterType;
  hint: TranslationKey;
  title: TranslationKey;
  editTitle: TranslationKey;
  icon: typeof ArrowDownLeft;
  color: string;
  tone: PageHeaderTone;
}[] = [
  {
    value: 'inbound',
    hint: 'aps.entry.inboundHint',
    title: 'aps.entry.newTitle.inbound',
    editTitle: 'aps.entry.editTitle.inbound',
    icon: ArrowDownLeft,
    color: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
    tone: 'emerald',
  },
  {
    value: 'outbound',
    hint: 'aps.entry.outboundHint',
    title: 'aps.entry.newTitle.outbound',
    editTitle: 'aps.entry.editTitle.outbound',
    icon: ArrowUpRight,
    color: 'bg-orange-500/10 text-orange-700 dark:text-orange-300',
    tone: 'orange',
  },
  {
    value: 'internal_transfer',
    hint: 'aps.entry.internalHint',
    title: 'aps.entry.newTitle.internal_transfer',
    editTitle: 'aps.entry.editTitle.internal_transfer',
    icon: ArrowLeftRight,
    color: 'bg-violet-500/10 text-violet-700 dark:text-violet-300',
    tone: 'violet',
  },
  {
    value: 'external_transfer',
    hint: 'aps.entry.externalHint',
    title: 'aps.entry.newTitle.external_transfer',
    editTitle: 'aps.entry.editTitle.external_transfer',
    icon: ArrowRight,
    color: 'bg-sky-500/10 text-sky-700 dark:text-sky-300',
    tone: 'sky',
  },
];

function warehouseOptions(
  warehouses: readonly EntryWarehouse[],
): readonly { value: string; label: string; keywords: string }[] {
  return warehouses.map((warehouse) => ({
    value: warehouse.id,
    label: warehouseLabel(warehouse),
    keywords: `${warehouse.name} ${warehouse.stationName ?? ''} ${warehouse.code}`,
  }));
}
const NO_HIGHLIGHTED_LINES: ReadonlySet<string> = new Set();

const WRITE_ERROR: Record<EntryErrorCode, TranslationKey> = {
  unavailable: 'aps.entry.errorUnknown',
  forbidden: 'aps.entry.errorForbidden',
  network: 'aps.entry.errorNetwork',
  duplicate: 'aps.entry.errorDuplicate',
  duplicateLetterCode: 'aps.entry.errorDuplicateCode',
  duplicatePartyLine: 'aps.entry.errorDuplicateLine',
  existing: 'aps.entry.errorExisting',
  stale: 'aps.entry.errorStale',
  invalid: 'aps.entry.errorInvalid',
  notFound: 'aps.entry.draftUnavailable',
  unknown: 'aps.entry.errorUnknown',
};

interface CachedEntry {
  readonly id: string;
  readonly version: string | null;
  readonly baseline: string;
  readonly form: EntryForm;
}
// Memory only: preserve unsaved data across SPA navigation/back for this actor.
// No financial data is placed in localStorage or sessionStorage.
const unsavedEntries = new Map<string, CachedEntry>();

/* Field labels are dark and one step larger than the hints under them: the
   label is read first, and at `text-xs` it competed with the help text. */
function labelClass() {
  return 'text-foreground block min-w-0 space-y-2 text-sm font-semibold';
}
function SectionHeading({
  number,
  title,
  hint,
}: {
  readonly number: string;
  readonly title: string;
  readonly hint: string;
}) {
  return (
    <div className="flex min-w-0 items-start gap-3">
      <span className="bg-primary/10 text-primary grid size-8 shrink-0 place-items-center rounded-xl text-xs font-bold">
        {number}
      </span>
      <div className="min-w-0">
        <h3 className="text-foreground text-base font-bold">{title}</h3>
        <p className="text-muted-foreground mt-1 text-xs leading-relaxed">{hint}</p>
      </div>
    </div>
  );
}
function OptionSelect({
  label,
  value,
  options,
  placeholder,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly options: readonly EntryOption[];
  readonly placeholder: string;
  readonly onChange: (value: string) => void;
}) {
  const { t } = useI18n();
  const missing = value !== '' && !options.some((option) => option.id === value);
  return (
    <label className={labelClass()}>
      <span>{label}</span>
      <select className={CONTROL} value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{placeholder}</option>
        {missing && <option value={value}>{t('aps.entry.unavailableOption')}</option>}
        {options.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name} — {item.code}
          </option>
        ))}
      </select>
    </label>
  );
}
function Alert({
  children,
  error = false,
}: {
  readonly children: ReactNode;
  readonly error?: boolean;
}) {
  return (
    <div
      role={error ? 'alert' : 'status'}
      className={`rounded-xl border px-4 py-3 text-sm leading-relaxed ${error ? 'border-destructive/25 bg-destructive/5 text-destructive' : 'border-emerald-500/25 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300'}`}
    >
      {children}
    </div>
  );
}
function Loading({ label }: { readonly label: string }) {
  return (
    <div
      role="status"
      className={`${CARD} text-muted-foreground flex min-h-40 items-center justify-center gap-2 text-sm`}
    >
      <LoaderCircle className="size-5 animate-spin" aria-hidden="true" />
      {label}
    </div>
  );
}

export default function ApsLetterEntryPage() {
  const { t } = useI18n();
  const { session } = useAuth();
  const [params] = useSearchParams();
  const draftId = params.get('draft');
  const options = useEntryOptions();
  const draft = useEntryDraft(draftId);
  if (options.isPending || (draftId !== null && draft.isPending)) {
    return <Loading label={t(draftId === null ? 'aps.entry.loading' : 'aps.entry.loadingDraft')} />;
  }
  if (options.isError || (draftId !== null && draft.isError)) {
    const error =
      draftId !== null && draft.isError
        ? classifyEntryError(draft.error)
        : classifyEntryError(options.error);
    const key =
      draftId !== null && error === 'notFound'
        ? 'aps.entry.draftUnavailable'
        : draftId !== null && error === 'invalid'
          ? 'aps.entry.draftInvalid'
          : error === 'forbidden'
            ? 'aps.entry.errorForbidden'
            : 'aps.entry.loadError';
    return (
      <div className="space-y-4">
        <Alert error>{t(key)}</Alert>
        <button
          type="button"
          className="text-primary min-h-11 text-sm font-semibold"
          onClick={() => {
            void options.refetch();
            if (draftId !== null) void draft.refetch();
          }}
        >
          {t('aps.letters.retry')}
        </button>
      </div>
    );
  }
  if (!options.data || session?.user.id === undefined || (draftId !== null && !draft.data))
    return null;
  if (options.data.years.length === 0) return <Alert error>{t('aps.entry.emptyYears')}</Alert>;
  return (
    <EntryEditor
      key={`${session.user.id}:${draftId ?? 'new'}`}
      actor={session.user.id}
      draft={draftId === null ? null : (draft.data ?? null)}
      options={options.data}
    />
  );
}

function EntryEditor({
  actor,
  draft,
  options,
}: {
  readonly actor: string;
  readonly draft: LoadedDraft | null;
  readonly options: EntryOptions;
}) {
  const { t, locale, dir } = useI18n();
  const location = useLocation();
  const queryClient = useQueryClient();
  const cacheKey = `${actor}:${draft?.id ?? 'new'}`;
  const [initial] = useState(() => {
    const cached = unsavedEntries.get(cacheKey);
    if (cached) return { ...cached, restored: true };
    const empty = newEntryForm();
    const form = draft?.form ?? {
      ...empty,
      yearId: runningEntryPeriod(options)?.year.id ?? '',
    };
    return {
      id: draft?.id ?? crypto.randomUUID(),
      version: draft?.updatedAt ?? null,
      baseline: JSON.stringify(form),
      form,
      restored: false,
    };
  });
  const [id] = useState(initial.id);
  const [version, setVersion] = useState(initial.version);
  const [baseline, setBaseline] = useState(initial.baseline);
  const [form, setForm] = useState(initial.form);
  const [validation, setValidation] = useState<EntryValidationError | null>(null);
  const [banner, setBanner] = useState<{
    key: TranslationKey;
    error: boolean;
    showDraft?: boolean;
  } | null>(null);
  const [busy, setBusy] = useState<'saving' | 'approving' | null>(null);
  const [approved, setApproved] = useState(false);
  const [approvalUnknown, setApprovalUnknown] = useState(false);
  const inFlight = useRef(false);
  const dirty = JSON.stringify(form) !== baseline;
  const transfer = form.type === 'internal_transfer';
  const reclassification = entryHasReclassification(form);
  const total = entryTotal(form);
  const parties = options.parties.filter((party) => party.branch === form.type);
  const counterpartyTree = form.type === 'inbound' || form.type === 'outbound';
  /* Validation names a line by its 1-based position; the tree wants keys.
     A duplicate triple blames both of its rows, not just the repeat. */
  const highlightedKeys = useMemo<ReadonlySet<string>>(() => {
    if (!counterpartyTree || validation === null || validation.line === undefined) {
      return NO_HIGHLIGHTED_LINES;
    }
    const target = form.lines[validation.line - 1];
    if (target === undefined) return NO_HIGHLIGHTED_LINES;
    const keys = new Set<string>([target.key]);
    if (validation.code === 'duplicateLine') {
      const first = form.lines.find(
        (line, index) =>
          index < validation.line! - 1 &&
          line.partyId === target.partyId &&
          line.warehouseId === target.warehouseId &&
          line.classificationId === target.classificationId,
      );
      if (first !== undefined) keys.add(first.key);
    }
    return keys;
  }, [counterpartyTree, form.lines, validation]);
  /* The badges read the physical balance as of the day this letter carries:
     today for a new letter, the draft's own accounting date when resuming. */
  const balances = useLetterBalances(form.yearId, draft?.letterDate ?? localToday());
  const year = options.years.find((item) => item.id === form.yearId);
  /* The screen works in the period that is running today. A draft that belongs
     to another fiscal year keeps its own year — and therefore its own period
     statement — instead of being silently moved forward. */
  const running = runningEntryPeriod(options);
  const period = running !== null && running.year.id === form.yearId ? running : null;
  const activeYear = year ?? running?.year ?? null;
  const letterCodeId = 'aps-letter-code';
  const letterCodeHelpId = 'aps-letter-code-help';
  /* One stored column (`issuer_reference`, e.g. `YM:63`) answered by two
     controls: the dropdown of registered issuers and the digits. The colon is
     never typed — `joinLetterCode` writes it. */
  const letterCode = splitLetterCode(form.letterCode);
  const issuerKnown = options.issuers.some((item) => item.code === letterCode.code);
  /* A draft can hold a code that was deactivated afterwards: the value is kept
     (and shown as inactive) rather than silently dropped, and the save refuses
     it with the issuer explanation. */
  const letterCodeProblem = letterCode.code !== '' && !issuerKnown;
  const letterCodeNumberMissing = letterCode.code !== '' && letterCode.number === '';
  const noActiveIssuers = options.issuers.length === 0;
  const activeType = TYPES.find((item) => item.value === form.type) ?? TYPES[0]!;
  /* The shell's sticky header is the only header: it carries the type name, its
     colour and its arrow, and it changes the moment the type changes. */
  usePageHeaderOverride({
    titleKey: draft === null ? activeType.title : activeType.editTitle,
    tone: activeType.tone,
    icon: activeType.icon,
  });
  const warehouses = warehouseOptions(options.warehouses);

  useEffect(() => {
    if (dirty && !approved) unsavedEntries.set(cacheKey, { id, version, baseline, form });
    else unsavedEntries.delete(cacheKey);
  }, [approved, baseline, cacheKey, dirty, form, id, version]);

  useEffect(() => {
    if (!dirty || approved) return;
    function beforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = '';
    }
    function guardLink(event: MouseEvent) {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const target = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (
        !(target instanceof HTMLAnchorElement) ||
        target.target === '_blank' ||
        target.hasAttribute('download')
      )
        return;
      const next = new URL(target.href, window.location.href);
      if (
        next.origin !== window.location.origin ||
        (next.pathname === location.pathname && next.search === location.search)
      )
        return;
      if (!window.confirm(t('aps.entry.unsavedConfirm'))) {
        event.preventDefault();
        event.stopPropagation();
      }
    }
    window.addEventListener('beforeunload', beforeUnload);
    document.addEventListener('click', guardLink, true);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      document.removeEventListener('click', guardLink, true);
    };
  }, [approved, dirty, location.pathname, location.search, t]);

  function patch(next: Partial<EntryForm>) {
    setForm((current) => ({ ...current, ...next }));
    setValidation(null);
    setBanner(null);
  }
  function updateLine(key: string, next: Partial<EntryLine>) {
    setForm((current) => ({
      ...current,
      lines: current.lines.map((line) => (line.key === key ? { ...line, ...next } : line)),
    }));
    setValidation(null);
    setBanner(null);
  }
  async function submit(shouldApprove: boolean) {
    if (inFlight.current || approved || approvalUnknown) return;
    const invalid = validateEntry(form, options);
    if (invalid) {
      setValidation(invalid);
      setBanner(null);
      return;
    }
    inFlight.current = true;
    setValidation(null);
    setBanner(null);
    let phase: 'saving' | 'approving' = 'saving';
    try {
      if (version === null || dirty) {
        setBusy('saving');
        const saved = await saveEntryDraft(id, version, form);
        setVersion(saved.updatedAt);
        setBaseline(JSON.stringify(form));
        unsavedEntries.delete(cacheKey);
        void queryClient.invalidateQueries({ queryKey: ['aps', 'letters'] });
        void queryClient.invalidateQueries({ queryKey: ['aps', 'letter-detail'] });
        void queryClient.invalidateQueries({ queryKey: ['aps', 'entry-draft', actor, id] });
      }
      if (!shouldApprove) {
        setBanner({ key: 'aps.entry.saved', error: false, showDraft: true });
        return;
      }
      phase = 'approving';
      setBusy('approving');
      await approveEntryLetter(id);
      setApproved(true);
      unsavedEntries.delete(cacheKey);
      setBanner({ key: 'aps.entry.approved', error: false });
      void queryClient.invalidateQueries({ queryKey: ['aps', 'letters'] });
      void queryClient.invalidateQueries({ queryKey: ['aps', 'letter-detail'] });
    } catch (error) {
      const kind = classifyEntryError(error);
      if (phase === 'approving') {
        if (kind === 'network') setApprovalUnknown(true);
        setBanner({
          key: kind === 'network' ? 'aps.entry.approveUnknown' : 'aps.entry.approveFailedSaved',
          error: true,
          showDraft: true,
        });
      } else {
        setBanner({
          key: WRITE_ERROR[kind],
          error: true,
          showDraft: kind === 'existing' || kind === 'stale' || kind === 'network',
        });
      }
    } finally {
      setBusy(null);
      inFlight.current = false;
    }
  }

  const totalValue =
    total === null ? t('aps.entry.waitingAmount') : formatLetterAmount(total, locale);
  const inboundTotal =
    form.type === 'inbound' ||
    transfer ||
    (form.type === 'external_transfer' && form.direction === 'in');
  const outboundTotal =
    form.type === 'outbound' ||
    transfer ||
    (form.type === 'external_transfer' && form.direction === 'out');
  const zero = formatLetterAmount('0.00', locale);

  return (
    <div className="min-w-0 space-y-5 pb-8">
      {initial.restored && dirty && (
        <p className="text-muted-foreground text-xs">{t('aps.entry.restored')}</p>
      )}
      {banner && (
        <Alert error={banner.error}>
          <span>{t(banner.key)}</span>
          {banner.showDraft && (
            <Link
              to={`${APS_LETTERS_PATH}/${id}`}
              className="ms-2 font-bold underline underline-offset-2"
            >
              {t('aps.entry.viewDraft')}
            </Link>
          )}
        </Alert>
      )}
      {validation && (
        <Alert error>
          {t(`aps.entry.validate.${validation.code}`, { line: validation.line ?? 0 })}
        </Alert>
      )}

      <fieldset
        disabled={busy !== null || approved || approvalUnknown}
        className="min-w-0 space-y-5 disabled:opacity-75"
      >
        {/* One paragraph, three answers: which type, in which period, under which
            numbers. The type used to be a paragraph of its own with a heading
            that restated the sticky header — the four buttons are a switch that
            belongs with the rest of the header data. */}
        <section className={CARD}>
          <SectionHeading
            number="01"
            title={t('aps.entry.headerTitle')}
            hint={t('aps.entry.headerHint')}
          />
          {/* 1 — the type. One row of four labels, sized to their text: a switch
              inside the paragraph, not four cards of their own. */}
          <div
            role="group"
            aria-label={t('aps.entry.typeTitle')}
            className="border-border bg-muted/45 mt-4 grid min-w-0 grid-cols-4 gap-1 rounded-xl border p-1 @2xl:inline-grid @2xl:auto-cols-max @2xl:grid-flow-col @2xl:grid-cols-none"
          >
            {TYPES.map(({ value, hint, icon: Icon, color }) => {
              const selected = form.type === value;
              return (
                <button
                  key={value}
                  type="button"
                  aria-pressed={selected}
                  title={t(hint)}
                  onClick={() => {
                    if (selected) return;
                    // Lines keep their warehouses and amounts across a type
                    // switch, but a party of the other branch cannot travel.
                    const cleared = form.lines.map((line) => ({ ...line, partyId: '' }));
                    // A fresh outbound tree opens with its first purpose
                    // already present — the smallest numeric code — ready to
                    // be changed or removed like any other group.
                    if (value === 'outbound') {
                      const seed = smallestCodeParty(
                        options.parties.filter((party) => party.branch === 'outbound'),
                      );
                      const blank = cleared.every(
                        (line) =>
                          line.warehouseId === '' &&
                          line.classificationId === '' &&
                          line.amount === '',
                      );
                      if (seed !== undefined && blank && cleared[0] !== undefined) {
                        cleared[0] = { ...cleared[0], partyId: seed.id };
                      }
                    }
                    patch({ type: value, partyId: '', sisterId: '', lines: cleared });
                  }}
                  className={`focus-visible:ring-ring flex min-h-11 min-w-0 flex-col items-center justify-center gap-1 rounded-lg px-1.5 py-1.5 text-center transition-colors focus-visible:ring-2 focus-visible:outline-none @xl:flex-row @xl:gap-2 @xl:px-3 @xl:py-2 ${selected ? 'bg-card text-foreground border-border border shadow-sm' : 'text-muted-foreground hover:bg-card/60 border border-transparent'}`}
                >
                  <span
                    className={`hidden size-7 shrink-0 place-items-center rounded-md @xl:grid ${color}`}
                  >
                    <Icon className="size-4" aria-hidden="true" />
                  </span>
                  <span className="text-[10px] leading-tight font-bold break-words @xl:text-sm">
                    {t(`aps.letters.type.${value}`)}
                  </span>
                </button>
              );
            })}
          </div>

          {/* 2 — the running period, read from the periodic settings. It is the
              only period statement on the screen: nothing is typed here.
              Three weights, not one sentence: the period is a badge, the month
              is the emphasis, and the fiscal year is quiet — and the month's
              own year is left out because the fiscal year already states it. */}
          <div
            role="status"
            className="border-border bg-muted/55 mt-3 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border px-3 py-2.5"
          >
            {period !== null ? (
              <>
                <span className="bg-primary/10 text-primary inline-flex shrink-0 items-center rounded-md px-2 py-0.5 text-[11px] font-bold">
                  {t('aps.entry.periodBadge', { period: period.month.period })}
                </span>
                <span className="inline-flex min-w-0 items-center gap-1.5">
                  <CalendarDays className="text-primary size-4 shrink-0" aria-hidden="true" />
                  <span className="text-foreground truncate text-sm font-semibold">
                    {period.month.name}
                  </span>
                </span>
                <span className="text-muted-foreground text-xs">
                  {t('aps.entry.periodFiscalYear', {
                    fiscalYear: fiscalYearLabel(period.year.name),
                  })}
                </span>
                {period.month.closed && (
                  <span className="text-destructive inline-flex items-center gap-1.5 text-xs font-semibold">
                    <span aria-hidden="true" className="bg-destructive size-1.5 rounded-full" />
                    {t('aps.entry.periodClosed')}
                  </span>
                )}
              </>
            ) : (
              <span className="text-muted-foreground inline-flex min-w-0 items-center gap-2 text-xs leading-relaxed">
                <CalendarDays className="size-4 shrink-0" aria-hidden="true" />
                {activeYear !== null
                  ? t('aps.entry.periodOutside', {
                      fiscalYear: fiscalYearLabel(activeYear.name),
                    })
                  : t('aps.entry.periodUnknown')}
              </span>
            )}
          </div>
          {/* 3 — one row: the EPS number is typed, and the letter code is
              answered by a dropdown of the registered issuers plus a digits-only
              field. No date, no fiscal-year picker, no period field: all three
              are answered above or by the database. The row splits in two only
              when the width cannot hold both fields side by side. */}
          <div className="mt-4 grid min-w-0 gap-4 @xl:grid-cols-2">
            <label className={labelClass()}>
              <span>{t('aps.entry.epsNumber')}</span>
              <input
                className={CONTROL}
                type="text"
                dir="ltr"
                inputMode="numeric"
                autoComplete="off"
                maxLength={64}
                value={form.number}
                onChange={(event) => patch({ number: event.target.value.replace(/[^0-9]/g, '') })}
              />
            </label>
            <div className="min-w-0 space-y-2">
              <span id={letterCodeId} className="text-foreground block text-sm font-semibold">
                {t('aps.entry.letterCode')}
              </span>
              <div
                role="group"
                aria-labelledby={letterCodeId}
                dir="ltr"
                className="flex min-w-0 items-stretch gap-1.5"
              >
                <select
                  aria-label={t('aps.entry.letterCodeIssuer')}
                  className={`${CODE_SELECT} ${
                    letterCodeProblem ? 'ring-destructive/60 bg-destructive/5 ring-2' : ''
                  }`}
                  value={letterCode.code}
                  disabled={noActiveIssuers}
                  aria-invalid={letterCodeProblem}
                  aria-describedby={letterCodeHelpId}
                  onChange={(event) =>
                    patch({
                      letterCode: joinLetterCode(event.target.value, letterCode.number),
                    })
                  }
                >
                  <option value="">{t('aps.entry.chooseIssuer')}</option>
                  {options.issuers.map((issuer) => (
                    <option key={issuer.id} value={issuer.code}>
                      {issuerLabel(issuer)}
                    </option>
                  ))}
                  {letterCodeProblem ? (
                    <option value={letterCode.code}>
                      {`${letterCode.code} ${t('aps.entry.letterCodeInactive')}`}
                    </option>
                  ) : null}
                </select>
                <span
                  aria-hidden="true"
                  className="text-muted-foreground self-center font-mono text-lg font-bold"
                >
                  :
                </span>
                <input
                  aria-label={t('aps.entry.letterCodeNumber')}
                  className={CODE_NUMBER}
                  type="text"
                  dir="ltr"
                  lang="en"
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={29}
                  value={letterCode.number}
                  disabled={letterCode.code === ''}
                  aria-describedby={letterCodeHelpId}
                  onChange={(event) =>
                    patch({
                      letterCode: joinLetterCode(
                        letterCode.code,
                        event.target.value.replace(/[^0-9]/g, ''),
                      ),
                    })
                  }
                />
              </div>
              <p
                id={letterCodeHelpId}
                className={`text-xs leading-relaxed ${
                  letterCodeProblem ? 'text-destructive font-semibold' : 'text-muted-foreground'
                }`}
              >
                {noActiveIssuers
                  ? t('aps.entry.letterCodeNoIssuers')
                  : letterCodeProblem
                    ? t('aps.entry.letterCodeInvalid')
                    : letterCodeNumberMissing
                      ? t('aps.entry.letterCodeNumberRequired')
                      : t('aps.entry.letterCodeHint')}
              </p>
            </div>
          </div>
        </section>

        {year?.closed && !year.supplementsOpen && (
          <p className="text-destructive text-xs">
            {t('aps.entry.yearClosed')} — {t('aps.entry.approveHint')}
          </p>
        )}

        {/* Which sister company, and which way: the external transfer keeps its
            one counterparty row. Inbound and outbound no longer ask here — the
            party lives inside the tree below, once per line. */}
        {form.type === 'external_transfer' && (
          <section className={`${CARD} flex min-w-0 flex-col gap-4 sm:flex-row sm:items-end`}>
            <div className="flex min-w-0 items-start gap-2 sm:w-60 sm:shrink-0">
              <span className="bg-primary/10 text-primary grid size-7 shrink-0 place-items-center rounded-lg text-xs font-bold">
                02
              </span>
              <div className="min-w-0">
                <h3 className="text-foreground text-sm font-bold">
                  {t('aps.entry.counterpartyTitle')}
                </h3>
                <p className="text-muted-foreground mt-0.5 text-[11px] leading-relaxed">
                  {t('aps.entry.counterpartyHint')}
                </p>
              </div>
            </div>
            <div className="grid min-w-0 flex-1 gap-3 @2xl:grid-cols-2">
              {form.type === 'external_transfer' && (
                <OptionSelect
                  label={t('aps.entry.sister')}
                  value={form.sisterId}
                  options={options.sisters}
                  placeholder={t('aps.entry.chooseSister')}
                  onChange={(sisterId) => patch({ sisterId })}
                />
              )}
              {form.type === 'external_transfer' && (
                <label className={labelClass()}>
                  <span>{t('aps.entry.direction')}</span>
                  <select
                    className={CONTROL}
                    value={form.direction}
                    onChange={(event) =>
                      patch({ direction: event.target.value === 'out' ? 'out' : 'in' })
                    }
                  >
                    <option value="in">{t('aps.entry.externalIn')}</option>
                    <option value="out">{t('aps.entry.externalOut')}</option>
                  </select>
                </label>
              )}
            </div>
          </section>
        )}

        <section className="min-w-0 space-y-3">
          <SectionHeading
            number={form.type === 'external_transfer' ? '03' : '02'}
            title={t(
              counterpartyTree
                ? form.type === 'inbound'
                  ? 'aps.entry.tree.inboundTitle'
                  : 'aps.entry.tree.outboundTitle'
                : transfer
                  ? 'aps.entry.pairsTitle'
                  : 'aps.entry.linesTitle',
            )}
            hint={t(
              counterpartyTree
                ? form.type === 'inbound'
                  ? 'aps.entry.tree.inboundHint'
                  : 'aps.entry.tree.outboundHint'
                : transfer
                  ? 'aps.entry.pairsHint'
                  : 'aps.entry.linesHint',
            )}
          />
          {counterpartyTree ? (
            <ApsLetterTree
              type={form.type === 'inbound' ? 'inbound' : 'outbound'}
              parties={parties}
              warehouseOptions={warehouses}
              classifications={options.classifications}
              lines={form.lines}
              balances={balances.data ?? null}
              maxLines={500}
              highlightedKeys={highlightedKeys}
              onLinesChange={(lines) => patch({ lines })}
            />
          ) : (
            <>
              <div className="flex flex-wrap items-start justify-end gap-3">
                <button
                  type="button"
                  disabled={form.lines.length >= (transfer ? 250 : 500)}
                  onClick={() => patch({ lines: [...form.lines, newEntryLine()] })}
                  className="border-primary/25 text-primary hover:bg-primary/5 inline-flex min-h-10 items-center gap-2 rounded-xl border px-3 text-sm font-semibold disabled:opacity-50"
                >
                  <Plus className="size-4" aria-hidden="true" />
                  {t(transfer ? 'aps.entry.addPair' : 'aps.entry.addLine')}
                </button>
              </div>
              {form.lines.map((line, index) => (
                <div key={line.key} className={CARD}>
                  <div className="flex items-center justify-between gap-3">
                    <h4 className="text-foreground text-sm font-bold">
                      {t(transfer ? 'aps.entry.pair' : 'aps.entry.line', { number: index + 1 })}
                    </h4>
                    <button
                      type="button"
                      disabled={form.lines.length === 1}
                      aria-label={t(transfer ? 'aps.entry.removePair' : 'aps.entry.removeLine', {
                        number: index + 1,
                      })}
                      onClick={() =>
                        patch({ lines: form.lines.filter((item) => item.key !== line.key) })
                      }
                      className="text-muted-foreground hover:text-destructive grid size-10 place-items-center rounded-lg disabled:opacity-30"
                    >
                      <Trash2 className="size-4" aria-hidden="true" />
                    </button>
                  </div>
                  {transfer ? (
                    <div className="mt-3 grid min-w-0 gap-3 @4xl:grid-cols-2">
                      <div className="min-w-0 space-y-3 rounded-xl bg-orange-500/5 p-3">
                        <p className="flex items-center gap-2 text-xs font-bold text-orange-700 dark:text-orange-300">
                          <ArrowUpRight className="size-4" aria-hidden="true" />
                          {t('aps.entry.source')}
                        </p>
                        <SearchCombobox
                          label={`${t('aps.entry.source')} — ${t('aps.letters.warehouse')}`}
                          value={line.warehouseId}
                          options={warehouses}
                          placeholder={t('aps.entry.chooseWarehouse')}
                          searchPlaceholder={t('aps.entry.searchWarehouse')}
                          noMatches={t('aps.entry.noWarehouseMatches')}
                          clearLabel={t('aps.entry.clearWarehouse')}
                          missingLabel={t('aps.entry.unavailableOption')}
                          onChange={(warehouseId) => updateLine(line.key, { warehouseId })}
                        />
                        <OptionSelect
                          label={`${t('aps.entry.source')} — ${t('aps.letters.classification')}`}
                          value={line.classificationId}
                          options={options.classifications}
                          placeholder={t('aps.entry.chooseClassification')}
                          onChange={(classificationId) =>
                            updateLine(line.key, { classificationId })
                          }
                        />
                      </div>
                      <div className="min-w-0 space-y-3 rounded-xl bg-emerald-500/5 p-3">
                        <p className="flex items-center gap-2 text-xs font-bold text-emerald-700 dark:text-emerald-300">
                          <ArrowDownLeft className="size-4" aria-hidden="true" />
                          {t('aps.entry.destination')}
                        </p>
                        <SearchCombobox
                          label={`${t('aps.entry.destination')} — ${t('aps.letters.warehouse')}`}
                          value={line.destinationWarehouseId}
                          options={warehouses}
                          placeholder={t('aps.entry.chooseWarehouse')}
                          searchPlaceholder={t('aps.entry.searchWarehouse')}
                          noMatches={t('aps.entry.noWarehouseMatches')}
                          clearLabel={t('aps.entry.clearWarehouse')}
                          missingLabel={t('aps.entry.unavailableOption')}
                          onChange={(destinationWarehouseId) =>
                            updateLine(line.key, { destinationWarehouseId })
                          }
                        />
                        <OptionSelect
                          label={`${t('aps.entry.destination')} — ${t('aps.letters.classification')}`}
                          value={line.destinationClassificationId}
                          options={options.classifications}
                          placeholder={t('aps.entry.chooseClassification')}
                          onChange={(destinationClassificationId) =>
                            updateLine(line.key, { destinationClassificationId })
                          }
                        />
                      </div>
                    </div>
                  ) : (
                    <div className="mt-3 grid min-w-0 gap-3 @3xl:grid-cols-3">
                      <SearchCombobox
                        label={t('aps.letters.warehouse')}
                        value={line.warehouseId}
                        options={warehouses}
                        placeholder={t('aps.entry.chooseWarehouse')}
                        searchPlaceholder={t('aps.entry.searchWarehouse')}
                        noMatches={t('aps.entry.noWarehouseMatches')}
                        clearLabel={t('aps.entry.clearWarehouse')}
                        missingLabel={t('aps.entry.unavailableOption')}
                        onChange={(warehouseId) => updateLine(line.key, { warehouseId })}
                      />
                      <OptionSelect
                        label={t('aps.letters.classification')}
                        value={line.classificationId}
                        options={options.classifications}
                        placeholder={t('aps.entry.chooseClassification')}
                        onChange={(classificationId) => updateLine(line.key, { classificationId })}
                      />
                      <label className={labelClass()}>
                        <span>{t('aps.letters.amount')}</span>
                        <input
                          className={CONTROL}
                          dir="ltr"
                          inputMode="decimal"
                          placeholder={t('aps.entry.amountPlaceholder')}
                          value={line.amount}
                          onChange={(event) => updateLine(line.key, { amount: event.target.value })}
                        />
                      </label>
                    </div>
                  )}
                  {transfer && (
                    <label className={`${labelClass()} mt-3 max-w-xs`}>
                      <span>{t('aps.entry.pairAmount')}</span>
                      <input
                        className={CONTROL}
                        dir="ltr"
                        inputMode="decimal"
                        placeholder={t('aps.entry.amountPlaceholder')}
                        value={line.amount}
                        onChange={(event) => updateLine(line.key, { amount: event.target.value })}
                      />
                    </label>
                  )}
                </div>
              ))}
            </>
          )}
          {reclassification && (
            <div className={`${CARD} border-amber-300/70`}>
              <label className={labelClass()}>
                <span>{t('aps.entry.reason')}</span>
                <span className="text-muted-foreground block font-normal">
                  {t('aps.entry.reasonHint')}
                </span>
                <textarea
                  className={`${CONTROL} min-h-24 py-3`}
                  value={form.reason}
                  placeholder={t('aps.entry.reasonPlaceholder')}
                  onChange={(event) => patch({ reason: event.target.value })}
                />
              </label>
            </div>
          )}
        </section>

        <section className={`${CARD} space-y-4`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-foreground flex items-center gap-2 text-base font-bold">
              <ClipboardList className="text-primary size-4" aria-hidden="true" />
              {t('aps.entry.summary')}
            </h3>
            <span className="text-muted-foreground text-xs">
              {form.lines.length === 1
                ? t(transfer ? 'aps.entry.summaryPairOne' : 'aps.entry.summaryLineOne')
                : t(transfer ? 'aps.entry.summaryPairs' : 'aps.entry.summaryLines', {
                    count: form.lines.length,
                  })}
            </span>
          </div>
          <div className="bg-muted/60 grid min-w-0 grid-cols-2 gap-4 rounded-xl p-4">
            <div className="min-w-0">
              <p className="text-muted-foreground text-xs">{t('aps.letters.inTotal')}</p>
              <p className="text-foreground mt-1 text-base font-bold break-all">
                <bdi dir="ltr">{inboundTotal ? totalValue : zero}</bdi>
              </p>
            </div>
            <div className="border-border min-w-0 border-s ps-4">
              <p className="text-muted-foreground text-xs">{t('aps.letters.outTotal')}</p>
              <p className="text-foreground mt-1 text-base font-bold break-all">
                <bdi dir="ltr">{outboundTotal ? totalValue : zero}</bdi>
              </p>
            </div>
          </div>
          {transfer && total !== null && (
            <p className="flex items-center gap-2 text-xs font-semibold text-emerald-700 dark:text-emerald-300">
              <CheckCircle2 className="size-4" aria-hidden="true" />
              {t('aps.entry.balanced')}
            </p>
          )}
          <div className="border-border flex flex-wrap items-center justify-between gap-3 border-t pt-4">
            <p className="text-muted-foreground max-w-lg text-xs leading-relaxed">
              {t('aps.entry.approveHint')}
              {dirty && !approved && (
                <span className="text-muted-foreground font-semibold">
                  {' '}
                  {t('aps.entry.unsaved')}
                </span>
              )}
            </p>
            <div className="flex w-full flex-wrap gap-2 sm:w-auto">
              <button
                type="button"
                onClick={() => void submit(false)}
                className="border-border bg-card text-foreground hover:bg-muted inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl border px-4 text-sm font-semibold sm:flex-none"
              >
                <Save className="size-4" aria-hidden="true" />
                {t(version === null ? 'aps.entry.saveDraft' : 'aps.entry.saveChanges')}
              </button>
              <button
                type="button"
                onClick={() => void submit(true)}
                className="bg-primary text-primary-foreground inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold hover:opacity-90 sm:flex-none"
              >
                <CheckCircle2 className="size-4" aria-hidden="true" />
                {t('aps.entry.approve')}
              </button>
            </div>
          </div>
        </section>
      </fieldset>
      {busy && (
        <div role="status" className="text-primary flex items-center gap-2 text-sm">
          <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
          {t(busy === 'saving' ? 'aps.entry.saving' : 'aps.entry.approving')}
        </div>
      )}
      {approved && (
        <div className="flex flex-wrap gap-3">
          <a
            href={APS_LETTER_NEW_PATH}
            className="bg-primary text-primary-foreground inline-flex min-h-11 items-center gap-2 rounded-xl px-4 text-sm font-semibold"
          >
            <FilePlus2 className="size-4" aria-hidden="true" />
            {t('aps.entry.newAnother')}
          </a>
          <Link
            to={APS_LETTERS_PATH}
            className="text-primary inline-flex min-h-11 items-center gap-2 text-sm font-semibold"
          >
            <ArrowRight
              className={`size-4 ${dir === 'rtl' ? 'rotate-180' : ''}`}
              aria-hidden="true"
            />
            {t('aps.entry.backToList')}
          </Link>
        </div>
      )}
    </div>
  );
}
