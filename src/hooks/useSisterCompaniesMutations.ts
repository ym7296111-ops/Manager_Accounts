import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import { SISTER_COMPANIES_QUERY_KEY, SISTER_COMPANIES_SELECT } from '@/hooks/useSisterCompanies';
import { validateName } from '@/lib/nameValidation';
import { getSupabase } from '@/lib/supabase';

/**
 * Write operations for the sister-companies tree.
 *
 * Shape of the contract, in one place:
 *
 *   create   `{ name }` (a parent company) or `{ name, parentId }` (a branch)
 *   rename   `{ id, name }`
 *   toggle   `{ id, is_active }`
 *   delete   `{ id }`                        → refused while branches exist
 *
 * `code` and `level` are never sent, on any verb: `sister_companies_before_write`
 * mints `SIS-###` for a parent and `SIS-###-##` for a branch, and derives the
 * level. `parent_id` travels exactly once — on INSERT, where it selects the
 * company the branch belongs to — and never on UPDATE: the trigger refuses a
 * changed parent or code with SQLSTATE 22023, because moving a branch would
 * silently rewrite its code and its meaning on every report. The
 * `assertKeysAbsent` checks make both invariants hard failures instead of
 * comments.
 *
 * Deleting a parent that still has branches is refused by
 * `on delete restrict` (23503), classified as `hasBranches`. The UI hides the
 * button in that case; the constraint is the real guard.
 *
 * Authorization is the database's (`project.settings:manage`). Every failure
 * is classified and surfaced instead of silently doing nothing.
 */

export type SisterCompanyWriteErrorCode =
  | 'unavailable'
  | 'forbidden'
  | 'network'
  | 'validation'
  /** 22023: the trigger refused a `parent_id`/`code`/`level` change. */
  | 'immutable'
  /** 23503 on delete: the company still has branches. */
  | 'hasBranches'
  /** 23503 on create: the chosen parent no longer exists. */
  | 'missingParent'
  /** The row no longer exists (deleted elsewhere, or filtered by RLS). */
  | 'notFound'
  | 'unknown';

/** The same SQLSTATE does not mean the same thing on every verb. */
export type SisterCompanyWriteOperation = 'create' | 'rename' | 'toggle' | 'delete';

export class SisterCompanyWriteError extends Error {
  readonly code: SisterCompanyWriteErrorCode;

  constructor(code: SisterCompanyWriteErrorCode) {
    super(code);
    this.name = 'SisterCompanyWriteError';
    this.code = code;
  }
}

/** Derived by the trigger; no payload may carry them. */
export const DERIVED_COLUMNS = ['code', 'level'] as const;

/** Written once on INSERT (`parent_id`) or never (`code`, `level`). */
export const IMMUTABLE_UPDATE_COLUMNS = ['code', 'level', 'parent_id'] as const;

const WRITTEN_COLUMNS = SISTER_COMPANIES_SELECT;

function assertKeysAbsent(payload: Record<string, unknown>, keys: readonly string[]): void {
  for (const key of keys) {
    if (key in payload) {
      throw new SisterCompanyWriteError('validation');
    }
  }
}

export interface CreateSisterCompanyInput {
  readonly name: string;
  /** Absent/null creates a parent company; an id creates a branch under it. */
  readonly parentId?: string | null;
}

export interface RenameSisterCompanyInput {
  readonly id: string;
  readonly name: string;
}

function validateNameOrThrow(raw: string): string {
  const result = validateName(raw);
  if (!result.ok) {
    throw new SisterCompanyWriteError('validation');
  }
  return result.value;
}

/**
 * INSERT payload: the name, plus `parent_id` when a branch is being created.
 * `code` and `level` are derived server-side and are asserted absent.
 */
export function buildCreatePayload(input: CreateSisterCompanyInput): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    name: validateNameOrThrow(input.name),
  };
  if (input.parentId !== undefined && input.parentId !== null && input.parentId !== '') {
    payload.parent_id = input.parentId;
  }
  assertKeysAbsent(payload, DERIVED_COLUMNS);
  return payload;
}

/** UPDATE payload for a rename: the name and nothing else. */
export function buildRenamePayload(name: string): Record<string, unknown> {
  const payload: Record<string, unknown> = { name: validateNameOrThrow(name) };
  assertKeysAbsent(payload, IMMUTABLE_UPDATE_COLUMNS);
  return payload;
}

