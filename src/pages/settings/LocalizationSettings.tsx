import {
  AlertCircle,
  Check,
  Clock3,
  Globe2,
  Loader2,
  RefreshCw,
  Search,
  ShieldAlert,
  X,
} from 'lucide-react';
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router';
import {
  LOCALIZATION_ERROR_KEYS,
  useLocalizationAdmin,
  type LocalizationErrorCode,
  type SaveLocalizationInput,
} from '@/hooks/useLocalizationAdmin';
import { useI18n, type TranslationKey } from '@/i18n/I18nContext';
import {
  DIRECTION_FOR_LOCALE,
  browserTimezone,
  isValidWeekendSelection,
  normalizeWeekendDays,
  type DefaultTheme,
  type LocalizationSettings,
  type SupportedLocale,
} from '@/lib/localization';

/**
 * Localization & Multi-Tenant Theme settings (renders inside SettingsPage for
 * `appearance`, screen 6 of 7).
 *
 * * Capability gate: without `settings.manage` or `*` the screen is a 403.
 * * ONE DOM tree serves both layouts through `@container` queries: form + live
 *   time preview side by side on wide containers, stacked on narrow ones.
 * * The timezone picker is generated at runtime from `Intl.supportedValuesOf`
 *   and decorated with `Intl.DateTimeFormat` — zero bundled date libraries.
 * * Saving goes through the single audited RPC with an optimistic lock; the
 *   response feeds the shared cache and the boot snapshot before Realtime.
 */

const FIELD_CLASS =
  'w-full rounded-lg border border-input bg-background px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground outline-none transition-shadow focus:border-primary/60 focus:ring-2 focus:ring-primary/25';

const PRIMARY_BUTTON_CLASS =
  'inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold transition-opacity hover:opacity-90 aria-disabled:cursor-not-allowed aria-disabled:opacity-60 disabled:cursor-not-allowed disabled:opacity-60';

const MAX_LISTED_ZONES = 50;

interface LocalizationDraft {
  locale: SupportedLocale;
  theme: DefaultTheme;
  timezone: string;
  weekendDays: number[];
}

function draftFrom(settings: LocalizationSettings): LocalizationDraft {
  return {
    locale: settings.defaultLocale,
    theme: settings.defaultTheme,
    timezone: settings.timezone,
    weekendDays: [...settings.weekendDays],
  };
}

function sameWeekend(left: readonly number[], right: readonly number[]): boolean {
  const a = normalizeWeekendDays(left);
  const b = normalizeWeekendDays(right);
  return a.length === b.length && a.every((day, index) => day === b[index]);
}

function isDraftDirty(draft: LocalizationDraft, settings: LocalizationSettings): boolean {
  return (
    draft.locale !== settings.defaultLocale ||
    draft.theme !== settings.defaultTheme ||
    draft.timezone.trim() !== settings.timezone ||
    !sameWeekend(draft.weekendDays, settings.weekendDays)
  );
}

/* -------------------------------------------------------------------------
 * Global Timezone Picker data (pure Intl — no external libraries)
 * ---------------------------------------------------------------------- */

function listIanaTimezones(): string[] {
  try {
    if (typeof Intl.supportedValuesOf === 'function') {
      const zones = Intl.supportedValuesOf('timeZone');
      if (Array.isArray(zones) && zones.length > 1) {
        return [...zones];
      }
    }
  } catch {
    // Older engine: fall through to the restricted manual-entry mode.
  }
  const current = browserTimezone();
  return current === 'UTC' ? [] : [current];
}

const SUPPORTED_TIMEZONES: readonly string[] = listIanaTimezones();
const ENGINE_AVAILABLE: boolean = SUPPORTED_TIMEZONES.length > 1;

function cityFromId(id: string): string {
  const lastSlash = id.lastIndexOf('/');
  const raw = lastSlash >= 0 ? id.slice(lastSlash + 1) : id;
  return raw.replaceAll('_', ' ');
}

function regionFromId(id: string): string {
  const firstSlash = id.indexOf('/');
  return firstSlash > 0 ? id.slice(0, firstSlash).replaceAll('_', ' ') : '';
}

interface TimezoneDescriptor {
  readonly id: string;
  readonly city: string;
  readonly region: string;
  readonly offsetLabel: string;
  readonly timeLabel: string;
}

