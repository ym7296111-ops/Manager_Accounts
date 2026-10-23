import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider, LOCALE_STORAGE_KEY } from '@/i18n/I18nContext';
import { fallbackIdentity } from '@/lib/branding';
import GeneralSettings from '@/pages/settings/GeneralSettings';
import { useAppIdentityAdmin, type AppIdentityAdminApi } from '@/hooks/useAppIdentity';
import type * as IdentityModule from '@/hooks/useAppIdentity';

vi.mock('@/hooks/useAppIdentity', async (importOriginal) => ({
  ...(await importOriginal<typeof IdentityModule>()),
  useAppIdentityAdmin: vi.fn(),
}));

function renderScreen(overrides: Partial<AppIdentityAdminApi> = {}) {
  const identity = fallbackIdentity();
  vi.mocked(useAppIdentityAdmin).mockReturnValue({
    identity,
    logoUrl: null,
    faviconUrl: null,
    displayName: identity.nameAr,
    canManage: true,
    isIdentityLoading: false,
    isAccessLoading: false,
    isSaving: false,
    configured: true,
    refresh: vi.fn(),
    save: vi.fn(() => Promise.resolve({ ok: true as const, identity })),
    ...overrides,
  });
  return render(
    <I18nProvider>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <MemoryRouter>
          <GeneralSettings />
        </MemoryRouter>
      </QueryClientProvider>
    </I18nProvider>,
  );
}

describe('GeneralSettings', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'ar');
    document.documentElement.lang = 'ar';
    document.documentElement.dir = 'rtl';
  });

  it('renders bilingual fields, dropzones and a container-query root', () => {
    const { container } = renderScreen();
    expect(screen.getByLabelText('اسم التطبيق بالعربية')).toBeTruthy();
    expect(screen.getByLabelText('اسم التطبيق بالإنجليزية')).toBeTruthy();
    expect(screen.getByLabelText('البريد الإلكتروني الإداري')).toBeTruthy();
    expect(screen.getByText('شعار التطبيق')).toBeTruthy();
    expect(screen.getByText('أيقونة الموقع (Favicon)')).toBeTruthy();
    expect(container.querySelector('[class~="@container"]')).not.toBeNull();
  });

  it('shows a 403 panel when the caller cannot manage identity', () => {
    renderScreen({ canManage: false });
    expect(screen.getByText('403')).toBeTruthy();
    expect(screen.getByRole('heading', { name: /الوصول مرفوض/ })).toBeTruthy();
    expect(screen.queryByLabelText('اسم التطبيق بالعربية')).toBeNull();
  });

  it('keeps save disabled until the draft is dirty, then opens a confirm dialog', () => {
    renderScreen();
    const save = screen.getByRole('button', { name: 'حفظ التغييرات' });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('اسم التطبيق بالعربية'), {
      target: { value: 'هوية جديدة' },
    });
    expect((save as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(save);
    expect(screen.getByRole('dialog', { name: 'تأكيد حفظ الهوية' })).toBeTruthy();
  });
});
