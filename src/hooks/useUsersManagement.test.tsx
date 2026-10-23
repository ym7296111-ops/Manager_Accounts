import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ar } from '@/i18n/locales/ar';
import type { PostgrestError } from '@supabase/supabase-js';
import type { TranslationKey } from '@/i18n/I18nContext';
import {
  failureMessageKey,
  failureMessageKeyForRoleChange,
  getStatusChangeBlocker,
  INVITE_ROLES,
  inviteFailureMessageKey,
  passwordResetFailureMessageKey,
  USERS_ERROR_KEYS,
  USERS_INVITE_ERROR_KEYS,
  USERS_PASSWORD_RESET_ERROR_KEYS,
  USERS_ROLE_CHANGE_ERROR_KEYS,
  usersActorAccessQueryKey,
  useUsersManagement,
  type ActorAccess,
  type ChangeUserRoleErrorCode,
  type ChangeUserRoleResult,
  type InviteErrorCode,
  type InviteResult,
  type ManagedUser,
  type PasswordResetErrorCode,
  type PasswordResetResult,
  type SetUserStatusResult,
} from '@/hooks/useUsersManagement';

const { rpc, select, invoke, actor, client, capabilityState } = vi.hoisted(() => {
  const rpc = vi.fn();
  const select = vi.fn();
  const invoke = vi.fn();
  const actor = { id: 'actor' };
  const capabilityState = { capabilities: ['*'] as string[], isAuthoritative: true };
  const channel = {
    on: vi.fn().mockReturnThis(),
    subscribe: vi.fn().mockReturnThis(),
  };
  const client = {
    from: vi.fn(() => ({ select })),
    rpc,
    functions: { invoke },
    channel: vi.fn(() => channel),
    removeChannel: vi.fn(),
  };
  return { rpc, select, invoke, actor, client, capabilityState };
});

vi.mock('@/lib/supabase', () => ({ getSupabase: () => client }));
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    session: { user: { id: actor.id } },
    configured: true,
    approvalStatus: 'approved',
    loading: false,
  }),
}));
vi.mock('@/hooks/useAuthCapabilities', () => ({
  WILDCARD_CAPABILITY: '*',
  useAuthCapabilities: () => ({
    capabilities: capabilityState.capabilities,
    isLoading: false,
    isAuthoritative: capabilityState.isAuthoritative,
    configured: true,
    hasCapability: (slug: string) =>
      capabilityState.capabilities.includes('*') || capabilityState.capabilities.includes(slug),
    refetch: vi.fn().mockResolvedValue(undefined),
  }),
}));

function user(id: string, superAdmin = true): ManagedUser {
  return {
    id,
    email: `${id}@example.invalid`,
    fullName: id,
    status: 'active',
    approvalStatus: 'approved',
    roles: superAdmin
      ? [{ slug: 'super_admin', nameAr: 'مدير النظام', nameEn: 'Super Administrator' }]
      : [],
    isSuperAdmin: superAdmin,
    isProtected: superAdmin,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
  };
}

const ACTOR = user('actor');
const OTHER_ADMIN = user('other-admin');
const VIEWER = user('viewer', false);

function mountHook(
  users = [ACTOR, OTHER_ADMIN, VIEWER],
  actorAccess: ActorAccess = { canAdministerUsers: false },
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(['users'], users);
  queryClient.setQueryData(usersActorAccessQueryKey('actor'), actorAccess);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return renderHook(() => useUsersManagement(), { wrapper });
}

