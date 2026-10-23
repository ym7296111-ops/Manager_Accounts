import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import NotificationSettings from '@/components/notifications/NotificationSettings';
import { I18nProvider, LOCALE_STORAGE_KEY } from '@/i18n/I18nContext';
import { ar } from '@/i18n/locales/ar';
import SettingsPage from '@/pages/SettingsPage';

/**
 * Phase 3.3 acceptance tests — §3.7 A18 & A19
 * (`docs/consultations/2026-10-02-notifications-smtp-templates-design-study.md`).
 *
 * - A18: at a 360px *container* the screen collapses to one column and the editor/preview switch
 *   works, keeping the editor mounted so its draft survives; the layout is driven by `@container`
 *   breakpoints only (no viewport media queries) — the collapsible-drawer criterion.
 * - A19: `TemplatePreview` reports `dir="rtl"` for `locale="ar"` and `dir="ltr"` for `locale="en"`
 *   **inside the iframe**, and an explicitly-LTR block inside an RTL document is never mirrored.
 *
 * Two supporting cases round out the deliverable: the route wiring in `SettingsPage` and the
 * Realtime contract of `useNotificationRealtime` (templates table only → invalidation signal only).
 */

const { rpc, client, channelListeners } = vi.hoisted(() => {
  interface ChannelListener {
    table: string;
    callback: () => void;
  }
  const rpc = vi.fn();
  const channelListeners: ChannelListener[] = [];
  const channel = {
    on: vi.fn((_type: string, filter: { table: string }, callback: () => void) => {
      channelListeners.push({ table: filter.table, callback });
      return channel;
    }),
    subscribe: vi.fn((callback?: (status: string) => void) => {
      callback?.('SUBSCRIBED');
      return channel;
    }),
  };
  const client = {
    rpc,
    channel: vi.fn(() => channel),
    removeChannel: vi.fn(),
  };
  return { rpc, client, channelListeners };
});

vi.mock('@/lib/supabase', () => ({
  getSupabase: () => client,
}));

// The route gate (`SettingsPage` → `NotificationsSection`) resolves the caller's
// capability through `useAuth`, exactly like the other settings screens.
vi.mock('@/context/AuthContext', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
  useAuth: () => ({
    session: { user: { id: 'audit-actor', email: 'audit@example.invalid' } },
    loading: false,
    configured: true,
    signIn: vi.fn(),
    signOut: vi.fn(() => Promise.resolve({ error: null })),
  }),
}));

/** §2.9 — a masked carrier snapshot (`admin_get_email_transport`, §1.8). */
const TRANSPORT_SNAPSHOT = {
  id: 'default-smtp',
  slug: 'default-smtp',
  provider_type: 'smtp_generic',
  host: 'smtp.example.invalid',
  port: 587,
  tls_mode: 'starttls',
  auth_mode: 'login',
  username: 'smtp-user',
  sender_name: 'نظام الإدارة',
  sender_email: 'no-reply@example.invalid',
  reply_to_email: null,
  is_enabled: true,
  is_default: true,
  secrets_version: 2,
  has_password: true,
  fingerprint: '9f2c1a03',
  updated_at: '2026-10-02T10:00:00Z',
  created_at: '2026-10-01T00:00:00Z',
};

/** §2.7 — one `admin_list_notification_templates` row per `(key, locale)`. */
function templateRow(key: string, locale: 'ar' | 'en') {
  const isArabic = locale === 'ar';
  return {
    id: `${key}-${locale}-v3`,
    key,
    channel: 'email',
    locale,
    version: 3,
    status: 'active',
    is_current: true,
    subject: `${isArabic ? 'عنوان' : 'Subject'} ${key} {{user_name}}`,
    body_text: `${isArabic ? 'نص' : 'Text'} ${key} {{user_name}}`,
    body_html: isArabic
      ? `<div dir="rtl"><p>${key}</p><div dir="ltr"><code>LATIN-BLOCK</code></div></div>`
      : `<div dir="ltr"><p>${key}</p></div>`,
    layout_key: null,
    direction: isArabic ? 'rtl' : 'ltr',
    variables: [{ name: 'user_name', type: 'text', required: true }],
    sample_variables: { user_name: isArabic ? 'لينا' : 'Lina' },
    requires_tokens: false,
    content_hash: `${key}-${locale}`.padEnd(64, 'a').slice(0, 64),
    is_system: false,
    notes: null,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-02T00:00:00Z',
  };
}

