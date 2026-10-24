import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AuthCapabilitiesModule from '@/hooks/useAuthCapabilities';
import type * as ClassificationsModule from '@/hooks/useClassifications';
import type * as StationsDirectoryModule from '@/hooks/useStationsDirectory';
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

/* The stations tab issues a real nested query; stub it so this test asserts the
   shell's wiring rather than the transport layer. */
vi.mock('@/hooks/useStationsDirectory', async (importOriginal) => {
  const actual = await importOriginal<typeof StationsDirectoryModule>();
  return {
    ...actual,
    useStationsDirectory: () => ({
      isLoading: false,
      isError: false,
      isSuccess: true,
      data: [
        {
          id: 's1',
          code: 'ST-01',
          name: 'المحطة الرئيسية',
          isActive: true,
          warehouses: [{ id: 'w1', code: 'WH-001', name: 'مخزن المواد الخام', isActive: true }],
        },
      ],
      error: null,
      refetch: vi.fn(),
    }),
  };
});

/* The classifications tab reads the tree on mount; stub it for the same reason
   as the stations directory — this test asserts the shell's wiring. */
vi.mock('@/hooks/useClassifications', async (importOriginal) => {
  const actual = await importOriginal<typeof ClassificationsModule>();
  return {
    ...actual,
    useClassifications: () => ({
      isLoading: false,
      isError: false,
      isSuccess: true,
      data: [
        {
          id: 'c1',
          code: 'CLS-001',
          name: 'المواد والمستلزمات',
          level: 1,
          isLeaf: false,
          isActive: true,
          children: [
            {
              id: 'g1',
              code: 'CLS-002',
              name: 'المواد الخام',
              level: 2,
              isLeaf: true,
              isActive: true,
              children: [],
            },
          ],
        },
      ],
      error: null,
      refetch: vi.fn(),
    }),
  };
});

function renderScreen() {
  /* The stations tab mounts real mutation hooks, which need a QueryClient even
     though the directory query itself is stubbed below. */
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <MemoryRouter initialEntries={['/settings/project']}>
          <ProjectSettings />
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
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
    // Header description: master-data copy (no identity/branding language).
    expect(
      screen.getByText(
        'إدارة البيانات الأساسية للمشروع: المحطات والمخازن، التصنيفات، الجهات، والإعدادات العامة.',
      ),
    ).toBeTruthy();

    const tablist = screen.getByRole('tablist');
    expect(tablist).toBeTruthy();

    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(4);
    expect(tabs[0]?.textContent).toBe('المحطات والمخازن');
    expect(tabs[1]?.textContent).toBe('التصنيفات');
    expect(tabs[2]?.textContent).toBe('جهات الوارد والمنصرف');
    expect(tabs[3]?.textContent).toBe('عام');

    // First tab is active by default, and it now renders the read-only accordion
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('المحطة الرئيسية')).toBeTruthy();
    expect(screen.getByText('ST-01')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'إضافة محطة' })).toBeTruthy();

    // No form fields in shell
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('form')).toBeNull();
  });

  it('switches tab panels on click', () => {
    renderScreen();

    const tabs = screen.getAllByRole('tab');

    expect(screen.getByText('المحطة الرئيسية')).toBeTruthy();

    fireEvent.click(tabs[1]!);
    expect(tabs[1]?.getAttribute('aria-selected')).toBe('true');
    // The classifications tab now renders the read-only tree, collapsed.
    expect(screen.getByRole('heading', { name: 'شجرة التصنيفات' })).toBeTruthy();
    expect(screen.getByText('المواد والمستلزمات')).toBeTruthy();
    expect(screen.getByText('CLS-001')).toBeTruthy();
    expect(screen.queryByText('المواد الخام')).toBeNull();
    // Only the active panel is mounted, so the stations directory is gone.
    expect(screen.queryByText('ST-01')).toBeNull();

    fireEvent.click(tabs[2]!);
    expect(screen.getByText('محتوى جهات الوارد والمنصرف قيد الإنشاء')).toBeTruthy();

    fireEvent.click(tabs[3]!);
    expect(screen.getByText('محتوى الإعدادات العامة قيد الإنشاء')).toBeTruthy();

    fireEvent.click(tabs[0]!);
    expect(screen.getByText('المحطة الرئيسية')).toBeTruthy();
    // Leaving and returning to the tab does not resurrect the old placeholder.
    expect(screen.queryByText('محتوى المحطات والمخازن قيد الإنشاء')).toBeNull();
    // …and the classifications tree is unmounted with its panel.
    expect(screen.queryByText('المواد والمستلزمات')).toBeNull();
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
