import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { ar, type TranslationKey, type TranslationVars } from './locales/ar';
import { en } from './locales/en';

/**
 * Lightweight i18n for a bilingual (Arabic / English) app.
 *
 * * Arabic is the build-neutral default locale with direction `rtl`;
 *   English is `ltr`.
 * * Resolution cascade: an explicit choice stored under
 *   {@link LOCALE_STORAGE_KEY} (raw string == explicit envelope) wins;
 *   without one the system-wide `defaultLocale` injected by
 *   LocalizationProvider is followed live (derived at render, no sync
 *   effects); finally the locale baked into index.html / `<html lang>` is
 *   honoured.
 * * The active locale is mirrored onto `<html lang dir>` live; the boot
 *   script applies the same resolution before first paint (zero flash).
 * * Nothing is persisted for first-time visitors: storage is written only for
 *   explicit choices, so system defaults are never force-reserved locally.
 * * Dictionary parity is compiler enforced — see locales/en.ts.
 */

export type Locale = 'ar' | 'en';
export type Direction = 'rtl' | 'ltr';

/** Single source of truth for persistence (also read by the boot script). */
export const LOCALE_STORAGE_KEY = 'admin-system:locale';

const LOCALES: readonly Locale[] = ['ar', 'en'] as const;
const DIRECTIONS: Record<Locale, Direction> = { ar: 'rtl', en: 'ltr' };
const DICTIONARIES: Record<Locale, Record<TranslationKey, string>> = { ar, en };

export interface I18nContextValue {
  /** Active locale. */
  readonly locale: Locale;
  /** Text direction derived from the locale. */
  readonly dir: Direction;
  /** True when the locale is an explicit user choice (not a default). */
  readonly isExplicit: boolean;
  /** Translate a key, interpolating `{placeholders}` from `vars`. */
  readonly t: (key: TranslationKey, vars?: TranslationVars) => string;
  /** Persist and apply a new locale (updates `<html lang dir>`). */
  readonly setLocale: (locale: Locale) => void;
}

const I18nContext = createContext<I18nContextValue | null>(null);
I18nContext.displayName = 'I18nContext';

function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/** The explicit stored choice, or `null` when the visitor inherits defaults. */
function readStoredOverride(): Locale | null {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    return isLocale(stored) ? stored : null;
  } catch {
    // Storage blocked: fall through to the default / document locale.
    return null;
  }
}

/** First visit without system defaults: honour the locale baked into index.html. */
function readDocumentFallback(): Locale {
  const documentLocale = typeof document !== 'undefined' ? document.documentElement.lang : '';
  return isLocale(documentLocale) ? documentLocale : 'ar';
}

function interpolate(template: string, vars?: TranslationVars): string {
  if (!vars) {
    return template;
  }
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match,
  );
}

export interface I18nProviderProps {
  children: ReactNode;
  /**
   * System-wide default injected by LocalizationProvider
   * (`appearance.default_locale`). Inherited until an explicit choice exists.
   */
  defaultLocale?: Locale;
}

export function I18nProvider({ children, defaultLocale }: I18nProviderProps) {
  // `override` is the only stored state: an explicit user choice. When it is
  // `null`, the effective locale is derived from the injected default, so new
  // defaults propagate at render time without any sync effect.
  const [override, setOverride] = useState<Locale | null>(readStoredOverride);
  const [documentFallback] = useState<Locale>(readDocumentFallback);

  const explicit = override !== null;
  const locale: Locale = override ?? defaultLocale ?? documentFallback;
  const dir = DIRECTIONS[locale];

  /* Mirror the locale onto <html> so CSS :dir() / rtl variants stay correct. */
  useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }
    document.documentElement.lang = locale;
    document.documentElement.dir = dir;
  }, [locale, dir]);

  /* Persist explicit choices only — never reserve storage for new visitors. */
  useEffect(() => {
    if (override !== null) {
      try {
        window.localStorage.setItem(LOCALE_STORAGE_KEY, override);
      } catch {
        // Storage blocked: the in-memory locale still applies for this session.
      }
    }
  }, [override]);

  /* Keep multiple open tabs on the same preference. */
  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const handleStorage = (event: StorageEvent) => {
      if (event.key !== LOCALE_STORAGE_KEY) {
        return;
      }
      if (event.newValue === null) {
        // Cleared elsewhere: inherit the injected system default again.
        setOverride(null);
        return;
      }
      if (isLocale(event.newValue)) {
        setOverride(event.newValue);
      }
    };

    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  const setLocale = useCallback((next: Locale) => {
    setOverride(isLocale(next) ? next : 'ar');
  }, []);

  const t = useCallback(
    (key: TranslationKey, vars?: TranslationVars) => {
      const dictionary = DICTIONARIES[locale];
      const template = dictionary[key] ?? ar[key] ?? key;
      return interpolate(template, vars);
    },
    [locale],
  );

  const value = useMemo<I18nContextValue>(
    () => ({ locale, dir, isExplicit: explicit, t, setLocale }),
    [locale, dir, explicit, t, setLocale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/**
 * Read the active locale, direction and translation function.
 * Throws outside of {@link I18nProvider} so a missing provider fails loudly.
 */
export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  if (context === null) {
    throw new Error('useI18n must be used inside an <I18nProvider>. Wrap your app root first.');
  }
  return context;
}

export type { TranslationKey, TranslationVars };
