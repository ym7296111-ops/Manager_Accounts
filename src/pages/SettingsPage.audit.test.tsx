/// <reference types="node" />
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cwd, env } from 'node:process';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import App from '@/App';
import { ar } from '@/i18n/locales/ar';
import { en } from '@/i18n/locales/en';
import { LOCALE_STORAGE_KEY } from '@/i18n/I18nContext';
import type * as UsersModule from '@/hooks/useUsersManagement';
import type * as RolesModule from '@/hooks/useRolesManagement';
import type * as SupportModule from '@/hooks/useSupportManagement';
import type * as IdentityModule from '@/hooks/useAppIdentity';
import type * as LocalizationModule from '@/hooks/useLocalizationAdmin';
import { useUsersManagement, type UsersManagementApi } from '@/hooks/useUsersManagement';
import { useRolesManagement, type RolesManagementApi } from '@/hooks/useRolesManagement';
import {
  useSupportManagement,
  type SupportManagementApi,
  type SupportTicket,
  type SupportTicketReply,
} from '@/hooks/useSupportManagement';
import { useAppIdentityAdmin, type AppIdentityAdminApi } from '@/hooks/useAppIdentity';
import { useLocalizationAdmin, type LocalizationAdminApi } from '@/hooks/useLocalizationAdmin';
import { fallbackIdentity } from '@/lib/branding';
import { fallbackLocalization } from '@/lib/localization';

// Exercise the real App router and actual screen DOM. Only authentication/data
// adapters are mocked; this is not a claim of authenticated production access.
vi.mock('@/context/AuthContext', () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: () => ({
    session: { user: { id: 'audit-actor', email: 'audit@example.invalid' } },
    loading: false,
    configured: true,
    signIn: vi.fn(),
    signOut: vi.fn(() => Promise.resolve({ error: null })),
  }),
}));
vi.mock('@/lib/supabase', () => ({
  getSupabase: () => ({
    from: (table: string) => ({
      select: () => ({
        eq: () => {
          const maybeSingle = () =>
            Promise.resolve({
              data:
                table === 'profiles'
                  ? { status: 'active' }
                  : table === 'app_identity_settings'
                    ? {
                        id: true,
                        name_ar: 'نظام الإدارة',
                        name_en: 'Admin System',
                        admin_email: 'support@example.com',
                        phone: null,
                        logo_path: null,
                        logo_hash: null,
                        favicon_path: null,
                        favicon_hash: null,
                        assets_revision: 1,
                        updated_at: '2026-10-01T00:00:00Z',
                        updated_by: null,
                      }
                    : null,
              error: null,
            });
          return Object.assign(
            Promise.resolve({ data: [{ roles: { slug: 'super_admin' } }], error: null }),
            {
              maybeSingle,
            },
          );
        },
      }),
    }),
    rpc: () => Promise.resolve({ data: true, error: null }),
    channel: () => ({
      on() {
        return this;
      },
      subscribe() {
        return this;
      },
    }),
    removeChannel: () => undefined,
    storage: {
      from: () => ({
        getPublicUrl: (path: string) => ({
          data: { publicUrl: `https://example.invalid/${path}` },
        }),
      }),
    },
  }),
}));
vi.mock('@/hooks/useUsersManagement', async (importOriginal) => ({
  ...(await importOriginal<typeof UsersModule>()),
  useUsersManagement: vi.fn(),
}));
vi.mock('@/hooks/useRolesManagement', async (importOriginal) => ({
  ...(await importOriginal<typeof RolesModule>()),
  useRolesManagement: vi.fn(),
}));
vi.mock('@/hooks/useSupportManagement', async (importOriginal) => ({
  ...(await importOriginal<typeof SupportModule>()),
  useSupportManagement: vi.fn(),
}));
vi.mock('@/hooks/useAppIdentity', async (importOriginal) => ({
  ...(await importOriginal<typeof IdentityModule>()),
  useAppIdentityAdmin: vi.fn(),
}));
vi.mock('@/hooks/useLocalizationAdmin', async (importOriginal) => ({
  ...(await importOriginal<typeof LocalizationModule>()),
  useLocalizationAdmin: vi.fn(),
}));

const USER = {
  id: 'audit-actor',
  email: 'audit@example.invalid',
  fullName: 'Audit administrator',
  status: 'active' as const,
  approvalStatus: 'approved' as const,
  roles: [{ slug: 'super_admin', nameAr: 'مدير النظام', nameEn: 'Super Administrator' }],
  isSuperAdmin: true,
  isProtected: true,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
};
const PERMISSION = {
  id: 'audit-wildcard',
  slug: '*',
  module: 'system',
  nameAr: 'كل الصلاحيات',
  nameEn: 'All permissions',
  description: null,
};
const ROLE = {
  id: 'audit-role',
  slug: 'super_admin',
  nameAr: 'مدير النظام',
  nameEn: 'Super Administrator',
  isSystem: true,
  assignedUserCount: 1,
  permissionIds: [PERMISSION.id],
  heldByActor: true,
};

