import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import { CLASSIFICATIONS_QUERY_KEY } from '@/hooks/useClassifications';
import { getSupabase } from '@/lib/supabase';
import { validateName } from '@/lib/nameValidation';

/**
 * Write operations for the classifications tree.
 *
 * Shape of the contract, in one place:
 *
 *   create   `{ name }`                 → level 1 (root; `parent_id` omitted)
 *   create   `{ name, parent_id }`      → level 2 (under a category)
 *   create   `{ name, parent_id }`      → level 3 (under a group)
 *   rename   `{ id, name }`             → the name and nothing else
 *   toggle   `{ id, is_active }`        → the flag and nothing else
 *   delete   `{ id }`                   → refused by the FK when it has children
 *
 * The client never sends `code`, `level` or `is_leaf`, and has no code path that
 * could: the payload builders below construct an explicit allowlist, and
 * `assertNoDerivedColumns()` rejects a payload that somehow carries one. Those
 * three columns are owned by the database — `code` defaults to
 * `next_classification_code()` (a sequence-backed SECURITY DEFINER function),
 * while `level` and `is_leaf` are derived by the triggers from `parent_id`.
 *
 * `parent_id` is likewise write-once: it may appear on an INSERT (that is what
 * makes a child a child) and never on an UPDATE. Moving a node re-derives a
 * whole subtree's levels, so the UI does not offer it yet; `buildUpdatePayload`
 * has no branch that could set it.
 *
 * Authorization is the database's. The screen sits behind `RequireCapability`,
 * but that gate reads a capability snapshot and can disagree with a live grant
 * revoked or delegated away mid-session, so every failure is classified and
 * surfaced instead of silently succeeding or silently doing nothing.
 *
 * Deleting a node that still has children is refused by
 * `classifications_parent_id_fkey ... ON DELETE RESTRICT` (SQLSTATE 23503).
 * The UI hides the button in that case, but the constraint is the real guard:
 * a concurrent insert still produces a clear, classified `hasChildren` error.
 */

export type ClassificationWriteErrorCode =
  | 'unavailable'
  | 'forbidden'
  | 'network'
  | 'validation'
  /** 23503 on delete: the node still has children (ON DELETE RESTRICT). */
  | 'hasChildren'
  /** 23503 on create: the parent vanished between render and submit. */
  | 'missingParent'
  /** The row no longer exists (deleted elsewhere, or filtered by RLS). */
  | 'notFound'
  | 'unknown';

/**
 * What the caller was trying to do. The same SQLSTATE does not mean the same
 * thing everywhere: 23503 is "still has children" for a delete, but "the parent
 * is gone" for an insert, and 22023 is a move that would exceed three levels
 * (only reachable from an UPDATE).
 */
export type ClassificationWriteOperation = 'create' | 'rename' | 'toggle' | 'delete';

export class ClassificationWriteError extends Error {
  readonly code: ClassificationWriteErrorCode;

  constructor(code: ClassificationWriteErrorCode) {
    super(code);
    this.name = 'ClassificationWriteError';
    this.code = code;
  }
}

/**
 * Columns the database owns. The client may READ them (the tree renders codes
 * and the future letter screen needs `is_leaf`) but must never write them.
 */
export const DERIVED_COLUMNS = ['code', 'level', 'is_leaf'] as const;

/** What a write may echo back: the recomputed row, read-only. */
const WRITTEN_COLUMNS = 'id, parent_id, code, name, level, is_leaf, is_active';

/**
 * Belt-and-braces. The payload builders cannot produce a derived column; this
 * makes that a checked invariant rather than a comment, so a future edit that
 * spreads caller input into a payload fails loudly before the request leaves
 * the client.
 */
function assertNoDerivedColumns(payload: Record<string, unknown>): void {
  for (const column of DERIVED_COLUMNS) {
    if (column in payload) {
      throw new ClassificationWriteError('validation');
    }
  }
}

export type CreateClassificationInput = {
  readonly name: string;
  /** Omit for a level-1 category. Present = the parent to append under. */
  readonly parentId?: string;
};

export type RenameClassificationInput = {
  readonly id: string;
  readonly name: string;
};

export type SetClassificationActiveInput = {
  readonly id: string;
  readonly isActive: boolean;
};

/**
 * INSERT payload: name, plus `parent_id` only when there is a parent.
 *
 * A root omits the key instead of sending `parent_id: null` — both are stored
 * the same way, but omitting keeps the payload exactly as small as the contract
 * and makes "this is a category" a property of the request, not of a null.
 */
export function buildCreatePayload(input: CreateClassificationInput): Record<string, unknown> {
  const result = validateName(input.name);
  if (!result.ok) {
    throw new ClassificationWriteError('validation');
  }

  const payload: Record<string, unknown> = { name: result.value };
  if (input.parentId !== undefined) {
    payload.parent_id = input.parentId;
  }

  assertNoDerivedColumns(payload);
  return payload;
}

/**
 * UPDATE payload. There is deliberately no branch for `parent_id`: moving a
 * node is out of scope for this phase, so the UI has no way to ask for it.
 */
export function buildUpdatePayload(
  input: Pick<RenameClassificationInput, 'name'> | Pick<SetClassificationActiveInput, 'isActive'>,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};

  if ('name' in input && input.name !== undefined) {
    const result = validateName(input.name);
    if (!result.ok) {
      throw new ClassificationWriteError('validation');
    }
    payload.name = result.value;
  }

  if ('isActive' in input && input.isActive !== undefined) {
    payload.is_active = input.isActive;
  }

  if (Object.keys(payload).length === 0) {
    throw new ClassificationWriteError('validation');
  }

  assertNoDerivedColumns(payload);
  return payload;
}

