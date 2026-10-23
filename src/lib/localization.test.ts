import { beforeEach, describe, expect, it } from 'vitest';
import {
  DIRECTION_FOR_LOCALE,
  EPOCH_UPDATED_AT,
  LOCALIZATION_STORAGE_KEY,
  SETTING_KEY,
  browserTimezone,
  fallbackLocalization,
  isDefaultTheme,
  isDirection,
  isSupportedLocale,
  isValidWeekendSelection,
  normalizeWeekendDays,
  parseLocalizationResponse,
  parseLocalizationRows,
  readStoredPreference,
  readStoredSnapshot,
  serializeExplicitPreference,
  settingsFromStoredSnapshot,
  snapshotFrom,
  writeStoredSnapshot,
} from '@/lib/localization';

function publicRow(key: string, value: unknown, updatedAt = '2026-10-01T10:00:00Z') {
  return { key, value, is_public: true, updated_at: updatedAt };
}

function fullRows(overrides: Record<string, unknown> = {}) {
  return [
    publicRow(SETTING_KEY.defaultLocale, overrides.locale ?? 'ar'),
    publicRow(SETTING_KEY.defaultDirection, overrides.direction ?? 'rtl'),
    publicRow(SETTING_KEY.defaultTheme, overrides.theme ?? 'system'),
    publicRow(SETTING_KEY.defaultTimezone, overrides.timezone ?? 'Europe/Paris'),
    publicRow(SETTING_KEY.weekendDays, overrides.weekend ?? [6, 7]),
  ];
}

describe('localization guards', () => {
  it('accepts only the supported locales, directions and themes', () => {
    expect(isSupportedLocale('ar')).toBe(true);
    expect(isSupportedLocale('en')).toBe(true);
    expect(isSupportedLocale('fr')).toBe(false);
    expect(isSupportedLocale(42)).toBe(false);

    expect(isDirection('rtl')).toBe(true);
    expect(isDirection('ltr')).toBe(true);
    expect(isDirection('up')).toBe(false);

    expect(isDefaultTheme('light')).toBe(true);
    expect(isDefaultTheme('dark')).toBe(true);
    expect(isDefaultTheme('system')).toBe(true);
    expect(isDefaultTheme('auto')).toBe(false);
  });

  it('pairs every locale with the direction the server enforces', () => {
    expect(DIRECTION_FOR_LOCALE.ar).toBe('rtl');
    expect(DIRECTION_FOR_LOCALE.en).toBe('ltr');
  });

  it('validates weekend selections exactly like the RPC contract', () => {
    expect(isValidWeekendSelection([6, 7])).toBe(true);
    expect(isValidWeekendSelection([5])).toBe(true);
    expect(isValidWeekendSelection([5, 6, 7])).toBe(true);
    expect(isValidWeekendSelection([])).toBe(false);
    expect(isValidWeekendSelection([1, 2, 3, 4])).toBe(false);
    expect(isValidWeekendSelection([0])).toBe(false);
    expect(isValidWeekendSelection([8])).toBe(false);
    expect(isValidWeekendSelection([6, 6])).toBe(false);
    expect(isValidWeekendSelection([6.5])).toBe(false);
  });

  it('normalizes weekend days into ascending canonical order', () => {
    expect(normalizeWeekendDays([7, 5, 6])).toEqual([5, 6, 7]);
    expect(normalizeWeekendDays([])).toEqual([]);
  });

  it('derives a usable browser timezone without throwing', () => {
    expect(typeof browserTimezone()).toBe('string');
    expect(browserTimezone()).not.toBe('');
  });
});

describe('fallback defaults (cascade layer 3)', () => {
  it('match the build-neutral index.html contract and the DB seed shape', () => {
    const fallback = fallbackLocalization();
    expect(fallback.defaultLocale).toBe('ar');
    expect(fallback.defaultDirection).toBe('rtl');
    expect(fallback.defaultTheme).toBe('system');
    expect(fallback.weekendDays).toEqual([6, 7]);
    expect(fallback.timezone).not.toBe('');
    expect(fallback.updatedAt).toBe(EPOCH_UPDATED_AT);
  });
});