function mockScreens() {
  vi.mocked(useUsersManagement).mockReturnValue({
    users: [USER],
    actorId: USER.id,
    actorIsSuperAdmin: true,
    actorCanApprove: true,
    activeSuperAdmins: [USER],
    isInitialLoading: false,
    isRefreshing: false,
    fetchError: null,
    lastSyncedAt: null,
    realtimeState: 'live',
    pendingUserId: null,
    approvalFilter: 'all',
    setApprovalFilter: vi.fn(),
    approveUser: vi.fn(),
    rejectUser: vi.fn(),
    changeUserRole: vi.fn(),
    inviteUser: vi.fn(),
    resetUserPassword: vi.fn(),
    actorCanInvite: true,
    refresh: vi.fn(),
    setUserStatus: vi.fn(() =>
      Promise.resolve({ ok: true as const, userId: USER.id, status: 'active' as const }),
    ),
  } satisfies UsersManagementApi);
  vi.mocked(useRolesManagement).mockReturnValue({
    roles: [ROLE],
    groups: [{ module: 'system', permissions: [PERMISSION] }],
    permissionsById: new Map([[PERMISSION.id, PERMISSION]]),
    actorIsSuperAdmin: true,
    isInitialLoading: false,
    isRefreshing: false,
    fetchError: null,
    lastSyncedAt: null,
    refresh: vi.fn(),
    selectedRole: ROLE,
    selectRole: vi.fn(),
    draft: {
      roleId: ROLE.id,
      baselineIds: new Set([PERMISSION.id]),
      selectedIds: new Set([PERMISSION.id]),
      grantedIds: [],
      revokedIds: [],
      isDirty: false,
    },
    protectedReasons: new Map([[PERMISSION.id, 'system-role-locked']]),
    saveBlocker: 'noop',
    togglePermission: vi.fn(() => null),
    toggleGroup: vi.fn(() => ({ added: 0, removed: 0, keptProtected: 0 })),
    getGroupState: vi.fn(() => 'all' as const),
    resetDraft: vi.fn(),
    isSaving: false,
    save: vi.fn(() =>
      Promise.resolve({ ok: true as const, roleId: ROLE.id, granted: [], revoked: [] }),
    ),
  } satisfies RolesManagementApi);
  const TICKET: SupportTicket = {
    id: '00000000-0000-4000-8000-000000000020',
    ticketNumber: 1042,
    userId: USER.id,
    assignedTo: USER.id,
    subject: 'Audit support ticket subject',
    description: 'Detailed audit support ticket description for testing.',
    status: 'in_progress',
    priority: 'high',
    lastActivityAt: '2026-10-01T01:00:00Z',
    resolvedAt: null,
    closedAt: null,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T01:00:00Z',
    requester: {
      id: USER.id,
      email: USER.email,
      fullName: USER.fullName,
      status: 'active',
      roles: USER.roles,
    },
  };

  const REPLY: SupportTicketReply = {
    id: '00000000-0000-4000-8000-000000000021',
    ticketId: TICKET.id,
    senderId: USER.id,
    isSupportReply: true,
    body: 'Initial support team reply.',
    createdAt: '2026-10-01T01:00:00Z',
    sender: TICKET.requester,
  };

  const identity = fallbackIdentity();
  vi.mocked(useAppIdentityAdmin).mockReturnValue({
    identity,
    logoUrl: null,
    faviconUrl: null,
    displayName: identity.nameAr,
    canManage: true,
    isIdentityLoading: false,
    isAccessLoading: false,
    isSaving: false,
    configured: true,
    refresh: vi.fn(),
    save: vi.fn(() => Promise.resolve({ ok: true as const, identity })),
  } satisfies AppIdentityAdminApi);

  const localization = fallbackLocalization();
  vi.mocked(useLocalizationAdmin).mockReturnValue({
    settings: localization,
    canManage: true,
    isAccessLoading: false,
    isSaving: false,
    configured: true,
    refresh: vi.fn(),
    save: vi.fn(() => Promise.resolve({ ok: true as const, settings: localization })),
  } satisfies LocalizationAdminApi);

  vi.mocked(useSupportManagement).mockReturnValue({
    tickets: [TICKET],
    replies: [REPLY],
    selectedTicket: TICKET,
    selectTicket: vi.fn(),
    actorId: USER.id,
    actorIsActive: true,
    actorIsSupportAgent: true,
    actorIsSuperAdmin: true,
    isInitialLoading: false,
    isRefreshing: false,
    isLoadingReplies: false,
    fetchError: null,
    repliesError: null,
    lastSyncedAt: null,
    realtimeState: 'live',
    isCreatingTicket: false,
    isSendingReply: false,
    isUpdatingStatus: false,
    refresh: vi.fn(),
    createTicket: vi.fn(() =>
      Promise.resolve({ ok: true as const, ticketId: TICKET.id, ticketNumber: 1042 }),
    ),
    addReply: vi.fn(() =>
      Promise.resolve({ ok: true as const, ticketId: TICKET.id, replyId: REPLY.id }),
    ),
    updateTicketStatus: vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        ticketId: TICKET.id,
        status: 'in_progress' as const,
        priority: 'high' as const,
      }),
    ),
  } satisfies SupportManagementApi);
}

