import type { AuthError } from '@supabase/supabase-js';
import { env } from './env';
import { getSupabase } from './supabase';

/**
 * Self-service password flows (Phase 1) on top of the Supabase client.
 *
 * Three operations, one place:
 *   requestPasswordReset → the "forgot password" mailer (unauthenticated),
 *   updatePassword       → writes the new password for an open session,
 *   changePassword       → optional current-password proof, then the update.
 *
 * Errors are normalized into locale-independent codes so every screen can
 * translate them; nothing here returns prose. The session lifecycle itself
 * stays in `AuthContext` — these helpers only perform the write.
 */

/** Where Supabase must land the user after following the emailed link. */
export const PASSWORD_RESET_PATH = '/reset-password';

/**
 * Absolute redirect target handed to `resetPasswordForEmail`.
 *
 * This repository is a **template**: it is deployed to a different origin in
 * every environment, so no domain may be baked into the bundle. The target is
 * resolved through the single env entry point (`VITE_APP_URL`, declared in
 * `.env.example` and typed in `vite-env.d.ts`) with the browser origin as the
 * fallback for local development and preview deployments that do not set it.
 *
 * The operator must whitelist the result in Supabase → Authentication → URL
 * Configuration → Redirect URLs — see the "Authentication Setup" section of the
 * README. `env.appUrl` already strips a trailing slash, so the path always
 * joins with a single separator.
 */
export function passwordResetRedirectTo(): string {
  return `${env.appUrl}${PASSWORD_RESET_PATH}`;
}

/** Failure codes of {@link requestPasswordReset}. */
export type PasswordResetRequestErrorCode =
  'not-configured' | 'rate-limited' | 'network' | 'unknown';

/** Failure codes of the six digit recovery code pair. */
export type PasswordRecoveryCodeErrorCode =
  'not-configured' | 'invalid-code' | 'expired-code' | 'rate-limited' | 'network' | 'unknown';

/** Failure codes of {@link updatePassword} / {@link changePassword}. */
export type PasswordChangeErrorCode =
  | 'not-configured'
  | 'not-authenticated'
  | 'current-password-invalid'
  | 'server-rejected'
  | 'rate-limited'
  | 'network'
  | 'unknown';

function isNetworkFailure(error: AuthError): boolean {
  return (
    error.name === 'AuthRetryableFetchError' ||
    error.message.toLowerCase().includes('failed to fetch') ||
    error.message.toLowerCase().includes('network')
  );
}

function mapCommonError(error: AuthError): 'rate-limited' | 'network' | 'unknown' {
  if (error.status === 429 || error.message.toLowerCase().includes('rate limit')) {
    return 'rate-limited';
  }
  if (isNetworkFailure(error)) {
    return 'network';
  }
  return 'unknown';
}

function mapPasswordError(error: AuthError): PasswordChangeErrorCode {
  const message = error.message.toLowerCase();

  if (message.includes('auth session missing') || message.includes('invalid jwt')) {
    return 'not-authenticated';
  }
  if (message.includes('invalid login credentials')) {
    return 'current-password-invalid';
  }
  const common = mapCommonError(error);
  if (common !== 'unknown') {
    return common;
  }
  /* Everything else the server attributes to the value itself (too short for
     the project rules, identical to the previous password, ...). */
  if (message.includes('password')) {
    return 'server-rejected';
  }
  return 'unknown';
}

/**
 * Normalize a recovery-code rejection into a translatable reason.
 *
 * GoTrue answers a wrong, already used, or expired code with a single family
 * of messages ("Token has expired or is invalid", "Invalid token", ...); the
 * UI must not tell the visitor WHICH part failed, only that the code can no
 * longer be used.
 */
function mapRecoveryCodeError(error: AuthError): PasswordRecoveryCodeErrorCode {
  const common = mapCommonError(error);
  if (common !== 'unknown') {
    return common;
  }

  const message = error.message.toLowerCase();
  if (message.includes('expired')) {
    return 'expired-code';
  }
  if (
    message.includes('invalid') ||
    message.includes('token') ||
    message.includes('otp') ||
    message.includes('email not confirmed')
  ) {
    return 'invalid-code';
  }
  return 'unknown';
}

