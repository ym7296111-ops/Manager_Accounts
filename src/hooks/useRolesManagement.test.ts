import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildDraft,
  computeGroupState,
  getPermissionProtection,
  getSaveBlocker,
  groupPermissionsByModule,
  parseMatrix,
  useRolesManagement,
  type ManagedRole,
  type PermissionItem,
  type RoleGuardContext,
} from '@/hooks/useRolesManagement';

/**
 * Unit tests for the pure RBAC guards plus an integration pass over the hook
 * (mocked Supabase wire) proving: one round trip, dynamic protection, the
 * iterative group-clear and the save RPC contract.
 */

/* ------------------------------------------------------------- fixtures */

function permission(
  id: string,
  slug: string,
  module: string,
  nameAr = slug,
  description: string | null = null,
): PermissionItem {
  return { id, slug, module, nameAr, nameEn: slug, description };
}

const P_STAR = permission('p-star', '*', 'system', 'كل الصلاحيات');
const P_MANAGE = permission('p-manage', 'roles.manage', 'system', 'الصلاحيات والأدوار');
const P_USERS = permission('p-users', 'users.manage', 'system', 'ضبط المستخدمين');
const P_DASH = permission('p-dash', 'dashboard.view', 'dashboard', 'عرض الشاشة الرئيسية');

const ALL_PERMISSIONS = [P_STAR, P_MANAGE, P_USERS, P_DASH];

/** Cartesian wire rows of `role_permission_matrix`, built in test space. */
function wireRows(): Record<string, unknown>[] {
  const roles = [
    {
      id: 'r-super',
      slug: 'super_admin',
      nameAr: 'مدير النظام',
      isSystem: true,
      heldByActor: true,
      users: 1,
      grants: new Set(['p-star']),
    },
    {
      id: 'r-editor',
      slug: 'editor',
      nameAr: 'محرر',
      isSystem: true,
      heldByActor: false,
      users: 2,
      grants: new Set(['p-manage', 'p-dash']),
    },
    {
      id: 'r-ghost',
      slug: 'ghost',
      nameAr: 'شبح',
      isSystem: false,
      heldByActor: false,
      users: 0,
      grants: new Set<string>(),
    },
  ];

  const rows: Record<string, unknown>[] = [];
  for (const role of roles) {
    for (const perm of ALL_PERMISSIONS) {
      rows.push({
        role_id: role.id,
        role_slug: role.slug,
        role_name_ar: role.nameAr,
        role_name_en: role.slug,
        role_is_system: role.isSystem,
        permission_id: perm.id,
        permission_slug: perm.slug,
        permission_module: perm.module,
        permission_name_ar: perm.nameAr,
        permission_name_en: perm.nameEn,
        permission_description: perm.description,
        granted: role.grants.has(perm.id),
        held_by_actor: role.heldByActor,
        assigned_user_count: role.users,
      });
    }
  }
  return rows;
}

function guardContext(over: Partial<RoleGuardContext> = {}): RoleGuardContext {
  return {
    roleId: 'r-editor',
    roleSlug: 'editor',
    actorRoleIds: new Set(['r-super']),
    baselineSlugsByRole: new Map([
      ['r-super', new Set(['*'])],
      ['r-editor', new Set(['roles.manage', 'dashboard.view'])],
    ]),
    ...over,
  };
}

/* ------------------------------------------------------- pure: grouping */

describe('groupPermissionsByModule', () => {
  it('groups by module in deterministic order (system first)', () => {
    const groups = groupPermissionsByModule([P_DASH, P_USERS, P_STAR, P_MANAGE]);
    expect(groups.map((group) => group.module)).toEqual(['system', 'dashboard']);
    expect(groups[0]?.permissions.map((p) => p.slug)).toEqual([
      '*',
      'roles.manage',
      'users.manage',
    ]);
    expect(groups[1]?.permissions.map((p) => p.slug)).toEqual(['dashboard.view']);
  });

  it('keeps unknown modules after the known ones, alphabetically', () => {
    const groups = groupPermissionsByModule([
      permission('p-x', 'x.y', 'zebra'),
      permission('p-a', 'a.b', 'alpha'),
      P_DASH,
    ]);
    expect(groups.map((group) => group.module)).toEqual(['dashboard', 'alpha', 'zebra']);
  });
});

describe('computeGroupState', () => {
  const group = {
    module: 'system',
    permissions: [P_STAR, P_MANAGE, P_USERS],
  };

  it('maps selection coverage onto none / some / all', () => {
    expect(computeGroupState(group, new Set())).toBe('none');
    expect(computeGroupState(group, new Set(['p-star']))).toBe('some');
    expect(computeGroupState(group, new Set(['p-star', 'p-manage', 'p-users']))).toBe('all');
    expect(computeGroupState({ module: 'x', permissions: [] }, new Set())).toBe('none');
  });
});

