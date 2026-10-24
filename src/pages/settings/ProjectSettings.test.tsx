import { fireEvent, render, screen } from '@testing-library/react';
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

  it('renders the project settings shell with four tabs in the specified order', () => {
    renderScreen();

    expect(screen.getByRole('heading', { name: 'ضبط المشروع' })).toBeTruthy();
    // Header description stays
    expect(screen.getByText('هوية المشروع وبيانات المسؤول والشعار وأيقونة المتصفح.')).toBeTruthy();

    const tablist = screen.getByRole('tablist');
    expect(tablist).toBeTruthy();

    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(4);
    expect(tabs[0]?.textContent).toBe('المحطات والمخازن');
    expect(tabs[1]?.textContent).toBe('التصنيفات');
    expect(tabs[2]?.textContent).toBe('جهات الوارد والمنصرف');
    expect(tabs[3]?.textContent).toBe('عام');

    // First tab is active by default, its panel is visible
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('محتوى المحطات والمخازن قيد الإنشاء')).toBeTruthy();

    // No form fields in shell
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('form')).toBeNull();
  });

  it('switches tab panels on click', () => {
    renderScreen();

    const tabs = screen.getAllByRole('tab');

    expect(screen.getByText('محتوى المحطات والمخازن قيد الإنشاء')).toBeTruthy();

    fireEvent.click(tabs[1]!);
    expect(screen.getByText('محتوى التصنيفات قيد الإنشاء')).toBeTruthy();
    expect(tabs[1]?.getAttribute('aria-selected')).toBe('true');

    fireEvent.click(tabs[2]!);
    expect(screen.getByText('محتوى جهات الوارد والمنصرف قيد الإنشاء')).toBeTruthy();

    fireEvent.click(tabs[3]!);
    expect(screen.getByText('محتوى الإعدادات العامة قيد الإنشاء')).toBeTruthy();

    fireEvent.click(tabs[0]!);
    expect(screen.getByText('محتوى المحطات والمخازن قيد الإنشاء')).toBeTruthy();
  });

  it('returns 403 to an admin without project.settings:manage', () => {
    capabilityState.capabilities = ['dashboard.view', 'settings.manage'];

    renderScreen();

    expect(screen.getByRole('alert').textContent).toContain('403');
    expect(screen.getByRole('heading', { name: /الوصول مرفوض/ })).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('tablist')).toBeNull();
  });

  it('does not render any form fields or queries', () => {
    renderScreen();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('form')).toBeNull();
    // Tabs are buttons, not inputs
    expect(screen.queryByRole('tablist')).toBeTruthy();
  });
});
