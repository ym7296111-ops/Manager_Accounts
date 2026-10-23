import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

/**
 * Theme system
 * -------------
 * * `light` / `dark` are explicit user choices, `system` follows the OS.
 * * The resolved mode is painted as the `.dark` class on <html> plus
 *   `color-scheme` and `<meta name="theme-color">`, exactly the same way the
 *   boot script in index.html does before first paint (zero flash).
 * * Resolution cascade: an explicit choice stored under
 *   {@link THEME_STORAGE_KEY} (raw string == explicit envelope) wins; without
 *   one the system-wide `defaultTheme` injected by LocalizationProvider is
 *   followed live (derived at render, no sync effects); the build-neutral
 *   fallback is `system`.
 * * Nothing is persisted for first-time visitors: storage is written only for
 *   explicit choices, so system defaults are never force-reserved locally.
 * * Explicit choices sync across browser tabs through the `storage` event.
 */

/** Themes the user can pick. `system` follows the operating system preference. */
export type Theme = 'light' | 'dark' | 'system';

/** The theme that is actually painted on screen (never `system`). */
export type ResolvedTheme = 'light' | 'dark';

/**
 * Single source of truth for persistence.
 * The boot script in index.html uses the same literal string.
 */
export const THEME_STORAGE_KEY = 'admin-system:theme';

const COLOR_SCHEME_QUERY = '(prefers-color-scheme: dark)';
const THEMES: readonly Theme[] = ['light', 'dark', 'system'] as const;

/** Background colours for `<meta name="theme-color">`, matched to --background. */
const THEME_COLORS: Record<ResolvedTheme, string> = {
  light: '#f8fafc',
  dark: '#020617',
};

export interface ThemeContextValue {
  /** Currently effective preference (may be `system`). */
  readonly theme: Theme;
  /** Theme actually applied to the document. */
  readonly resolvedTheme: ResolvedTheme;
  /** Convenience mirror of `resolvedTheme === 'dark'`. */
  readonly isDark: boolean;
  /** True when the current theme is an explicit user choice (not a default). */
  readonly isExplicit: boolean;
  /** Persist and apply a new preference (marks it explicit). */
  readonly setTheme: (theme: Theme) => void;
  /** Flip between the resolved light and dark modes. */
  readonly toggleTheme: () => void;
  /** Cycle light -> dark -> system -> light (three-state switch). */
  readonly cycleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);
ThemeContext.displayName = 'ThemeContext';

function isTheme(value: unknown): value is Theme {
  return typeof value === 'string' && (THEMES as readonly string[]).includes(value);
}

function readSystemTheme(): ResolvedTheme {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return 'light';
  }
  return window.matchMedia(COLOR_SCHEME_QUERY).matches ? 'dark' : 'light';
}

/** The explicit stored choice, or `null` when the visitor inherits defaults. */
function readStoredOverride(): Theme | null {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isTheme(stored) ? stored : null;
  } catch {
    // Storage blocked (private mode / disabled cookies): inherit the default.
    return null;
  }
}

function writeStoredTheme(theme: Theme): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Storage blocked: the in-memory preference still works for this session.
  }
}

function ensureThemeColorMeta(): HTMLMetaElement | null {
  if (typeof document === 'undefined') {
    return null;
  }
  let meta = document.head.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.setAttribute('name', 'theme-color');
    document.head.appendChild(meta);
  }
  return meta;
}

export interface ThemeProviderProps {
  children: ReactNode;
  /**
   * System-wide default injected by LocalizationProvider
   * (`appearance.default_theme`). Inherited until an explicit choice exists.
   */
  defaultTheme?: Theme;
}

export function ThemeProvider({ children, defaultTheme = 'system' }: ThemeProviderProps) {
  // `override` is the only stored state: an explicit user choice. When it is
  // `null`, the effective theme is derived from the injected default, so new
  // defaults propagate at render time without any sync effect.
  const [override, setOverride] = useState<Theme | null>(readStoredOverride);
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(readSystemTheme);

  const explicit = override !== null;
  const theme: Theme = override ?? defaultTheme;
  const resolvedTheme: ResolvedTheme = theme === 'system' ? systemTheme : theme;

  /* Track the OS preference live so `system` reacts without a reload. */
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }

    const media = window.matchMedia(COLOR_SCHEME_QUERY);
    const handleChange = (event: MediaQueryListEvent) => {
      setSystemTheme(event.matches ? 'dark' : 'light');
    };

    // The initial value already comes from readSystemTheme() in useState;
    // this listener only keeps `system` in sync with later OS changes.
    media.addEventListener('change', handleChange);
    return () => media.removeEventListener('change', handleChange);
  }, []);

  /* Paint the resolved theme on <html> (class, color-scheme, theme-color). */
  useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }

    const root = document.documentElement;
    root.classList.toggle('dark', resolvedTheme === 'dark');
    root.style.colorScheme = resolvedTheme;

    ensureThemeColorMeta()?.setAttribute('content', THEME_COLORS[resolvedTheme]);
  }, [resolvedTheme]);

  /* Persist explicit choices only — never reserve storage for new visitors. */
  useEffect(() => {
    if (override !== null) {
      writeStoredTheme(override);
    }
  }, [override]);

  /* Keep multiple open tabs on the same preference. */
  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const handleStorage = (event: StorageEvent) => {
      if (event.key !== THEME_STORAGE_KEY) {
        return;
      }
      if (event.newValue === null) {
        // Cleared elsewhere: inherit the injected system default again.
        setOverride(null);
        return;
      }
      if (isTheme(event.newValue)) {
        setOverride(event.newValue);
      }
    };

    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  const setTheme = useCallback((next: Theme) => {
    setOverride(isTheme(next) ? next : 'system');
  }, []);

  const toggleTheme = useCallback(() => {
    setOverride(resolvedTheme === 'dark' ? 'light' : 'dark');
  }, [resolvedTheme]);

  const cycleTheme = useCallback(() => {
    setOverride(theme === 'light' ? 'dark' : theme === 'dark' ? 'system' : 'light');
  }, [theme]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme,
      resolvedTheme,
      isDark: resolvedTheme === 'dark',
      isExplicit: explicit,
      setTheme,
      toggleTheme,
      cycleTheme,
    }),
    [theme, resolvedTheme, explicit, setTheme, toggleTheme, cycleTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/**
 * Read and control the current theme.
 * Throws when used outside of {@link ThemeProvider} so a missing provider is
 * caught immediately instead of silently rendering the wrong mode.
 */
export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (context === null) {
    throw new Error('useTheme must be used inside a <ThemeProvider>. Wrap your app root first.');
  }
  return context;
}