function describeTimezone(
  id: string,
  now: Date,
  locale: SupportedLocale,
): TimezoneDescriptor | null {
  try {
    const parts = new Intl.DateTimeFormat('en', {
      timeZone: id,
      timeZoneName: 'longOffset',
    }).formatToParts(now);
    const offsetLabel = parts.find((part) => part.type === 'timeZoneName')?.value ?? '';
    const timeLabel = new Intl.DateTimeFormat(locale === 'ar' ? 'ar' : 'en', {
      timeZone: id,
      hour: '2-digit',
      minute: '2-digit',
    }).format(now);
    return { id, city: cityFromId(id), region: regionFromId(id), offsetLabel, timeLabel };
  } catch {
    return null; // Unknown/invalid identifier — never rendered.
  }
}

const WEEKDAY_TO_ISODOW: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

function isodowInTimezone(id: string, now: Date): number | null {
  try {
    const weekday = new Intl.DateTimeFormat('en', { timeZone: id, weekday: 'short' }).format(now);
    return WEEKDAY_TO_ISODOW[weekday] ?? null;
  } catch {
    return null;
  }
}

function useNow(intervalMs: number): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/* -------------------------------------------------------------------------
 * Timezone combobox (searchable, keyboard navigable, live clocks)
 * ---------------------------------------------------------------------- */

interface TimezoneComboboxProps {
  value: string;
  disabled: boolean;
  suggestedIds: readonly string[];
  /** Id of the input the field <label> points at. */
  inputId: string;
  onChange: (id: string) => void;
}

