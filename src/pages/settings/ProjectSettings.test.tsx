import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AuthCapabilitiesModule from '@/hooks/useAuthCapabilities';
import type * as ClassificationsModule from '@/hooks/useClassifications';
import type * as FiscalSettingsModule from '@/hooks/useFiscalSettings';
import type * as PartiesModule from '@/hooks/useParties';
import type * as SisterCompaniesModule from '@/hooks/useSisterCompanies';
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

/* The General tab now mounts the fiscal-settings subtabs. Keep this shell test
   focused on tab wiring; dedicated fiscal-settings tests cover its workflows. */
vi.mock('@/hooks/useFiscalSettings', async (importOriginal) => {
  const actual = await importOriginal<typeof FiscalSettingsModule>();
  return {
    ...actual,
    useFiscalYears: () => ({
      isLoading: false,
      isError: false,
      isSuccess: true,
      data: [],
      error: null,
      refetch: vi.fn(),
    }),
    useFiscalMonths: () => ({
      isLoading: false,
      isError: false,
      isSuccess: true,
      data: [],
      error: null,
      refetch: vi.fn(),
    }),
    useCreateFiscalYear: () => ({ isPending: false, mutateAsync: vi.fn() }),
    useActivateFiscalYear: () => ({ isPending: false, mutateAsync: vi.fn() }),
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

/* The parties tab reads the directory on mount; stub it for the same reason
   as the other two tabs — this test asserts the shell's wiring. */
vi.mock('@/hooks/useParties', async (importOriginal) => {
  const actual = await importOriginal<typeof PartiesModule>();
  return {
    ...actual,
    useParties: () => ({
      isLoading: false,
      isError: false,
      isSuccess: true,
      data: [
        {
          id: 'p1',
          branch: 'inbound',
          code: 'IN-001',
          name: 'شركة النيل للتوريدات الصناعية',
          isActive: true,
        },
      ],
      error: null,
      refetch: vi.fn(),
    }),
  };
});

/* The sister-companies tab reads its tree on mount; stub it for the same
   reason as the other three — this test asserts the shell's wiring. */
vi.mock('@/hooks/useSisterCompanies', async (importOriginal) => {
  const actual = await importOriginal<typeof SisterCompaniesModule>();
  return {
    ...actual,
    useSisterCompanies: () => ({
      isLoading: false,
      isError: false,
      isSuccess: true,
      data: [
        {
          id: 'sc1',
          parentId: null,
          level: 1,
          code: 'SIS-001',
          name: 'الشركة المتحدة للخدمات اللوجستية',
          isActive: true,
          branches: [
            {
              id: 'sc1-1',
              parentId: 'sc1',
              level: 2,
              code: 'SIS-001-01',
              name: 'المتحدة للنقل الثقيل',
              isActive: true,
              branches: [],
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

  it('renders the project settings shell with five tabs in the specified order', () => {
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
    expect(tabs).toHaveLength(5);
    expect(tabs[0]?.textContent).toBe('المحطات والمخازن');
    expect(tabs[1]?.textContent).toBe('التصنيفات');
    expect(tabs[2]?.textContent).toBe('جهات الوارد وأغراض الصرف');
    /* Sister companies is a top-level tab of its own, ahead of General. */
    expect(tabs[3]?.textContent).toBe('الشركات الشقيقة');
    expect(tabs[4]?.textContent).toBe('عام');

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
    expect(tabs[2]?.getAttribute('aria-selected')).toBe('true');
    // The parties tab now renders the live two-root tree, not the placeholder.
    expect(screen.getByText('شركة النيل للتوريدات الصناعية')).toBeTruthy();
    expect(screen.getByText('IN-001')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'إضافة جهة داخل «جهات الوارد»' })).toBeTruthy();
    /* The roots replace the old sub-tab strip entirely. */
    expect(screen.queryAllByRole('tab')).toHaveLength(5);
    // Only the active panel is mounted, so the classifications tree is gone.
    expect(screen.queryByText('المواد والمستلزمات')).toBeNull();

    // The sister-companies tab opens the tree directly, with no sub-tabs.
    fireEvent.click(tabs[3]!);
    expect(tabs[3]?.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('heading', { name: 'شجرة الشركات الشقيقة' })).toBeTruthy();
    expect(screen.getByText('SIS-001', { exact: true })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'شركات شقيقة' })).toBeNull();
    expect(screen.queryByRole('tablist', { name: 'الشركات الشقيقة' })).toBeNull();
    // …and the parties tree left with its panel.
    expect(screen.queryByText('IN-001')).toBeNull();

    fireEvent.click(tabs[4]!);
    expect(screen.getByRole('tablist', { name: 'الضبط المالي' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'الضبط السنوي' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'الضبط الدوري' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'أرصدة أول المدة' })).toBeTruthy();
    expect(screen.queryByText('محتوى الإعدادات العامة قيد الإنشاء')).toBeNull();

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