describe('buildDraft', () => {
  const role: ManagedRole = {
    id: 'r-editor',
    slug: 'editor',
    nameAr: 'محرر',
    nameEn: 'Editor',
    isSystem: true,
    assignedUserCount: 2,
    permissionIds: ['p-manage', 'p-dash'],
    heldByActor: false,
  };

  it('derives granted / revoked from the baseline, sorted and read-only', () => {
    const draft = buildDraft(role, new Set(['p-dash', 'p-users']));
    expect(draft.grantedIds).toEqual(['p-users']);
    expect(draft.revokedIds).toEqual(['p-manage']);
    expect(draft.isDirty).toBe(true);
  });

  it('is clean when the selection equals the baseline', () => {
    const draft = buildDraft(role, new Set(['p-manage', 'p-dash']));
    expect(draft.isDirty).toBe(false);
    expect(draft.grantedIds).toEqual([]);
    expect(draft.revokedIds).toEqual([]);
  });
});

/* --------------------------------------------------------- pure: guards */

describe('getPermissionProtection', () => {
  it('locks `*` on the super_admin role whenever it is selected', () => {
    const reason = getPermissionProtection(
      '*',
      new Set(['*']),
      guardContext({ roleSlug: 'super_admin' }),
    );
    expect(reason).toBe('system-role-locked');
  });

  it('blocks self-demotion: sole source of roles.manage cannot be unchecked', () => {
    const reason = getPermissionProtection(
      'roles.manage',
      new Set(['roles.manage']),
      guardContext({
        actorRoleIds: new Set(['r-editor']),
        baselineSlugsByRole: new Map([['r-editor', new Set(['roles.manage'])]]),
      }),
    );
    expect(reason).toBe('self-demotion');
  });

  it('allows unchecking roles.manage when a wildcard elsewhere keeps the capability', () => {
    const reason = getPermissionProtection(
      'roles.manage',
      new Set(['roles.manage', 'dashboard.view']),
      guardContext(),
    );
    expect(reason).toBeNull();
  });

  it('allows unchecking `*` from a role the actor does not hold', () => {
    const reason = getPermissionProtection(
      '*',
      new Set(['*']),
      guardContext({ roleSlug: 'admin' }),
    );
    expect(reason).toBeNull();
  });

  it('protects `*` when it is the actor last wildcard source (capability-level)', () => {
    const reason = getPermissionProtection(
      '*',
      new Set(['*']),
      guardContext({
        roleSlug: 'admin',
        actorRoleIds: new Set(['r-editor']),
        baselineSlugsByRole: new Map([['r-editor', new Set(['*'])]]),
      }),
    );
    expect(reason).toBe('self-demotion');
  });

  it('never protects non-critical permissions or unselected ones', () => {
    const context = guardContext();
    expect(getPermissionProtection('users.manage', new Set(['users.manage']), context)).toBeNull();
    expect(getPermissionProtection('roles.manage', new Set(), context)).toBeNull();
  });
});

describe('getSaveBlocker', () => {
  it('maps the pre-flight states', () => {
    const base = {
      ...guardContext(),
      selectedSlugs: new Set(['roles.manage', 'dashboard.view']),
      isDirty: true,
      actorIsSuperAdmin: true,
    };
    expect(getSaveBlocker({ ...base, roleSlug: '' })).toBe('not-found');
    expect(getSaveBlocker({ ...base, actorIsSuperAdmin: false })).toBe('forbidden');
    expect(getSaveBlocker({ ...base, isDirty: false })).toBe('noop');
  });

  it('refuses a draft that strips `*` from super_admin', () => {
    const blocker = getSaveBlocker({
      ...guardContext({ roleSlug: 'super_admin' }),
      selectedSlugs: new Set(['roles.manage']),
      isDirty: true,
      actorIsSuperAdmin: true,
    });
    expect(blocker).toBe('system-role-locked');
  });

  it('catches holistic self-demotion that no single toggle would reveal', () => {
    /* Stale-baseline scenario: the draft empties the actor's only role. */
    const blocker = getSaveBlocker({
      ...guardContext({
        actorRoleIds: new Set(['r-editor']),
        baselineSlugsByRole: new Map([['r-editor', new Set(['roles.manage', 'users.manage'])]]),
      }),
      selectedSlugs: new Set(),
      isDirty: true,
      actorIsSuperAdmin: true,
    });
    expect(blocker).toBe('self-demotion');
  });

  it('passes a healthy dirty draft', () => {
    const blocker = getSaveBlocker({
      ...guardContext(),
      selectedSlugs: new Set(['roles.manage', 'dashboard.view', 'users.manage']),
      isDirty: true,
      actorIsSuperAdmin: true,
    });
    expect(blocker).toBeNull();
  });
});

