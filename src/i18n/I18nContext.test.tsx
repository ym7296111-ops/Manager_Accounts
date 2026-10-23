import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { ar, type TranslationKey } from '@/i18n/locales/ar';
import { en } from '@/i18n/locales/en';
import { I18nProvider, LOCALE_STORAGE_KEY, useI18n } from '@/i18n/I18nContext';

function placeholders(value: string): string[] {
  const names = [...value.matchAll(/\{(\w+)\}/g)]
    .map((match) => match[1])
    .filter((name): name is string => name !== undefined);
  return [...new Set(names)].sort();
}

describe('bilingual dictionary audit', () => {
  it('has identical, non-empty Arabic and English keys, including all three settings screens', () => {
    const keys = Object.keys(ar) as TranslationKey[];
    expect(Object.keys(en).sort()).toEqual([...keys].sort());
    for (const prefix of ['users.', 'roles.', 'backup.']) {
      expect(keys.some((key) => key.startsWith(prefix))).toBe(true);
    }
    for (const key of keys) {
      expect(ar[key].trim(), `Arabic: ${key}`).not.toBe('');
      expect(en[key].trim(), `English: ${key}`).not.toBe('');
    }
  });

  it('keeps interpolation variables in parity across both locales', () => {
    for (const key of Object.keys(ar) as TranslationKey[]) {
      expect(placeholders(en[key]), key).toEqual(placeholders(ar[key]));
    }
  });
});

describe('i18n runtime audit', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.lang = 'ar';
    document.documentElement.dir = 'rtl';
  });

  it('resolves every key in both languages without returning a missing-key fallback', () => {
    const { result } = renderHook(() => useI18n(), { wrapper: I18nProvider });
    for (const key of Object.keys(ar) as TranslationKey[]) {
      expect(result.current.t(key), key).toBe(ar[key]);
      expect(result.current.t(key), key).not.toBe(key);
    }
    act(() => result.current.setLocale('en'));
    for (const key of Object.keys(ar) as TranslationKey[]) {
      expect(result.current.t(key), key).toBe(en[key]);
      expect(result.current.t(key), key).not.toBe(key);
    }
  });

  it('restores the saved locale and synchronizes language, direction and interpolation', () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'en');
    const { result } = renderHook(() => useI18n(), { wrapper: I18nProvider });
    expect(result.current.locale).toBe('en');
    expect(document.documentElement.lang).toBe('en');
    expect(document.documentElement.dir).toBe('ltr');
    expect(result.current.t('users.count', { count: 3 })).toBe('Users: 3');
    act(() => result.current.setLocale('ar'));
    expect(document.documentElement.lang).toBe('ar');
    expect(document.documentElement.dir).toBe('rtl');
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('ar');
    expect(result.current.t('users.count', { count: 3 })).toBe(
      ar['users.count'].replace('{count}', '3'),
    );
  });
});
