import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CapabilitiesModule from '@/hooks/useAuthCapabilities';
import type * as CatalogModule from '@/hooks/usePermissionCatalog';
import type * as RolesModule from '@/hooks/useRolesManagement';
import {
  PermissionCatalogError,
  usePermissionCatalog,
  type PermissionCatalogApi,
  type PermissionCatalogEntry,
} from '@/hooks/usePermissionCatalog';
import {
  useRolesManagement,
  type GroupToggleState,
  type ManagedRole,
  type PermissionItem,
  type RolePermissionDraft,
  type RolesManagementApi,
} from '@/hooks/useRolesManagement';
import { I18nProvider, LOCALE_STORAGE_KEY } from '@/i18n/I18nContext';
import RolesPermissions from '@/pages/settings/RolesPermissions';

/**
 * Screen-level tests: the 403 gate, the fieldset/legend grouping, the native
 * indeterminate master checkbox, protected leaves (aria-disabled + reason)
 * and the accessible save-confirmation dialog.
 */

vi.mock('@/hooks/useRolesManagement', async (importOriginal) => {
  const actual = await importOriginal<typeof RolesModule>();
  return { ...actual, useRolesManagement: vi.fn() };
});

/* The capability channel needs an AuthProvider; this suite exercises the
   matrix-derived gate, so the channel is mocked as unresolved (fail-soft). */
vi.mock('@/hooks/useAuthCapabilities', async (importOriginal) => {
  const actual = await importOriginal<typeof CapabilitiesModule>();
  return {
    ...actual,
    useAuthCapabilities: () => ({
      capabilities: [],
      isLoading: false,
      isAuthoritative: false,
      configured: false,
      hasCapability: () => false,
    }),
  };
});

vi.mock('@/hooks/usePermissionCatalog', async (importOriginal) => {
  const actual = await importOriginal<typeof CatalogModule>();
  return { ...actual, usePermissionCatalog: vi.fn() };
});

const mockedUseRolesManagement = vi.mocked(useRolesManagement);
const mockedUsePermissionCatalog = vi.mocked(usePermissionCatalog);

/* ------------------------------------------------------------- fixtures */

function permission(
  id: string,
  slug: string,
  module: string,
  nameAr: string,
  description: string | null = null,
): PermissionItem {
  return { id, slug, module, nameAr, nameEn: slug, description };
}

const P_STAR = permission('p-star', '*', 'system', 'كل الصلاحيات');
const P_MANAGE = permission('p-manage', 'roles.manage', 'system', 'الصلاحيات والأدوار');
const P_USERS = permission('p-users', 'users.manage', 'system', 'ضبط المستخدمين', 'إدارة الحسابات');

const ROLE: ManagedRole = {
  id: 'r1',
  slug: 'super_admin',
  nameAr: 'مدير النظام',
  nameEn: 'Super Admin',
  isSystem: true,
  assignedUserCount: 2,
  permissionIds: ['p-star', 'p-manage'],
  heldByActor: true,
};

const PERMISSIONS = new Map<string, PermissionItem>(
  [P_STAR, P_MANAGE, P_USERS].map((permission) => [permission.id, permission]),
);

function catalogEntry(
  id: string,
  slug: string,
  module: string,
  nameAr: string,
  isDelegatable: boolean,
): PermissionCatalogEntry {
  return { id, slug, module, nameAr, nameEn: slug, description: null, isDelegatable };
}

const CATALOG: readonly PermissionCatalogEntry[] = [
  catalogEntry('p-star', '*', 'system', 'كل الصلاحيات', false),
  catalogEntry('p-manage', 'roles.manage', 'system', 'الصلاحيات والأدوار', false),
  catalogEntry('p-users', 'users.manage', 'system', 'ضبط المستخدمين', false),
  catalogEntry('p-approve', 'users.approve', 'system', 'اعتماد المستخدمين', true),
  catalogEntry('p-settings', 'settings.manage', 'app', 'الإعدادات الإدارية العامة', false),
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

function makeDraft(over: Partial<RolePermissionDraft> = {}): RolePermissionDraft {
  return {
    roleId: ROLE.id,
    baselineIds: new Set(ROLE.permissionIds),
    selectedIds: new Set(ROLE.permissionIds),
    grantedIds: [],
    revokedIds: [],
    isDirty: false,
    ...over,
  };
}

function fakeApi(over: Partial<RolesManagementApi> = {}): RolesManagementApi {
  return {
    roles: [ROLE],
    groups: [{ module: 'system', permissions: [P_STAR, P_MANAGE, P_USERS] }],
    permissionsById: PERMISSIONS,
    actorIsSuperAdmin: true,
    isInitialLoading: false,
    isRefreshing: false,
    fetchError: null,
    lastSyncedAt: null,
    refresh: vi.fn(),
    selectedRole: ROLE,
    selectRole: vi.fn(),
    draft: makeDraft(),
    protectedReasons: new Map([['p-star', 'system-role-locked']]),
    saveBlocker: 'noop',
    togglePermission: vi.fn(() => null),
    toggleGroup: vi.fn(() => ({ added: 0, removed: 0, keptProtected: 0 })),
    getGroupState: vi.fn((): GroupToggleState => 'some'),
    resetDraft: vi.fn(),
    isSaving: false,
    save: vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        roleId: ROLE.id,
        granted: [],
        revoked: [],
      }),
    ),
    ...over,
  };
}