/** The toggle writes the flag and nothing else. */
export function buildSetActivePayload(isActive: boolean): Record<string, unknown> {
  const payload: Record<string, unknown> = { is_active: isActive };
  assertKeysAbsent(payload, IMMUTABLE_UPDATE_COLUMNS);
  return payload;
}

/** Map a PostgREST failure onto a value-free code the UI can translate. */
export function classifySisterCompanyWriteError(
  error: unknown,
  operation: SisterCompanyWriteOperation,
): SisterCompanyWriteErrorCode {
  if (error instanceof SisterCompanyWriteError) {
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

  // 22023: the trigger refused a parent/code/level change, or a third level.
  if (code === '22023') {
    return 'immutable';
  }

  // 23503 flips meaning with the verb: on delete the company still has
  // branches; on create the parent it was pointed at is gone.
  if (code === '23503') {
    return operation === 'delete' ? 'hasBranches' : 'missingParent';
  }

  // 23514: the CHECK family — blank name, level outside 1..2, code/level
  // mismatch.
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
    throw new SisterCompanyWriteError('unavailable');
  }
  return supabase;
}

function useInvalidate() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: SISTER_COMPANIES_QUERY_KEY });
  };
}

export interface WrittenSisterCompanyRow {
  readonly id: string;
  readonly parent_id: string | null;
  readonly level: number;
  readonly code: string;
  readonly name: string;
  readonly is_active: boolean;
}

type SupabaseErrorLike = { code?: string; message?: string };

function unwrapSingle<T>(
  data: T | null,
  error: SupabaseErrorLike | null | undefined,
  operation: SisterCompanyWriteOperation,
): T {
  if (error !== null && error !== undefined) {
    throw new SisterCompanyWriteError(classifySisterCompanyWriteError(error, operation));
  }
  if (data === null) {
    throw new SisterCompanyWriteError('notFound');
  }
  return data;
}

export function useCreateSisterCompany(): UseMutationResult<
  WrittenSisterCompanyRow,
  SisterCompanyWriteError,
  CreateSisterCompanyInput
> {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (input) => {
      const payload = buildCreatePayload(input);
      const supabase = requireClient();
      const { data, error } = await supabase
        .from('sister_companies')
        .insert(payload)
        .select(WRITTEN_COLUMNS)
        .single();
      return unwrapSingle<WrittenSisterCompanyRow>(data, error, 'create');
    },
    onSuccess: invalidate,
  });
}

export function useRenameSisterCompany(): UseMutationResult<
  WrittenSisterCompanyRow,
  SisterCompanyWriteError,
  RenameSisterCompanyInput
> {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (input) => {
      const payload = buildRenamePayload(input.name);
      const supabase = requireClient();
      const { data, error } = await supabase
        .from('sister_companies')
        .update(payload)
        .eq('id', input.id)
        .select(WRITTEN_COLUMNS)
        .single();
      return unwrapSingle<WrittenSisterCompanyRow>(data, error, 'rename');
    },
    onSuccess: invalidate,
  });
}

export function useSetSisterCompanyActive(): UseMutationResult<
  WrittenSisterCompanyRow,
  SisterCompanyWriteError,
  { readonly id: string; readonly isActive: boolean }
> {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (input) => {
      const payload = buildSetActivePayload(input.isActive);
      const supabase = requireClient();
      const { data, error } = await supabase
        .from('sister_companies')
        .update(payload)
        .eq('id', input.id)
        .select(WRITTEN_COLUMNS)
        .single();
      return unwrapSingle<WrittenSisterCompanyRow>(data, error, 'toggle');
    },
    onSuccess: invalidate,
  });
}

export function useDeleteSisterCompany(): UseMutationResult<
  { readonly id: string },
  SisterCompanyWriteError,
  { readonly id: string }
> {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async ({ id }) => {
      const supabase = requireClient();
      /* `.select('id')` asks for the deleted rows back, which is what lets a
         zero-row delete be reported as `notFound` instead of "Deleted". */
      const { data, error } = await supabase
        .from('sister_companies')
        .delete()
        .eq('id', id)
        .select('id');

      if (error !== null && error !== undefined) {
        throw new SisterCompanyWriteError(classifySisterCompanyWriteError(error, 'delete'));
      }
      if (!Array.isArray(data) || data.length === 0) {
        throw new SisterCompanyWriteError('notFound');
      }
      return { id };
    },
    onSuccess: invalidate,
    /* A refused delete means the tree on screen was out of date (a branch was
       added elsewhere). Refetch so the row the user is looking at matches the
       database. */
    onError: invalidate,
  });
}
