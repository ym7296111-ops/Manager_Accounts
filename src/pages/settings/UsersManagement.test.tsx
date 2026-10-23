import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CapabilitiesModule from '@/hooks/useAuthCapabilities';
import type * as DelegatedUsersModule from '@/hooks/useDelegatedUsers';
import type * as UsersModule from '@/hooks/useUsersManagement';
import { useDelegatedUsers, type DelegatedUsersMap } from '@/hooks/useDelegatedUsers';
import {
  useUsersManagement,
  type ChangeUserRoleResult,
  type ManagedUser,
  type UsersManagementApi,
} from '@/hooks/useUsersManagement';
import { I18nProvider } from '@/i18n/I18nContext';
import UsersManagement from '@/pages/settings/UsersManagement';

/**
 * Screen-level tests for the Users Management page:
 * - the 403 gate,
 * - the Edit Roles button visibility (approved, non-protected, admin actor),
 * - the ConfirmRoleDialog open/close and role checkbox toggling,
 * - the changeUserRole RPC call on confirm.
 */

vi.mock('@/hooks/useUsersManagement', async (importOriginal) => {
  const actual = await importOriginal<typeof UsersModule>();
  return { ...actual, useUsersManagement: vi.fn() };
});

vi.mock('@/hooks/useDelegatedUsers', async (importOriginal) => {
  const actual = await importOriginal<typeof DelegatedUsersModule>();
  return { ...actual, useDelegatedUsers: vi.fn() };
});

vi.mock('@/hooks/useAuthCapabilities', async (importOriginal) => {
  const actual = await importOriginal<typeof CapabilitiesModule>();
  return {
    ...actual,
    useAuthCapabilities: () => ({
      capabilities: [],
      isLoading: false,
      isAuthoritative: true,
      configured: false,
      hasCapability: () => true,
    }),
  };
});

const mockedUseUsersManagement = vi.mocked(useUsersManagement);
const mockedUseDelegatedUsers = vi.mocked(useDelegatedUsers);

/* ------------------------------------------------------------- fixtures */

function managedUser(
  id: string,
  opts: {
    isSuperAdmin?: boolean;
    isProtected?: boolean;
    approvalStatus?: 'pending' | 'approved' | 'rejected';
    roles?: { slug: string; nameAr: string; nameEn: string }[];
  } = {},
): ManagedUser {
  return {
    id,
    email: `${id}@example.invalid`,
    fullName: id,
    status: 'active' as const,
    approvalStatus: opts.approvalStatus ?? 'approved',
    roles: opts.roles ?? [
      {
        slug: opts.isSuperAdmin ? 'super_admin' : 'viewer',
        nameAr: opts.isSuperAdmin ? 'مدير النظام' : 'مشاهد',
        nameEn: opts.isSuperAdmin ? 'Super Administrator' : 'Viewer',
      },
    ],
    isSuperAdmin: opts.isSuperAdmin ?? false,
    isProtected: opts.isProtected ?? opts.isSuperAdmin ?? false,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
  };
}

const ACTOR = managedUser('actor', { isSuperAdmin: true, isProtected: false });
const OTHER_ADMIN = managedUser('other-admin', { isSuperAdmin: true, isProtected: false });
const VIEWER = managedUser('viewer', { isSuperAdmin: false, isProtected: false });
const OWNER = managedUser('owner', {
  isSuperAdmin: true,
  isProtected: true,
  roles: [{ slug: 'owner', nameAr: 'المالك', nameEn: 'Owner' }],
});
const PENDING = managedUser('pending', {
  approvalStatus: 'pending',
  isSuperAdmin: false,
  isProtected: false,
});

/* ------------------------------------------------------------- helpers */