function renderScreen(api: RolesManagementApi, catalog: PermissionCatalogApi = fakeCatalog()) {
  mockedUseRolesManagement.mockReturnValue(api);
  mockedUsePermissionCatalog.mockReturnValue(catalog);
  return render(
    <I18nProvider>
      <MemoryRouter>
        <RolesPermissions />
      </MemoryRouter>
    </I18nProvider>,
  );
}

/* ---------------------------------------------------------------- tests */

describe('RolesPermissions screen', () => {
  beforeEach(() => {
    window.localStorage.removeItem(LOCALE_STORAGE_KEY);
    mockedUseRolesManagement.mockReset();
    mockedUsePermissionCatalog.mockReset();
  });

  it('shows the translated 403 panel to non-super-admins', () => {
    renderScreen(fakeApi({ actorIsSuperAdmin: false, roles: [], selectedRole: null, draft: null }));

    expect(screen.getByText('403')).toBeTruthy();
    expect(screen.getByRole('heading', { name: /الوصول مرفوض/ })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'العودة إلى الشاشة الرئيسية' })).toBeTruthy();
    /* No matrix may leak through the gate. */
    expect(screen.queryByRole('group')).toBeNull();
  });

  it('groups permissions into fieldset/legend sets with a master checkbox', () => {
    renderScreen(fakeApi());

    const group = screen.getByRole('group', { name: 'النظام' });
    expect(group.tagName).toBe('FIELDSET');

    const master = screen.getByRole('checkbox', { name: 'تحديد كل صلاحيات النظام' });
    expect(group.contains(master)).toBe(true);
  });

  it('drives the NATIVE indeterminate property from the group state', () => {
    renderScreen(fakeApi({ getGroupState: vi.fn((): GroupToggleState => 'some') }));

    const master = screen.getByRole<HTMLInputElement>('checkbox', {
      name: 'تحديد كل صلاحيات النظام',
    });
    expect(master.indeterminate).toBe(true);
    expect(master.checked).toBe(false);

    /* Clicking the master runs one bulk toggle with the checked direction. */
    fireEvent.click(master);
    const api = mockedUseRolesManagement.mock.results[0]?.value as RolesManagementApi;
    expect(api.toggleGroup).toHaveBeenCalledWith('system', true);
  });

  it('locks protected leaves with aria-disabled and a linked reason', () => {
    renderScreen(fakeApi());

    const wildcard = screen.getByRole<HTMLInputElement>('checkbox', { name: /^كل الصلاحيات/ });
    expect(wildcard.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByText(/لا يمكن سحب «كل الصلاحيات»/)).toBeTruthy();

    /* The reason is linked through aria-describedby, not buried in a title. */
    const describedBy = wildcard.getAttribute('aria-describedby') ?? '';
    expect(describedBy).not.toBe('');
    const described = describedBy
      .split(' ')
      .map((id) => document.getElementById(id))
      .filter((element): element is HTMLElement => element !== null);
    expect(described.some((element) => element.textContent?.includes('لا يمكن سحب'))).toBe(true);

    fireEvent.click(wildcard);
    const api = mockedUseRolesManagement.mock.results[0]?.value as RolesManagementApi;
    expect(api.togglePermission).not.toHaveBeenCalled();
  });

  it('toggles unprotected leaves and keeps the description in the a11y tree', () => {
    renderScreen(fakeApi());

    const manage = screen.getByRole<HTMLInputElement>('checkbox', { name: /^الصلاحيات والأدوار/ });
    expect(manage.getAttribute('aria-disabled')).toBeNull();

    fireEvent.click(manage);
    const api = mockedUseRolesManagement.mock.results[0]?.value as RolesManagementApi;
    expect(api.togglePermission).toHaveBeenCalledWith('p-manage');

    /* Leaf description is wired via aria-describedby. */
    const users = screen.getByRole<HTMLInputElement>('checkbox', { name: /^ضبط المستخدمين/ });
    const describedBy = users.getAttribute('aria-describedby') ?? '';
    expect(describedBy).not.toBe('');
  });

  it('saves through the accessible confirmation dialog summarizing the diff', async () => {
    const save = vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        roleId: ROLE.id,
        granted: ['users.manage'],
        revoked: [],
      }),
    );
    renderScreen(
      fakeApi({
        save,
        saveBlocker: null,
        draft: makeDraft({
          selectedIds: new Set(['p-star', 'p-manage', 'p-users']),
          grantedIds: ['p-users'],
          isDirty: true,
        }),
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: /حفظ التعديلات/ }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(screen.getByRole('heading', { name: 'تأكيد حفظ الصلاحيات' })).toBeTruthy();
    /* Diff summary + system-role warning are inside the dialog body. */
    expect(screen.getByText('منح: 1')).toBeTruthy();
    expect(screen.getByText(/يؤثر على 2 مستخدم/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'تأكيد الحفظ' }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));

    /* Success banner announces the applied diff politely. */
    expect(await screen.findByText(/تم تحديث صلاحيات دور «مدير النظام»/)).toBeTruthy();
  });

  it('refuses to open the save dialog when a blocker exists and says why', () => {
    renderScreen(fakeApi({ saveBlocker: 'self-demotion' }));

    fireEvent.click(screen.getByRole('button', { name: /حفظ التعديلات/ }));

    expect(screen.queryByRole('dialog')).toBeNull();
    /* The blocker reason is visible under the save bar. */
    expect(screen.getAllByText(/يمنعك من إدارة الأدوار/).length).toBeGreaterThan(0);
  });

  it('asks before switching roles with unsaved changes', () => {
    const selectRole = vi.fn();
    const otherRole: ManagedRole = { ...ROLE, id: 'r2', slug: 'admin', nameAr: 'مدير عام' };
    renderScreen(
      fakeApi({
        roles: [ROLE, otherRole],
        selectRole,
        draft: makeDraft({ grantedIds: ['p-users'], isDirty: true }),
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: /مدير عام/ }));
    expect(selectRole).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'لديك تعديلات غير محفوظة' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'التخلي والانتقال' }));
    expect(selectRole).toHaveBeenCalledWith('r2');
  });

  it('renders the loading skeleton with a polite status', () => {
    renderScreen(fakeApi({ isInitialLoading: true, roles: [], selectedRole: null, draft: null }));

    expect(screen.getByText(/جارٍ تحميل الأدوار والصلاحيات/)).toBeTruthy();
  });
});

