import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BrandingProvider, useBranding } from '@/context/BrandingContext';
import { I18nProvider } from '@/i18n/I18nContext';
import { IDENTITY_STORAGE_KEY } from '@/lib/branding';

const { from, channel, state } = vi.hoisted(() => {
  const from = vi.fn();
  const channel = {
    on: vi.fn().mockReturnThis(),
    subscribe: vi.fn().mockReturnThis(),
  };
  const state = { configured: true };
  return { from, channel, state };
});

vi.mock('@/lib/supabase', () => ({
  getSupabase: () =>
    state.configured
      ? {
          from,
          channel: vi.fn(() => channel),
          removeChannel: vi.fn(),
          storage: {
            from: () => ({
              getPublicUrl: (path: string) => ({
                data: { publicUrl: `https://example.invalid/${path}` },
              }),
            }),
          },
        }
      : null,
}));

function Probe() {
  const branding = useBranding();
  return (
    <div>
      <span>{branding.displayName}</span>
      <span data-testid="revision">{branding.identity.assetsRevision}</span>
    </div>
  );
}

function renderBranding() {
  return render(
    <I18nProvider>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <BrandingProvider>
          <Probe />
        </BrandingProvider>
      </QueryClientProvider>
    </I18nProvider>,
  );
}

describe('BrandingProvider', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.title = 'نظام الإدارة';
    state.configured = true;
    from.mockReset().mockReturnValue({
      select: () => ({
        eq: () => ({
          maybeSingle: () =>
            Promise.resolve({
              data: {
                name_ar: 'هوية حية',
                name_en: 'Live Identity',
                admin_email: 'ops@example.com',
                phone: null,
                logo_path: null,
                logo_hash: null,
                favicon_path: null,
                favicon_hash: null,
                assets_revision: 7,
                updated_at: '2026-10-01T00:00:00Z',
                updated_by: null,
              },
              error: null,
            }),
        }),
      }),
    });
    channel.on.mockClear();
    channel.subscribe.mockClear();
  });

  it('loads the singleton row, paints the name, and writes the boot snapshot', async () => {
    renderBranding();
    expect(await screen.findByText('هوية حية')).toBeTruthy();
    await waitFor(() => expect(document.title).toBe('هوية حية'));
    expect(screen.getByTestId('revision').textContent).toBe('7');
    expect(window.localStorage.getItem(IDENTITY_STORAGE_KEY)).toContain('Live Identity');
  });

  it('subscribes to realtime as an invalidation signal only', async () => {
    renderBranding();
    await screen.findByText('هوية حية');
    expect(channel.on).toHaveBeenCalled();
    const args = channel.on.mock.calls[0] as unknown as [string, { table?: string }, unknown];
    expect(args[0]).toBe('postgres_changes');
    expect(args[1]?.table).toBe('app_identity_settings');
  });

  it('falls back without a configured Supabase client', async () => {
    state.configured = false;
    renderBranding();
    expect(await screen.findByText('نظام الإدارة')).toBeTruthy();
  });
});
