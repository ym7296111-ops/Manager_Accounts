import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '@/lib/env';
import {
  changePassword,
  passwordResetRedirectTo,
  PASSWORD_RESET_PATH,
  requestPasswordRecoveryCode,
  requestPasswordReset,
  updatePassword,
  verifyPasswordRecoveryCode,
} from '@/lib/passwordRecovery';
import { getSupabase } from '@/lib/supabase';

/**
 * Supabase-facing password writes. Every test drives the client through a
 * mocked `getSupabase`, so the network is never touched.
 */
vi.mock('@/lib/supabase', () => ({
  getSupabase: vi.fn(() => null),
}));

function mockClient(overrides: {
  resetPasswordForEmail?: unknown;
  verifyOtp?: unknown;
  updateUser?: unknown;
  signInWithPassword?: unknown;
}) {
  const auth = {
    resetPasswordForEmail: vi
      .fn()
      .mockResolvedValue(overrides.resetPasswordForEmail ?? { error: null }),
    verifyOtp: vi.fn().mockResolvedValue(overrides.verifyOtp ?? { error: null }),
    updateUser: vi.fn().mockResolvedValue(overrides.updateUser ?? { error: null }),
    signInWithPassword: vi.fn().mockResolvedValue(overrides.signInWithPassword ?? { error: null }),
  };
  vi.mocked(getSupabase).mockReturnValue({ auth } as unknown as NonNullable<
    ReturnType<typeof getSupabase>
  >);
  return auth;
}

describe('passwordRecovery', () => {
  beforeEach(() => {
    vi.mocked(getSupabase).mockReturnValue(null);
  });

  it('points the emailed link at the reset screen of this origin when no app URL is set', () => {
    expect(PASSWORD_RESET_PATH).toBe('/reset-password');
    expect(passwordResetRedirectTo()).toBe(`${env.appUrl}/reset-password`);
    /* Fallback: no VITE_APP_URL in the test environment, so the browser origin wins. */
    expect(env.appUrl).toBe(window.location.origin);
  });

  it('sends the recovery mail with the absolute redirect target', async () => {
    const auth = mockClient({});

    await expect(requestPasswordReset('user@example.com')).resolves.toEqual({ error: null });
    expect(auth.resetPasswordForEmail).toHaveBeenCalledWith('user@example.com', {
      redirectTo: passwordResetRedirectTo(),
    });
  });

  it('never reports an unknown address differently from a known one', async () => {
    mockClient({});

    /* GoTrue answers identically for both cases: an empty error means "we may
       have sent something", never "this account exists". */
    await expect(requestPasswordReset('nobody@example.com')).resolves.toEqual({ error: null });
  });

  it('maps a missing Supabase configuration on the reset request', async () => {
    await expect(requestPasswordReset('user@example.com')).resolves.toEqual({
      error: 'not-configured',
    });
  });

  it('maps a rate-limited reset request', async () => {
    mockClient({
      resetPasswordForEmail: { error: { status: 429, message: 'Email rate limit exceeded' } },
    });

    await expect(requestPasswordReset('user@example.com')).resolves.toEqual({
      error: 'rate-limited',
    });
  });

  it('writes the new password for the open session', async () => {
    const auth = mockClient({});

    await expect(updatePassword('a-long-enough-password')).resolves.toEqual({ error: null });
    expect(auth.updateUser).toHaveBeenCalledWith({ password: 'a-long-enough-password' });
  });

  it('maps a missing recovery session on the write', async () => {
    mockClient({ updateUser: { error: { message: 'Auth session missing!' } } });

    await expect(updatePassword('a-long-enough-password')).resolves.toEqual({
      error: 'not-authenticated',
    });
  });

  it('maps a server-side password refusal', async () => {
    mockClient({
      updateUser: { error: { message: 'New password should be different from the old password.' } },
    });

    await expect(updatePassword('a-long-enough-password')).resolves.toEqual({
      error: 'server-rejected',
    });
  });

  it('skips the verification call when no current password is supplied', async () => {
    const auth = mockClient({});

    await expect(
      changePassword({ email: 'user@example.com', currentPassword: '', newPassword: 'newpass123' }),
    ).resolves.toEqual({ error: null });
    expect(auth.signInWithPassword).not.toHaveBeenCalled();
    expect(auth.updateUser).toHaveBeenCalledWith({ password: 'newpass123' });
  });

  it('verifies a supplied current password before writing', async () => {
    const auth = mockClient({});

    await expect(
      changePassword({
        email: 'user@example.com',
        currentPassword: 'oldpass123',
        newPassword: 'newpass123',
      }),
    ).resolves.toEqual({ error: null });
    expect(auth.signInWithPassword).toHaveBeenCalledWith({
      email: 'user@example.com',
      password: 'oldpass123',
    });
    expect(auth.updateUser).toHaveBeenCalledWith({ password: 'newpass123' });
  });

  it('refuses the change when the current password is wrong', async () => {
    const auth = mockClient({
      signInWithPassword: { error: { message: 'Invalid login credentials' } },
    });

    await expect(
      changePassword({
        email: 'user@example.com',
        currentPassword: 'wrong-one',
        newPassword: 'newpass123',
      }),
    ).resolves.toEqual({ error: 'current-password-invalid' });
    expect(auth.updateUser).not.toHaveBeenCalled();
  });
});

