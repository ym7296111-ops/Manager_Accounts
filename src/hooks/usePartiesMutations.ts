import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import { PARTIES_QUERY_KEY, PARTIES_SELECT } from '@/hooks/useParties';
import type { PartyBranch } from '@/lib/database.types';
import { validateName } from '@/lib/nameValidation';
import { isPartyBranch, validatePartyForm } from '@/lib/partyValidation';
import { getSupabase } from '@/lib/supabase';

/**
 * Write operations for the parties tree.
 *
 * Shape of the contract, in one place:
 *
 *   create   `{ branch, name }`   → the server mints the code
 *   rename   `{ id, name }`       → the only editable column
 *   toggle   `{ id, isActive }`   → the flag and nothing else
 *   delete   `{ id }`             → free today; refuses once referenced
 *
 * `code` is never sent, on any verb: the `parties_before_write` trigger mints
 * `IN-###` (inbound) or `OUT-###` (outbound) from that branch's own sequence
 * and overwrites anything a client tries to supply. `branch` is sent exactly
 * once — on INSERT, where it selects the sequence — and never on UPDATE: the
 * trigger refuses a changed `branch` or `code` with SQLSTATE 22023, and the
 * payload builders below have no branch that could emit either. The
 * `assertKeysAbsent` checks make both invariants hard failures instead of
 * comments, so a future edit that spreads caller input into a payload breaks
 * loudly before the request leaves the client.
 *
 * There is no commercial profile: a party is a name under a root. Tax number,
 * commercial register, address, contact person, phone, email, credit limit and
 * payment terms were retired with the columns themselves in 20261109000000, so
 * no payload here can carry them. Sister companies stay in their own table
 * (`useSisterCompaniesMutations`) and are untouched by this module.
 *
 * Authorization is the database's. The screen sits behind `RequireCapability`,
 * but that gate reads a capability snapshot and can disagree with a live grant
 * revoked or delegated away mid-session, so every failure is classified and
 * surfaced instead of silently succeeding or silently doing nothing.
 *
 * Deleting is unrestricted in this phase — no table references a party yet
 * (`letters.party_id … on delete restrict` arrives with the letters phase).
 * The 23503 branch is already classified (`hasReferences`) so the day that
 * foreign key lands, a refused delete reads as a sentence, not a generic error.
 */

export type PartyWriteErrorCode =
  | 'unavailable'
  | 'forbidden'
  | 'network'
  | 'validation'
  /** 22023: the trigger refused a `branch`/`code` change (unreachable from the UI). */
  | 'immutable'
  /** 23503 on delete: documents already reference this party (letters phase). */
  | 'hasReferences'
  /** The row no longer exists (deleted elsewhere, or filtered by RLS). */
  | 'notFound'
  | 'unknown';

/** The same SQLSTATE does not mean the same thing on every verb. */
export type PartyWriteOperation = 'create' | 'rename' | 'toggle' | 'delete';

export class PartyWriteError extends Error {
  readonly code: PartyWriteErrorCode;

  constructor(code: PartyWriteErrorCode) {
    super(code);
    this.name = 'PartyWriteError';
    this.code = code;
  }
}

/** Minted by the trigger from a per-branch sequence; no payload may carry it. */
export const SERVER_MINTED_COLUMNS = ['code'] as const;

/** Written once on INSERT (`branch`) or never (`code`); an UPDATE carries neither. */
export const IMMUTABLE_UPDATE_COLUMNS = ['code', 'branch'] as const;

/** What a write may echo back: the stored row, read-only. */
const WRITTEN_COLUMNS = PARTIES_SELECT;

/**
 * Belt-and-braces. The payload builders construct an explicit allowlist and
 * cannot produce a forbidden key; this turns that into a checked invariant.
 */
function assertKeysAbsent(payload: Record<string, unknown>, keys: readonly string[]): void {
  for (const key of keys) {
    if (key in payload) {
      throw new PartyWriteError('validation');
    }
  }
}

export interface CreatePartyInput {
  /** Chooses the code sequence; immutable from the moment the row exists. */
  readonly branch: PartyBranch;
  readonly name: string;
}

export interface RenamePartyInput {
  readonly id: string;
  readonly name: string;
}

function validateNameOrThrow(name: string): string {
  const result = validateName(name);
  if (!result.ok) {
    throw new PartyWriteError('validation');
  }
  return result.value;
}

/**
 * INSERT payload: the branch (it selects the sequence) and the name, and never
 * a code — the trigger mints it and would overwrite a sent one.
 */
