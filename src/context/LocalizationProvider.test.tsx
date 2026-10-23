import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalizationProvider, useLocalization } from '@/context/LocalizationProvider';
import { THEME_STORAGE_KEY, ThemeProvider, useTheme } from '@/context/ThemeContext';
import { I18nProvider, LOCALE_STORAGE_KEY, useI18n } from '@/i18n/I18nContext';
import { LOCALIZATION_QUERY_KEY, LOCALIZATION_STORAGE_KEY } from '@/lib/localization';

const { from, channel, state } = vi.hoisted(() => {
  const from = vi.fn();
  const channel = {
    on: vi.fn().mockReturnThis(),
    subscribe: vi.fn().mockReturnThis(),
  };
  const state = { configured: true };
  return { from, channel, state };
});

vi.mock('@/lib/supabase', () => ({
  getSupabase: () =>
    state.configured
      ? {
          from,
          channel: vi.fn(() => channel),
          removeChannel: vi.fn(),
        }
      : null,
}));

function appearanceRows(overrides: Partial<Record<string, unknown>> = {}) {
  const row = (key: string, value: unknown) => ({
    key,
    value,
    is_public: true,
    updated_at: '2026-10-02T08:00:00Z',
  });
  return [
    row('appearance.default_locale', overrides.locale ?? 'en'),
    row('appearance.default_direction', overrides.direction ?? 'ltr'),
    row('appearance.default_theme', overrides.theme ?? 'dark'),
    row('appearance.default_timezone', overrides.timezone ?? 'Asia/Riyadh'),
    row('appearance.weekend_days', overrides.weekend ?? [5, 6]),
  ];
}

function mockRows(rows: unknown[]) {
  from.mockReturnValue({
    select: () => ({
      eq: () => Promise.resolve({ data: rows, error: null }),
    }),
  });
}

function DefaultsProbe() {
  const { settings } = useLocalization();
  return (
    <div>
      <span data-testid="locale">{settings.defaultLocale}</span>
      <span data-testid="theme">{settings.defaultTheme}</span>
      <span data-testid="timezone">{settings.timezone}</span>
      <span data-testid="weekend">{settings.weekendDays.join(',')}</span>
    </div>
  );
}

function CascadeProbe() {
  const { settings } = useLocalization();
  const { locale, dir, isExplicit: localeExplicit } = useI18n();
  const { theme, resolvedTheme, isExplicit: themeExplicit } = useTheme();
  return (
    <div>
      <span data-testid="settings-locale">{settings.defaultLocale}</span>
      <span data-testid="locale">{locale}</span>
      <span data-testid="dir">{dir}</span>
      <span data-testid="locale-explicit">{String(localeExplicit)}</span>
      <span data-testid="theme">{theme}</span>
      <span data-testid="resolved">{resolvedTheme}</span>
      <span data-testid="theme-explicit">{String(themeExplicit)}</span>
    </div>
  );
}

/** Mirrors the App composition: defaults flow into theme + i18n providers. */
function ThemeCascadeBridge({ probe }: { probe: ReactNode }) {
  const { settings } = useLocalization();
  return (
    <ThemeProvider defaultTheme={settings.defaultTheme}>
      <I18nProvider defaultLocale={settings.defaultLocale}>{probe}</I18nProvider>
    </ThemeProvider>
  );
}

function newClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderProvider(client: QueryClient, probe: ReactNode) {
  return render(
    <QueryClientProvider client={client}>
      <LocalizationProvider>
        <ThemeCascadeBridge probe={probe} />
      </LocalizationProvider>
    </QueryClientProvider>,
  );
}

