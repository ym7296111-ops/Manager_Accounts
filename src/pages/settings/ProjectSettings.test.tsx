import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AuthCapabilitiesModule from '@/hooks/useAuthCapabilities';
import { I18nProvider } from '@/i18n/I18nContext';
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

function renderScreen() {
  return render(
    <I18nProvider>
      <MemoryRouter initialEntries={['/settings/project']}>
        <ProjectSettings />
      </MemoryRouter>
    </I18nProvider>,
  );
}

describe('ProjectSettings', () => {
  beforeEach(() => {
    capabilityState.capabilities = ['*'];
    window.localStorage.clear();
  });

  it('renders the project settings shell without any form fields', () => {
    renderScreen();

    expect(screen.getByRole('heading', { name: 'ضبط المشروع' })).toBeTruthy();
    expect(screen.getByText('لا توجد عناصر لعرضها بعد')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('form')).toBeNull();
    expect(screen.queryByLabelText('اسم التطبيق بالعربية')).toBeNull();
  });

  it('returns 403 to an admin without project.settings:manage', () => {
    capabilityState.capabilities = ['dashboard.view', 'settings.manage'];

    renderScreen();

    expect(screen.getByRole('alert').textContent).toContain('403');
    expect(screen.getByRole('heading', { name: /الوصول مرفوض/ })).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});
