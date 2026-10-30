import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import { ISSUERS_QUERY_KEY, ISSUERS_SELECT } from '@/hooks/useIssuers';
import { isIssuerCode, validateIssuerName } from '@/lib/issuers';
import { getSupabase } from '@/lib/supabase';

/**
 * Write operations for the issuer register.
 *
 * The contract, in one place:
 *
 *   create   `{ code, name }`   → the code is written exactly once
 *   rename   `{ name }`         → the name only; the code is the identity
 *   toggle   `{ is_active }`    → deactivate instead of delete
 *
 * There is no delete verb. A code that has been printed on a letter must stay
 * readable: `letters.issuer_code` references it and the history would lose its
 * meaning. The database does not grant `delete` on the table at all, so a
 * delete could only fail — the UI never offers one.
 *
 * `code` and `id` are never sent on update. `assertKeysAbsent` makes that a
 * hard failure instead of a comment: an update that carried `code` would
 * rewrite the prefix of every historical letter that points at the row.
 *
 * Authorization is the database's (`project.settings:manage`). Every failure is
 * classified and surfaced instead of silently doing nothing.
 */

export type IssuerWriteErrorCode =
  | 'unavailable'
  | 'forbidden'
  | 'network'
  /** The two letters are not `[A-Z]{2}`, or the name is over 120 characters. */
  | 'validation'
  /** 23505: a code that is already in the register (case-insensitively). */
  | 'duplicate'
  /** The row no longer exists (removed elsewhere, or filtered by RLS). */
  | 'notFound'
  | 'unknown';

export type IssuerWriteOperation = 'create' | 'rename' | 'toggle';

export class IssuerWriteError extends Error {
  readonly code: IssuerWriteErrorCode;

  constructor(code: IssuerWriteErrorCode) {
    super(code);
    this.name = 'IssuerWriteError';
    this.code = code;
  }
}

/** The code is the row's identity: written on INSERT, never changed. */
export const IMMUTABLE_UPDATE_COLUMNS = ['id', 'code'] as const;

function assertKeysAbsent(payload: Record<string, unknown>, keys: readonly string[]): void {
  for (const key of keys) {
    if (key in payload) {
      throw new IssuerWriteError('validation');
    }
  }
}

export interface CreateIssuerInput {
  readonly code: string;
  /** Optional in the UI; a blank name falls back to the code. */
  readonly name: string;
}

export interface RenameIssuerInput {
  readonly code: string;
  readonly name: string;
}

/**
 * The payload keeps the letters it was given, up-cased — it never truncates
 * `YMX` into `YM`, because silently writing a different code than the one the
 * administrator typed is worse than refusing it.
 */
function codeOrThrow(raw: string): string {
  const code = raw.trim().toUpperCase();
  if (!isIssuerCode(code)) {
    throw new IssuerWriteError('validation');
  }
  return code;
}

function nameOrThrow(raw: string, code: string): string {
  const result = validateIssuerName(raw, code);
  if (!result.ok) {
    throw new IssuerWriteError('validation');
  }
  return result.value;
}

/** INSERT payload: the two letters and the name — nothing derived, nothing else. */
export function buildCreateIssuerPayload(input: CreateIssuerInput): Record<string, unknown> {
  const code = codeOrThrow(input.code);
  return { code, name: nameOrThrow(input.name, code) };
}

/** UPDATE payload for a rename: the name and nothing else. */
export function buildRenameIssuerPayload(input: RenameIssuerInput): Record<string, unknown> {
  const code = codeOrThrow(input.code);
  const payload: Record<string, unknown> = { name: nameOrThrow(input.name, code) };
  assertKeysAbsent(payload, IMMUTABLE_UPDATE_COLUMNS);
  return payload;
}

/** The toggle writes the flag and nothing else. */
export function buildSetIssuerActivePayload(isActive: boolean): Record<string, unknown> {
  const payload: Record<string, unknown> = { is_active: isActive };
  assertKeysAbsent(payload, IMMUTABLE_UPDATE_COLUMNS);
  return payload;
}

/** Map a PostgREST failure onto a value-free code the UI can translate. */
export function classifyIssuerWriteError(
  error: unknown,
  operation: IssuerWriteOperation,
): IssuerWriteErrorCode {
  if (error instanceof IssuerWriteError) {
    return error.code;
  }

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

  // 23505: `issuers_code_key` or `issuers_code_upper_key`. Only a create can
  // reach it — the other two verbs never send a code.
  if (code === '23505' || message.includes('duplicate key')) {
    return operation === 'create' ? 'duplicate' : 'unknown';
  }

  // 23514: the CHECK family — code shape, blank name, name length.
  if (code === '23514') {
    return 'validation';
  }

  if (code === 'PGRST116') {
    return 'notFound';
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

/** Fails closed: with no configured client there is nothing to write to. */
function requireClient() {
  const supabase = getSupabase();
  if (supabase === null) {
    throw new IssuerWriteError('unavailable');
  }
  return supabase;
}

/**
 * Both the register and the entry dropdown are invalidated: the dropdown is
 * built from `aps_letter_entry_options`, which filters on `is_active`, so a
 * code added or deactivated here must disappear from — or appear in — the entry
 * screen without a reload.
 */
function useInvalidate() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ISSUERS_QUERY_KEY });
    void queryClient.invalidateQueries({ queryKey: ['aps', 'entry-options'] });
  };
}

export interface WrittenIssuerRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly is_active: boolean;
}

type SupabaseErrorLike = { code?: string; message?: string };

function unwrapSingle<T>(
  data: T | null,
  error: SupabaseErrorLike | null | undefined,
  operation: IssuerWriteOperation,
): T {
  if (error !== null && error !== undefined) {
    throw new IssuerWriteError(classifyIssuerWriteError(error, operation));
  }
  if (data === null) {
    throw new IssuerWriteError('notFound');
  }
  return data;
}

export function useCreateIssuer(): UseMutationResult<
  WrittenIssuerRow,
  IssuerWriteError,
  CreateIssuerInput
> {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (input) => {
      const payload = buildCreateIssuerPayload(input);
      const supabase = requireClient();
      const { data, error } = await supabase
        .from('issuers')
        .insert(payload)
        .select(ISSUERS_SELECT)
        .single();
      return unwrapSingle<WrittenIssuerRow>(data, error, 'create');
    },
    onSuccess: invalidate,
  });
}

export function useRenameIssuer(): UseMutationResult<
  WrittenIssuerRow,
  IssuerWriteError,
  RenameIssuerInput & { readonly id: string }
> {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (input) => {
      const payload = buildRenameIssuerPayload({ code: input.code, name: input.name });
      const supabase = requireClient();
      const { data, error } = await supabase
        .from('issuers')
        .update(payload)
        .eq('id', input.id)
        .select(ISSUERS_SELECT)
        .single();
      return unwrapSingle<WrittenIssuerRow>(data, error, 'rename');
    },
    onSuccess: invalidate,
  });
}

export function useSetIssuerActive(): UseMutationResult<
  WrittenIssuerRow,
  IssuerWriteError,
  { readonly id: string; readonly isActive: boolean }
> {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (input) => {
      const payload = buildSetIssuerActivePayload(input.isActive);
      const supabase = requireClient();
      const { data, error } = await supabase
        .from('issuers')
        .update(payload)
        .eq('id', input.id)
        .select(ISSUERS_SELECT)
        .single();
      return unwrapSingle<WrittenIssuerRow>(data, error, 'toggle');
    },
    onSuccess: invalidate,
  });
}
