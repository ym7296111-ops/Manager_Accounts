import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AuthCapabilitiesModule from '@/hooks/useAuthCapabilities';

const capabilityState = vi.hoisted(() => ({
  capabilities: [] as string[],
  isAuthoritative: false,
}));
vi.mock('@/hooks/useAuthCapabilities', async (importOriginal) => {
  const actual = await importOriginal<typeof AuthCapabilitiesModule>();
  return {
    ...actual,
    useAuthCapabilities: () => ({
      capabilities: capabilityState.capabilities,
      isAuthoritative: capabilityState.isAuthoritative,
      isLoading: false,
      configured: true,
      hasCapability: (slug: string) =>
        capabilityState.capabilities.includes('*') || capabilityState.capabilities.includes(slug),
    }),
  };
});
import { AuthProvider } from '@/context/AuthContext';
import { BrandingProvider } from '@/context/BrandingContext';
import { ThemeProvider } from '@/context/ThemeContext';
import { I18nProvider, LOCALE_STORAGE_KEY } from '@/i18n/I18nContext';
import DashboardLayout from '@/layouts/DashboardLayout';
import DashboardPage from '@/pages/DashboardPage';
import SettingsPage from '@/pages/SettingsPage';
import WorkspacePage from '@/pages/workspaces/WorkspacePage';

function renderLayout(initialPath = '/') {
  return render(
    <ThemeProvider>
      <I18nProvider>
        <AuthProvider>
          {/* Fresh cache per render: screens under SettingsPage use TanStack Query. */}
          <QueryClientProvider
            client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
          >
            <BrandingProvider>
              <MemoryRouter initialEntries={[initialPath]}>
                <Routes>
                  <Route element={<DashboardLayout />}>
                    <Route index element={<DashboardPage />} />
                    <Route path="workspaces/:workspaceSlug" element={<WorkspacePage />} />
                    <Route path="settings/:family/:section" element={<SettingsPage />} />
                  </Route>
                </Routes>
              </MemoryRouter>
            </BrandingProvider>
          </QueryClientProvider>
        </AuthProvider>
      </I18nProvider>
    </ThemeProvider>,
  );
}

/** Resolve the accordion panel a toggle controls (ids are useId()-prefixed). */
function panelOf(toggle: HTMLElement): HTMLElement | null {
  const id = toggle.getAttribute('aria-controls');
  return id === null ? null : document.getElementById(id);
}

function sidebar(): HTMLElement {
  const element = document.querySelector('aside');
  if (element === null) {
    throw new Error('Desktop sidebar <aside> not found');
  }
  return element;
}

