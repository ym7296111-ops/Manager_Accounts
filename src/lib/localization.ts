/**
 * Shared localization helpers (pure + storage I/O).
 *
 * The system-wide defaults live in `public.app_settings` under the
 * `appearance` group (key/value, all public). This module never talks to
 * React; contexts and hooks compose it.
 *
 * Versioned storage envelope contract:
 * * The boot snapshot under {@link LOCALIZATION_STORAGE_KEY} is a versioned
 *   JSON envelope (`v: 1`) carrying the system defaults — the "default"
 *   source of the resolution cascade.
 * * Per-preference keys (`admin-system:locale`, `admin-system:theme`) keep
 *   the legacy RAW format for explicit user choices: a raw stored value means
 *   `source: 'explicit'`, an ABSENT key means "inherit the system default".
 *   {@link readStoredPreference} additionally accepts JSON envelopes of the
 *   form `{ "v": 2, "value": ..., "source": ... }` so future writers can move
 *   to full envelopes without breaking readers. Nothing is ever persisted for
 *   first-time visitors — defaults are never force-reserved in localStorage.
 */

export type SupportedLocale = 'ar' | 'en';
export type Direction = 'rtl' | 'ltr';
export type DefaultTheme = 'light' | 'dark' | 'system';

/** Single source of truth for the boot snapshot key (index.html mirrors it). */
export const LOCALIZATION_STORAGE_KEY = 'admin-system:localization';

export const LOCALIZATION_QUERY_KEY = ['localization-settings'] as const;
export const LOCALIZATION_CHANNEL = 'localization-live';
export const APPEARANCE_GROUP = 'appearance';
export const LOCALIZATION_SELECT_COLUMNS = 'key, value, is_public, updated_at';

/** Full key names as stored in `public.app_settings`. */
export const SETTING_KEY = {
  defaultLocale: 'appearance.default_locale',
  defaultDirection: 'appearance.default_direction',
  defaultTheme: 'appearance.default_theme',
  defaultTimezone: 'appearance.default_timezone',
  weekendDays: 'appearance.weekend_days',
} as const;

export const SUPPORTED_LOCALES: readonly SupportedLocale[] = ['ar', 'en'];
export const DEFAULT_THEMES: readonly DefaultTheme[] = ['light', 'dark', 'system'];
export const DIRECTIONS: readonly Direction[] = ['rtl', 'ltr'];

/** Server-enforced pairing between locale and text direction. */
export const DIRECTION_FOR_LOCALE: Record<SupportedLocale, Direction> = {
  ar: 'rtl',
  en: 'ltr',
};

/** Saturday + Sunday — identical to the historical hardcoded behaviour. */
export const FALLBACK_WEEKEND_DAYS: readonly number[] = [6, 7];

/** Sentinel `updated_at` meaning "never written" (optimistic lock skips it). */
export const EPOCH_UPDATED_AT = '1970-01-01T00:00:00.000Z';

export interface LocalizationSettings {
  readonly defaultLocale: SupportedLocale;
  readonly defaultDirection: Direction;
  readonly defaultTheme: DefaultTheme;
  /** Canonical IANA identifier, e.g. `Asia/Riyadh` — never a raw offset. */
  readonly timezone: string;
  /** isodow days (1=Mon..7=Sun) excluded from technical working-day counts. */
  readonly weekendDays: readonly number[];
  /** `max(updated_at)` across the managed keys; the optimistic-lock version. */
  readonly updatedAt: string;
}

export interface LocalizationSnapshot {
  readonly v: 1;
  readonly defaultLocale: SupportedLocale;
  readonly defaultDirection: Direction;
  readonly defaultTheme: DefaultTheme;
  readonly timezone: string;
  readonly weekendDays: readonly number[];
  readonly updatedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

export function isDirection(value: unknown): value is Direction {
  return typeof value === 'string' && (DIRECTIONS as readonly string[]).includes(value);
}

export function isDefaultTheme(value: unknown): value is DefaultTheme {
  return typeof value === 'string' && (DEFAULT_THEMES as readonly string[]).includes(value);
}

/**
 * The visitor's own zone via the platform engine — used only as a display
 * suggestion and as the fallback default; the persisted value always comes
 * from the settings row.
 */
export function browserTimezone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof zone === 'string' && zone.trim() !== '' ? zone : 'UTC';
  } catch {
    return 'UTC';
  }
}

