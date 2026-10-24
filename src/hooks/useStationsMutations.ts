import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import { getSupabase } from '@/lib/supabase';
import { STATIONS_DIRECTORY_QUERY_KEY } from '@/hooks/useStationsDirectory';

/**
 * Write operations for the Stations & Warehouses directory.
 *
 * Every mutation goes straight to the table; authorization is the database's
 * job. Both tables are RLS-gated by `can_manage_project_settings()`, so a
 * caller who lost the grant between page load and click is rejected with
 * `42501` here rather than by a client-side check.
 *
 * `code` is never sent. Both columns default to a SECURITY DEFINER generator
 * backed by a sequence, so codes are minted server-side and cannot be forged
 * or duplicated from the client.
 *
 * Deleting a station that still has warehouses is refused by
 * `warehouses_station_id_fkey ... ON DELETE RESTRICT` (SQLSTATE 23503); the UI
 * hides the button in that case, but the guard is the constraint, so a
 * concurrent warehouse insert still produces a clear, classified error.
 */

export type StationWriteErrorCode =
  'unavailable' | 'forbidden' | 'network' | 'validation' | 'conflict' | 'unknown';

export class StationWriteError extends Error {
  readonly code: StationWriteErrorCode;

  constructor(code: StationWriteErrorCode) {
    super(code);
    this.name = 'StationWriteError';
    this.code = code;
  }
}

/** Mirrors the Arabic/English copy requirement: a name is at least 2 characters. */
export const MIN_NAME_LENGTH = 2;

export type NameValidationFailure = 'required' | 'tooShort';

export type NameValidation =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly code: NameValidationFailure };

/** Trim first, then require content, then require the minimum length. */
export function validateName(raw: string): NameValidation {
  const value = raw.trim();
  if (value === '') {
    return { ok: false, code: 'required' };
  }
  if ([...value].length < MIN_NAME_LENGTH) {
    return { ok: false, code: 'tooShort' };
  }
  return { ok: true, value };
}

function validateNameOrThrow(raw: string): string {
  const result = validateName(raw);
  if (!result.ok) {
    throw new StationWriteError('validation');
  }
  return result.value;
}

/** Map a PostgREST failure onto a value-free code the UI can translate. */
export function classifyStationWriteError(error: unknown): StationWriteErrorCode {
  if (error instanceof StationWriteError) {
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

  // 23503: ON DELETE RESTRICT (station still has warehouses) or a dangling FK.
  // 23505: a duplicate code, which only the server can produce.
  if (code === '23503' || code === '23505') {
    return 'conflict';
  }

  // 23514: the *_name_not_blank CHECK constraint.
  if (code === '23514' || code === '22023') {
    return 'validation';
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
    throw new StationWriteError('unavailable');
  }
  return supabase;
}

const WRITTEN_COLUMNS = 'id, code, name, is_active';

export interface StationPatch {
  readonly id: string;
  readonly name?: string;
  readonly isActive?: boolean;
}

export interface WarehousePatch {
  readonly id: string;
  readonly name?: string;
  readonly isActive?: boolean;
}

/** Rejects an empty patch: an UPDATE with no columns is a no-op worth catching. */
function buildPatch(input: StationPatch | WarehousePatch): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) {
    patch.name = validateNameOrThrow(input.name);
  }
  if (input.isActive !== undefined) {
    patch.is_active = input.isActive;
  }
  return Object.keys(patch).length === 0 ? null : patch;
}

type WrittenRow = { id: string; code: string; name: string; is_active: boolean };

function useInvalidateOnSuccess() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: STATIONS_DIRECTORY_QUERY_KEY });
  };
}

export function useCreateStation(): UseMutationResult<
  WrittenRow,
  StationWriteError,
  { readonly name: string }
> {
  const invalidate = useInvalidateOnSuccess();
  return useMutation({
    mutationFn: async ({ name }) => {
      /* Validate before touching the client: an invalid name must not even open
         a request, let alone reach the database. */
      const value = validateNameOrThrow(name);
      const supabase = requireClient();
      const { data, error } = await supabase
        .from('stations')
        .insert({ name: value })
        .select(WRITTEN_COLUMNS)
        .single();
      if (error !== null && error !== undefined) {
        throw new StationWriteError(classifyStationWriteError(error));
      }
      return data;
    },
    onSuccess: invalidate,
  });
}

export function useUpdateStation(): UseMutationResult<WrittenRow, StationWriteError, StationPatch> {
  const invalidate = useInvalidateOnSuccess();
  return useMutation({
    mutationFn: async (input) => {
      const patch = buildPatch(input);
      if (patch === null) {
        throw new StationWriteError('validation');
      }
      const supabase = requireClient();
      const { data, error } = await supabase
        .from('stations')
        .update(patch)
        .eq('id', input.id)
        .select(WRITTEN_COLUMNS)
        .single();
      if (error !== null && error !== undefined) {
        throw new StationWriteError(classifyStationWriteError(error));
      }
      return data;
    },
    onSuccess: invalidate,
  });
}

export function useDeleteStation(): UseMutationResult<
  { readonly id: string },
  StationWriteError,
  { readonly id: string }
> {
  const invalidate = useInvalidateOnSuccess();
  return useMutation({
    mutationFn: async ({ id }) => {
      const supabase = requireClient();
      const { error } = await supabase.from('stations').delete().eq('id', id);
      if (error !== null && error !== undefined) {
        throw new StationWriteError(classifyStationWriteError(error));
      }
      return { id };
    },
    onSuccess: invalidate,
  });
}

export function useCreateWarehouse(): UseMutationResult<
  WrittenRow,
  StationWriteError,
  { readonly stationId: string; readonly name: string }
> {
  const invalidate = useInvalidateOnSuccess();
  return useMutation({
    mutationFn: async ({ stationId, name }) => {
      const value = validateNameOrThrow(name);
      const supabase = requireClient();
      const { data, error } = await supabase
        .from('warehouses')
        .insert({ station_id: stationId, name: value })
        .select(WRITTEN_COLUMNS)
        .single();
      if (error !== null && error !== undefined) {
        throw new StationWriteError(classifyStationWriteError(error));
      }
      return data;
    },
    onSuccess: invalidate,
  });
}

export function useUpdateWarehouse(): UseMutationResult<
  WrittenRow,
  StationWriteError,
  WarehousePatch
> {
  const invalidate = useInvalidateOnSuccess();
  return useMutation({
    mutationFn: async (input) => {
      const patch = buildPatch(input);
      if (patch === null) {
        throw new StationWriteError('validation');
      }
      const supabase = requireClient();
      const { data, error } = await supabase
        .from('warehouses')
        .update(patch)
        .eq('id', input.id)
        .select(WRITTEN_COLUMNS)
        .single();
      if (error !== null && error !== undefined) {
        throw new StationWriteError(classifyStationWriteError(error));
      }
      return data;
    },
    onSuccess: invalidate,
  });
}

export function useDeleteWarehouse(): UseMutationResult<
  { readonly id: string },
  StationWriteError,
  { readonly id: string }
> {
  const invalidate = useInvalidateOnSuccess();
  return useMutation({
    mutationFn: async ({ id }) => {
      const supabase = requireClient();
      const { error } = await supabase.from('warehouses').delete().eq('id', id);
      if (error !== null && error !== undefined) {
        throw new StationWriteError(classifyStationWriteError(error));
      }
      return { id };
    },
    onSuccess: invalidate,
  });
}