describe('row parsing (RLS-shaped app_settings rows)', () => {
  it('parses a complete public appearance group and takes max(updated_at)', () => {
    const rows = fullRows({
      locale: 'en',
      direction: 'ltr',
      theme: 'dark',
      timezone: 'Asia/Riyadh',
      weekend: [5, 6],
    });
    (rows[2] as { updated_at: string }).updated_at = '2026-10-02T09:30:00Z';

    const parsed = parseLocalizationRows(rows);
    expect(parsed).not.toBeNull();
    expect(parsed?.defaultLocale).toBe('en');
    expect(parsed?.defaultDirection).toBe('ltr');
    expect(parsed?.defaultTheme).toBe('dark');
    expect(parsed?.timezone).toBe('Asia/Riyadh');
    expect(parsed?.weekendDays).toEqual([5, 6]);
    expect(parsed?.updatedAt).toBe('2026-10-02T09:30:00Z');
  });

  it('keeps per-key fallbacks when individual values are malformed', () => {
    const rows = fullRows({ locale: 'fr', theme: 42, weekend: [9], timezone: '  ' });
    const parsed = parseLocalizationRows(rows);
    expect(parsed).not.toBeNull();
    expect(parsed?.defaultLocale).toBe('ar'); // invalid -> fallback
    expect(parsed?.defaultTheme).toBe('system'); // invalid -> fallback
    expect(parsed?.weekendDays).toEqual([6, 7]); // invalid -> fallback
    expect(parsed?.timezone).toBe(fallbackLocalization().timezone);
    expect(parsed?.defaultDirection).toBe('rtl'); // valid one survives
  });

  it('ignores private rows, foreign keys and non-array input', () => {
    const rows = [
      { key: SETTING_KEY.defaultLocale, value: 'en', is_public: false, updated_at: 'x' },
      { key: 'appearance.accent_color', value: 'indigo', is_public: true, updated_at: 'x' },
      { key: 12, value: 'ar', is_public: true, updated_at: 'x' },
    ];
    expect(parseLocalizationRows(rows)).toBeNull();
    expect(parseLocalizationRows('not-an-array')).toBeNull();
  });
});

describe('RPC response parsing', () => {
  it('parses the admin_update_appearance_settings snapshot', () => {
    const parsed = parseLocalizationResponse({
      default_locale: 'en',
      default_direction: 'ltr',
      default_theme: 'dark',
      default_timezone: 'Asia/Riyadh',
      weekend_days: [5, 6],
      updated_at: '2026-10-02T12:00:00Z',
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.defaultLocale).toBe('en');
    expect(parsed?.timezone).toBe('Asia/Riyadh');
    expect(parsed?.weekendDays).toEqual([5, 6]);
    expect(parsed?.updatedAt).toBe('2026-10-02T12:00:00Z');
  });

  it('rejects incomplete or malformed snapshots', () => {
    expect(parseLocalizationResponse(null)).toBeNull();
    expect(parseLocalizationResponse({ default_locale: 'en' })).toBeNull();
    expect(
      parseLocalizationResponse({
        default_locale: 'xx',
        default_direction: 'ltr',
        default_theme: 'dark',
        default_timezone: 'UTC',
        weekend_days: [6],
        updated_at: '2026-10-02T12:00:00Z',
      }),
    ).toBeNull();
  });
});

describe('boot snapshot envelope (v:1)', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('round-trips a snapshot and rejects wrong versions or corrupt JSON', () => {
    const settings = fallbackLocalization();
    writeStoredSnapshot(snapshotFrom(settings));
    const read = readStoredSnapshot();
    expect(read).not.toBeNull();
    expect(read?.defaultLocale).toBe(settings.defaultLocale);
    expect(read?.timezone).toBe(settings.timezone);

    window.localStorage.setItem(LOCALIZATION_STORAGE_KEY, '{"v":2}');
    expect(readStoredSnapshot()).toBeNull();

    window.localStorage.setItem(LOCALIZATION_STORAGE_KEY, '{corrupt');
    expect(readStoredSnapshot()).toBeNull();

    // Corrupt snapshot never poisons the cascade: fall back cleanly.
    expect(settingsFromStoredSnapshot().defaultLocale).toBe('ar');
  });

  it('validates every field of a hand-crafted snapshot', () => {
    window.localStorage.setItem(
      LOCALIZATION_STORAGE_KEY,
      JSON.stringify({
        v: 1,
        defaultLocale: 'ar',
        defaultDirection: 'rtl',
        defaultTheme: 'system',
        timezone: '',
        weekendDays: [6, 7],
        updatedAt: EPOCH_UPDATED_AT,
      }),
    );
    expect(readStoredSnapshot()).toBeNull();
  });
});

describe('explicit-vs-inherited preference envelopes', () => {
  const guard = isSupportedLocale;

  it('treats a raw legacy string as an explicit choice', () => {
    expect(readStoredPreference('en', guard)).toEqual({ v: 2, value: 'en', source: 'explicit' });
  });

  it('honours JSON envelopes with source attribution', () => {
    expect(
      readStoredPreference(JSON.stringify({ v: 2, value: 'ar', source: 'default' }), guard),
    ).toEqual({
      v: 2,
      value: 'ar',
      source: 'default',
    });
    expect(
      readStoredPreference(JSON.stringify({ v: 2, value: 'en', source: 'explicit' }), guard),
    ).toEqual({
      v: 2,
      value: 'en',
      source: 'explicit',
    });
  });

  it('returns null for absent, corrupt or out-of-vocabulary entries', () => {
    expect(readStoredPreference(null, guard)).toBeNull();
    expect(readStoredPreference('fr', guard)).toBeNull();
    expect(readStoredPreference('{corrupt', guard)).toBeNull();
    expect(readStoredPreference(JSON.stringify({ v: 3, value: 'ar' }), guard)).toBeNull();
  });

  it('serializes explicit choices in the legacy raw format', () => {
    expect(serializeExplicitPreference('dark')).toBe('dark');
  });
});
