import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider, LOCALE_STORAGE_KEY } from '@/i18n/I18nContext';
import {
  fallbackLocalization,
  type LocalizationSettings as SettingsShape,
} from '@/lib/localization';
import LocalizationSettings from '@/pages/settings/LocalizationSettings';
import { useLocalizationAdmin, type LocalizationAdminApi } from '@/hooks/useLocalizationAdmin';
import type * as LocalizationModule from '@/hooks/useLocalizationAdmin';

vi.mock('@/hooks/useLocalizationAdmin', async (importOriginal) => ({
  ...(await importOriginal<typeof LocalizationModule>()),
  useLocalizationAdmin: vi.fn(),
}));

function settings(): SettingsShape {
  return { ...fallbackLocalization(), timezone: 'Europe/Paris', weekendDays: [6, 7] };
}

function renderScreen(overrides: Partial<LocalizationAdminApi> = {}) {
  const current = settings();
  vi.mocked(useLocalizationAdmin).mockReturnValue({
    settings: current,
    canManage: true,
    isAccessLoading: false,
    isSaving: false,
    configured: true,
    refresh: vi.fn(),
    save: vi.fn(() => Promise.resolve({ ok: true as const, settings: current })),
    ...overrides,
  });
  return render(
    <I18nProvider>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <MemoryRouter>
          <LocalizationSettings />
        </MemoryRouter>
      </QueryClientProvider>
    </I18nProvider>,
  );
}

describe('LocalizationSettings', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'ar');
    document.documentElement.lang = 'ar';
    document.documentElement.dir = 'rtl';
  });

  it('renders language/theme selects, the timezone picker, weekend checkboxes and a container-query root', () => {
    const { container } = renderScreen();

    expect(screen.getByLabelText('لغة الواجهة الافتراضية')).toBeTruthy();
    expect(screen.getByLabelText('المظهر الافتراضي')).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'المنطقة الزمنية' })).toBeTruthy();
    expect(screen.getByLabelText('السبت')).toBeTruthy();
    expect(screen.getByLabelText('الأحد')).toBeTruthy();
    expect(screen.getByLabelText('الاثنين')).toBeTruthy();
    expect(container.querySelector('[class~="@container"]')).not.toBeNull();

    const save = screen.getByRole('button', { name: 'حفظ التغييرات' });
    expect((save as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows a 403 panel when the caller cannot manage appearance settings', () => {
    renderScreen({ canManage: false });
    expect(screen.getByText('403')).toBeTruthy();
    expect(screen.getByRole('heading', { name: /الوصول مرفوض/ })).toBeTruthy();
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('keeps save disabled until the draft is dirty, then opens the confirm dialog with a diff summary', () => {
    renderScreen();
    const save = screen.getByRole('button', { name: 'حفظ التغييرات' });
    expect((save as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('المظهر الافتراضي'), { target: { value: 'dark' } });
    expect((save as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(save);
    expect(screen.getByRole('dialog', { name: 'تأكيد حفظ الإعدادات الإقليمية' })).toBeTruthy();
    expect(screen.getByText('تغيير المظهر الافتراضي')).toBeTruthy();
  });

  it('blocks saving and warns when the weekend selection becomes invalid', () => {
    renderScreen();
    fireEvent.click(screen.getByLabelText('السبت'));
    fireEvent.click(screen.getByLabelText('الأحد'));

    expect(
      screen.getByRole('alert') && screen.getByText('يجب اختيار يوم إلى ثلاثة أيام عطلة.'),
    ).toBeTruthy();
    // Changing the theme makes the draft dirty, yet the invalid weekend keeps save locked.
    fireEvent.change(screen.getByLabelText('المظهر الافتراضي'), { target: { value: 'dark' } });
    const save = screen.getByRole('button', { name: 'حفظ التغييرات' });
    expect((save as HTMLButtonElement).disabled).toBe(true);
  });
});