/* ------------------------------------------------------- pure: parsing */

describe('parseMatrix', () => {
  it('assembles roles, groups and actor state from ONE cartesian payload', () => {
    const matrix = parseMatrix(wireRows());

    /* Empty role and orphan permission both survive — completeness matters. */
    expect(matrix.roles.map((role) => role.slug)).toEqual(['editor', 'ghost', 'super_admin']);
    expect(matrix.permissionsById.size).toBe(4);
    expect(matrix.groups.map((group) => group.module)).toEqual(['system', 'dashboard']);

    const superAdmin = matrix.roles.find((role) => role.slug === 'super_admin');
    expect(superAdmin?.heldByActor).toBe(true);
    expect(superAdmin?.assignedUserCount).toBe(1);
    expect(superAdmin?.permissionIds).toEqual(['p-star']);

    const ghost = matrix.roles.find((role) => role.slug === 'ghost');
    expect(ghost?.permissionIds).toEqual([]);

    expect(matrix.actorRoleIds).toEqual(new Set(['r-super']));
    expect(matrix.actorIsSuperAdmin).toBe(true);
    expect(matrix.baselineSlugsByRole.get('r-editor')).toEqual(
      new Set(['roles.manage', 'dashboard.view']),
    );
  });

  it('reports a non-admin actor and tolerates malformed rows', () => {
    const rows: unknown[] = wireRows().map((row) =>
      row['role_id'] === 'r-super' ? { ...row, held_by_actor: false } : row,
    );
    rows.push(null, { role_id: '' }, 'junk');
    const matrix = parseMatrix(rows);
    expect(matrix.actorRoleIds).toEqual(new Set());
    expect(matrix.actorIsSuperAdmin).toBe(false);
    expect(matrix.roles.length).toBe(3);
  });

  it('returns an empty matrix for non-array payloads', () => {
    const matrix = parseMatrix(undefined);
    expect(matrix.roles).toEqual([]);
    expect(matrix.groups).toEqual([]);
    expect(matrix.actorIsSuperAdmin).toBe(false);
  });
});

/* -------------------------------------------------- hook integration */

const { mockFrom, mockRpc } = vi.hoisted(() => ({
  mockFrom: vi.fn<(...args: unknown[]) => unknown>(),
  mockRpc: vi.fn<(...args: unknown[]) => unknown>(),
}));

vi.mock('@/lib/supabase', () => ({
  getSupabase: () => ({
    from: (...args: unknown[]) => mockFrom(...args),
    rpc: (...args: unknown[]) => mockRpc(...args),
  }),
}));

function createWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

function mockMatrixResponse(rows: Record<string, unknown>[] = wireRows()) {
  mockFrom.mockReturnValue({
    select: () => ({
      range: () => Promise.resolve({ data: rows, error: null }),
    }),
  });
}

