import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowDownLeft,
  ArrowLeftRight,
  ArrowRight,
  ArrowUpRight,
  CheckCircle2,
  ClipboardList,
  FilePlus2,
  LoaderCircle,
  Plus,
  Save,
  Trash2,
} from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router';
import { useAuth } from '@/context/AuthContext';
import {
  approveEntryLetter,
  classifyEntryError,
  saveEntryDraft,
  useEntryDraft,
  useEntryOptions,
  type EntryErrorCode,
  type LoadedDraft,
} from '@/hooks/useApsLetterEntry';
import { useI18n, type TranslationKey } from '@/i18n/I18nContext';
import {
  APS_LETTER_NEW_PATH,
  entryHasReclassification,
  entryTotal,
  newEntryForm,
  newEntryLine,
  validateEntry,
  type EntryForm,
  type EntryLetterType,
  type EntryLine,
  type EntryOption,
  type EntryOptions,
  type EntryValidationError,
} from '@/lib/apsLetterEntry';
import { APS_LETTERS_PATH, formatLetterAmount } from '@/lib/apsLetters';

const CONTROL =
  'border-input bg-card text-foreground focus:border-primary/60 focus:ring-primary/25 min-h-11 w-full min-w-0 rounded-xl border px-3 text-sm outline-none focus:ring-2 disabled:opacity-60';
const CARD =
  'border-border bg-card min-w-0 rounded-2xl border p-4 shadow-[0_2px_12px_rgb(15_23_42/0.035)] sm:p-5';
