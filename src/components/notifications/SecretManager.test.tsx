import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SecretManager } from '@/components/notifications/SecretManager';
import { I18nProvider, LOCALE_STORAGE_KEY } from '@/i18n/I18nContext';

const { rpc, client } = vi.hoisted(() => {
  const rpc = vi.fn();
  const client = { rpc };
  return { rpc, client };
});

vi.mock('@/lib/supabase', () => ({
  getSupabase: () => client,
}));

describe('SecretManager (§3.6.3 write-only secret contract)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'ar');
    rpc.mockReset().mockImplementation((fnName: string) => {
      if (fnName === 'admin_set_email_password') {
        return Promise.resolve({
          data: {
            has_password: true,
            fingerprint: '9f2c1a03',
            secrets_version: 2,
            updated_at: '2026-10-02T12:00:00Z',
          },
          error: null,
        });
      }
      if (fnName === 'admin_clear_email_password') {
        return Promise.resolve({
          data: {
            has_password: false,
            fingerprint: null,
            secrets_version: 3,
            updated_at: '2026-10-02T12:05:00Z',
          },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    });
  });

  it('wipes the password field value from state immediately after a successful submission and never persists it', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });

    render(
      <I18nProvider>
        <QueryClientProvider client={queryClient}>
          <SecretManager
            hasPassword={true}
            fingerprint="9f2c1a03deadbeef"
            updatedAt="2026-10-02T10:00:00Z"
            secretsVersion={1}
          />
        </QueryClientProvider>
      </I18nProvider>,
    );

    // §3.6.3: Only masked metadata is displayed (has_password, first 8 chars of fingerprint, updated_at).
    expect(screen.getByTestId('secret-has-password').textContent).toContain('has_password: true');
    expect(screen.getByTestId('secret-fingerprint').textContent).toBe('9f2c1a03');
    expect(screen.getByTestId('secret-updated-at').textContent).toBe('2026-10-02T10:00:00Z');

    // Open the standalone password rotation dialog.
    fireEvent.click(screen.getByRole('button', { name: 'تغيير كلمة المرور' }));
    expect(screen.getByRole('dialog')).toBeTruthy();

    const passwordInput = screen.getByLabelText<HTMLInputElement>('كلمة المرور');
    expect(passwordInput.type).toBe('password');
    expect(passwordInput.getAttribute('autocomplete')).toBe('new-password');
    expect(passwordInput.getAttribute('name')).toBe('np_7x9k');

    const secretValue = 'S3cret-SMTP-P@ssw0rd!';
    fireEvent.change(passwordInput, { target: { value: secretValue } });
    expect(passwordInput.value).toBe(secretValue);

    // Submit the form and verify that the password state is immediately wiped.
    fireEvent.click(screen.getByRole('button', { name: 'حفظ التغييرات' }));

    await waitFor(() => {
      expect(rpc).toHaveBeenCalledWith(
        'admin_set_email_password',
        expect.objectContaining({ p_new_password: secretValue }),
      );
      expect(passwordInput.value).toBe('');
    });

    // §3.6.3: Ensure the secret never leaked to localStorage or TanStack Query cache.
    expect(JSON.stringify(window.localStorage)).not.toContain(secretValue);
    expect(JSON.stringify(queryClient.getQueryCache().getAll())).not.toContain(secretValue);
  });
});
