/**
 * Shared classification of a failed PostgREST read.
 *
 * Every read on a project-settings table fails in one of three ways the UI can
 * say something useful about:
 *
 *   * `forbidden` — the database refused the read (RLS / table privilege
 *     `42501`, or an expired/absent JWT `PGRST301`). This is NOT the same as an
 *     empty list: the caller must be told the grant is missing instead of being
 *     shown "nothing here yet".
 *   * `network` — the request never reached PostgREST.
 *   * `unknown` — anything else (a schema drift, a malformed projection, …).
 *
 * `unavailable` is deliberately not produced here: it means "this build has no
 * Supabase client at all", which each hook decides before issuing a request.
 *
 * The classifier never returns the server message. Messages are install
 * specific (they may name tables or grants) and the UI must stay translatable,
 * so only a value-free code crosses this boundary.
 */

export type PostgrestReadErrorCode = 'forbidden' | 'network' | 'unknown';

export function classifyPostgrestReadError(error: unknown): PostgrestReadErrorCode {
  const candidate = error as { code?: unknown; message?: unknown } | null;
  const code = typeof candidate?.code === 'string' ? candidate.code : '';
  const message = typeof candidate?.message === 'string' ? candidate.message.toLowerCase() : '';

  if (
    code === '42501' ||
    code === 'PGRST301' ||
    message.includes('permission denied') ||
    message.includes('permission_denied') ||
    message.includes('jwt')
  ) {
    return 'forbidden';
  }

  if (
    code === 'PGRST503' ||
    message.includes('failed to fetch') ||
    message.includes('networkerror') ||
    message.includes('timeout')
  ) {
    return 'network';
  }

  return 'unknown';
}
