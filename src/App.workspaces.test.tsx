import { render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AuthCapabilitiesModule from '@/hooks/useAuthCapabilities';
import App from '@/App';

vi.mock('@/context/AuthContext', () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: () => ({
    session: {
      user: {
        id: 'workspace-owner',
        email: 'owner@example.invalid',
        user_metadata: { full_name: 'Workspace Owner' },
      },
    },
    approvalStatus: 'approved',
    loading: false,
    configured: true,
    signIn: vi.fn(),
    signUp: vi.fn(),
    signOut: vi.fn(() => Promise.resolve({ error: null })),
  }),
}));

vi.mock('@/hooks/useAuthCapabilities', async (importOriginal) => {
  const actual = await importOriginal<typeof AuthCapabilitiesModule>();
  return {
    ...actual,
    AuthCapabilitiesProvider: ({ children }: { children: ReactNode }) => children,
    useAuthCapabilities: () => ({
      capabilities: ['*'],
      isAuthoritative: true,
      isLoading: false,
      configured: true,
      hasCapability: () => true,
      refetch: vi.fn(),
    }),
  };
});

vi.mock('@/lib/supabase', () => ({ getSupabase: () => null }));
vi.mock('@/components/layout/NotificationsProvider', () => ({
  NotificationsProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/components/layout/NotificationBell', () => ({ NotificationBell: () => null }));

describe('App workspace routes', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.classList.remove('dark');
  });

  it.each([
    ['/workspaces/1', '/workspaces/aps/letters', 'الخطابات'],
    ['/workspaces/2', '/workspaces/workshops-10th', 'المنتج التام — ورش العاشر'],
    ['/workspaces/3', '/workspaces/reports', 'التقارير والاستعلامات'],
  ] as const)('redirects legacy workspace %s to %s', async (legacyPath, canonicalPath, title) => {
    window.history.replaceState({}, '', legacyPath);

    render(<App />);

    expect(await screen.findByRole('heading', { name: title })).toBeTruthy();
    await waitFor(() => expect(window.location.pathname).toBe(canonicalPath));
  });
});