const CASES = (['ar', 'en'] as const).flatMap((locale) =>
  (['users', 'roles', 'backup', 'support'] as const).map((section) => ({ locale, section })),
);

describe('default router / bilingual settings integration audit', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.lang = 'ar';
    document.documentElement.dir = 'rtl';
    mockScreens();
  });

  it.each(CASES)(
    'mounts the actual $section screen in $locale at its default protected route',
    async ({ locale, section }) => {
      const dictionary = locale === 'ar' ? ar : en;
      window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
      window.history.replaceState({}, '', `/settings/system/${section}`);
      const { container } = render(<App />);
      expect(
        await screen.findByRole('heading', { level: 1, name: dictionary[`nav.${section}`] }),
      ).toBeTruthy();
      if (section === 'backup') {
        expect(
          await screen.findByRole('heading', { name: dictionary['backup.native.title'] }),
        ).toBeTruthy();
        expect(
          screen.getByRole('link', { name: dictionary['backup.native.openDashboard'] }),
        ).toBeTruthy();
      } else if (section === 'users') {
        expect(screen.getByRole('table', { name: dictionary['users.table.label'] })).toBeTruthy();
      } else if (section === 'support') {
        expect(
          screen.getByRole('navigation', { name: dictionary['support.list.label'] }),
        ).toBeTruthy();
        expect(screen.getByRole('log', { name: dictionary['support.thread.label'] })).toBeTruthy();
      } else {
        expect(
          screen.getByRole('checkbox', {
            name: new RegExp(`^${locale === 'ar' ? PERMISSION.nameAr : PERMISSION.nameEn}`),
          }),
        ).toBeTruthy();
      }
      expect(window.location.pathname).toBe(`/settings/system/${section}`);
      expect(document.documentElement.lang).toBe(locale);
      expect(document.documentElement.dir).toBe(locale === 'ar' ? 'rtl' : 'ltr');
      expect(container.querySelector('main')?.textContent).not.toMatch(
        /\b(?:users|roles|backup|support)\.[a-zA-Z]+(?:\.[a-zA-Z]+)?/,
      );
      const queryContainer = container.querySelector('main [class~="@container"]');
      expect(queryContainer).not.toBeNull();
      // Optional export of real rendered DOM, for a separate Chromium CSS audit.
      // Ignored scratch output, never a production route or a deployed test page.
      if (env.AUDIT_EXPORT_LAYOUTS === '1' && queryContainer) {
        const directory = join(cwd(), '.cache/live-audit/layouts');
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, `${section}-${locale}.html`), queryContainer.outerHTML);
      }
    },
  );

  it.each(['ar', 'en'] as const)(
    'mounts the general branding screen in $locale at /settings/app/general',
    async (locale) => {
      const dictionary = locale === 'ar' ? ar : en;
      window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
      window.history.replaceState({}, '', '/settings/app/general');
      const { container } = render(<App />);
      expect(
        await screen.findByRole('heading', { level: 1, name: dictionary['nav.general'] }),
      ).toBeTruthy();
      expect(screen.getByLabelText(dictionary['identity.field.nameAr'])).toBeTruthy();
      expect(screen.getByLabelText(dictionary['identity.field.nameEn'])).toBeTruthy();
      expect(screen.getByRole('button', { name: dictionary['identity.save'] })).toBeTruthy();
      expect(window.location.pathname).toBe('/settings/app/general');
      expect(container.querySelector('main [class~="@container"]')).not.toBeNull();
    },
  );

  it.each(['ar', 'en'] as const)(
    'mounts the localization & theme screen in $locale at /settings/app/appearance',
    async (locale) => {
      const dictionary = locale === 'ar' ? ar : en;
      window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
      window.history.replaceState({}, '', '/settings/app/appearance');
      const { container } = render(<App />);
      expect(
        await screen.findByRole('heading', { level: 1, name: dictionary['nav.appearance'] }),
      ).toBeTruthy();
      expect(screen.getByLabelText(dictionary['appearance.field.locale'])).toBeTruthy();
      expect(screen.getByLabelText(dictionary['appearance.field.theme'])).toBeTruthy();
      expect(
        screen.getByRole('combobox', { name: dictionary['appearance.field.timezone'] }),
      ).toBeTruthy();
      expect(screen.getByRole('button', { name: dictionary['appearance.save'] })).toBeTruthy();
      expect(window.location.pathname).toBe('/settings/app/appearance');
      expect(container.querySelector('main [class~="@container"]')).not.toBeNull();
    },
  );
});