describe('useRolesManagement', () => {
  beforeEach(() => {
    mockFrom.mockReset();
    mockRpc.mockReset();
    mockMatrixResponse();
  });

  it('fetches the whole matrix in exactly one round trip', async () => {
    const { result } = renderHook(() => useRolesManagement(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isInitialLoading).toBe(false));
    expect(mockFrom).toHaveBeenCalledTimes(1);
    expect(mockFrom).toHaveBeenCalledWith('role_permission_matrix');
    expect(result.current.roles.length).toBe(3);
    expect(result.current.groups.length).toBe(2);
    expect(result.current.actorIsSuperAdmin).toBe(true);
  });

  it('seeds the draft from the baseline on role selection and tracks the diff', async () => {
    const { result } = renderHook(() => useRolesManagement(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isInitialLoading).toBe(false));

    act(() => result.current.selectRole('r-editor'));
    expect(result.current.draft?.isDirty).toBe(false);

    act(() => {
      const reason = result.current.togglePermission('p-users');
      expect(reason).toBeNull();
    });
    expect(result.current.draft?.grantedIds).toEqual(['p-users']);
    expect(result.current.draft?.isDirty).toBe(true);

    act(() => result.current.resetDraft());
    expect(result.current.draft?.isDirty).toBe(false);
  });

  it('refuses protected toggles and clears groups iteratively around them', async () => {
    const { result } = renderHook(() => useRolesManagement(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isInitialLoading).toBe(false));

    /* super_admin holds `*` — the wildcard is invariant-protected. */
    act(() => result.current.selectRole('r-super'));
    act(() => {
      const reason = result.current.togglePermission('p-star');
      expect(reason).toBe('system-role-locked');
    });
    expect(result.current.draft?.selectedIds.has('p-star')).toBe(true);

    /* Bulk clear must KEEP the protected leaf (`*` is load-bearing here). */
    let summary = { added: 0, removed: 0, keptProtected: 0 };
    act(() => {
      summary = result.current.toggleGroup('system', false);
    });
    expect(summary.keptProtected).toBe(1);
    expect(result.current.draft?.selectedIds.has('p-star')).toBe(true);

    /* Bulk select adds everything (including anything previously locked). */
    act(() => {
      summary = result.current.toggleGroup('system', true);
    });
    expect(summary.added).toBeGreaterThan(0);
    expect(result.current.getGroupState('system')).toBe('all');
  });

  it('keeps the load-bearing leaf and protects self-demotion dynamically', async () => {
    /* The actor holds ONLY editor here, whose roles.manage is their sole
       manage source — the toggle must be refused with a reason. */
    const rows = wireRows().map((row) => ({
      ...row,
      held_by_actor: row['role_id'] === 'r-editor',
    }));
    mockMatrixResponse(rows);

    const { result } = renderHook(() => useRolesManagement(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isInitialLoading).toBe(false));

    act(() => result.current.selectRole('r-editor'));
    act(() => {
      const reason = result.current.togglePermission('p-manage');
      expect(reason).toBe('self-demotion');
    });
    expect(result.current.draft?.selectedIds.has('p-manage')).toBe(true);
    expect(result.current.protectedReasons.get('p-manage')).toBe('self-demotion');

    /* Iterative clear: `*` is kept (load-bearing), its redundancy goes. */
    const adminRows = wireRows()
      .filter((row) => row['role_id'] === 'r-editor')
      .map((row) => ({
        ...row,
        role_id: 'r-admin',
        role_slug: 'admin',
        held_by_actor: true,
        granted: row['permission_id'] !== 'p-dash',
      }));
    mockMatrixResponse(adminRows);

    const admin = renderHook(() => useRolesManagement(), { wrapper: createWrapper() });
    await waitFor(() => expect(admin.result.current.isInitialLoading).toBe(false));
    act(() => {
      admin.result.current.selectRole('r-admin');
    });
    let summary = { added: 0, removed: 0, keptProtected: 0 };
    act(() => {
      summary = admin.result.current.toggleGroup('system', false);
    });
    expect(summary).toEqual({ added: 0, removed: 2, keptProtected: 1 });
    expect(admin.result.current.draft?.selectedIds.has('p-star')).toBe(true);
    expect(admin.result.current.draft?.selectedIds.has('p-manage')).toBe(false);
  });

  it('saves through the RPC with sorted slugs and re-invalidates the cache', async () => {
    mockRpc.mockResolvedValue({
      data: { role_id: 'r-editor', granted: ['users.manage'], revoked: [], updated_at: 'now' },
      error: null,
    });

    const { result } = renderHook(() => useRolesManagement(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isInitialLoading).toBe(false));

    act(() => result.current.selectRole('r-editor'));
    act(() => {
      result.current.togglePermission('p-users');
    });

    await act(async () => {
      const outcome = await result.current.save();
      expect(outcome).toEqual({
        ok: true,
        roleId: 'r-editor',
        granted: ['users.manage'],
        revoked: [],
      });
    });

    expect(mockRpc).toHaveBeenCalledWith('admin_set_role_permissions', {
      target_role_id: 'r-editor',
      permission_slugs: ['dashboard.view', 'roles.manage', 'users.manage'],
    });
  });

  it('maps database guard rejections onto normalized codes', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { code: 'RBA01', message: 'admin_set_role_permissions: self-demotion guard' },
    });

    const { result } = renderHook(() => useRolesManagement(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isInitialLoading).toBe(false));

    act(() => result.current.selectRole('r-editor'));
    act(() => {
      result.current.togglePermission('p-users');
    });

    await act(async () => {
      const outcome = await result.current.save();
      expect(outcome).toEqual({ ok: false, roleId: 'r-editor', code: 'self-demotion' });
    });
  });

  it('refuses to save a clean draft (noop) before any network call', async () => {
    const { result } = renderHook(() => useRolesManagement(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isInitialLoading).toBe(false));

    act(() => result.current.selectRole('r-editor'));
    await act(async () => {
      const outcome = await result.current.save();
      expect(outcome).toEqual({ ok: false, roleId: 'r-editor', code: 'noop' });
    });
    expect(mockRpc).not.toHaveBeenCalled();
  });
});