function renderScreen(
  containerWidth = 360,
  cardGates: { canManageTransport?: boolean; canManageTemplates?: boolean } = {},
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = render(
    // A18: the *available space* is what matters — the (collapsible) sidebar decides it, so the
    // harness pins a container width instead of a window width.
    <div style={{ width: `${containerWidth}px` }} data-testid="container-probe">
      <I18nProvider>
        <QueryClientProvider client={queryClient}>
          <NotificationSettings {...cardGates} />
        </QueryClientProvider>
      </I18nProvider>
    </div>,
  );
  return { ...view, queryClient };
}

describe('NotificationSettings (Phase 3.3 — A18)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'ar');
    document.documentElement.lang = 'ar';
    document.documentElement.dir = 'rtl';
    channelListeners.length = 0;
    client.channel.mockClear();
    client.removeChannel.mockClear();
    rpc.mockReset().mockImplementation((fnName: string, args?: Record<string, unknown>) => {
      // The SettingsPage route gate resolves these two capabilities before it
      // mounts the screen; the harness actor is a notifications manager.
      if (
        fnName === 'can_manage_notification_templates' ||
        fnName === 'can_manage_email_transport'
      ) {
        return Promise.resolve({ data: true, error: null });
      }
      if (fnName === 'admin_list_notification_templates') {
        const key = typeof args?.p_key === 'string' ? args.p_key : 'auth.welcome_invitation';
        const locale = args?.p_locale === 'en' ? 'en' : 'ar';
        return Promise.resolve({ data: [templateRow(key, locale)], error: null });
      }
      if (fnName === 'admin_get_email_transport') {
        return Promise.resolve({ data: TRANSPORT_SNAPSHOT, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });
  });

  it('collapses to a single column at a 360px container and switches editor/preview without losing the draft', async () => {
    const { container } = renderScreen(360);

    // §3.6.1: the container — never the viewport — is the layout reference.
    const root = screen.getByTestId('notification-settings');
    expect(root.className).toContain('@container');
    expect(container.querySelector('[class~="@container"]')).not.toBeNull();

    // §3.6.2: one column by default; the fixed three-track grid only applies from `@3xl` up.
    const grid = screen.getByTestId('notification-settings-grid');
    expect(grid.className).toContain('grid-cols-1');
    expect(grid.className).toContain('@3xl:grid-cols-[9.5rem_minmax(0,1fr)_minmax(20rem,26rem)]');

    // The event rail is a horizontal scroller below `@3xl` and a sticky column at `@3xl`.
    const rail = screen.getByTestId('notification-event-rail');
    expect(rail.className).toContain('overflow-x-auto');
    expect(rail.className).toContain('snap-x');
    expect(rail.className).toContain('@3xl:sticky');
    expect(rail.className).toContain('@3xl:flex-col');

    // The active seeded events are the rail entries, and clicking one swaps `templateKey`.
    const welcome = screen.getByTestId('notification-event-auth.welcome_invitation');
    const suspension = screen.getByTestId('notification-event-security.suspension_alert');
    expect(screen.queryByTestId('notification-event-backup.failure_notice')).toBeNull();
    expect(welcome.getAttribute('aria-pressed')).toBe('true');
    expect(suspension.getAttribute('aria-pressed')).toBe('false');
    // §3.6.2: the transport card (SMTP) is collapsed by default.
    const editorPane = screen.getByTestId('notification-editor-pane');
    expect([...editorPane.querySelectorAll('details')].every((node) => !node.open)).toBe(true);

    // Editor visible, preview hidden but still mounted.
    const previewPane = screen.getByTestId('notification-preview-pane');
    expect(editorPane.className).toContain('block');
    expect(editorPane.className).toContain('@3xl:block');
    expect(previewPane.className).toContain('hidden');
    expect(previewPane.className).toContain('@3xl:block');

    // Type into the editor so pane switching can prove the draft survives.
    const bodyText = await screen.findByLabelText<HTMLTextAreaElement>('النص المجرد (Plain Text)');
    fireEvent.change(bodyText, { target: { value: 'مسودة تبقى في الحالة' } });

    fireEvent.click(screen.getByTestId('notification-pane-preview'));
    expect(screen.getByTestId('notification-pane-preview').getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(previewPane.className).toContain('block');
    expect(editorPane.className).toContain('hidden');
    // The editor is hidden — never unmounted — so its `textarea` state is preserved.
    expect(screen.getByLabelText('النص المجرد (Plain Text)')).toBe(bodyText);
    expect(bodyText.value).toBe('مسودة تبقى في الحالة');

    fireEvent.click(screen.getByTestId('notification-pane-editor'));
    expect(previewPane.className).toContain('hidden');
    expect(screen.getByLabelText<HTMLTextAreaElement>('النص المجرد (Plain Text)').value).toBe(
      'مسودة تبقى في الحالة',
    );

    // Switching the event re-fetches and re-seeds editor + preview from one shared record.
    fireEvent.click(suspension);
    expect(suspension.getAttribute('aria-pressed')).toBe('true');
    expect(welcome.getAttribute('aria-pressed')).toBe('false');
    await waitFor(() =>
      expect(within(editorPane).getByTestId('template-version-badge').textContent).toContain('v3'),
    );
    await waitFor(() =>
      expect(screen.getByTestId('template-preview-iframe').getAttribute('srcdoc') ?? '').toContain(
        'عنوان security.suspension_alert لينا',
      ),
    );

    // §3.6.2: a container-driven screen must not smuggle in viewport breakpoints.
    const source = readFileSync(
      resolve(process.cwd(), 'src/components/notifications/NotificationSettings.tsx'),
      'utf8',
    );
    expect(source).not.toMatch(/(?<!@)\b(?:sm|md|lg|xl|2xl|3xl):/);
  });

  it('registers the composite screen on /settings/app/notifications via SettingsPage', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });

    render(
      <I18nProvider>
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/settings/app/notifications']}>
            <Routes>
              <Route path="settings/:family/:section" element={<SettingsPage />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>
      </I18nProvider>,
    );

    expect(
      await screen.findByRole('heading', { level: 1, name: ar['settings.notifications.title'] }),
    ).toBeTruthy();
    expect(screen.getByText(ar['settings.notifications.description'])).toBeTruthy();
    // The route gate resolves the caller's capability first, so the composite
    // screen mounts one round trip later than the page heading.
    expect(await screen.findByTestId('notification-settings')).toBeTruthy();
    expect(await screen.findByTestId('notification-event-auth.welcome_invitation')).toBeTruthy();
  });

  it('keeps Realtime a templates-only invalidation signal (§3.6.4 / A16 contract)', async () => {
    const { queryClient } = renderScreen(1024);

    await waitFor(() => expect(channelListeners.length).toBeGreaterThan(0));
    // Exactly one subscription, targeting `notification_templates` only — never the secrets
    // carriers or the transports table.
    expect(channelListeners.map((entry) => entry.table)).toEqual(['notification_templates']);

    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    act(() => {
      channelListeners[0]?.callback();
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['notification-templates'] });
    await waitFor(() =>
      expect(screen.getByTestId('notification-realtime-state').getAttribute('data-state')).toBe(
        'live',
      ),
    );
  });
});