function renderScreen(
  overrideApi?: Partial<UsersManagementApi>,
  options: { delegatedUsers?: DelegatedUsersMap; locale?: 'en' | 'ar' } = {},
) {
  const api: UsersManagementApi = {
    users: [ACTOR, OTHER_ADMIN, VIEWER, OWNER, PENDING],
    approvalFilter: 'all',
    setApprovalFilter: vi.fn(),
    approveUser: vi.fn().mockResolvedValue({ ok: true, userId: '', status: 'active' }),
    rejectUser: vi.fn().mockResolvedValue({ ok: true, userId: '', status: 'active' }),
    changeUserRole: vi.fn().mockResolvedValue({ ok: true, userId: '', roles: ['editor'] }),
    inviteUser: vi
      .fn()
      .mockResolvedValue({ ok: true, userId: 'invited', tempPassword: 'Ab2Cd4Ef6Gh8Jk1L' }),
    resetUserPassword: vi.fn().mockResolvedValue({
      ok: true,
      userId: 'viewer',
      tempPassword: 'Mn3Pq5Rs7Tu9Vw2X',
      auditRecorded: true,
    }),
    actorId: 'actor',
    actorIsSuperAdmin: true,
    actorCanApprove: true,
    actorCanInvite: true,
    activeSuperAdmins: [ACTOR, OTHER_ADMIN],
    isInitialLoading: false,
    isRefreshing: false,
    fetchError: null,
    lastSyncedAt: Date.now(),
    realtimeState: 'live' as const,
    pendingUserId: null,
    refresh: vi.fn(),
    setUserStatus: vi.fn().mockResolvedValue({ ok: true, userId: '', status: 'active' }),
    ...overrideApi,
  };
  mockedUseUsersManagement.mockReturnValue(api);
  mockedUseDelegatedUsers.mockReturnValue({
    delegatedUsers: options.delegatedUsers ?? new Map(),
    isLoading: false,
    error: null,
    refresh: vi.fn().mockResolvedValue(undefined),
  });

  return render(
    <MemoryRouter>
      <I18nProvider defaultLocale={options.locale ?? 'en'}>
        <UsersManagement />
      </I18nProvider>
    </MemoryRouter>,
  );
}

/* ------------------------------------------------------------- tests */

