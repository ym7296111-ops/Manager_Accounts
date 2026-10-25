import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import { PARTIES_QUERY_KEY, PARTIES_SELECT } from '@/hooks/useParties';
import type { PartyPaymentTerms, PartyType } from '@/lib/database.types';
import { validateName } from '@/lib/nameValidation';
import {
  isPartyPaymentTerms,
  isPartyType,
  isValidPartyEmail,
  roundCreditLimit,
  supportsCreditTerms,
} from '@/lib/partyValidation';
import { getSupabase } from '@/lib/supabase';

/**
 * Write operations for the parties directory.
 *
 * Shape of the contract, in one place:
 *
 *   create   `{ type, name, …optionals }`  → the server mints the code
 *   update   `{ id, name, …optionals }`    → the editable columns, nothing else
 *   toggle   `{ id, is_active }`           → the flag and nothing else
 *   delete   `{ id }`                      → free today; refuses once referenced
 *
 * `code` is never sent, on any verb: the `parties_before_write` trigger mints
 * it from the per-type sequence (`SUP-001` / `CUS-001` / `SIS-001` / `INT-001`)
 * and overwrites anything a client tries to supply. `type` is sent exactly
 * once — on INSERT, where it selects the sequence — and never on UPDATE: the
 * trigger refuses a changed `type` or `code` with SQLSTATE 22023, and
 * `buildUpdatePayload` receives the type *beside* the fields (as rule context)
 * rather than among them, so it has no branch that could emit it. The
 * `assertKeysAbsent` checks make both invariants hard failures instead of
 * comments, so a future edit that spreads caller input into a payload breaks
 * loudly before the request leaves the client.
 *
 * Credit terms (`credit_limit`, `payment_terms`) belong to suppliers and
 * customers only. For a sister company or an internal party the payload omits
 * both keys entirely — on insert that stores NULL, and on update it leaves
 * whatever is already there untouched (a value written out-of-band must not
 * be wiped by an unrelated rename just because the form cannot show it). The
 * database backs the one absolute case: `parties_internal_no_credit_terms`
 * refuses credit terms on internal parties outright.
 *
 * Authorization is the database's. The screen sits behind `RequireCapability`,
 * but that gate reads a capability snapshot and can disagree with a live grant
 * revoked or delegated away mid-session, so every failure is classified and
 * surfaced instead of silently succeeding or silently doing nothing.
 *
 * Deleting is unrestricted in this phase — no table references a party yet.
 * The 23503 branch is still classified (`hasReferences`) so the day the
 * letters module adds its foreign key, a refused delete already reads as a
 * sentence instead of a generic failure.
 */

export type PartyWriteErrorCode =
  | 'unavailable'
  | 'forbidden'
  | 'network'
  | 'validation'
  /** 22023: the trigger refused a `type`/`code` change (unreachable from the UI). */
  | 'immutable'
  /** 23503 on delete: documents already reference this party (letters phase). */
  | 'hasReferences'
  /** The row no longer exists (deleted elsewhere, or filtered by RLS). */
  | 'notFound'
  | 'unknown';

/** The same SQLSTATE does not mean the same thing on every verb. */
export type PartyWriteOperation = 'create' | 'update' | 'toggle' | 'delete';

export class PartyWriteError extends Error {
  readonly code: PartyWriteErrorCode;

  constructor(code: PartyWriteErrorCode) {
    super(code);
    this.name = 'PartyWriteError';
    this.code = code;
  }
}

/** Minted by the trigger from a per-type sequence; no payload may carry it. */
export const SERVER_MINTED_COLUMNS = ['code'] as const;

/** Written once on INSERT (`type`) or never (`code`); an UPDATE carries neither. */
export const IMMUTABLE_UPDATE_COLUMNS = ['code', 'type'] as const;

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

/** The columns the edit dialog may change. Deliberately no `type`, no `code`. */
export interface EditablePartyFields {
  readonly name: string;
  readonly taxNumber?: string | null;
  readonly commercialRegister?: string | null;
  readonly address?: string | null;
  readonly contactPerson?: string | null;
  readonly phone?: string | null;
  readonly email?: string | null;
  /** Honoured only for suppliers/customers; stripped for the other two types. */
  readonly creditLimit?: number | null;
  readonly paymentTerms?: PartyPaymentTerms | null;
}

export interface CreatePartyInput extends EditablePartyFields {
  /** Chooses the code sequence; immutable from the moment the row exists. */
  readonly type: PartyType;
}