export function buildCreatePayload(input: CreatePartyInput): Record<string, unknown> {
  if (!isPartyBranch(input.branch)) {
    throw new PartyWriteError('validation');
  }
  const result = validatePartyForm({ name: input.name }, input.branch);
  if (!result.ok) {
    throw new PartyWriteError('validation');
  }
  const payload: Record<string, unknown> = {
    branch: input.branch,
    name: result.value.name,
  };
  assertKeysAbsent(payload, SERVER_MINTED_COLUMNS);
  return payload;
}

/**
 * UPDATE payload. It is built from the editable allowlist alone — the name —
 * so it structurally cannot contain `branch` or `code`: changing either is
 * refused by the trigger with 22023, and the UI offers no way to ask.
 */
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
export function classifyPartyWriteError(
  error: unknown,
  operation: PartyWriteOperation,
): PartyWriteErrorCode {
  if (error instanceof PartyWriteError) {
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

  // 22023: parties_before_write refused a branch/code change. The payload
  // builders make this unreachable from the UI; if it ever surfaces, it is a
  // client bug and deserves its own message rather than "invalid input".
  if (code === '22023') {
    return 'immutable';
  }

  // 23503 can only mean "still referenced" here: parties has no foreign key of
  // its own, so only a DELETE can trip one (once letters reference a party).
  if (code === '23503' && operation === 'delete') {
    return 'hasReferences';
  }

  // 23514: the CHECK family — blank name, a branch outside the two roots.
  if (code === '23514') {
    return 'validation';
  }

  // PGRST116: `.single()` found zero rows — already deleted, or invisible
  // under RLS. Nothing happened, and the UI must not claim otherwise.
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
    throw new PartyWriteError('unavailable');
  }
  return supabase;
}

/** Refetch the directory; used after a write settles and after a refused delete. */
function useInvalidate() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: PARTIES_QUERY_KEY });
  };
}

export interface WrittenPartyRow {
  readonly id: string;
  readonly branch: PartyBranch;
  readonly code: string;
  readonly name: string;
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
  operation: PartyWriteOperation,
): T {
  if (error !== null && error !== undefined) {
    throw new PartyWriteError(classifyPartyWriteError(error, operation));
  }
  if (data === null) {
    throw new PartyWriteError('notFound');
  }
  return data;
}

export function useCreateParty(): UseMutationResult<
  WrittenPartyRow,
  PartyWriteError,
  CreatePartyInput
> {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (input) => {
      /* Validation runs before the client is touched: an invalid party must
         not even open a request. */
      const payload = buildCreatePayload(input);
      const supabase = requireClient();
      const { data, error } = await supabase
        .from('parties')
        .insert(payload)
        .select(WRITTEN_COLUMNS)
        .single();
      return unwrapSingle<WrittenPartyRow>(data, error, 'create');
    },
    onSuccess: invalidate,
  });
}

export function useRenameParty(): UseMutationResult<
  WrittenPartyRow,
  PartyWriteError,
  RenamePartyInput
> {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (input) => {
      /* The payload is asserted free of both `branch` and `code`. */
      const payload = buildRenamePayload(input.name);
      const supabase = requireClient();
      const { data, error } = await supabase
        .from('parties')
        .update(payload)
        .eq('id', input.id)
        .select(WRITTEN_COLUMNS)
        .single();
      return unwrapSingle<WrittenPartyRow>(data, error, 'rename');
    },
    onSuccess: invalidate,
  });
}

export function useSetPartyActive(): UseMutationResult<
  WrittenPartyRow,
  PartyWriteError,
  { readonly id: string; readonly isActive: boolean }
> {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (input) => {
      const payload = buildSetActivePayload(input.isActive);
      const supabase = requireClient();
      const { data, error } = await supabase
        .from('parties')
        .update(payload)
        .eq('id', input.id)
        .select(WRITTEN_COLUMNS)
        .single();
      return unwrapSingle<WrittenPartyRow>(data, error, 'toggle');
    },
    onSuccess: invalidate,
  });
}

export function useDeleteParty(): UseMutationResult<
  { readonly id: string },
  PartyWriteError,
  { readonly id: string }
> {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async ({ id }) => {
      const supabase = requireClient();
      /* `.select('id')` asks for the deleted rows back, which is what lets a
         zero-row delete be reported as `notFound` instead of "Deleted". */
      const { data, error } = await supabase.from('parties').delete().eq('id', id).select('id');

      if (error !== null && error !== undefined) {
        throw new PartyWriteError(classifyPartyWriteError(error, 'delete'));
      }
      if (!Array.isArray(data) || data.length === 0) {
        throw new PartyWriteError('notFound');
      }
      return { id };
    },
    onSuccess: invalidate,
    /* A refused delete means the cached list was out of date (a document now
       references the party, or it is already gone). Refetch on failure so the
       row the user is looking at matches the database. */
    onError: invalidate,
  });
}
