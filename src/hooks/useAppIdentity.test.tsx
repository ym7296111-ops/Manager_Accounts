import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BrandingProvider } from '@/context/BrandingContext';
import { I18nProvider } from '@/i18n/I18nContext';
import { useAppIdentityAdmin } from '@/hooks/useAppIdentity';
import { fallbackIdentity } from '@/lib/branding';

const { rpc, upload, from, state, client } = vi.hoisted(() => {
  const rpc = vi.fn();
  const upload = vi.fn();
  const from = vi.fn();
  const channel = {
    on: vi.fn().mockReturnThis(),
    subscribe: vi.fn().mockReturnThis(),
  };
  const state = { configured: true };
  const client = {
    from,
    rpc,
    channel: vi.fn(() => channel),
    removeChannel: vi.fn(),
    storage: {
      from: vi.fn(() => ({
        upload,
        getPublicUrl: (path: string) => ({
          data: { publicUrl: `https://example.invalid/${path}` },
        }),
      })),
    },
  };
  return { rpc, upload, from, state, client };
});

vi.mock('@/lib/supabase', () => ({
  getSupabase: () => (state.configured ? client : null),
}));

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    session: { user: { id: 'actor' } },
    loading: false,
    configured: true,
    signIn: vi.fn(),
    signOut: vi.fn(),
  }),
}));

const ROW = {
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
  updated_by: 'actor',
};

function wrapper({ children }: { children: ReactNode }) {
  return (
    <I18nProvider>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <BrandingProvider>{children}</BrandingProvider>
      </QueryClientProvider>
    </I18nProvider>
  );
}

describe('useAppIdentityAdmin', () => {
  beforeEach(() => {
    state.configured = true;
    rpc.mockReset().mockImplementation((name: string) => {
      if (name === 'can_manage_app_identity') {
        return Promise.resolve({ data: true, error: null });
      }
      return Promise.resolve({
        data: {
          ...ROW,
          name_ar: 'اسم جديد',
          assets_revision: 2,
          updated_at: '2026-10-01T01:00:00Z',
        },
        error: null,
      });
    });
    upload.mockReset().mockResolvedValue({ data: { path: 'identity/logo/x.png' }, error: null });
    from.mockReset().mockReturnValue({
      select: () => ({
        eq: () => ({ maybeSingle: () => Promise.resolve({ data: ROW, error: null }) }),
      }),
    });
  });

  it('gates writers through can_manage_app_identity', async () => {
    const { result } = renderHook(() => useAppIdentityAdmin(), { wrapper });
    await waitFor(() => expect(result.current.canManage).toBe(true));
    expect(rpc).toHaveBeenCalledWith('can_manage_app_identity');
  });

  it('saves through admin_update_app_identity and never upserts storage objects', async () => {
    const { result } = renderHook(() => useAppIdentityAdmin(), { wrapper });
    await waitFor(() => expect(result.current.canManage).toBe(true));
    let outcome: Awaited<ReturnType<typeof result.current.save>> | undefined;
    await act(async () => {
      outcome = await result.current.save({
        nameAr: 'اسم جديد',
        nameEn: 'Admin System',
        adminEmail: 'support@example.com',
        phone: '',
        logoFile: null,
        faviconFile: null,
        clearLogo: false,
        clearFavicon: false,
        expectedUpdatedAt: ROW.updated_at,
      });
    });
    expect(outcome?.ok).toBe(true);
    expect(rpc).toHaveBeenCalledWith(
      'admin_update_app_identity',
      expect.objectContaining({ p_name_ar: 'اسم جديد', p_clear_logo: false }),
    );
    expect(upload).not.toHaveBeenCalled();
  });

  it('maps 42501 to a forbidden result instead of throwing', async () => {
    rpc.mockImplementation((name: string) => {
      if (name === 'can_manage_app_identity') {
        return Promise.resolve({ data: true, error: null });
      }
      return Promise.resolve({ data: null, error: { code: '42501', message: 'denied' } });
    });
    const { result } = renderHook(() => useAppIdentityAdmin(), { wrapper });
    await waitFor(() => expect(result.current.canManage).toBe(true));
    let outcome: Awaited<ReturnType<typeof result.current.save>> | undefined;
    await act(async () => {
      outcome = await result.current.save({
        nameAr: 'اسم جديد',
        nameEn: 'Admin System',
        adminEmail: '',
        phone: '',
        logoFile: null,
        faviconFile: null,
        clearLogo: false,
        clearFavicon: false,
        expectedUpdatedAt: fallbackIdentity().updatedAt,
      });
    });
    expect(outcome).toEqual({ ok: false, code: 'forbidden' });
  });
});