function TimezoneCombobox({
  value,
  disabled,
  suggestedIds,
  inputId,
  onChange,
}: TimezoneComboboxProps) {
  const { t, locale } = useI18n();
  const now = useNow(30_000);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();

  const normalizedQuery = query.trim().toLowerCase();

  const options = useMemo<readonly TimezoneDescriptor[]>(() => {
    const described = (ids: readonly string[]) =>
      ids
        .map((id) => describeTimezone(id, now, locale))
        .filter((descriptor): descriptor is TimezoneDescriptor => descriptor !== null);

    const suggested = described([...new Set(suggestedIds)]);
    const suggestedIdSet = new Set(suggested.map((descriptor) => descriptor.id));
    const matches =
      normalizedQuery === ''
        ? SUPPORTED_TIMEZONES
        : SUPPORTED_TIMEZONES.filter((id) => {
            if (suggestedIdSet.has(id) && normalizedQuery === '') {
              return false;
            }
            return (
              id.toLowerCase().includes(normalizedQuery) ||
              cityFromId(id).toLowerCase().includes(normalizedQuery)
            );
          });
    const rest = described(matches.slice(0, MAX_LISTED_ZONES)).filter(
      (descriptor) => !suggestedIdSet.has(descriptor.id),
    );
    return [...suggested, ...rest];
  }, [normalizedQuery, now, locale, suggestedIds]);

  const suggestedCount = useMemo(() => {
    if (normalizedQuery !== '') {
      return 0;
    }
    const suggestedIdSet = new Set([...new Set(suggestedIds)]);
    return options.filter((descriptor) => suggestedIdSet.has(descriptor.id)).length;
  }, [options, suggestedIds, normalizedQuery]);

  const selectedDescriptor = useMemo(
    () => (value === '' ? null : describeTimezone(value, now, locale)),
    [value, now, locale],
  );

  useEffect(() => {
    if (!open) {
      return;
    }
    const handlePointerDown = (event: MouseEvent) => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [open]);

  const select = (id: string) => {
    onChange(id);
    setOpen(false);
    setQuery('');
    setActiveIndex(0);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        setActiveIndex(0);
        return;
      }
      setActiveIndex((current) => Math.min(current + 1, Math.max(options.length - 1, 0)));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (open) {
        setActiveIndex((current) => Math.max(current - 1, 0));
      }
      return;
    }
    if (event.key === 'Home' && open) {
      event.preventDefault();
      setActiveIndex(0);
      return;
    }
    if (event.key === 'End' && open) {
      event.preventDefault();
      setActiveIndex(Math.max(options.length - 1, 0));
      return;
    }
    if (event.key === 'Enter') {
      if (!open) {
        setOpen(true);
        event.preventDefault();
        return;
      }
      const active = options[activeIndex];
      if (active !== undefined) {
        event.preventDefault();
        select(active.id);
      }
      return;
    }
    if (event.key === 'Escape') {
      if (open) {
        event.preventDefault();
        setOpen(false);
        setQuery('');
      }
      return;
    }
    if (event.key === 'Tab') {
      setOpen(false);
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <div className="relative">
        <Search
          className="text-muted-foreground pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2"
          aria-hidden="true"
        />
        <input
          id={inputId}
          role="combobox"
          type="text"
          dir="ltr"
          autoComplete="off"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={
            open && options[activeIndex] !== undefined
              ? `${listboxId}-opt-${activeIndex}`
              : undefined
          }
          disabled={disabled}
          className={`${FIELD_CLASS} ps-9`}
          placeholder={t('appearance.timezone.placeholder')}
          value={open ? query : (selectedDescriptor?.id ?? value)}
          onFocus={() => {
            if (!disabled) {
              setOpen(true);
            }
          }}
          onClick={() => {
            if (!disabled) {
              setOpen(true);
            }
          }}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(0);
            if (!open) {
              setOpen(true);
            }
          }}
          onKeyDown={handleKeyDown}
        />
      </div>

      {open && (
        <div className="border-border bg-popover text-popover-foreground absolute z-20 mt-1.5 w-full overflow-hidden rounded-xl border shadow-lg">
          <ul
            id={listboxId}
            role="listbox"
            aria-label={t('appearance.field.timezone')}
            className="max-h-64 overflow-y-auto py-1"
          >
            {suggestedCount > 0 && (
              <li
                aria-hidden="true"
                className="text-muted-foreground px-3 py-1.5 text-[11px] font-semibold tracking-wide uppercase"
              >
                {t('appearance.timezone.suggested')}
              </li>
            )}
            {options.map((descriptor, index) => {
              const selected = descriptor.id === value;
              return (
                <li
                  key={descriptor.id}
                  id={`${listboxId}-opt-${index}`}
                  role="option"
                  aria-selected={selected}
                  onMouseEnter={() => setActiveIndex(index)}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    select(descriptor.id);
                  }}
                  className={[
                    'flex cursor-pointer items-center justify-between gap-3 px-3 py-2 text-sm',
                    index === activeIndex ? 'bg-accent text-accent-foreground' : '',
                    selected ? 'font-semibold' : '',
                  ].join(' ')}
                >
                  <span className="min-w-0">
                    <span className="block truncate">{descriptor.city}</span>
                    <span className="text-muted-foreground block truncate text-[11px]">
                      {descriptor.region === '' ? descriptor.id : descriptor.region}
                    </span>
                  </span>
                  <span className="text-muted-foreground flex shrink-0 items-center gap-2 text-xs">
                    <span dir="ltr">{descriptor.offsetLabel}</span>
                    <span className="bg-muted rounded px-1.5 py-0.5 font-mono" dir="ltr">
                      {descriptor.timeLabel}
                    </span>
                  </span>
                </li>
              );
            })}
            {options.length === 0 && (
              <li className="text-muted-foreground px-3 py-3 text-sm">
                {t('appearance.timezone.empty')}
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------
 * Confirm dialog (accessible: focus trap, Escape, focus restore)
 * ---------------------------------------------------------------------- */

interface ConfirmDialogProps {
  busy: boolean;
  error: string | null;
  summary: readonly string[];
  onConfirm: () => void;
  onCancel: () => void;
}

function ConfirmDialog({ busy, error, summary, onConfirm, onCancel }: ConfirmDialogProps) {
  const { t } = useI18n();
  const panelRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const bodyId = useId();

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelRef.current?.focus();
    return () => previous?.focus();
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (!busy) {
        onCancel();
      }
      return;
    }
    if (event.key !== 'Tab') {
      return;
    }
    const focusables = Array.from(
      panelRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    );
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (first === undefined || last === undefined) {
      return;
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div
      className="bg-foreground/50 fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) {
          onCancel();
        }
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        onKeyDown={handleKeyDown}
        className="bg-card text-card-foreground animate-scale-in border-border w-full max-w-md rounded-2xl border p-5 shadow-xl motion-reduce:animate-none"
      >
        <h2 id={titleId} className="text-card-foreground text-base font-semibold">
          {t('appearance.confirm.title')}
        </h2>
        <p id={bodyId} className="text-muted-foreground mt-2 text-sm leading-relaxed">
          {t('appearance.confirm.body')}
        </p>
        <ul className="mt-3 list-disc space-y-1 ps-5 text-sm">
          {summary.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        {error !== null && (
          <p role="alert" className="text-destructive mt-3 text-sm">
            {error}
          </p>
        )}
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            ref={cancelRef}
            type="button"
            disabled={busy}
            onClick={onCancel}
            className={`${PRIMARY_BUTTON_CLASS} border-border bg-background`}
          >
            {t('appearance.confirm.cancel')}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className={`${PRIMARY_BUTTON_CLASS} bg-primary text-primary-foreground`}
          >
            {busy && (
              <Loader2
                className="size-4 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            )}
            {t('appearance.confirm.save')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* -------------------------------------------------------------------------
 * Screen states
 * ---------------------------------------------------------------------- */

function SkeletonScreen() {
  const { t } = useI18n();
  return (
    <div className="@container" aria-busy="true">
      <div role="status" className="sr-only">
        {t('appearance.loading')}
      </div>
      <div className="grid grid-cols-1 gap-4 @3xl:grid-cols-[minmax(0,1fr)_minmax(18rem,22rem)]">
        <div className="border-border bg-card h-96 animate-pulse rounded-2xl border motion-reduce:animate-none" />
        <div className="border-border bg-card h-64 animate-pulse rounded-2xl border motion-reduce:animate-none" />
      </div>
    </div>
  );
}

const WEEKEND_DAY_LABEL_KEYS: readonly { isodow: number; labelKey: TranslationKey }[] = [
  { isodow: 1, labelKey: 'appearance.day.mon' },
  { isodow: 2, labelKey: 'appearance.day.tue' },
  { isodow: 3, labelKey: 'appearance.day.wed' },
  { isodow: 4, labelKey: 'appearance.day.thu' },
  { isodow: 5, labelKey: 'appearance.day.fri' },
  { isodow: 6, labelKey: 'appearance.day.sat' },
  { isodow: 7, labelKey: 'appearance.day.sun' },
];

export default function LocalizationSettings() {
  const { t, locale } = useI18n();
  const admin = useLocalizationAdmin();
  const { settings } = admin;
  const now = useNow(30_000);
  const [draft, setDraft] = useState<LocalizationDraft>(() => draftFrom(settings));
  const [baselineStamp, setBaselineStamp] = useState(settings.updatedAt);
  const [formError, setFormError] = useState<LocalizationErrorCode | null>(null);
  const [success, setSuccess] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const liveId = useId();
  const localeFieldId = useId();
  const directionFieldId = useId();
  const themeFieldId = useId();
  const timezoneFieldId = useId();
  const weekendHintId = useId();
  const weekendGroupId = useId();

  if (settings.updatedAt !== baselineStamp && !isDraftDirty(draft, settings)) {
    setDraft(draftFrom(settings));
    setBaselineStamp(settings.updatedAt);
  }

  const dirty = isDraftDirty(draft, settings);
  const weekendValid = isValidWeekendSelection(draft.weekendDays);
  const timezoneValid = draft.timezone.trim() !== '';
  const canSave = dirty && weekendValid && timezoneValid && !admin.isSaving;

  useEffect(() => {
    if (!dirty) {
      return;
    }
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [dirty]);

  const resetDraft = () => {
    setDraft(draftFrom(settings));
    setFormError(null);
    setSuccess(false);
    setBaselineStamp(settings.updatedAt);
  };

  const summary = useMemo(() => {
    const items: string[] = [];
    if (draft.locale !== settings.defaultLocale) {
      items.push(t('appearance.diff.locale'));
    }
    if (draft.theme !== settings.defaultTheme) {
      items.push(t('appearance.diff.theme'));
    }
    if (draft.timezone.trim() !== settings.timezone) {
      items.push(t('appearance.diff.timezone'));
    }
    if (!sameWeekend(draft.weekendDays, settings.weekendDays)) {
      items.push(t('appearance.diff.weekend'));
    }
    return items;
  }, [draft, settings, t]);

  const handleSave = async () => {
    setFormError(null);
    setSuccess(false);
    const payload: SaveLocalizationInput = {
      defaultLocale: draft.locale,
      defaultTheme: draft.theme,
      timezone: draft.timezone,
      weekendDays: draft.weekendDays,
      expectedUpdatedAt: settings.updatedAt,
    };
    const result = await admin.save(payload);
    if (!result.ok) {
      setFormError(result.code);
      return;
    }
    setDraft(draftFrom(result.settings));
    setBaselineStamp(result.settings.updatedAt);
    setConfirmOpen(false);
    setSuccess(true);
  };

  const toggleWeekendDay = (isodow: number) => {
    setDraft((current) => {
      const selected = current.weekendDays.includes(isodow);
      return {
        ...current,
        weekendDays: selected
          ? current.weekendDays.filter((day) => day !== isodow)
          : [...current.weekendDays, isodow],
      };
    });
  };

  const previewDescriptor = useMemo(
    () =>
      draft.timezone.trim() === '' ? null : describeTimezone(draft.timezone.trim(), now, locale),
    [draft.timezone, now, locale],
  );
  const previewIsodow =
    previewDescriptor === null ? null : isodowInTimezone(previewDescriptor.id, now);
  const previewClock = useMemo(() => {
    if (previewDescriptor === null) {
      return null;
    }
    try {
      return new Intl.DateTimeFormat(locale === 'ar' ? 'ar' : 'en', {
        timeZone: previewDescriptor.id,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }).format(now);
    } catch {
      return null;
    }
  }, [previewDescriptor, now, locale]);
  const previewIsWeekend = previewIsodow !== null && draft.weekendDays.includes(previewIsodow);

  const browserZone = browserTimezone();
  const suggestedZones = useMemo(() => {
    const ids = [browserZone, settings.timezone];
    return [...new Set(ids.filter((id) => id !== ''))];
  }, [browserZone, settings.timezone]);

  let content: ReactNode;
  if (admin.isAccessLoading || admin.canManage === null) {
    content = <SkeletonScreen />;
  } else if (!admin.configured) {
    content = (
      <div className="@container">
        <div className="bg-card flex flex-col items-center gap-4 rounded-2xl border border-dashed px-6 py-14 text-center">
          <AlertCircle className="text-warning size-8" aria-hidden="true" />
          <h2 className="text-base font-semibold">{t('appearance.error.title')}</h2>
          <p className="text-muted-foreground max-w-md text-sm">
            {t('appearance.error.unavailable')}
          </p>
        </div>
      </div>
    );
  } else if (!admin.canManage) {
    content = (
      <div className="@container">
        <section className="border-destructive/30 bg-card mx-auto max-w-xl rounded-2xl border p-8 text-center">
          <ShieldAlert className="text-destructive mx-auto size-10" aria-hidden="true" />
          <p className="text-destructive mt-3 text-xs font-bold">{t('appearance.denied.code')}</p>
          <h2 className="mt-1 text-xl font-bold">{t('appearance.denied.title')}</h2>
          <p className="text-muted-foreground mt-2 text-sm">{t('appearance.denied.body')}</p>
          <Link
            to="/"
            className={`${PRIMARY_BUTTON_CLASS} bg-primary text-primary-foreground mt-5`}
          >
            {t('appearance.denied.back')}
          </Link>
        </section>
      </div>
    );
  } else {
    content = (
      <div className="@container space-y-4" aria-busy={admin.isSaving}>
        <div className="border-border bg-card/95 sticky top-0 z-10 flex flex-col gap-3 rounded-2xl border p-4 shadow-sm @3xl:flex-row @3xl:items-center @3xl:justify-between">
          <p className="text-muted-foreground text-sm">
            {dirty ? t('appearance.dirty', { count: summary.length }) : t('appearance.clean')}
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={!dirty || admin.isSaving}
              onClick={resetDraft}
              className={`${PRIMARY_BUTTON_CLASS} border-border bg-background`}
            >
              <X className="size-4" aria-hidden="true" />
              {t('appearance.reset')}
            </button>
            <button
              type="button"
              disabled={!canSave}
              onClick={() => {
                setFormError(null);
                setConfirmOpen(true);
              }}
              className={`${PRIMARY_BUTTON_CLASS} bg-primary text-primary-foreground`}
            >
              {t('appearance.save')}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 @3xl:grid-cols-[minmax(0,1fr)_minmax(18rem,22rem)] @3xl:items-start">
          <form
            className="border-border bg-card space-y-6 rounded-2xl border p-5 shadow-sm sm:p-6"
            onSubmit={(event) => {
              event.preventDefault();
              if (canSave) {
                setConfirmOpen(true);
              }
            }}
          >
            <fieldset className="space-y-4">
              <legend className="text-base font-semibold">{t('appearance.section.locale')}</legend>
              <div>
                <label htmlFor={localeFieldId} className="mb-1.5 block text-sm font-medium">
                  {t('appearance.field.locale')}
                </label>
                <select
                  id={localeFieldId}
                  value={draft.locale}
                  disabled={admin.isSaving}
                  className={FIELD_CLASS}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      locale: event.target.value === 'en' ? 'en' : 'ar',
                    }))
                  }
                >
                  <option value="ar">{t('appearance.locale.ar')}</option>
                  <option value="en">{t('appearance.locale.en')}</option>
                </select>
              </div>
              <div>
                <label htmlFor={directionFieldId} className="mb-1.5 block text-sm font-medium">
                  {t('appearance.field.direction')}
                </label>
                <input
                  id={directionFieldId}
                  readOnly
                  tabIndex={-1}
                  value={t(
                    DIRECTION_FOR_LOCALE[draft.locale] === 'rtl'
                      ? 'appearance.direction.rtl'
                      : 'appearance.direction.ltr',
                  )}
                  aria-label={t('appearance.field.direction')}
                  className={`${FIELD_CLASS} opacity-70`}
                />
                <p className="text-muted-foreground mt-1 text-xs">
                  {t('appearance.direction.follows')}
                </p>
              </div>
            </fieldset>

            <fieldset className="space-y-4">
              <legend className="text-base font-semibold">{t('appearance.section.theme')}</legend>
              <div>
                <label htmlFor={themeFieldId} className="mb-1.5 block text-sm font-medium">
                  {t('appearance.field.theme')}
                </label>
                <select
                  id={themeFieldId}
                  value={draft.theme}
                  disabled={admin.isSaving}
                  className={FIELD_CLASS}
                  onChange={(event) => {
                    const next = event.target.value;
                    setDraft((current) => ({
                      ...current,
                      theme:
                        next === 'light' || next === 'dark' || next === 'system' ? next : 'system',
                    }));
                  }}
                >
                  <option value="light">{t('appearance.theme.light')}</option>
                  <option value="dark">{t('appearance.theme.dark')}</option>
                  <option value="system">{t('appearance.theme.system')}</option>
                </select>
              </div>
            </fieldset>

            <fieldset className="space-y-4">
              <legend className="text-base font-semibold">
                {t('appearance.section.timezone')}
              </legend>
              <div>
                <label htmlFor={timezoneFieldId} className="mb-1.5 block text-sm font-medium">
                  {t('appearance.field.timezone')}
                </label>
                {ENGINE_AVAILABLE ? (
                  <TimezoneCombobox
                    value={draft.timezone}
                    disabled={admin.isSaving}
                    suggestedIds={suggestedZones}
                    inputId={timezoneFieldId}
                    onChange={(id) => setDraft((current) => ({ ...current, timezone: id }))}
                  />
                ) : (
                  <div className="space-y-2">
                    <p className="text-muted-foreground text-xs">
                      {t('appearance.timezone.unsupported')}
                    </p>
                    {browserZone !== 'UTC' && (
                      <button
                        type="button"
                        disabled={admin.isSaving}
                        onClick={() =>
                          setDraft((current) => ({ ...current, timezone: browserZone }))
                        }
                        className={`${PRIMARY_BUTTON_CLASS} border-border bg-background text-xs`}
                      >
                        <Globe2 className="size-3.5" aria-hidden="true" />
                        {t('appearance.timezone.browser')} — {browserZone}
                      </button>
                    )}
                    <input
                      id={timezoneFieldId}
                      dir="ltr"
                      value={draft.timezone}
                      disabled={admin.isSaving}
                      placeholder="Asia/Riyadh"
                      aria-label={t('appearance.field.timezone')}
                      aria-describedby={`${timezoneFieldId}-hint`}
                      className={FIELD_CLASS}
                      onChange={(event) =>
                        setDraft((current) => ({ ...current, timezone: event.target.value }))
                      }
                    />
                    <p id={`${timezoneFieldId}-hint`} className="text-muted-foreground text-xs">
                      {t('appearance.timezone.manualHint')}
                    </p>
                  </div>
                )}
              </div>
            </fieldset>

            <fieldset className="space-y-4">
              <legend className="text-base font-semibold">{t('appearance.section.weekend')}</legend>
              <p id={weekendHintId} className="text-muted-foreground text-xs">
                {t('appearance.weekend.hint')}
              </p>
              <div
                id={weekendGroupId}
                role="group"
                aria-labelledby={weekendGroupId}
                aria-describedby={weekendHintId}
                className="grid grid-cols-2 gap-2 @md:grid-cols-4"
              >
                {WEEKEND_DAY_LABEL_KEYS.map(({ isodow, labelKey }) => {
                  const checked = draft.weekendDays.includes(isodow);
                  const dayId = `${weekendGroupId}-day-${isodow}`;
                  return (
                    <label
                      key={isodow}
                      htmlFor={dayId}
                      className={[
                        'flex cursor-pointer items-center gap-2.5 rounded-xl border px-3 py-2.5 text-sm transition-colors',
                        checked
                          ? 'border-primary/60 bg-primary/10 text-primary'
                          : 'border-border bg-background hover:border-primary/40',
                        admin.isSaving ? 'cursor-not-allowed opacity-60' : '',
                      ].join(' ')}
                    >
                      <input
                        id={dayId}
                        type="checkbox"
                        checked={checked}
                        disabled={admin.isSaving}
                        onChange={() => toggleWeekendDay(isodow)}
                        className="size-4 accent-current"
                      />
                      {t(labelKey)}
                    </label>
                  );
                })}
              </div>
              {!weekendValid && (
                <p role="alert" className="text-destructive text-xs">
                  {t('appearance.weekend.invalid')}
                </p>
              )}
            </fieldset>
          </form>

          <aside className="border-border bg-card space-y-4 rounded-2xl border p-5 shadow-sm @3xl:sticky @3xl:top-24">
            <h2 className="text-sm font-semibold">{t('appearance.preview.title')}</h2>
            <div className="border-sidebar-border bg-sidebar rounded-xl border p-4 text-center">
              <Clock3 className="text-sidebar-primary mx-auto size-6" aria-hidden="true" />
              <p className="mt-2 text-3xl font-bold tracking-tight" dir="ltr">
                {previewClock ?? '—:—:—'}
              </p>
              <p className="text-muted-foreground mt-1 truncate text-xs" dir="ltr">
                {draft.timezone.trim() === '' ? '—' : draft.timezone.trim()}
              </p>
            </div>
            <dl className="space-y-2 text-sm">
              <div className="flex items-center justify-between gap-2">
                <dt className="text-muted-foreground">{t('appearance.preview.offset')}</dt>
                <dd className="font-mono text-xs" dir="ltr">
                  {previewDescriptor?.offsetLabel ?? '—'}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-muted-foreground">{t('appearance.preview.status')}</dt>
                <dd>
                  <span
                    className={[
                      'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold',
                      previewIsodow === null
                        ? 'bg-muted text-muted-foreground'
                        : previewIsWeekend
                          ? 'bg-warning/15 text-warning'
                          : 'bg-success/15 text-success',
                    ].join(' ')}
                  >
                    {previewIsodow === null
                      ? '—'
                      : previewIsWeekend
                        ? t('appearance.preview.weekendDay')
                        : t('appearance.preview.workingDay')}
                  </span>
                </dd>
              </div>
            </dl>
            <p className="text-muted-foreground text-xs leading-relaxed">
              {t('appearance.preview.scheduleNote')}
            </p>
          </aside>
        </div>

        <div id={liveId} className="sr-only" aria-live="polite">
          {success ? t('appearance.success.saved') : ''}
        </div>
        {success && (
          <p role="status" className="text-success flex items-center gap-2 text-sm font-medium">
            <Check className="size-4" aria-hidden="true" />
            {t('appearance.success.saved')}
          </p>
        )}
        {formError !== null && !confirmOpen && (
          <p role="alert" className="text-destructive flex items-center gap-2 text-sm">
            <AlertCircle className="size-4" aria-hidden="true" />
            {t(LOCALIZATION_ERROR_KEYS[formError])}
            <button
              type="button"
              onClick={() => admin.refresh()}
              className="text-foreground inline-flex items-center gap-1 text-xs font-semibold"
            >
              <RefreshCw className="size-3.5" aria-hidden="true" />
              {t('appearance.retry')}
            </button>
          </p>
        )}
      </div>
    );
  }

  return (
    <>
      {content}
      {confirmOpen && (
        <ConfirmDialog
          busy={admin.isSaving}
          error={formError === null ? null : t(LOCALIZATION_ERROR_KEYS[formError])}
          summary={summary}
          onCancel={() => {
            if (!admin.isSaving) {
              setConfirmOpen(false);
            }
          }}
          onConfirm={() => {
            void handleSave();
          }}
        />
      )}
    </>
  );
}