describe('RolesPermissions delegation policy', () => {
  beforeEach(() => {
    window.localStorage.removeItem(LOCALE_STORAGE_KEY);
    mockedUseRolesManagement.mockReset();
    mockedUsePermissionCatalog.mockReset();
  });

  it('renders one switch per permission reflecting the stored delegatable flag', () => {
    renderScreen(fakeApi());

    const section = screen.getByTestId('delegatable-permissions');
    expect(within(section).getByRole('heading', { name: 'تفويض الصلاحيات' })).toBeTruthy();
    expect(within(section).getByRole('columnheader', { name: 'قابل للتفويض' })).toBeTruthy();

    const approve = screen.getByTestId('delegatable-toggle-users.approve');
    expect(approve.getAttribute('role')).toBe('switch');
    expect(approve.getAttribute('aria-checked')).toBe('true');
    expect(approve.getAttribute('aria-label')).toBe('قابل للتفويض — اعتماد المستخدمين');

    const settings = screen.getByTestId('delegatable-toggle-settings.manage');
    expect(settings.getAttribute('aria-checked')).toBe('false');
  });

  it('shows the Protected badge instead of a toggle for * and roles.manage', () => {
    renderScreen(fakeApi());

    const star = screen.getByTestId('delegatable-protected-*');
    expect(star.textContent).toContain('محمي');
    expect(star.getAttribute('title')).toBe('لا يمكن تفويض هذه الصلاحية أبداً');
    expect(screen.getByTestId('delegatable-protected-roles.manage')).toBeTruthy();

    /* No switch may ever be offered for the protected pair. */
    expect(screen.queryByTestId('delegatable-toggle-*')).toBeNull();
    expect(screen.queryByTestId('delegatable-toggle-roles.manage')).toBeNull();
  });

  it('writes through the RPC on toggle and announces the new state', async () => {
    const setDelegatable = vi.fn(() => Promise.resolve());
    renderScreen(fakeApi(), fakeCatalog({ setDelegatable }));

    fireEvent.click(screen.getByTestId('delegatable-toggle-settings.manage'));

    await waitFor(() => expect(setDelegatable).toHaveBeenCalledWith('settings.manage', true));
    expect(
      await screen.findByText('أصبحت «الإعدادات الإدارية العامة» قابلة للتفويض.'),
    ).toBeTruthy();
  });

  it('surfaces a write refusal as an alert and keeps the switch state', async () => {
    const setDelegatable = vi.fn(() => Promise.reject(new PermissionCatalogError('forbidden')));
    renderScreen(fakeApi(), fakeCatalog({ setDelegatable }));

    fireEvent.click(screen.getByTestId('delegatable-toggle-settings.manage'));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('فقط المالك أو المشرف الأعلى');
    /* Server wins: the catalogue never flipped, so neither does the switch. */
    expect(
      screen.getByTestId('delegatable-toggle-settings.manage').getAttribute('aria-checked'),
    ).toBe('false');
  });

  it('shows the loading state while the catalogue is in flight', () => {
    renderScreen(fakeApi(), fakeCatalog({ isLoading: true, permissions: [] }));

    const section = screen.getByTestId('delegatable-permissions');
    expect(within(section).getByText('جارٍ التحميل...')).toBeTruthy();
  });

  it('hides the delegation policy from non-super-admins', () => {
    renderScreen(fakeApi({ actorIsSuperAdmin: false, roles: [], selectedRole: null, draft: null }));

    expect(screen.queryByTestId('delegatable-permissions')).toBeNull();
  });
});