/** Build-neutral defaults (layer 3 of the resolution cascade). */
export function fallbackLocalization(): LocalizationSettings {
  return {
    defaultLocale: 'ar',
    defaultDirection: 'rtl',
    defaultTheme: 'system',
    timezone: browserTimezone(),
    weekendDays: [...FALLBACK_WEEKEND_DAYS],
    updatedAt: EPOCH_UPDATED_AT,
  };
}

/**
 * Weekend selection guard shared by the client (pre-save) and the snapshot
 * reader: 1..3 distinct integers, each in isodow 1..7.
 */
export function isValidWeekendSelection(days: readonly number[]): boolean {
  if (!Number.isInteger(days.length) || days.length < 1 || days.length > 3) {
    return false;
  }
  const seen = new Set<number>();
  for (const day of days) {
    if (!Number.isInteger(day) || day < 1 || day > 7 || seen.has(day)) {
      return false;
    }
    seen.add(day);
  }
  return true;
}

/** Canonical ascending copy (the server stores sorted arrays). */
export function normalizeWeekendDays(days: readonly number[]): number[] {
  return [...days].sort((left, right) => left - right);
}

function parseWeekendValue(value: unknown): number[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const days: number[] = [];
  for (const entry of value) {
    if (typeof entry !== 'number' || !Number.isInteger(entry) || entry < 1 || entry > 7) {
      return null;
    }
    if (days.includes(entry)) {
      return null;
    }
    days.push(entry);
  }
  if (days.length < 1 || days.length > 3) {
    return null;
  }
  return normalizeWeekendDays(days);
}

/* -------------------------------------------------------------------------
 * Boot snapshot (versioned envelope, `v: 1`)
 * ---------------------------------------------------------------------- */

export function snapshotFrom(settings: LocalizationSettings): LocalizationSnapshot {
  return {
    v: 1,
    defaultLocale: settings.defaultLocale,
    defaultDirection: settings.defaultDirection,
    defaultTheme: settings.defaultTheme,
    timezone: settings.timezone,
    weekendDays: [...settings.weekendDays],
    updatedAt: settings.updatedAt,
  };
}

export function settingsFromSnapshot(snapshot: LocalizationSnapshot): LocalizationSettings {
  return {
    defaultLocale: snapshot.defaultLocale,
    defaultDirection: snapshot.defaultDirection,
    defaultTheme: snapshot.defaultTheme,
    timezone: snapshot.timezone,
    weekendDays: [...snapshot.weekendDays],
    updatedAt: snapshot.updatedAt,
  };
}

export function readStoredSnapshot(): LocalizationSnapshot | null {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(LOCALIZATION_STORAGE_KEY);
    if (raw === null) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.v !== 1) {
      return null;
    }
    const weekendDays = parseWeekendValue(parsed.weekendDays);
    if (
      !isSupportedLocale(parsed.defaultLocale) ||
      !isDirection(parsed.defaultDirection) ||
      !isDefaultTheme(parsed.defaultTheme) ||
      typeof parsed.timezone !== 'string' ||
      parsed.timezone.trim() === '' ||
      typeof parsed.updatedAt !== 'string' ||
      weekendDays === null
    ) {
      return null;
    }
    return {
      v: 1,
      defaultLocale: parsed.defaultLocale,
      defaultDirection: parsed.defaultDirection,
      defaultTheme: parsed.defaultTheme,
      timezone: parsed.timezone,
      weekendDays,
      updatedAt: parsed.updatedAt,
    };
  } catch {
    return null;
  }
}

export function writeStoredSnapshot(snapshot: LocalizationSnapshot): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.localStorage.setItem(LOCALIZATION_STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // Storage blocked: in-memory defaults still apply for this session.
  }
}

/** Snapshot (when valid) as settings, otherwise the build-neutral fallback. */
export function settingsFromStoredSnapshot(): LocalizationSettings {
  const snapshot = readStoredSnapshot();
  if (snapshot === null) {
    return fallbackLocalization();
  }
  return settingsFromSnapshot(snapshot);
}

/* -------------------------------------------------------------------------
 * Row / RPC response parsing (defensive: anything malformed is skipped)
 * ---------------------------------------------------------------------- */

type MutableLocalizationSettings = {
  -readonly [K in keyof LocalizationSettings]: LocalizationSettings[K];
};