describe('NotificationSettings (Phase 3.3 — A19)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'ar');
    document.documentElement.lang = 'ar';
    document.documentElement.dir = 'rtl';
    channelListeners.length = 0;
    client.channel.mockClear();
    client.removeChannel.mockClear();
    rpc.mockReset().mockImplementation((fnName: string, args?: Record<string, unknown>) => {
      if (fnName === 'admin_list_notification_templates') {
        const key = typeof args?.p_key === 'string' ? args.p_key : 'auth.welcome_invitation';
        const locale = args?.p_locale === 'en' ? 'en' : 'ar';
        return Promise.resolve({ data: [templateRow(key, locale)], error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });
  });

  it('renders dir="rtl" for Arabic and dir="ltr" for English inside the sandboxed iframe', async () => {
    renderScreen(640);

    // The preview mounts once the real `(key, locale)` record lands (no seed flash).
    const iframe = await screen.findByTestId<HTMLIFrameElement>('template-preview-iframe');
    // §2.5(ج): the sandbox contract never changes — allow-same-origin and never allow-scripts.
    expect(iframe.getAttribute('sandbox')).toBe('allow-same-origin');
    expect(iframe.getAttribute('dir')).toBe('rtl');

    await waitFor(() => {
      const srcdoc = screen.getByTestId('template-preview-iframe').getAttribute('srcdoc') ?? '';
      // The iframe document root follows the template locale…
      expect(srcdoc).toContain('<html lang="ar" dir="rtl">');
      expect(srcdoc).toContain('<body dir="rtl">');
      // …and the Arabic record (with its masked sample variable) is what gets rendered.
      expect(srcdoc).toContain('عنوان auth.welcome_invitation لينا');
      // An explicitly-LTR block inside the RTL body keeps its own direction: no mirroring.
      expect(srcdoc).toContain('<div dir="ltr"><code>LATIN-BLOCK</code></div>');
      expect(srcdoc).toContain('<div dir="rtl">');
    });

    // Switch the content language to English → the English row drives the same preview.
    fireEvent.click(screen.getByTestId('notification-locale-en'));
    expect(screen.getByTestId('notification-locale-en').getAttribute('aria-pressed')).toBe('true');

    await waitFor(() => {
      // Switching the content language mounts the English record's own preview instance.
      const englishIframe = screen.getByTestId('template-preview-iframe');
      const srcdoc = englishIframe.getAttribute('srcdoc') ?? '';
      expect(englishIframe.getAttribute('dir')).toBe('ltr');
      expect(srcdoc).toContain('<html lang="en" dir="ltr">');
      expect(srcdoc).toContain('<body dir="ltr">');
      expect(srcdoc).toContain('Subject auth.welcome_invitation Lina');
      expect(srcdoc).not.toContain('LATIN-BLOCK');
    });
  });
});

