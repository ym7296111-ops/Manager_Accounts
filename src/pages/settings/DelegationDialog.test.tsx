import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CatalogModule from '@/hooks/usePermissionCatalog';
import type * as CapabilitiesModule from '@/hooks/useUserCapabilities';
import {
  usePermissionCatalog,
  type PermissionCatalogApi,
  type PermissionCatalogEntry,
} from '@/hooks/usePermissionCatalog';
import {
  UserCapabilityError,
  useUserCapabilities,
  type UserCapabilitiesApi,
  type UserCapabilityGrant,
} from '@/hooks/useUserCapabilities';
import type { ManagedUser } from '@/hooks/useUsersManagement';
import { I18nProvider, LOCALE_STORAGE_KEY } from '@/i18n/I18nContext';
import DelegationDialog from '@/pages/settings/DelegationDialog';

/**
 * The dialog is fully data-driven now: its grantable list is whatever the
 * owner flagged `is_delegatable` (via the catalogue hook), labels resolve
 * override → catalogue name → slug, and a "no delegatable permissions"
 * configuration renders an explicit empty state instead of an empty select.
 */

vi.mock('@/hooks/useUserCapabilities', async (importOriginal) => {
  const actual = await importOriginal<typeof CapabilitiesModule>();
  return { ...actual, useUserCapabilities: vi.fn() };
});

vi.mock('@/hooks/usePermissionCatalog', async (importOriginal) => {
  const actual = await importOriginal<typeof CatalogModule>();
  return { ...actual, usePermissionCatalog: vi.fn() };
});

const mockedUseUserCapabilities = vi.mocked(useUserCapabilities);
const mockedUsePermissionCatalog = vi.mocked(usePermissionCatalog);

/* ------------------------------------------------------------- fixtures */

const USER: ManagedUser = {
  id: 'target-1',
  email: 'target@example.com',
  fullName: 'هدف التفويض',
  status: 'active',
  approvalStatus: 'approved',
  roles: [{ slug: 'viewer', nameAr: 'مشاهد', nameEn: 'Viewer' }],
  isSuperAdmin: false,
  isProtected: false,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};

function catalogEntry(
  id: string,
  slug: string,
  module: string,
  nameAr: string,
  nameEn: string,
  isDelegatable: boolean,
): PermissionCatalogEntry {
  return { id, slug, module, nameAr, nameEn, description: null, isDelegatable };
}

const CATALOG: readonly PermissionCatalogEntry[] = [
  catalogEntry('p-approve', 'users.approve', 'system', 'اعتماد المستخدمين', 'Approve users', true),
  catalogEntry(
    'p-settings',
    'settings.manage',
    'app',
    'الإعدادات الإدارية العامة',
    'Manage general settings',
    true,
  ),
  catalogEntry('p-users', 'users.manage', 'system', 'ضبط المستخدمين', 'Manage users', false),
];

function fakeCatalog(over: Partial<PermissionCatalogApi> = {}): PermissionCatalogApi {
  const permissions = over.permissions ?? CATALOG;
  return {
    permissions,
    delegatable: permissions.filter((entry) => entry.isDelegatable),
    bySlug: new Map(permissions.map((entry) => [entry.slug, entry] as const)),
    isLoading: false,
    error: null,
    refresh: vi.fn(() => Promise.resolve()),
    setDelegatable: vi.fn(() => Promise.resolve()),
    ...over,
  };
}

function fakeCapabilities(over: Partial<UserCapabilitiesApi> = {}): UserCapabilitiesApi {
  return {
    grants: [],
    isLoading: false,
    error: null,
    grant: vi.fn(() => Promise.resolve()),
    revoke: vi.fn(() => Promise.resolve()),
    refresh: vi.fn(() => Promise.resolve()),
    ...over,
  };
}

function grant(id: string, permissionSlug: string): UserCapabilityGrant {
  return { id, permissionSlug, grantedAt: '2026-10-20T10:00:00.000Z', expiresAt: null };
}