/** Map a PostgREST failure onto a value-free code the UI can translate. */
export function classifyClassificationWriteError(
  error: unknown,
  operation: ClassificationWriteOperation,
): ClassificationWriteErrorCode {
  if (error instanceof ClassificationWriteError) {
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

  // 23503 is a foreign-key violation, and which side broke depends on the verb:
  // a delete is refused because children reference the row (ON DELETE RESTRICT),
  // an insert is refused because its parent no longer exists.
  if (code === '23503') {
    return operation === 'delete' ? 'hasChildren' : 'missingParent';
  }

  // 23514: the *_name_not_blank CHECK. 22023: the level guard (a move past
  // three levels), which only an UPDATE could reach.
  if (code === '23514' || code === '22023') {
    return 'validation';
  }

  // PGRST116: `.single()` found zero rows — already deleted, or invisible under
  // RLS. Not an error state on the server, but nothing happened either.
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
    throw new ClassificationWriteError('unavailable');
  }
  return supabase;
}

/** Refetch the tree; used after a write settles and after a refused delete. */
function useInvalidate() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: CLASSIFICATIONS_QUERY_KEY });
  };
}

function useInvalidateOnSuccess() {
  return useInvalidate();
}

export interface WrittenClassificationRow {
  readonly id: string;
  readonly parent_id: string | null;
  readonly code: string;
  readonly name: string;
  readonly level: number;
  readonly is_leaf: boolean;
  readonly is_active: boolean;
}

type SupabaseErrorLike = { code?: string; message?: string };

/**
 * `.single()` on a write that matched nothing returns PGRST116. Treat that as
 * `notFound` rather than letting an undefined row reach the caller.
 */
function unwrapSingle<T>(
  data: T | null,
  error: SupabaseErrorLike | null | undefined,
  operation: ClassificationWriteOperation,
): T {
  if (error !== null && error !== undefined) {
    throw new ClassificationWriteError(classifyClassificationWriteError(error, operation));
  }
  if (data === null) {
    throw new ClassificationWriteError('notFound');
  }
  return data;
}

export function useCreateClassification(): UseMutationResult<
  WrittenClassificationRow,
  ClassificationWriteError,
  CreateClassificationInput
> {
  const invalidate = useInvalidateOnSuccess();
  return useMutation({
    mutationFn: async (input) => {
      /* Validation runs before the client is touched: an invalid name must not
         even open a request. */
      const payload = buildCreatePayload(input);
      const supabase = requireClient();
      const { data, error } = await supabase
        .from('classifications')
        .insert(payload)
        .select(WRITTEN_COLUMNS)
        .single();
      return unwrapSingle<WrittenClassificationRow>(data, error, 'create');
    },
    onSuccess: invalidate,
  });
}

export function useRenameClassification(): UseMutationResult<
  WrittenClassificationRow,
  ClassificationWriteError,
  RenameClassificationInput
> {
  const invalidate = useInvalidateOnSuccess();
  return useMutation({
    mutationFn: async (input) => {
      const payload = buildUpdatePayload({ name: input.name });
      const supabase = requireClient();
      const { data, error } = await supabase
        .from('classifications')
        .update(payload)
        .eq('id', input.id)
        .select(WRITTEN_COLUMNS)
        .single();
      return unwrapSingle<WrittenClassificationRow>(data, error, 'rename');
    },
    onSuccess: invalidate,
  });
}

export function useSetClassificationActive(): UseMutationResult<
  WrittenClassificationRow,
  ClassificationWriteError,
  SetClassificationActiveInput
> {
  const invalidate = useInvalidateOnSuccess();
  return useMutation({
    mutationFn: async (input) => {
      const payload = buildUpdatePayload({ isActive: input.isActive });
      const supabase = requireClient();
      const { data, error } = await supabase
        .from('classifications')
        .update(payload)
        .eq('id', input.id)
        .select(WRITTEN_COLUMNS)
        .single();
      return unwrapSingle<WrittenClassificationRow>(data, error, 'toggle');
    },
    onSuccess: invalidate,
  });
}

export function useDeleteClassification(): UseMutationResult<
  { readonly id: string },
  ClassificationWriteError,
  { readonly id: string }
> {
  const invalidate = useInvalidateOnSuccess();
  return useMutation({
    mutationFn: async ({ id }) => {
      const supabase = requireClient();
      /* `.select('id')` asks for the deleted rows back, which is what lets a
         zero-row delete be reported as `notFound` instead of "Deleted". */
      const { data, error } = await supabase
        .from('classifications')
        .delete()
        .eq('id', id)
        .select('id');

      if (error !== null && error !== undefined) {
        throw new ClassificationWriteError(classifyClassificationWriteError(error, 'delete'));
      }
      if (!Array.isArray(data) || data.length === 0) {
        throw new ClassificationWriteError('notFound');
      }
      return { id };
    },
    onSuccess: invalidate,
    /* A refused delete means the cached tree was out of date — somebody added a
       child since the screen was rendered. Refetch on failure so the row stops
       offering delete and the new child appears, instead of leaving the user
       with a message and a stale button. */
    onError: invalidate,
  });
}