describe('NotificationSettings — per-card Smart Hiding', () => {
  const SMTP_CARD_TITLE = 'إعدادات ناقل البريد (SMTP)';

  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'ar');
    document.documentElement.lang = 'ar';
    document.documentElement.dir = 'rtl';
    rpc.mockReset().mockImplementation((fnName: string, args?: Record<string, unknown>) => {
      if (fnName === 'admin_list_notification_templates') {
        const key = typeof args?.p_key === 'string' ? args.p_key : 'auth.welcome_invitation';
        const locale = args?.p_locale === 'en' ? 'en' : 'ar';
        return Promise.resolve({ data: [templateRow(key, locale)], error: null });
      }
      if (fnName === 'admin_get_email_transport') {
        return Promise.resolve({ data: TRANSPORT_SNAPSHOT, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });
  });

  it('shows the SMTP card to a settings.manage holder', async () => {
    renderScreen(360, { canManageTransport: true });
    expect(await screen.findByText(SMTP_CARD_TITLE)).toBeTruthy();
  });

  it('hides the SMTP card from a caller without settings.manage (server: can_manage_email_transport)', async () => {
    renderScreen(360, { canManageTransport: false, canManageTemplates: true });
    await screen.findByTestId('notification-settings');
    expect(screen.queryByText(SMTP_CARD_TITLE)).toBeNull();
    expect(rpc.mock.calls.some(([fn]) => fn === 'admin_get_email_transport')).toBe(false);
  });
});