function renderDialog(
  capabilities: UserCapabilitiesApi = fakeCapabilities(),
  catalog: PermissionCatalogApi = fakeCatalog(),
) {
  mockedUseUserCapabilities.mockReturnValue(capabilities);
  mockedUsePermissionCatalog.mockReturnValue(catalog);
  const onChanged = vi.fn(() => Promise.resolve());
  const onClose = vi.fn();
  render(
    <I18nProvider>
      <DelegationDialog user={USER} onClose={onClose} onChanged={onChanged} />
    </I18nProvider>,
  );
  return { capabilities, catalog, onChanged, onClose };
}

/* ---------------------------------------------------------------- tests */

describe('DelegationDialog', () => {
  beforeEach(() => {
    window.localStorage.removeItem(LOCALE_STORAGE_KEY);
    mockedUseUserCapabilities.mockReset();
    mockedUsePermissionCatalog.mockReset();
  });

  it('offers exactly the owner-flagged delegatable permissions', async () => {
    const { capabilities, onChanged } = renderDialog();

    expect(screen.getByRole('dialog', { name: 'إدارة التفويضات الفردية' })).toBeTruthy();

    const select = screen.getByRole<HTMLSelectElement>('combobox', { name: /الصلاحية/ });
    const options = within(select).getAllByRole<HTMLOptionElement>('option');
    /* users.approve keeps its richer dictionary override; settings.manage
       (owner-enabled) renders its catalogue name — users.manage is absent. */
    expect(options.map((option) => option.value)).toEqual(['users.approve', 'settings.manage']);
    expect(options.map((option) => option.textContent)).toEqual([
      'اعتماد أو رفض حسابات التسجيل (دور المشاهد فقط)',
      'الإعدادات الإدارية العامة',
    ]);

    fireEvent.change(select, { target: { value: 'settings.manage' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /دون تاريخ انتهاء/ }));
    fireEvent.click(screen.getByRole('button', { name: /منح الصلاحية/ }));

    await waitFor(() => expect(capabilities.grant).toHaveBeenCalledWith('settings.manage', null));
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('تم منح الصلاحية بنجاح.')).toBeTruthy();
  });

  it('renders an explicit empty state when nothing is delegatable', () => {
    renderDialog(
      fakeCapabilities(),
      fakeCatalog({
        permissions: CATALOG.map((entry) => ({ ...entry, isDelegatable: false })),
      }),
    );

    const empty = screen.getByTestId('delegation-none-delegatable');
    expect(empty.textContent).toContain('لا توجد صلاحيات قابلة للتفويض مفعّلة حالياً');
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('button', { name: /منح الصلاحية/ })).toBeNull();
  });

  it('shows the all-granted state when every delegatable capability is held', () => {
    renderDialog(
      fakeCapabilities({ grants: [grant('g-1', 'users.approve')] }),
      fakeCatalog({
        permissions: [CATALOG[0] as PermissionCatalogEntry, CATALOG[2] as PermissionCatalogEntry],
      }),
    );

    expect(screen.getByText('المستخدم يحمل جميع الصلاحيات القابلة للتفويض بالفعل.')).toBeTruthy();
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('labels live grants via the catalogue and revokes by id', async () => {
    const { capabilities } = renderDialog(
      fakeCapabilities({ grants: [grant('g-settings', 'settings.manage')] }),
    );

    const item = screen.getByText('الإعدادات الإدارية العامة').closest('li');
    expect(item).not.toBeNull();
    fireEvent.click(within(item as HTMLElement).getByRole('button', { name: /سحب/ }));

    await waitFor(() => expect(capabilities.revoke).toHaveBeenCalledWith('g-settings'));
  });

  it('falls back to the raw slug for a grant outside the catalogue', () => {
    renderDialog(fakeCapabilities({ grants: [grant('g-x', 'mystery.perm')] }));

    expect(screen.getByText('mystery.perm')).toBeTruthy();
  });

  it('reports a permission that stopped being delegatable and refreshes the list', async () => {
    const { catalog } = renderDialog(
      fakeCapabilities({
        grant: vi.fn(() => Promise.reject(new UserCapabilityError('not-delegatable'))),
      }),
    );

    fireEvent.click(screen.getByRole('checkbox', { name: /دون تاريخ انتهاء/ }));
    fireEvent.click(screen.getByRole('button', { name: /منح الصلاحية/ }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('لم تعد هذه الصلاحية قابلة للتفويض');
    expect(catalog.refresh).toHaveBeenCalledTimes(1);
  });
});