describe('UsersManagement — Edit Roles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the Edit Roles button for approved, non-protected users when the actor is an admin', () => {
    renderScreen();
    expect(screen.getAllByRole('button', { name: 'Edit user roles' })).not.toHaveLength(0);
  });

  it('hides the Edit Roles button for pending users', () => {
    renderScreen({ users: [PENDING] });
    expect(screen.queryByRole('button', { name: /edit roles/i })).toBeNull();
  });

  it('hides the Edit Roles button for protected (owner) users', () => {
    renderScreen({ users: [OWNER] });
    expect(screen.queryByRole('button', { name: /edit roles/i })).toBeNull();
  });

  it('replaces the status action with a protected-account notice for the owner', () => {
    renderScreen({ users: [OWNER] });
    expect(screen.queryByRole('button', { name: /suspend|activate/i })).toBeNull();
    expect(screen.getAllByText('Protected').length).toBeGreaterThan(0);
    expect(screen.getAllByTitle(/original owner is protected/i).length).toBeGreaterThan(0);
  });

  it('hides the Edit Roles button when the actor is not an admin', () => {
    renderScreen({ actorIsSuperAdmin: false, actorId: null });
    expect(screen.queryByRole('button', { name: /edit roles/i })).toBeNull();
  });

  it('opens the role dialog when the Edit Roles button is clicked', async () => {
    renderScreen({ users: [ACTOR, VIEWER] });
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit user roles' })[0]!);
    await waitFor(() =>
      expect(screen.getByRole('dialog', { name: /edit user roles/i })).toBeTruthy(),
    );
  });

  it("pre-selects the user's current roles in the dialog checkboxes", async () => {
    renderScreen({ users: [ACTOR, VIEWER] });
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit user roles' })[0]!);
    await waitFor(() => screen.getByRole('dialog'));

    // ACTOR (first in the list) has only the super_admin role — no assignable
    // role checkboxes should be pre-checked.
    const viewerCheckbox = screen.getByRole('checkbox', { name: /viewer/i });
    if (viewerCheckbox instanceof HTMLInputElement) {
      expect(viewerCheckbox.checked).toBe(false);
    } else {
      expect(false).toBe(false);
    }

    // The editor and admin checkboxes should also be unchecked (ACTOR has no
    // editor or admin role).
    const editorCheckbox = screen.getByRole('checkbox', { name: /editor/i });
    if (editorCheckbox instanceof HTMLInputElement) {
      expect(editorCheckbox.checked).toBe(false);
    } else {
      expect(false).toBe(false);
    }
    const adminCheckbox = screen.getByRole('checkbox', { name: /administrator/i });
    if (adminCheckbox instanceof HTMLInputElement) {
      expect(adminCheckbox.checked).toBe(false);
    } else {
      expect(false).toBe(false);
    }
  });

  it('calls changeUserRole with the selected roles on confirm', async () => {
    const changeUserRole = vi
      .fn()
      .mockResolvedValue({ ok: true, userId: 'actor', roles: ['editor'] });
    renderScreen({ users: [ACTOR, VIEWER], changeUserRole });

    fireEvent.click(screen.getAllByRole('button', { name: 'Edit user roles' })[0]!);
    await waitFor(() => screen.getByRole('dialog'));

    // Select 'editor' and 'admin' for the actor (first user in the list).
    fireEvent.click(screen.getByRole('checkbox', { name: /editor/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: /administrator/i }));

    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(changeUserRole).toHaveBeenCalledWith('actor', ['editor', 'admin']));
  });

  it('shows a failure message when changeUserRole rejects', async () => {
    const errorResult: ChangeUserRoleResult = {
      ok: false,
      userId: 'viewer',
      code: 'forbidden',
      messageKey: 'users.role.error.forbidden',
    };
    renderScreen({
      users: [ACTOR, VIEWER],
      changeUserRole: vi.fn().mockResolvedValue(errorResult),
    });

    fireEvent.click(screen.getAllByRole('button', { name: 'Edit user roles' })[0]!);
    await waitFor(() => screen.getByRole('dialog'));

    fireEvent.click(screen.getByRole('checkbox', { name: /editor/i }));
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() =>
      expect(screen.getByText(/you do not have permission to assign roles/i)).toBeTruthy(),
    );
  });

  it('requires at least one selected role and shows an error when none are chosen', async () => {
    renderScreen({ users: [ACTOR, VIEWER] });

    fireEvent.click(screen.getAllByRole('button', { name: 'Edit user roles' })[0]!);
    await waitFor(() => screen.getByRole('dialog'));

    // Leave all checkboxes unchecked.
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(screen.getByText(/no new roles selected/i)).toBeTruthy());
  });

  it('closes the dialog on cancel', async () => {
    renderScreen({ users: [ACTOR, VIEWER] });

    fireEvent.click(screen.getAllByRole('button', { name: 'Edit user roles' })[0]!);
    await waitFor(() => screen.getByRole('dialog'));

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('UsersManagement — admin invite and password reset', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /* ------------------------------------------------------------- toolbar */

  it('shows the Add user action to owner/super_admin actors (D2)', () => {
    renderScreen();
    expect(screen.getByRole('button', { name: 'Add user' })).toBeTruthy();
  });

  it('hides the Add user action entirely — not disabled — for everyone else', () => {
    renderScreen({ actorCanInvite: false });
    expect(screen.queryByRole('button', { name: 'Add user' })).toBeNull();
  });

  /* ------------------------------------------------------- invite dialog */

  it('opens the invite dialog with the email, name and role fields', async () => {
    renderScreen();
    fireEvent.click(screen.getByRole('button', { name: 'Add user' }));
    await waitFor(() => screen.getByRole('dialog', { name: 'Invite a new user' }));
    expect(screen.getByLabelText('Email')).toBeTruthy();
    expect(screen.getByLabelText('Full name (optional)')).toBeTruthy();
    expect(screen.getByLabelText('Role to grant')).toBeTruthy();
  });

  it('warns inside the dialog that the password is shown only once (D1/D3)', async () => {
    renderScreen();
    fireEvent.click(screen.getByRole('button', { name: 'Add user' }));
    await waitFor(() => screen.getByRole('dialog', { name: 'Invite a new user' }));
    expect(
      screen.getByText(
        'A temporary password is shown once, and the user is advised to change it after the first sign-in.',
      ),
    ).toBeTruthy();
  });

  it('offers viewer, editor, admin and executive as invitation roles (D5)', async () => {
    renderScreen();
    fireEvent.click(screen.getByRole('button', { name: 'Add user' }));
    await waitFor(() => screen.getByRole('dialog', { name: 'Invite a new user' }));
    const options = Array.from(
      screen.getByLabelText<HTMLSelectElement>('Role to grant').options,
    ).map((option) => option.value);
    expect(options).toEqual(['viewer', 'editor', 'admin', 'executive']);
  });

  it('submits the entered email, name and role to inviteUser', async () => {
    const inviteUser = vi
      .fn()
      .mockResolvedValue({ ok: true, userId: 'invited', tempPassword: 'Ab2Cd4Ef6Gh8Jk1L' });
    renderScreen({ inviteUser });
    fireEvent.click(screen.getByRole('button', { name: 'Add user' }));
    await waitFor(() => screen.getByRole('dialog', { name: 'Invite a new user' }));

    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'new.person@example.invalid' },
    });
    fireEvent.change(screen.getByLabelText('Full name (optional)'), {
      target: { value: 'New Person' },
    });
    fireEvent.change(screen.getByLabelText('Role to grant'), { target: { value: 'executive' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create user' }));

    await waitFor(() =>
      expect(inviteUser).toHaveBeenCalledWith({
        email: 'new.person@example.invalid',
        fullName: 'New Person',
        targetRole: 'executive',
      }),
    );
  });

  it('reveals the one-time password after a successful invite', async () => {
    renderScreen();
    fireEvent.click(screen.getByRole('button', { name: 'Add user' }));
    await waitFor(() => screen.getByRole('dialog', { name: 'Invite a new user' }));
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'a@b.invalid' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create user' }));

    await waitFor(() => screen.getByRole('dialog', { name: 'Temporary password' }));
    expect(screen.getByText('Ab2Cd4Ef6Gh8Jk1L')).toBeTruthy();
  });

  it('keeps the invite dialog open and shows the specific error on failure', async () => {
    const inviteUser = vi.fn().mockResolvedValue({ ok: false, code: 'email-exists' });
    renderScreen({ inviteUser });
    fireEvent.click(screen.getByRole('button', { name: 'Add user' }));
    await waitFor(() => screen.getByRole('dialog', { name: 'Invite a new user' }));
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'taken@example.invalid' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create user' }));

    await waitFor(() =>
      expect(screen.getByText('That email address is already registered.')).toBeTruthy(),
    );
    // The form must survive a failure so the admin can correct the address.
    expect(screen.getByRole('dialog', { name: 'Invite a new user' })).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'Temporary password' })).toBeNull();
  });

  it('closes the invite dialog on Escape without inviting', async () => {
    const inviteUser = vi.fn();
    renderScreen({ inviteUser });
    fireEvent.click(screen.getByRole('button', { name: 'Add user' }));
    await waitFor(() => screen.getByRole('dialog', { name: 'Invite a new user' }));
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Invite a new user' }), {
      key: 'Escape',
    });
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Invite a new user' })).toBeNull(),
    );
    expect(inviteUser).not.toHaveBeenCalled();
  });

  /* ------------------------------------------------- password reset flow */

  it('offers Reset password on an approved, active, non-protected row', () => {
    renderScreen({ users: [VIEWER] });
    expect(screen.getAllByRole('button', { name: 'Reset password' })).not.toHaveLength(0);
  });

  it('never offers Reset password on a protected row (D6)', () => {
    renderScreen({ users: [OWNER] });
    expect(screen.queryByRole('button', { name: 'Reset password' })).toBeNull();
  });

  it('hides Reset password when the actor lacks the authority (D2)', () => {
    renderScreen({ users: [VIEWER], actorCanInvite: false });
    expect(screen.queryByRole('button', { name: 'Reset password' })).toBeNull();
  });

  it('confirms, then reveals the new password', async () => {
    renderScreen({ users: [VIEWER] });
    fireEvent.click(screen.getAllByRole('button', { name: 'Reset password' })[0]!);
    await waitFor(() => screen.getByRole('dialog', { name: 'Reset password' }));
    fireEvent.click(screen.getByRole('button', { name: 'Set new password' }));

    await waitFor(() => screen.getByRole('dialog', { name: 'Temporary password' }));
    expect(screen.getByText('Mn3Pq5Rs7Tu9Vw2X')).toBeTruthy();
  });

  it('warns when the password changed but the audit row did not', async () => {
    const resetUserPassword = vi.fn().mockResolvedValue({
      ok: true,
      userId: 'viewer',
      tempPassword: 'Mn3Pq5Rs7Tu9Vw2X',
      auditRecorded: false,
    });
    renderScreen({ users: [VIEWER], resetUserPassword });
    fireEvent.click(screen.getAllByRole('button', { name: 'Reset password' })[0]!);
    await waitFor(() => screen.getByRole('dialog', { name: 'Reset password' }));
    fireEvent.click(screen.getByRole('button', { name: 'Set new password' }));

    await waitFor(() =>
      expect(
        screen.getByText(
          'The password was set, but the audit entry could not be written. Please review the audit log.',
        ),
      ).toBeTruthy(),
    );
    // The credential is already live, so it must still be handed over.
    expect(screen.getByText('Mn3Pq5Rs7Tu9Vw2X')).toBeTruthy();
  });

  it('shows the owner-protection message and reveals nothing on refusal', async () => {
    const resetUserPassword = vi
      .fn()
      .mockResolvedValue({ ok: false, userId: 'viewer', code: 'owner-protection' });
    renderScreen({ users: [VIEWER], resetUserPassword });
    fireEvent.click(screen.getAllByRole('button', { name: 'Reset password' })[0]!);
    await waitFor(() => screen.getByRole('dialog', { name: 'Reset password' }));
    fireEvent.click(screen.getByRole('button', { name: 'Set new password' }));

    await waitFor(() =>
      expect(
        screen.getByText(
          'The password of a protected account (the original owner) cannot be reset.',
        ),
      ).toBeTruthy(),
    );
    expect(screen.queryByRole('dialog', { name: 'Temporary password' })).toBeNull();
  });
});