/**
 * The repository is a template deployed to a different origin per environment,
 * so the emailed link must never carry a domain baked into the source. These
 * cases reload the modules with a stubbed `VITE_APP_URL` (the value Vercel /
 * `.env.local` injects at build time) to pin the resolution order.
 */
describe('passwordResetRedirectTo (template-safe origin resolution)', () => {
  async function redirectWith(appUrl: string | undefined): Promise<string> {
    if (appUrl === undefined) {
      vi.stubEnv('VITE_APP_URL', '');
    } else {
      vi.stubEnv('VITE_APP_URL', appUrl);
    }
    vi.resetModules();
    const fresh = await import('@/lib/passwordRecovery');
    return fresh.passwordResetRedirectTo();
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('prefers the configured VITE_APP_URL over the browser origin', async () => {
    await expect(redirectWith('https://admin.example.com')).resolves.toBe(
      'https://admin.example.com/reset-password',
    );
  });

  it('normalizes a trailing slash so the path never doubles up', async () => {
    await expect(redirectWith('https://admin.example.com/')).resolves.toBe(
      'https://admin.example.com/reset-password',
    );
  });

  it('falls back to the current origin when VITE_APP_URL is absent or blank', async () => {
    await expect(redirectWith(undefined)).resolves.toBe(`${window.location.origin}/reset-password`);
    await expect(redirectWith('')).resolves.toBe(`${window.location.origin}/reset-password`);
  });
});

/**
 * The OTP pair is the primary recovery path: the code is typed inside the app,
 * so nothing here may send a redirect target or depend on a landing page.
 */
describe('password recovery OTP (primary path)', () => {
  beforeEach(() => {
    vi.mocked(getSupabase).mockReturnValue(null);
  });

  it('requests the code without any redirect option', async () => {
    const auth = mockClient({});

    await expect(requestPasswordRecoveryCode('user@example.com')).resolves.toEqual({ error: null });
    expect(auth.resetPasswordForEmail).toHaveBeenCalledWith('user@example.com');
    expect(auth.resetPasswordForEmail).toHaveBeenCalledTimes(1);
  });

  it('reports a missing Supabase configuration on the code request', async () => {
    await expect(requestPasswordRecoveryCode('user@example.com')).resolves.toEqual({
      error: 'not-configured',
    });
  });

  it('exchanges the six digit code for a recovery session', async () => {
    const auth = mockClient({});

    await expect(verifyPasswordRecoveryCode('user@example.com', '123456')).resolves.toEqual({
      error: null,
    });
    expect(auth.verifyOtp).toHaveBeenCalledWith({
      email: 'user@example.com',
      token: '123456',
      type: 'recovery',
    });
  });

  it.each([
    ['Token has expired or is invalid', 'expired-code'],
    ['Invalid token', 'invalid-code'],
    ['Email not confirmed', 'invalid-code'],
  ])('maps "%s" to %s', async (message, expected) => {
    mockClient({ verifyOtp: { error: { message } } });

    await expect(verifyPasswordRecoveryCode('user@example.com', '123456')).resolves.toEqual({
      error: expected,
    });
  });

  it('maps a rate-limited verification', async () => {
    mockClient({ verifyOtp: { error: { status: 429, message: 'Too many requests' } } });

    await expect(verifyPasswordRecoveryCode('user@example.com', '123456')).resolves.toEqual({
      error: 'rate-limited',
    });
  });

  it('maps an unconfigured environment on verification', async () => {
    await expect(verifyPasswordRecoveryCode('user@example.com', '123456')).resolves.toEqual({
      error: 'not-configured',
    });
  });

  it('never leaks the presence of an account: unknown addresses succeed too', async () => {
    const auth = mockClient({});

    await expect(requestPasswordRecoveryCode('stranger@example.com')).resolves.toEqual({
      error: null,
    });
    expect(auth.resetPasswordForEmail).toHaveBeenCalledWith('stranger@example.com');
  });
});