/**
 * Parse `app_settings` rows for the appearance group. Each key is validated
 * independently; returns `null` when not a single managed key is recognizable
 * so callers fall back to the snapshot instead of caching garbage.
 */
export function parseLocalizationRows(rows: unknown): LocalizationSettings | null {
  if (!Array.isArray(rows)) {
    return null;
  }

  const result: MutableLocalizationSettings = { ...fallbackLocalization() };
  let matched = 0;
  let maxUpdatedAt: string | null = null;

  for (const row of rows) {
    if (!isRecord(row) || row.is_public !== true || typeof row.key !== 'string') {
      continue;
    }
    if (typeof row.updated_at === 'string' && row.updated_at !== '') {
      if (maxUpdatedAt === null || row.updated_at > maxUpdatedAt) {
        maxUpdatedAt = row.updated_at;
      }
    }

    switch (row.key) {
      case SETTING_KEY.defaultLocale:
        if (isSupportedLocale(row.value)) {
          result.defaultLocale = row.value;
          matched += 1;
        }
        break;
      case SETTING_KEY.defaultDirection:
        if (isDirection(row.value)) {
          result.defaultDirection = row.value;
          matched += 1;
        }
        break;
      case SETTING_KEY.defaultTheme:
        if (isDefaultTheme(row.value)) {
          result.defaultTheme = row.value;
          matched += 1;
        }
        break;
      case SETTING_KEY.defaultTimezone:
        if (typeof row.value === 'string' && row.value.trim() !== '') {
          result.timezone = row.value.trim();
          matched += 1;
        }
        break;
      case SETTING_KEY.weekendDays: {
        const weekendDays = parseWeekendValue(row.value);
        if (weekendDays !== null) {
          result.weekendDays = weekendDays;
          matched += 1;
        }
        break;
      }
      default:
        break;
    }
  }

  if (matched === 0) {
    return null;
  }
  result.updatedAt = maxUpdatedAt ?? result.updatedAt;
  return result;
}

/** Parse the snapshot returned by `admin_update_appearance_settings`. */
export function parseLocalizationResponse(value: unknown): LocalizationSettings | null {
  if (!isRecord(value)) {
    return null;
  }
  const weekendDays = parseWeekendValue(value.weekend_days);
  if (
    !isSupportedLocale(value.default_locale) ||
    !isDirection(value.default_direction) ||
    !isDefaultTheme(value.default_theme) ||
    typeof value.default_timezone !== 'string' ||
    value.default_timezone.trim() === '' ||
    typeof value.updated_at !== 'string' ||
    value.updated_at === '' ||
    weekendDays === null
  ) {
    return null;
  }
  return {
    defaultLocale: value.default_locale,
    defaultDirection: value.default_direction,
    defaultTheme: value.default_theme,
    timezone: value.default_timezone.trim(),
    weekendDays,
    updatedAt: value.updated_at,
  };
}

/* -------------------------------------------------------------------------
 * Explicit-vs-inherited preference envelopes
 * ---------------------------------------------------------------------- */

export type PreferenceSource = 'explicit' | 'default';

export interface StoredPreference<T extends string> {
  readonly v: 2;
  readonly value: T;
  readonly source: PreferenceSource;
}

/**
 * Read a per-preference storage entry.
 * * `null` → no stored preference (inherit the system default).
 * * Raw legacy string passing `guard` → `{ v: 2, value, source: 'explicit' }`.
 * * JSON envelope `{ v: 2, value, source }` → honoured as written.
 * * Anything else (corrupt, unknown value) → `null`.
 */
export function readStoredPreference<T extends string>(
  raw: string | null,
  guard: (value: unknown) => value is T,
): StoredPreference<T> | null {
  if (raw === null) {
    return null;
  }
  if (guard(raw)) {
    return { v: 2, value: raw, source: 'explicit' };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed) && parsed.v === 2 && guard(parsed.value)) {
      return {
        v: 2,
        value: parsed.value,
        source: parsed.source === 'default' ? 'default' : 'explicit',
      };
    }
  } catch {
    // Corrupt entry: treat as absent.
  }
  return null;
}

/**
 * Explicit choices persist in the legacy raw format — one raw string IS the
 * `source: 'explicit'` envelope at version 2's minimal encoding, keeping the
 * storage contract stable for existing visitors and the boot script.
 */
export function serializeExplicitPreference(value: string): string {
  return value;
}