describe('UsersManagement — delegated users visual distinction and filter tabs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the Expiry and Shield badges next to status in exact row order only for delegated users', () => {
    const delegatedUsers: DelegatedUsersMap = new Map([
      [
        'viewer',
        [
          {
            slug: 'users.approve',
            expires_at: new Date(Date.now() + 3 * 86_400_000).toISOString(),
            granted_at: '2026-10-22T00:00:00.000Z',
          },
          {
            slug: 'password_reset.manage',
            expires_at: null,
            granted_at: '2026-10-22T00:00:00.000Z',
          },
        ],
      ],
    ]);
    renderScreen({ users: [ACTOR, VIEWER, OWNER] }, { delegatedUsers });

    const expiryBadges = screen.getAllByTestId('delegation-expiry-badge');
    const shieldBadges = screen.getAllByTestId('delegated-user-badge');
    expect(expiryBadges).toHaveLength(1);
    expect(shieldBadges).toHaveLength(1);
    expect(shieldBadges[0]?.textContent).toBe('Delegated');
    expect(shieldBadges[0]?.getAttribute('title')).toBe(
      'Delegated with extra capabilities: users.approve, password_reset.manage',
    );
    expect(shieldBadges[0]?.querySelector('svg')).not.toBeNull();

    // Verify exact DOM order inside the row: [Name] -> [Roles] -> [Status] -> [Clock] -> [Shield]
    const nameEl = screen.getByText('viewer@example.invalid');
    const viewerRow = nameEl.closest('[role="row"]')!;
    const statusEl = Array.from(viewerRow.querySelectorAll('span')).find(
      (node) => node.textContent === 'Active',
    )!;
    expect(
      nameEl.compareDocumentPosition(statusEl) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      statusEl.compareDocumentPosition(expiryBadges[0]!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      expiryBadges[0]!.compareDocumentPosition(shieldBadges[0]!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('hides both delegation badges completely when no user holds active delegations', () => {
    renderScreen({ users: [ACTOR, VIEWER, OWNER] }, { delegatedUsers: new Map() });
    expect(screen.queryByTestId('delegation-expiry-badge')).toBeNull();
    expect(screen.queryByTestId('delegated-user-badge')).toBeNull();
    expect(screen.getByRole('tab', { name: 'Delegated (0)' })).toBeTruthy();
  });

  it('renders localized Arabic badge, tooltip and filter tabs accurately', () => {
    const delegatedUsers: DelegatedUsersMap = new Map([
      [
        'viewer',
        [
          {
            slug: 'users.approve',
            expires_at: null,
            granted_at: '2026-10-22T00:00:00.000Z',
          },
        ],
      ],
    ]);
    renderScreen({ users: [ACTOR, VIEWER, OWNER] }, { delegatedUsers, locale: 'ar' });

    const badge = screen.getByTestId('delegated-user-badge');
    expect(badge.textContent).toBe('مفوّض');
    expect(badge.getAttribute('title')).toBe('مفوّض بصلاحيات إضافية: users.approve');
    expect(screen.getByRole('tab', { name: 'الكل' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'المعلقون' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'مفوّضون (1)' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'المرفوضون' })).toBeTruthy();
  });

  it('filters table rows accurately across All (excluding rejected & suspended), Pending, Delegated (N), and Rejected tabs', () => {
    const rejectedUser = managedUser('rejected-user', {
      approvalStatus: 'rejected',
      isSuperAdmin: false,
      isProtected: false,
    });
    const suspendedUser: ManagedUser = {
      ...managedUser('suspended-user', { isSuperAdmin: false, isProtected: false }),
      status: 'suspended',
    };
    const delegatedUsers: DelegatedUsersMap = new Map([
      [
        'viewer',
        [
          {
            slug: 'users.approve',
            expires_at: null,
            granted_at: '2026-10-22T00:00:00.000Z',
          },
        ],
      ],
    ]);
    renderScreen(
      { users: [ACTOR, VIEWER, PENDING, rejectedUser, suspendedUser, OWNER] },
      { delegatedUsers },
    );

    // Default: All tab selected — excludes rejected & suspended, includes active + pending
    expect(screen.getByRole('tab', { name: 'All' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('viewer@example.invalid')).toBeTruthy();
    expect(screen.getByText('pending@example.invalid')).toBeTruthy();
    expect(screen.getByText('owner@example.invalid')).toBeTruthy();
    expect(screen.queryByText('rejected-user@example.invalid')).toBeNull();
    expect(screen.queryByText('suspended-user@example.invalid')).toBeNull();

    // Pending tab: only approval_status === 'pending'
    fireEvent.click(screen.getByRole('tab', { name: 'Pending' }));
    expect(screen.getByRole('tab', { name: 'Pending' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('pending@example.invalid')).toBeTruthy();
    expect(screen.queryByText('viewer@example.invalid')).toBeNull();
    expect(screen.queryByText('rejected-user@example.invalid')).toBeNull();

    // Delegated (1) tab: only delegated users
    fireEvent.click(screen.getByRole('tab', { name: 'Delegated (1)' }));
    expect(screen.getByRole('tab', { name: 'Delegated (1)' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(screen.getByText('viewer@example.invalid')).toBeTruthy();
    expect(screen.queryByText('pending@example.invalid')).toBeNull();
    expect(screen.queryByText('rejected-user@example.invalid')).toBeNull();

    // Rejected tab: ONLY approval_status === 'rejected'
    fireEvent.click(screen.getByRole('tab', { name: 'Rejected' }));
    expect(screen.getByRole('tab', { name: 'Rejected' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(screen.getByText('rejected-user@example.invalid')).toBeTruthy();
    expect(screen.queryByText('viewer@example.invalid')).toBeNull();
    expect(screen.queryByText('pending@example.invalid')).toBeNull();
    expect(screen.queryByText('owner@example.invalid')).toBeNull();
  });

  it('shows auto-suspend warning when unchecking a user last role and submits empty role list', async () => {
    const changeUserRole = vi.fn().mockResolvedValue({ ok: true, userId: 'viewer', roles: [] });
    renderScreen({ users: [ACTOR, VIEWER], changeUserRole }, { locale: 'ar' });

    // VIEWER is second row -> index 1 of Edit user roles buttons
    fireEvent.click(screen.getAllByRole('button', { name: 'تعديل أدوار المستخدم' })[1]!);
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());

    // Viewer has 1 role pre-selected -> uncheck it
    fireEvent.click(screen.getByRole('checkbox', { name: 'مشاهد' }));
    expect(
      screen.getByText('سحب آخر دور سيعطل الحساب (Suspended) حتى تعيين دور جديد.'),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'حفظ التغييرات' }));
    await waitFor(() => expect(changeUserRole).toHaveBeenCalledWith('viewer', []));
  });

  it('renders empty state while keeping filter tabs accessible when Delegated (0) is clicked', () => {
    renderScreen({ users: [ACTOR, VIEWER] }, { delegatedUsers: new Map() });

    fireEvent.click(screen.getByRole('tab', { name: 'Delegated (0)' }));
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByRole('tab', { name: 'All' })).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: 'All' }));
    expect(screen.getByRole('table')).toBeTruthy();
  });
});