/**
 * Send the recovery email.
 *
 * The outcome is intentionally coarse: Supabase never reveals whether an
 * address exists, and this helper never invents a message either — callers
 * show the same neutral confirmation for every accepted submission.
 */
export async function requestPasswordReset(
  email: string,
): Promise<{ error: PasswordResetRequestErrorCode | null }> {
  const client = getSupabase();
  if (client === null) {
    return { error: 'not-configured' };
  }

  try {
    const { error } = await client.auth.resetPasswordForEmail(email, {
      redirectTo: passwordResetRedirectTo(),
    });
    return { error: error === null ? null : mapCommonError(error) };
  } catch {
    return { error: 'network' };
  }
}

/**
 * Ask Supabase to deliver a six digit recovery code to `email`.
 *
 * The OTP path is the PRIMARY flow: the visitor types the code inside the app,
 * so nothing depends on an emailed link being whitelisted, on a PKCE code
 * exchange, or on the deployment rewriting `/reset-password` — which removes
 * the whole class of "the email arrives but the link breaks" failures.
 *
 * `redirectTo` is deliberately omitted: there is no landing page to return to.
 * The caller must never branch on the outcome (GoTrue answers identically for
 * registered and unknown addresses, and so must the UI).
 */
export async function requestPasswordRecoveryCode(
  email: string,
): Promise<{ error: PasswordRecoveryCodeErrorCode | null }> {
  const client = getSupabase();
  if (client === null) {
    return { error: 'not-configured' };
  }

  try {
    const { error } = await client.auth.resetPasswordForEmail(email);
    return { error: error === null ? null : mapRecoveryCodeError(error) };
  } catch {
    return { error: 'network' };
  }
}

/**
 * Exchange the six digit code for the recovery session.
 *
 * On success Supabase opens (and persists) a recovery session, which is what
 * authorizes the following `updateUser({ password })` call. A code can be used
 * once; a second attempt is refused as invalid/expired.
 */
export async function verifyPasswordRecoveryCode(
  email: string,
  token: string,
): Promise<{ error: PasswordRecoveryCodeErrorCode | null }> {
  const client = getSupabase();
  if (client === null) {
    return { error: 'not-configured' };
  }

  try {
    const { error } = await client.auth.verifyOtp({ email, token, type: 'recovery' });
    return { error: error === null ? null : mapRecoveryCodeError(error) };
  } catch {
    return { error: 'network' };
  }
}

/**
 * Write a new password for the session currently held by the client — the
 * recovery session opened by the emailed link, or the signed-in session of a
 * user changing their own password.
 */
export async function updatePassword(
  newPassword: string,
): Promise<{ error: PasswordChangeErrorCode | null }> {
  const client = getSupabase();
  if (client === null) {
    return { error: 'not-configured' };
  }

  try {
    const { error } = await client.auth.updateUser({ password: newPassword });
    return { error: error === null ? null : mapPasswordError(error) };
  } catch {
    return { error: 'network' };
  }
}

/**
 * Change the password of the signed-in user.
 *
 * `currentPassword` is optional proof of identity: when it is filled in we
 * verify it against Supabase (which only ever answers "wrong" or "right",
 * never whether the account exists) and refuse the change on a mismatch.
 * Leaving it empty skips the check and writes the new password directly.
 */
export async function changePassword(input: {
  email: string;
  currentPassword: string;
  newPassword: string;
}): Promise<{ error: PasswordChangeErrorCode | null }> {
  const client = getSupabase();
  if (client === null) {
    return { error: 'not-configured' };
  }

  if (input.currentPassword !== '') {
    try {
      const { error } = await client.auth.signInWithPassword({
        email: input.email,
        password: input.currentPassword,
      });
      if (error !== null) {
        return { error: mapPasswordError(error) };
      }
    } catch {
      return { error: 'network' };
    }
  }

  return updatePassword(input.newPassword);
}
