import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AuthCapabilitiesModule from '@/hooks/useAuthCapabilities';
import type * as IdentityModule from '@/hooks/useAppIdentity';
import { useAppIdentityAdmin, type AppIdentityAdminApi } from '@/hooks/useAppIdentity';
import { I18nProvider } from '@/i18n/I18nContext';
import { fallbackIdentity } from '@/lib/branding';
import ProjectSettings from '@/pages/settings/ProjectSettings';

const capabilityState = vi.hoisted(() => ({
  capabilities: ['*'] as string[],
}));

vi.mock('@/hooks/useAuthCapabilities', async (importOriginal) => {
  const actual = await importOriginal<typeof AuthCapabilitiesModule>();
  return {
    ...actual,
    useAuthCapabilities: () => ({
      capabilities: capabilityState.capabilities,
      isAuthoritative: true,
      isLoading: false,
      configured: true,
      hasCapability: (slug: string) =>
        capabilityState.capabilities.includes('*') || capabilityState.capabilities.includes(slug),
      refetch: vi.fn(),
    }),
  };
});

vi.mock('@/hooks/useAppIdentity', async (importOriginal) => ({
  ...(await importOriginal<typeof IdentityModule>()),
  useAppIdentityAdmin: vi.fn(),
}));

function identityApi(): AppIdentityAdminApi {
  const identity = fallbackIdentity();
  return {
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
  };
}

function renderScreen() {
  return render(
    <I18nProvider>
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={['/settings/project']}>
          <ProjectSettings />
        </MemoryRouter>
      </QueryClientProvider>
    </I18nProvider>,
  );
}

describe('ProjectSettings', () => {
  beforeEach(() => {
    capabilityState.capabilities = ['*'];
    vi.mocked(useAppIdentityAdmin).mockReset().mockReturnValue(identityApi());
    window.localStorage.clear();
  });

  it('shows all six identity fields to an owner through the project-scoped hook', () => {
    renderScreen();

    expect(screen.getByRole('heading', { name: 'ضبط المشروع' })).toBeTruthy();
    expect(screen.getByLabelText('اسم التطبيق بالعربية')).toBeTruthy();
    expect(screen.getByLabelText('اسم التطبيق بالإنجليزية')).toBeTruthy();
    expect(screen.getByLabelText('البريد الإلكتروني الإداري')).toBeTruthy();
    expect(screen.getByLabelText('هاتف التواصل')).toBeTruthy();
    expect(screen.getByText('شعار التطبيق')).toBeTruthy();
    expect(screen.getByText('أيقونة الموقع (Favicon)')).toBeTruthy();
    expect(useAppIdentityAdmin).toHaveBeenCalledWith('project');
  });

  it('returns 403 to an admin with settings.manage but without project.settings:manage and never mounts the data hook', () => {
    capabilityState.capabilities = ['dashboard.view', 'settings.manage'];

    renderScreen();

    expect(screen.getByRole('alert').textContent).toContain('403');
    expect(screen.getByRole('heading', { name: /الوصول مرفوض/ })).toBeTruthy();
    expect(screen.queryByLabelText('اسم التطبيق بالعربية')).toBeNull();
    expect(useAppIdentityAdmin).not.toHaveBeenCalled();
  });
});
