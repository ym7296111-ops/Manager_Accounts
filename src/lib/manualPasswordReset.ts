import type { PostgrestError } from '@supabase/supabase-js';
import { getSupabase } from './supabase';

/**
 * Manual password reset requests (the interim recovery path). Visitors submit
 * only their email; an authorized administrator enters a new password later
 * and sends it directly to GoTrue through `admin-reset-password`.
 *
 * The independent OTP helpers in `passwordRecovery` are intentionally untouched.
 * Errors are normalized into locale-independent codes so every screen can
 * translate them; nothing here returns prose.
 */
export type ManualResetErrorCode =
  'not-configured' | 'not-deployed' | 'duplicate-pending' | 'rate-limited' | 'network' | 'unknown';

export interface SubmitPasswordResetRequestInput {
  /** Account address the visitor cannot reach any more. */
  email: string;
}

/** Normalize a PostgREST INSERT failure into a translatable code. */
export function mapManualResetInsertError(error: PostgrestError): ManualResetErrorCode {
  const message = error.message.toLowerCase();
  if (error.code === '23505' || message.includes('duplicate key')) return 'duplicate-pending';
  if (
    error.code === 'PGRST204' ||
    error.code === 'PGRST205' ||
    message.includes('schema cache') ||
    message.includes('could not find the table')
  )
    return 'not-deployed';
  if (error.code === '429' || message.includes('rate limit')) return 'rate-limited';
  if (message.includes('failed to fetch') || message.includes('network')) return 'network';
  return 'unknown';
}

/**
 * Submit a request without revealing whether an account exists. Email is
 * normalized because the table check and unique open-request index rely on it.
 */
export async function submitPasswordResetRequest(
  input: SubmitPasswordResetRequestInput,
): Promise<{ error: ManualResetErrorCode | null }> {
  const client = getSupabase();
  if (client === null) return { error: 'not-configured' };

  try {
    const { error } = (await client.from('password_reset_requests').insert({
      email: input.email.trim().toLowerCase(),
    })) as { error: PostgrestError | null };
    return { error: error === null ? null : mapManualResetInsertError(error) };
  } catch {
    return { error: 'network' };
  }
}
