/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AuthCapabilitiesModule from '@/hooks/useAuthCapabilities';
import type * as StationsDirectoryModule from '@/hooks/useStationsDirectory';
import { I18nProvider } from '@/i18n/I18nContext';
import ProjectSettings from '@/pages/settings/ProjectSettings';

/**
 * Separation guard for the project-settings screen.
 *
 * The screen is the only place for the project's master data (stations,
 * warehouses, classifications, parties, general). It must stay completely
 * detached from the general / branding screen (`GeneralSettings`, mounted by
 * SettingsPage at /settings/app/general), whose copy is app identity,
 * administrator contact details, logo and favicon.
 */

/* --- shared capability + directory stubs (same wiring as ProjectSettings.test) --- */
const capabilityState = vi.hoisted(() => ({ capabilities: ['*'] as string[] }));

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
          warehouses: [],
        },
      ],
      error: null,
      refetch: vi.fn(),
    }),
  };
});

/* If this screen ever imported GeneralSettings, the factory below would run. */
const generalSettingsModule = vi.hoisted(() => ({ loaded: false }));

vi.mock('@/pages/settings/GeneralSettings', () => {
  generalSettingsModule.loaded = true;
  return { __esModule: true, default: () => null };
});

function renderScreen() {
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

/** Read a sibling source file in the same directory as this test. */
function readSibling(name: string): string {
  return readFileSync(join(process.cwd(), 'src/pages/settings', name), 'utf8');
}

describe('ProjectSettings separation from the general / branding screen', () => {
  beforeEach(() => {
    capabilityState.capabilities = ['*'];
    window.localStorage.clear();
  });

  it('does not import GeneralSettings', () => {
    renderScreen();

    /* The screen renders… */
    expect(screen.getByRole('heading', { name: 'ضبط المشروع' })).toBeTruthy();

    /* …and the GeneralSettings module factory never ran, so it is not part of
       this screen's module graph. */
    expect(generalSettingsModule.loaded).toBe(false);

    /* Belt-and-braces: no member of the local component tree references it. */
    for (const name of [
      'ProjectSettings.tsx',
      'StationsWarehouses.tsx',
      'StationDialogs.tsx',
      'Classifications.tsx',
      'Parties.tsx',
      'PartyDialogs.tsx',
    ]) {
      expect(readSibling(name)).not.toContain('GeneralSettings');
    }
  });

  it('renders no app-name / admin-email / branding copy', () => {
    const { container } = renderScreen();
    const text = container.textContent ?? '';

    /* identity.* labels belong to the general/branding screen. */
    expect(text).not.toContain('اسم التطبيق');
    expect(text).not.toContain('البريد الإلكتروني الإداري');
    expect(text).not.toContain('بيانات التواصل المؤسسي');
    expect(text).not.toContain('الشعار والأيقونة');

    /* Positive: the master-data description is what shows instead. */
    expect(text).toContain('إدارة البيانات الأساسية للمشروع');
  });
});