describe('LocalizationProvider', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.lang = 'ar';
    document.documentElement.dir = 'rtl';
    document.documentElement.classList.remove('dark');
    state.configured = true;
    from.mockReset();
    channel.on.mockClear();
    channel.subscribe.mockClear();
  });

  it('loads the appearance group, exposes it and writes the boot snapshot', async () => {
    mockRows(appearanceRows());
    renderProvider(newClient(), <DefaultsProbe />);

    await waitFor(() => expect(screen.getByTestId('locale').textContent).toBe('en'));
    expect(screen.getByTestId('theme').textContent).toBe('dark');
    expect(screen.getByTestId('timezone').textContent).toBe('Asia/Riyadh');
    expect(screen.getByTestId('weekend').textContent).toBe('5,6');

    const snapshot = window.localStorage.getItem(LOCALIZATION_STORAGE_KEY);
    expect(snapshot).toContain('Asia/Riyadh');
    expect(snapshot).toContain('"v":1');
  });

  it('subscribes to realtime as an invalidation signal only', async () => {
    mockRows(appearanceRows());
    renderProvider(newClient(), <DefaultsProbe />);
    await screen.findByTestId('locale');

    expect(channel.on).toHaveBeenCalled();
    const args = channel.on.mock.calls[0] as unknown as [
      string,
      { table?: string; filter?: string },
      unknown,
    ];
    expect(args[0]).toBe('postgres_changes');
    expect(args[1]?.table).toBe('app_settings');
    expect(args[1]?.filter).toBe('group_slug=eq.appearance');
  });

  it('falls back to build-neutral defaults without a configured client', async () => {
    state.configured = false;
    renderProvider(newClient(), <DefaultsProbe />);
    await waitFor(() => expect(screen.getByTestId('locale').textContent).toBe('ar'));
    expect(screen.getByTestId('theme').textContent).toBe('system');
  });

  it('applies fetched defaults to <html> for visitors without explicit choices', async () => {
    mockRows(appearanceRows());
    renderProvider(newClient(), <CascadeProbe />);

    await waitFor(() => expect(screen.getByTestId('locale').textContent).toBe('en'));
    expect(screen.getByTestId('locale-explicit').textContent).toBe('false');
    expect(screen.getByTestId('dir').textContent).toBe('ltr');
    expect(document.documentElement.lang).toBe('en');
    expect(document.documentElement.dir).toBe('ltr');
    expect(screen.getByTestId('resolved').textContent).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    // Defaults are never force-reserved in localStorage.
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBeNull();
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it('keeps explicit user choices above changed system defaults', async () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'ar');
    window.localStorage.setItem(THEME_STORAGE_KEY, 'light');
    mockRows(appearanceRows({ locale: 'en', direction: 'ltr', theme: 'dark' }));
    renderProvider(newClient(), <CascadeProbe />);

    await waitFor(() => expect(screen.getByTestId('settings-locale').textContent).toBe('en'));
    expect(screen.getByTestId('locale').textContent).toBe('ar');
    expect(screen.getByTestId('locale-explicit').textContent).toBe('true');
    expect(document.documentElement.lang).toBe('ar');
    expect(document.documentElement.dir).toBe('rtl');
    expect(screen.getByTestId('theme').textContent).toBe('light');
    expect(screen.getByTestId('resolved').textContent).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('follows later default changes after a Realtime-style invalidation', async () => {
    mockRows(appearanceRows({ locale: 'ar', direction: 'rtl', theme: 'light' }));
    const client = newClient();
    renderProvider(client, <CascadeProbe />);
    await waitFor(() => expect(screen.getByTestId('locale').textContent).toBe('ar'));
    expect(document.documentElement.dir).toBe('rtl');

    // The admin changed the defaults elsewhere; Realtime fires, the provider
    // invalidates, the refetch returns the new rows, the cascade re-applies.
    mockRows(appearanceRows({ locale: 'en', direction: 'ltr', theme: 'dark' }));
    act(() => {
      void client.invalidateQueries({ queryKey: LOCALIZATION_QUERY_KEY });
    });

    await waitFor(() => expect(screen.getByTestId('locale').textContent).toBe('en'));
    expect(document.documentElement.lang).toBe('en');
    expect(document.documentElement.dir).toBe('ltr');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });
});