describe('users-management lockout audit', () => {
  beforeEach(() => {
    actor.id = 'actor';
    capabilityState.capabilities = ['*'];
    capabilityState.isAuthoritative = true;
    rpc.mockReset().mockResolvedValue({ data: null, error: null });
    invoke.mockReset().mockResolvedValue({ error: null });
    select.mockReturnValue({
      order: vi.fn().mockReturnThis(),
      range: vi.fn().mockResolvedValue({ data: [], error: null }),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    });
  });

  it('blocks a self-suspension before calling the RPC', async () => {
    const { result } = mountHook();
    let outcome;
    await act(async () => {
      outcome = await result.current.setUserStatus('actor', 'suspended');
    });
    expect(outcome).toEqual({ ok: false, userId: 'actor', code: 'self-lockout' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('blocks owner suspension even with another active administrator', async () => {
    const owner: ManagedUser = {
      ...user('founder'),
      roles: [{ slug: 'owner', nameAr: 'المالك', nameEn: 'Owner' }],
    };
    expect(
      getStatusChangeBlocker({
        target: owner,
        actorId: ACTOR.id,
        actorIsSuperAdmin: true,
        nextStatus: 'suspended',
        activeSuperAdmins: [ACTOR, owner],
      }),
    ).toBe('owner-protection');
    const { result } = mountHook([ACTOR, owner]);
    let outcome;
    await act(async () => {
      outcome = await result.current.setUserStatus(owner.id, 'suspended');
    });
    expect(outcome).toEqual({ ok: false, userId: owner.id, code: 'owner-protection' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('blocks suspension of the last active super admin in the pure guard', () => {
    expect(
      getStatusChangeBlocker({
        target: OTHER_ADMIN,
        actorId: ACTOR.id,
        actorIsSuperAdmin: true,
        nextStatus: 'suspended',
        activeSuperAdmins: [OTHER_ADMIN],
      }),
    ).toBe('last-admin-lockout');
  });

  it('rejects a non-admin, an absent user, and a no-op without network writes', async () => {
    const { result } = mountHook();
    let missing;
    let noop;
    await act(async () => {
      missing = await result.current.setUserStatus('absent', 'suspended');
      noop = await result.current.setUserStatus('viewer', 'active');
    });
    expect(missing).toEqual({ ok: false, userId: 'absent', code: 'not-found' });
    expect(noop).toEqual({ ok: false, userId: 'viewer', code: 'noop' });
    expect(
      getStatusChangeBlocker({
        target: VIEWER,
        actorId: 'not-an-admin',
        actorIsSuperAdmin: false,
        nextStatus: 'suspended',
        activeSuperAdmins: [ACTOR, OTHER_ADMIN],
      }),
    ).toBe('forbidden');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('uses the checked status RPC and normalizes its permission denial', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'denied' } });
    const { result } = mountHook();
    let outcome;
    await act(async () => {
      outcome = await result.current.setUserStatus('other-admin', 'suspended');
    });
    expect(rpc).toHaveBeenCalledWith('admin_set_user_status', {
      p_user_id: 'other-admin',
      p_status: 'suspended',
    });
    expect(outcome).toEqual({ ok: false, userId: 'other-admin', code: 'forbidden' });

    rpc.mockResolvedValue({
      data: null,
      error: { code: 'RBA02', message: 'admin_set_user_status: last-admin-lockout' },
    });
    await act(async () => {
      outcome = await result.current.setUserStatus('other-admin', 'suspended');
    });
    expect(outcome).toEqual({ ok: false, userId: 'other-admin', code: 'last-admin-lockout' });
  });

  it('serializes duplicate writes to the same user while an RPC is in flight', async () => {
    let resolveRpc!: (value: { error: null }) => void;
    rpc.mockImplementation(() => new Promise<{ error: null }>((resolve) => (resolveRpc = resolve)));
    const { result } = mountHook();
    let first!: ReturnType<typeof result.current.setUserStatus>;
    act(() => {
      first = result.current.setUserStatus('viewer', 'suspended');
    });
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
    let duplicate;
    await act(async () => {
      duplicate = await result.current.setUserStatus('viewer', 'suspended');
    });
    expect(duplicate).toEqual({ ok: false, userId: 'viewer', code: 'in-flight' });
    await act(async () => {
      resolveRpc({ error: null });
      await first;
    });
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});

describe('approval workflow', () => {
  beforeEach(() => {
    actor.id = 'actor';
    capabilityState.capabilities = ['*'];
    capabilityState.isAuthoritative = true;
    rpc.mockReset().mockResolvedValue({ data: null, error: null });
    invoke.mockReset().mockResolvedValue({ error: null });
    select.mockReturnValue({
      order: vi.fn().mockReturnThis(),
      range: vi.fn().mockResolvedValue({ data: [], error: null }),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    });
  });

  function pendingApplicant(): ManagedUser {
    return {
      id: 'applicant',
      email: 'applicant@example.invalid',
      fullName: 'applicant',
      status: 'active',
      approvalStatus: 'pending',
      roles: [],
      isSuperAdmin: false,
      isProtected: false,
      createdAt: '2026-10-18T00:00:00Z',
      updatedAt: '2026-10-18T00:00:00Z',
    };
  }

  it('approves with the chosen role in the request body (role selection scenario)', async () => {
    const { result } = mountHook([ACTOR, pendingApplicant()], { canAdministerUsers: true });
    let outcome;
    await act(async () => {
      outcome = await result.current.approveUser('applicant', 'editor');
    });
    expect(outcome).toEqual({ ok: true, userId: 'applicant', status: 'active' });
    expect(invoke).toHaveBeenCalledWith('approve-user', {
      body: { userId: 'applicant', action: 'approve', targetRole: 'editor' },
    });
  });

  it('defaults the granted role to viewer when none is chosen', async () => {
    const { result } = mountHook([ACTOR, pendingApplicant()], { canAdministerUsers: true });
    await act(async () => {
      await result.current.approveUser('applicant');
    });
    expect(invoke).toHaveBeenCalledWith('approve-user', {
      body: { userId: 'applicant', action: 'approve', targetRole: 'viewer' },
    });
  });

  it('sends rejections without a target role', async () => {
    const { result } = mountHook([ACTOR, pendingApplicant()], { canAdministerUsers: true });
    await act(async () => {
      await result.current.rejectUser('applicant');
    });
    expect(invoke).toHaveBeenCalledWith('approve-user', {
      body: { userId: 'applicant', action: 'reject' },
    });
  });

  it('refuses approvals without network calls when the actor lacks the gate', async () => {
    capabilityState.capabilities = ['dashboard:read'];
    const { result } = mountHook([ACTOR, pendingApplicant()], { canAdministerUsers: false });
    let outcome;
    await act(async () => {
      outcome = await result.current.approveUser('applicant', 'viewer');
    });
    expect(outcome).toEqual({ ok: false, userId: 'applicant', code: 'forbidden' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('keeps the approval gate across approval filters (owner row is not in the pending list)', async () => {
    const { result } = mountHook([ACTOR, pendingApplicant()], { canAdministerUsers: true });
    expect(result.current.actorCanApprove).toBe(true);
    /* The owner is 'approved', so their row never appears under the 'pending'
       filter — the gate must come from the actor-access query, not the rows. */
    act(() => {
      result.current.setApprovalFilter('pending');
    });
    await waitFor(() => expect(result.current.users.every((u) => u.id !== 'actor')).toBe(true));
    expect(result.current.actorCanApprove).toBe(true);
  });

  /* P1 — distinct, specific messages per the machine code in the Edge
     Function body (`body.error.code`, bare string or nested object). */
  const approvalHttpError = (body: unknown) => ({ context: { json: () => Promise.resolve(body) } });

  it('P1: maps permission_denied to the forbidden message (not a blanket code)', async () => {
    invoke.mockResolvedValue({ error: approvalHttpError({ error: 'permission_denied' }) });
    const { result } = mountHook([ACTOR, pendingApplicant()], { canAdministerUsers: true });
    let outcome;
    await act(async () => {
      outcome = await result.current.approveUser('applicant', 'editor');
    });
    expect(outcome).toEqual({ ok: false, userId: 'applicant', code: 'forbidden' });
    expect(USERS_ERROR_KEYS['forbidden']).toBe('users.error.forbidden');
  });

  it('P1: maps not_found to the not-found message', async () => {
    invoke.mockResolvedValue({ error: approvalHttpError({ error: 'not_found' }) });
    const { result } = mountHook([ACTOR, pendingApplicant()], { canAdministerUsers: true });
    let outcome;
    await act(async () => {
      outcome = await result.current.rejectUser('applicant');
    });
    expect(outcome).toEqual({ ok: false, userId: 'applicant', code: 'not-found' });
    expect(USERS_ERROR_KEYS['not-found']).toBe('users.error.notFound');
  });

  it('P1: maps invalid_transition to the dedicated approval-transition message', async () => {
    invoke.mockResolvedValue({ error: approvalHttpError({ error: 'invalid_transition' }) });
    const { result } = mountHook([ACTOR, pendingApplicant()], { canAdministerUsers: true });
    let outcome: SetUserStatusResult | undefined;
    await act(async () => {
      outcome = await result.current.approveUser('applicant', 'viewer');
    });
    expect(outcome).toEqual({
      ok: false,
      userId: 'applicant',
      code: 'noop',
      messageKey: 'users.errors.approvalInvalidTransition',
    });
    if (outcome?.ok !== false) throw new Error('expected a failed approval');
    expect(failureMessageKey(outcome)).toBe('users.errors.approvalInvalidTransition');
    expect(ar['users.errors.approvalInvalidTransition']).toBe(
      'هذا المستخدم ليس بحالة تسمح بالاعتماد',
    );
  });

  it('P1: maps invalid_role to the dedicated invalid-role message', async () => {
    invoke.mockResolvedValue({ error: approvalHttpError({ error: 'invalid_role' }) });
    const { result } = mountHook([ACTOR, pendingApplicant()], { canAdministerUsers: true });
    let outcome: SetUserStatusResult | undefined;
    await act(async () => {
      outcome = await result.current.approveUser('applicant', 'owner');
    });
    expect(outcome).toEqual({
      ok: false,
      userId: 'applicant',
      code: 'owner-protection',
      messageKey: 'users.errors.approvalInvalidRole',
    });
    if (outcome?.ok !== false) throw new Error('expected a failed approval');
    expect(failureMessageKey(outcome)).toBe('users.errors.approvalInvalidRole');
    expect(ar['users.errors.approvalInvalidRole']).toBe('الدور المختار غير صالح');
  });

  it('P1: maps unknown via body.error.code (object) and the bare error string', async () => {
    const { result } = mountHook([ACTOR, pendingApplicant()], { canAdministerUsers: true });
    invoke.mockResolvedValue({ error: approvalHttpError({ error: { code: 'unknown' } }) });
    let objectShape;
    await act(async () => {
      objectShape = await result.current.approveUser('applicant', 'editor');
    });
    expect(objectShape).toEqual({ ok: false, userId: 'applicant', code: 'unknown' });
    invoke.mockResolvedValue({ error: approvalHttpError({ error: 'unknown' }) });
    let stringShape;
    await act(async () => {
      stringShape = await result.current.rejectUser('applicant');
    });
    expect(stringShape).toEqual({ ok: false, userId: 'applicant', code: 'unknown' });
    expect(USERS_ERROR_KEYS['unknown']).toBe('users.error.unknown');
  });
});

describe('changeUserRole', () => {
  beforeEach(() => {
    actor.id = 'actor';
    capabilityState.capabilities = ['*'];
    capabilityState.isAuthoritative = true;
    rpc.mockReset().mockResolvedValue({ data: null, error: null });
    select.mockReturnValue({
      order: vi.fn().mockReturnThis(),
      range: vi.fn().mockResolvedValue({ data: [], error: null }),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    });
  });

  function plainUser(id: string, slug: string, isProtected = false): ManagedUser {
    return {
      id,
      email: `${id}@example.invalid`,
      fullName: id,
      status: 'active' as const,
      approvalStatus: 'approved' as const,
      roles: [{ slug, nameAr: slug, nameEn: slug }],
      isSuperAdmin: false,
      isProtected,
      createdAt: '2026-10-01T00:00:00Z',
      updatedAt: '2026-10-01T00:00:00Z',
    };
  }

  it('calls admin_set_user_roles with the selected slugs and returns the granted roles', async () => {
    const { result } = mountHook([
      plainUser('actor', 'super_admin'),
      plainUser('viewer', 'viewer'),
    ]);
    let outcome!: ChangeUserRoleResult;
    await act(async () => {
      outcome = await result.current.changeUserRole('viewer', ['editor', 'admin']);
    });
    expect(outcome).toEqual({ ok: true, userId: 'viewer', roles: ['editor', 'admin'] });
    expect(rpc).toHaveBeenCalledWith('admin_set_user_roles', {
      p_user_id: 'viewer',
      p_role_slugs: ['editor', 'admin'],
    });
  });

  it('maps a 42501 PostgREST error to forbidden', async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { code: '42501', message: 'permission_denied' } as PostgrestError,
    });
    const { result } = mountHook([
      plainUser('actor', 'super_admin'),
      plainUser('target', 'viewer'),
    ]);
    let outcome!: ChangeUserRoleResult;
    await act(async () => {
      outcome = await result.current.changeUserRole('target', ['editor']);
    });
    expect(outcome).toEqual({ ok: false, userId: 'target', code: 'forbidden' });
    const failure = outcome as {
      ok: false;
      code: ChangeUserRoleErrorCode;
      messageKey?: TranslationKey;
    };
    expect(
      failureMessageKeyForRoleChange({ code: failure.code, messageKey: failure.messageKey }),
    ).toBe(USERS_ROLE_CHANGE_ERROR_KEYS['forbidden']);
  });

  it('maps a server-side owner-grant refusal (B1) to forbidden without crashing', async () => {
    // The role picker never offers 'owner' (hardcoded allow-list), but a stale
    // client or direct call can still reach the RPC: the server refuses with
    // 42501 + owner_protection, which must surface as a plain forbidden failure.
    rpc.mockResolvedValue({
      data: null,
      error: {
        code: '42501',
        message: 'owner_protection: owner role cannot be granted',
      } as PostgrestError,
    });
    const { result } = mountHook([
      plainUser('actor', 'super_admin'),
      plainUser('target', 'viewer'),
    ]);
    let outcome!: ChangeUserRoleResult;
    await act(async () => {
      outcome = await result.current.changeUserRole('target', ['editor']);
    });
    expect(outcome).toEqual({ ok: false, userId: 'target', code: 'forbidden' });
    const failure = outcome as {
      ok: false;
      code: ChangeUserRoleErrorCode;
      messageKey?: TranslationKey;
    };
    expect(
      failureMessageKeyForRoleChange({ code: failure.code, messageKey: failure.messageKey }),
    ).toBe(USERS_ROLE_CHANGE_ERROR_KEYS['forbidden']);
  });

  it('maps owner_protection to the owner-protection code and dedicated message key', async () => {
    rpc.mockResolvedValue({
      data: null,
      error: {
        code: '42501',
        message: 'owner_protection: owner approval is immutable',
      } as PostgrestError,
    });
    const { result } = mountHook([
      plainUser('actor', 'super_admin'),
      plainUser('owner', 'owner', true),
    ]);
    let outcome!: ChangeUserRoleResult;
    await act(async () => {
      outcome = await result.current.changeUserRole('owner', ['editor']);
    });
    expect(outcome).toEqual({
      ok: false,
      userId: 'owner',
      code: 'owner-protection',
      messageKey: 'users.role.error.ownerProtected',
    });
    const failure = outcome as {
      ok: false;
      code: ChangeUserRoleErrorCode;
      messageKey?: TranslationKey;
    };
    expect(
      failureMessageKeyForRoleChange({ code: failure.code, messageKey: failure.messageKey }),
    ).toBe('users.role.error.ownerProtected');
    expect(ar['users.role.error.ownerProtected']).toBe('لا يمكن تعديل أدوار المالك الأصلي.');
  });

  it('maps P0002 (user not found) to not-found', async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { code: 'P0002', message: 'user not found' } as PostgrestError,
    });
    const { result } = mountHook([plainUser('actor', 'super_admin')]);
    let outcome!: ChangeUserRoleResult;
    await act(async () => {
      outcome = await result.current.changeUserRole('absent', ['viewer']);
    });
    expect(outcome).toEqual({ ok: false, userId: 'absent', code: 'not-found' });
  });

  it('serializes concurrent calls to the same user', async () => {
    let resolveRpc!: (value: { error: null }) => void;
    rpc.mockImplementation(() => new Promise<{ error: null }>((resolve) => (resolveRpc = resolve)));
    const { result } = mountHook([
      plainUser('actor', 'super_admin'),
      plainUser('target', 'viewer'),
    ]);
    let first: Promise<ChangeUserRoleResult>;
    act(() => {
      first = result.current.changeUserRole('target', ['editor']);
    });
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
    let duplicate;
    await act(async () => {
      duplicate = await result.current.changeUserRole('target', ['admin']);
    });
    expect(duplicate).toEqual({ ok: false, userId: 'target', code: 'in-flight' });
    await act(async () => {
      resolveRpc({ error: null });
      await first;
    });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('protects a protected user without making a network call', async () => {
    const { result } = mountHook([
      plainUser('actor', 'super_admin'),
      plainUser('owner', 'owner', true),
    ]);
    let outcome!: ChangeUserRoleResult;
    await act(async () => {
      outcome = await result.current.changeUserRole('owner', ['editor']);
    });
    expect(outcome).toEqual({
      ok: false,
      userId: 'owner',
      code: 'owner-protection',
      messageKey: 'users.role.error.ownerProtected',
    });
    expect(rpc).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------- admin invite + password reset */

describe('admin invite and password reset', () => {
  const TEMP_PASSWORD = 'Ab2Cd4Ef6Gh8Jk1L';
  /** Mirrors the shape supabase-js builds from an Edge Function error body. */
  const httpError = (body: unknown) => ({ context: { json: () => Promise.resolve(body) } });

  function resetTarget(overrides: Partial<ManagedUser> = {}): ManagedUser {
    return {
      id: 'target',
      email: 'target@example.invalid',
      fullName: 'Target user',
      status: 'active',
      approvalStatus: 'approved',
      roles: [{ slug: 'viewer', nameAr: 'مشاهد', nameEn: 'Viewer' }],
      isSuperAdmin: false,
      isProtected: false,
      createdAt: '2026-10-01T00:00:00Z',
      updatedAt: '2026-10-01T00:00:00Z',
      ...overrides,
    };
  }

  beforeEach(() => {
    actor.id = 'actor';
    capabilityState.capabilities = ['*'];
    capabilityState.isAuthoritative = true;
    rpc.mockReset().mockResolvedValue({ data: null, error: null });
    invoke.mockReset().mockResolvedValue({ error: null });
    select.mockReturnValue({
      order: vi.fn().mockReturnThis(),
      range: vi.fn().mockResolvedValue({ data: [], error: null }),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    });
  });

  it('offers exactly the four grantable roles, including executive (D5)', () => {
    expect([...INVITE_ROLES]).toEqual(['viewer', 'editor', 'admin', 'executive']);
    // owner / super_admin must never be invitable from the UI.
    expect(INVITE_ROLES).not.toContain('owner');
    expect(INVITE_ROLES).not.toContain('super_admin');
  });

  it('every invite and password-reset code resolves to a bilingual key', () => {
    const inviteCodes: InviteErrorCode[] = [
      'unavailable',
      'forbidden',
      'email-exists',
      'invalid-role',
      'invalid-email',
      'in-flight',
      'rate-limited',
      'network',
      'unknown',
    ];
    for (const code of inviteCodes) {
      expect(typeof USERS_INVITE_ERROR_KEYS[code]).toBe('string');
      expect(ar[USERS_INVITE_ERROR_KEYS[code]]).toBeTruthy();
    }
    const resetCodes: PasswordResetErrorCode[] = [
      'unavailable',
      'forbidden',
      'owner-protection',
      'not-found',
      'in-flight',
      'rate-limited',
      'network',
      'unknown',
    ];
    for (const code of resetCodes) {
      expect(typeof USERS_PASSWORD_RESET_ERROR_KEYS[code]).toBe('string');
      expect(ar[USERS_PASSWORD_RESET_ERROR_KEYS[code]]).toBeTruthy();
    }
  });

  /* ------------------------------------------------------------ inviteUser */

  it('inviteUser sends the address, optional name and role, and returns the one-time password', async () => {
    invoke.mockResolvedValue({
      data: { ok: true, userId: 'invited-id', tempPassword: TEMP_PASSWORD },
      error: null,
    });
    const { result } = mountHook([ACTOR, VIEWER], { canAdministerUsers: true });

    let outcome: InviteResult | undefined;
    await act(async () => {
      outcome = await result.current.inviteUser({
        email: '  New.User@Example.INVALID  ',
        fullName: '  New User  ',
        targetRole: 'executive',
      });
    });

    expect(outcome).toEqual({ ok: true, userId: 'invited-id', tempPassword: TEMP_PASSWORD });
    expect(invoke).toHaveBeenCalledWith('admin-invite-user', {
      body: { email: 'new.user@example.invalid', fullName: 'New User', targetRole: 'executive' },
    });
  });

  it('inviteUser omits fullName when it is blank', async () => {
    invoke.mockResolvedValue({
      data: { ok: true, userId: 'invited-id', tempPassword: TEMP_PASSWORD },
      error: null,
    });
    const { result } = mountHook([ACTOR], { canAdministerUsers: true });
    await act(async () => {
      await result.current.inviteUser({
        email: 'a@b.invalid',
        fullName: '   ',
        targetRole: 'viewer',
      });
    });
    expect(invoke).toHaveBeenCalledWith('admin-invite-user', {
      body: { email: 'a@b.invalid', targetRole: 'viewer' },
    });
  });

  it('inviteUser refuses a malformed address before spending a request', async () => {
    const { result } = mountHook([ACTOR], { canAdministerUsers: true });
    let outcome: InviteResult | undefined;
    await act(async () => {
      outcome = await result.current.inviteUser({ email: 'not-an-email', targetRole: 'viewer' });
    });
    expect(outcome).toEqual({ ok: false, code: 'invalid-email' });
    expect(inviteFailureMessageKey({ code: 'invalid-email' })).toBe(
      'users.invite.error.invalidEmail',
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it('inviteUser is gated on owner/super_admin authority (D2)', async () => {
    const { result } = mountHook([ACTOR, VIEWER], { canAdministerUsers: false });
    let outcome: InviteResult | undefined;
    await act(async () => {
      outcome = await result.current.inviteUser({ email: 'a@b.invalid', targetRole: 'editor' });
    });
    expect(outcome).toEqual({ ok: false, code: 'forbidden' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each([
    ['email_exists', 'email-exists'],
    ['invalid_role', 'invalid-role'],
    ['permission_denied', 'forbidden'],
    ['unavailable', 'unavailable'],
  ])('inviteUser maps the %s wire code to %s', async (wire, code) => {
    invoke.mockResolvedValue({ error: httpError({ error: wire }) });
    const { result } = mountHook([ACTOR], { canAdministerUsers: true });
    let outcome: InviteResult | undefined;
    await act(async () => {
      outcome = await result.current.inviteUser({ email: 'a@b.invalid', targetRole: 'viewer' });
    });
    expect(outcome).toEqual({ ok: false, code });
  });

  it('inviteUser treats a 200 without a password as a failure, not a success', async () => {
    invoke.mockResolvedValue({ data: { ok: true, userId: 'x', tempPassword: '' }, error: null });
    const { result } = mountHook([ACTOR], { canAdministerUsers: true });
    let outcome: InviteResult | undefined;
    await act(async () => {
      outcome = await result.current.inviteUser({ email: 'a@b.invalid', targetRole: 'viewer' });
    });
    expect(outcome).toEqual({ ok: false, code: 'unknown' });
  });

  it('inviteUser refuses to run two invitations at once', async () => {
    /* Mirrors `serializes concurrent calls to the same user`: a synchronous
       act() that captures the raw promise, then waitFor() for the request to
       register. Awaiting inside the first act would leave the scope open past
       the end of the test. */
    let resolveInvoke!: (value: { data: unknown; error: null }) => void;
    invoke.mockImplementation(
      () => new Promise<{ data: unknown; error: null }>((resolve) => (resolveInvoke = resolve)),
    );
    const { result } = mountHook([ACTOR], { canAdministerUsers: true });
    let first: Promise<InviteResult>;
    act(() => {
      first = result.current.inviteUser({ email: 'a@b.invalid', targetRole: 'viewer' });
    });
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    let duplicate: InviteResult | undefined;
    await act(async () => {
      duplicate = await result.current.inviteUser({ email: 'c@d.invalid', targetRole: 'editor' });
    });
    expect(duplicate).toEqual({ ok: false, code: 'in-flight' });
    await act(async () => {
      resolveInvoke({ data: { ok: true, userId: 'x', tempPassword: TEMP_PASSWORD }, error: null });
      await first;
    });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  /* ----------------------------------------------------- resetUserPassword */

  it('resetUserPassword returns the one-time password and the audit status', async () => {
    invoke.mockResolvedValue({
      data: { ok: true, tempPassword: TEMP_PASSWORD, auditRecorded: true },
      error: null,
    });
    const { result } = mountHook([ACTOR, resetTarget()], { canAdministerUsers: true });
    let outcome: PasswordResetResult | undefined;
    await act(async () => {
      outcome = await result.current.resetUserPassword('target');
    });
    expect(outcome).toEqual({
      ok: true,
      userId: 'target',
      tempPassword: TEMP_PASSWORD,
      auditRecorded: true,
    });
    expect(invoke).toHaveBeenCalledWith('admin-set-password', { body: { userId: 'target' } });
  });

  it('resetUserPassword surfaces a missing audit row instead of hiding it', async () => {
    invoke.mockResolvedValue({
      data: { ok: true, tempPassword: TEMP_PASSWORD, auditRecorded: false },
      error: null,
    });
    const { result } = mountHook([ACTOR, resetTarget()], { canAdministerUsers: true });
    let outcome: PasswordResetResult | undefined;
    await act(async () => {
      outcome = await result.current.resetUserPassword('target');
    });
    expect(outcome?.ok).toBe(true);
    if (outcome?.ok) {
      // The password is already live, so it must still be handed back.
      expect(outcome.tempPassword).toBe(TEMP_PASSWORD);
      expect(outcome.auditRecorded).toBe(false);
    }
  });

  it.each([
    ['owner_protection', 'owner-protection'],
    ['permission_denied', 'forbidden'],
    ['user_not_found', 'not-found'],
  ])('resetUserPassword maps the %s wire code to %s', async (wire, code) => {
    invoke.mockResolvedValue({ error: httpError({ error: wire }) });
    const { result } = mountHook([ACTOR, resetTarget()], { canAdministerUsers: true });
    let outcome: PasswordResetResult | undefined;
    await act(async () => {
      outcome = await result.current.resetUserPassword('target');
    });
    expect(outcome).toEqual({ ok: false, userId: 'target', code });
  });

  it('resetUserPassword never targets a protected account, even before asking (D6)', async () => {
    const { result } = mountHook(
      [ACTOR, resetTarget({ id: 'owner', isProtected: true, isSuperAdmin: true })],
      { canAdministerUsers: true },
    );
    let outcome: PasswordResetResult | undefined;
    await act(async () => {
      outcome = await result.current.resetUserPassword('owner');
    });
    expect(outcome).toEqual({ ok: false, userId: 'owner', code: 'owner-protection' });
    expect(passwordResetFailureMessageKey({ code: 'owner-protection' })).toBe(
      'users.password.error.ownerProtection',
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it('resetUserPassword refuses a pending signup locally — there is no session to recover', async () => {
    const { result } = mountHook([ACTOR, resetTarget({ approvalStatus: 'pending' })], {
      canAdministerUsers: true,
    });
    let outcome: PasswordResetResult | undefined;
    await act(async () => {
      outcome = await result.current.resetUserPassword('target');
    });
    expect(outcome).toEqual({ ok: false, userId: 'target', code: 'owner-protection' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('resetUserPassword is gated on owner/super_admin authority (D2)', async () => {
    const { result } = mountHook([ACTOR, resetTarget()], { canAdministerUsers: false });
    let outcome: PasswordResetResult | undefined;
    await act(async () => {
      outcome = await result.current.resetUserPassword('target');
    });
    expect(outcome).toEqual({ ok: false, userId: 'target', code: 'forbidden' });
    expect(invoke).not.toHaveBeenCalled();
  });
});