describe('DashboardLayout (responsive shell + tree navigation)', () => {
  beforeEach(() => {
    capabilityState.capabilities = [];
    capabilityState.isAuthoritative = false;
    window.localStorage.clear();
    document.documentElement.classList.remove('dark');
    document.documentElement.lang = 'ar';
    document.documentElement.dir = 'rtl';
  });

  it('hides the desktop sidebar and mobile drawer for dashboard-only executive capability', () => {
    capabilityState.capabilities = ['dashboard:read'];
    capabilityState.isAuthoritative = true;
    renderLayout();
    expect(document.querySelector('aside')).toBeNull();
    expect(screen.queryByRole('button', { name: 'فتح القائمة' })).toBeNull();
    expect(screen.getByRole('button', { name: 'قائمة الحساب' })).toBeTruthy();
  });

  it('renders the required tree structure: dashboard, 3 workspaces, settings branches', () => {
    renderLayout();

    const nav = within(sidebar());

    /* Leaf: dashboard */
    expect(nav.getByRole('link', { name: 'الشاشة الرئيسية' })).toBeTruthy();

    /* Three workspace groups (each with an expand chevron) */
    expect(nav.getByRole('link', { name: 'APS' }).getAttribute('href')).toBe('/workspaces/aps');
    expect(nav.getByRole('link', { name: 'المنتج التام — ورش العاشر' }).getAttribute('href')).toBe(
      '/workspaces/workshops-10th',
    );
    expect(nav.getByRole('link', { name: 'التقارير والاستعلامات' }).getAttribute('href')).toBe(
      '/workspaces/reports',
    );

    /* Settings root group */
    expect(nav.getByRole('button', { name: 'الضبط والتحكم' })).toBeTruthy();
  });

  it('expands settings to system items, app items, and the final project-settings item', () => {
    renderLayout();
    const nav = within(sidebar());

    /* Collapsed by default: the panel is closed even though rows stay mounted
       for the CSS accordion transition (visibility handles a11y). */
    const settingsToggle = nav.getByRole('button', { name: 'الضبط والتحكم' });
    expect(settingsToggle.getAttribute('aria-expanded')).toBe('false');
    expect(panelOf(settingsToggle)?.getAttribute('data-open')).toBe('false');

    /* Level 1: الضبط والتحكم */
    fireEvent.click(settingsToggle);
    expect(settingsToggle.getAttribute('aria-expanded')).toBe('true');
    expect(panelOf(settingsToggle)?.getAttribute('data-open')).toBe('true');

    /* Level 2: the two sub-branches */
    expect(nav.getByRole('button', { name: 'ضبط النظام والمستخدمين' })).toBeTruthy();
    expect(nav.getByRole('button', { name: 'ضبط التطبيق' })).toBeTruthy();

    /* Level 3a: four system items */
    const systemToggle = nav.getByRole('button', { name: 'ضبط النظام والمستخدمين' });
    fireEvent.click(systemToggle);
    expect(nav.getByRole('link', { name: 'ضبط المستخدمين' })).toBeTruthy();
    expect(nav.getByRole('link', { name: 'الصلاحيات والأدوار' })).toBeTruthy();
    expect(nav.getByRole('link', { name: 'النسخ الاحتياطي' })).toBeTruthy();
    expect(nav.getByRole('link', { name: 'الدعم الفني' })).toBeTruthy();

    /* Level 3b: three app items */
    const appToggle = nav.getByRole('button', { name: 'ضبط التطبيق' });
    fireEvent.click(appToggle);
    expect(nav.getByRole('link', { name: 'الإعدادات الإدارية العامة' })).toBeTruthy();
    expect(nav.getByRole('link', { name: 'التحكم بالمظهر' })).toBeTruthy();
    expect(nav.getByRole('link', { name: 'التنبيهات' })).toBeTruthy();

    /* Direct final child of الضبط والتحكم, after both grouped branches. */
    expect(nav.getByRole('link', { name: 'ضبط المشروع' }).getAttribute('href')).toBe(
      '/settings/project',
    );
  });

  it('opens a workspace group into its empty, prepared state', () => {
    renderLayout();
    const nav = within(sidebar());

    const chevron = nav.getByRole('button', { name: 'فتح APS' });
    expect(chevron.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(chevron);

    expect(chevron.getAttribute('aria-expanded')).toBe('true');
    const panel = panelOf(chevron);
    expect(panel?.getAttribute('data-open')).toBe('true');
    expect(panel?.textContent).toContain('لا توجد عناصر بعد — جاهزة للتعبئة');
  });

  it('navigates to a workspace screen when its header is clicked', () => {
    renderLayout();

    const workspaceTwoLinks = screen.getAllByRole('link', {
      name: 'المنتج التام — ورش العاشر',
    });
    fireEvent.click(workspaceTwoLinks[0]!);

    expect(screen.getByRole('heading', { name: 'المنتج التام — ورش العاشر' })).toBeTruthy();
    expect(screen.getByText('مساحة عمل جاهزة')).toBeTruthy();
  });

  it('renders the settings screen for a deep leaf route with breadcrumb', () => {
    renderLayout('/settings/system/roles');

    expect(screen.getByRole('heading', { name: 'الصلاحيات والأدوار' })).toBeTruthy();
    expect(screen.getByText('تعريف الأدوار وربطها بمجموعة الصلاحيات داخل النظام.')).toBeTruthy();

    /* The accordion chain auto-opened to reveal the active route */
    const activeLink = within(sidebar()).getByRole('link', { name: 'الصلاحيات والأدوار' });
    expect(activeLink.getAttribute('aria-current')).toBe('page');
  });

  it('exposes the mobile drawer dialog markup (always mounted, inert when closed)', () => {
    renderLayout();

    const dialog = screen.getByRole('dialog', { name: 'التنقل الرئيسي', hidden: true });
    expect(dialog.getAttribute('data-open')).toBe('false');
    expect(dialog.hasAttribute('inert')).toBe(true);
  });

  it('switches to English navigation when the locale is English', () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'en');
    renderLayout();

    const nav = within(sidebar());
    expect(nav.getByRole('link', { name: 'Dashboard' })).toBeTruthy();
    expect(nav.getByRole('button', { name: 'Settings & Control' })).toBeTruthy();
    expect(document.documentElement.dir).toBe('ltr');
  });

  it('never renders duplicated DOM ids across the desktop sidebar and mobile drawer', () => {
    renderLayout('/settings/system/users');

    const ids = Array.from(document.querySelectorAll('[id]'), (element) => element.id);
    expect(new Set(ids).size).toBe(ids.length);

    /* Every aria-controls resolves to exactly one element. */
    for (const control of document.querySelectorAll('[aria-controls]')) {
      const target = control.getAttribute('aria-controls') ?? '';
      expect(document.querySelectorAll(`[id="${target}"]`)).toHaveLength(1);
    }
  });

  it('locks scroll and makes the shell inert only while the mobile drawer is open', () => {
    renderLayout();
    const content = document.querySelector('main')?.parentElement;
    if (!content) {
      throw new Error('Content column not found');
    }

    fireEvent.click(screen.getByRole('button', { name: 'فتح القائمة' }));
    expect(document.body.style.overflow).toBe('hidden');
    expect(content.hasAttribute('inert')).toBe(true);
    expect(sidebar().hasAttribute('inert')).toBe(true);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.body.style.overflow).toBe('');
    expect(content.hasAttribute('inert')).toBe(false);
    expect(sidebar().hasAttribute('inert')).toBe(false);
  });
});