const TYPES: readonly {
  value: EntryLetterType;
  hint: TranslationKey;
  icon: typeof ArrowDownLeft;
  color: string;
}[] = [
  {
    value: 'inbound',
    hint: 'aps.entry.inboundHint',
    icon: ArrowDownLeft,
    color: 'bg-emerald-500/10 text-emerald-700',
  },
  {
    value: 'outbound',
    hint: 'aps.entry.outboundHint',
    icon: ArrowUpRight,
    color: 'bg-orange-500/10 text-orange-700',
  },
  {
    value: 'internal_transfer',
    hint: 'aps.entry.internalHint',
    icon: ArrowLeftRight,
    color: 'bg-violet-500/10 text-violet-700',
  },
  {
    value: 'external_transfer',
    hint: 'aps.entry.externalHint',
    icon: ArrowRight,
    color: 'bg-sky-500/10 text-sky-700',
  },
];
const WRITE_ERROR: Record<EntryErrorCode, TranslationKey> = {
  unavailable: 'aps.entry.errorUnknown',
  forbidden: 'aps.entry.errorForbidden',
  network: 'aps.entry.errorNetwork',
  duplicate: 'aps.entry.errorDuplicate',
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

function labelClass() {
  return 'text-foreground block min-w-0 space-y-2 text-xs font-semibold';
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
      yearId: options.years.find((year) => year.active)?.id ?? '',
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
  const year = options.years.find((item) => item.id === form.yearId);

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
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h2 className="text-foreground text-lg font-bold">
            {t(draft ? 'aps.entry.editTitle' : 'aps.entry.title')}
          </h2>
          <p className="text-muted-foreground text-sm leading-relaxed">
            {t('aps.entry.description')}
          </p>
        </div>
        {dirty && !approved && (
          <span className="text-muted-foreground text-xs">{t('aps.entry.unsaved')}</span>
        )}
      </div>
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
        <section className={CARD}>
          <SectionHeading
            number="01"
            title={t('aps.entry.typeTitle')}
            hint={t('aps.entry.headerHint')}
          />
          <div className="mt-4 grid min-w-0 grid-cols-2 gap-2 @4xl:grid-cols-4">
            {TYPES.map(({ value, hint, icon: Icon, color }) => {
              const selected = form.type === value;
              return (
                <button
                  key={value}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => {
                    if (!selected) patch({ type: value, partyId: '', sisterId: '' });
                  }}
                  className={`focus-visible:ring-ring flex min-h-24 min-w-0 items-start gap-2 rounded-xl border p-3 text-start transition-colors focus-visible:ring-2 focus-visible:outline-none ${selected ? 'border-primary bg-primary/5 ring-primary/15 ring-2' : 'border-border hover:bg-muted/50'}`}
                >
                  <span className={`grid size-9 shrink-0 place-items-center rounded-lg ${color}`}>
                    <Icon className="size-4" aria-hidden="true" />
                  </span>
                  <span className="min-w-0">
                    <span className="text-foreground block text-sm font-bold">
                      {t(`aps.letters.type.${value}`)}
                    </span>
                    <span className="text-muted-foreground mt-1 block text-xs leading-relaxed">
                      {t(hint)}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        <section className={CARD}>
          <SectionHeading
            number="02"
            title={t('aps.entry.headerTitle')}
            hint={t('aps.entry.headerHint')}
          />
          <div className="mt-5 grid min-w-0 gap-4 @2xl:grid-cols-2 @5xl:grid-cols-3">
            <label className={labelClass()}>
              <span>{t('aps.letters.date')}</span>
              <input
                className={CONTROL}
                type="date"
                dir="ltr"
                value={form.date}
                onChange={(event) => patch({ date: event.target.value })}
              />
            </label>
            <label className={labelClass()}>
              <span>{t('aps.letters.number')}</span>
              <input
                className={CONTROL}
                type="text"
                maxLength={64}
                autoComplete="off"
                value={form.number}
                onChange={(event) => patch({ number: event.target.value })}
              />
            </label>
            <label className={labelClass()}>
              <span>{t('aps.entry.year')}</span>
              <select
                className={CONTROL}
                value={form.yearId}
                onChange={(event) => patch({ yearId: event.target.value })}
              >
                <option value="">{t('aps.entry.chooseYear')}</option>
                {options.years.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                    {item.supplementsOpen
                      ? ` — ${t('aps.entry.yearSupplement')}`
                      : item.closed
                        ? ` — ${t('aps.entry.yearClosed')}`
                        : ''}
                  </option>
                ))}
              </select>
            </label>
            {(form.type === 'inbound' || form.type === 'outbound') && (
              <OptionSelect
                label={t(
                  form.type === 'inbound' ? 'aps.entry.partyInbound' : 'aps.entry.partyOutbound',
                )}
                value={form.partyId}
                options={parties}
                placeholder={t('aps.entry.chooseParty')}
                onChange={(partyId) => patch({ partyId })}
              />
            )}
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
          {year?.closed && !year.supplementsOpen && (
            <p className="text-destructive mt-3 text-xs">
              {t('aps.entry.yearClosed')} — {t('aps.entry.approveHint')}
            </p>
          )}
        </section>

        <section className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <SectionHeading
              number="03"
              title={t(transfer ? 'aps.entry.pairsTitle' : 'aps.entry.linesTitle')}
              hint={t(transfer ? 'aps.entry.pairsHint' : 'aps.entry.linesHint')}
            />
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
                    <OptionSelect
                      label={`${t('aps.entry.source')} — ${t('aps.letters.warehouse')}`}
                      value={line.warehouseId}
                      options={options.warehouses}
                      placeholder={t('aps.entry.chooseWarehouse')}
                      onChange={(warehouseId) => updateLine(line.key, { warehouseId })}
                    />
                    <OptionSelect
                      label={`${t('aps.entry.source')} — ${t('aps.letters.classification')}`}
                      value={line.classificationId}
                      options={options.classifications}
                      placeholder={t('aps.entry.chooseClassification')}
                      onChange={(classificationId) => updateLine(line.key, { classificationId })}
                    />
                  </div>
                  <div className="min-w-0 space-y-3 rounded-xl bg-emerald-500/5 p-3">
                    <p className="flex items-center gap-2 text-xs font-bold text-emerald-700 dark:text-emerald-300">
                      <ArrowDownLeft className="size-4" aria-hidden="true" />
                      {t('aps.entry.destination')}
                    </p>
                    <OptionSelect
                      label={`${t('aps.entry.destination')} — ${t('aps.letters.warehouse')}`}
                      value={line.destinationWarehouseId}
                      options={options.warehouses}
                      placeholder={t('aps.entry.chooseWarehouse')}
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
                  <OptionSelect
                    label={t('aps.letters.warehouse')}
                    value={line.warehouseId}
                    options={options.warehouses}
                    placeholder={t('aps.entry.chooseWarehouse')}
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