export interface UpdatePartyInput extends EditablePartyFields {
  readonly id: string;
  /**
   * Rule context only (whether credit terms apply). Never part of the payload:
   * `buildUpdatePayload` receives it beside the fields, not among them.
   */
  readonly type: PartyType;
}

function validateNameOrThrow(raw: string): string {
  const result = validateName(raw);
  if (!result.ok) {
    throw new PartyWriteError('validation');
  }
  return result.value;
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** The dialog checks the address first; this is the same rule at the wire. */
function normalizeEmail(value: string | null | undefined): string | null {
  const email = normalizeOptionalText(value);
  if (email !== null && !isValidPartyEmail(email)) {
    throw new PartyWriteError('validation');
  }
  return email;
}

interface CreditColumns {
  readonly credit_limit: number | null;
  readonly payment_terms: PartyPaymentTerms | null;
}

/** Validate both credit values for a type that carries them (23514, pre-empted). */
function validatedCreditColumns(fields: EditablePartyFields): CreditColumns {
  const creditLimit = fields.creditLimit ?? null;
  if (creditLimit !== null && (!Number.isFinite(creditLimit) || creditLimit < 0)) {
    throw new PartyWriteError('validation');
  }
  const paymentTerms = fields.paymentTerms ?? null;
  if (paymentTerms !== null && !isPartyPaymentTerms(paymentTerms)) {
    throw new PartyWriteError('validation');
  }
  return {
    credit_limit: creditLimit === null ? null : roundCreditLimit(creditLimit),
    payment_terms: paymentTerms,
  };
}

/** The editable allowlist, shared by create and update. */
function editableColumns(type: PartyType, fields: EditablePartyFields): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    name: validateNameOrThrow(fields.name),
    tax_number: normalizeOptionalText(fields.taxNumber),
    commercial_register: normalizeOptionalText(fields.commercialRegister),
    address: normalizeOptionalText(fields.address),
    contact_person: normalizeOptionalText(fields.contactPerson),
    phone: normalizeOptionalText(fields.phone),
    email: normalizeEmail(fields.email),
  };

  /* For sister companies and internal parties both keys stay ABSENT (not
     null): an insert then stores NULL, and an update cannot wipe a value the
     form was never able to show. */
  if (supportsCreditTerms(type)) {
    const credit = validatedCreditColumns(fields);
    payload.credit_limit = credit.credit_limit;
    payload.payment_terms = credit.payment_terms;
  }

  return payload;
}

/**
 * INSERT payload: the type (it selects the sequence), the editable columns,
 * and never a code — the trigger mints it and would overwrite a sent one.
 */
export function buildCreatePayload(input: CreatePartyInput): Record<string, unknown> {
  if (!isPartyType(input.type)) {
    throw new PartyWriteError('validation');
  }
  const payload: Record<string, unknown> = {
    type: input.type,
    ...editableColumns(input.type, input),
  };
  assertKeysAbsent(payload, SERVER_MINTED_COLUMNS);
  return payload;
}

/**
 * UPDATE payload. `type` arrives beside the fields, as rule context, so the
 * payload structurally cannot contain it (nor `code`): changing either is
 * refused by the trigger with 22023, and the UI offers no way to ask.
 */
export function buildUpdatePayload(
  type: PartyType,
  fields: EditablePartyFields,
): Record<string, unknown> {
  if (!isPartyType(type)) {
    throw new PartyWriteError('validation');
  }
  const payload = editableColumns(type, fields);
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

  // 22023: parties_before_write refused a type/code change. The payload
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

  // 23514: the CHECK family — blank name, email shape, negative credit limit,
  // payment terms outside the set, credit terms on an internal party.
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
  readonly type: PartyType;
  readonly code: string;
  readonly name: string;
  readonly tax_number: string | null;
  readonly commercial_register: string | null;
  readonly address: string | null;
  readonly contact_person: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly credit_limit: number | null;
  readonly payment_terms: PartyPaymentTerms | null;
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

export function useUpdateParty(): UseMutationResult<
  WrittenPartyRow,
  PartyWriteError,
  UpdatePartyInput
> {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (input) => {
      /* `input.type` is rule context for the builder; the payload it returns
         is asserted free of both `type` and `code`. */
      const payload = buildUpdatePayload(input.type, input);
      const supabase = requireClient();
      const { data, error } = await supabase
        .from('parties')
        .update(payload)
        .eq('id', input.id)
        .select(WRITTEN_COLUMNS)
        .single();
      return unwrapSingle<WrittenPartyRow>(data, error, 'update');
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
