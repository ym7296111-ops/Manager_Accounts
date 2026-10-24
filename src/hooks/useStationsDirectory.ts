import { useQuery } from '@tanstack/react-query';
import { getSupabase } from '@/lib/supabase';

/**
 * Stations & Warehouses directory (`['project-settings', 'stations-directory']`).
 *
 * One nested PostgREST read returns every station with its warehouses; the
 * expected volume is <= 20 stations and <= 10 warehouses each, so there is no
 * pagination, no cursor and no per-station lazy fetch.
 *
 * Authorization lives entirely in the database: both tables are RLS-gated by
 * `can_manage_project_settings()` (`project.settings:manage`). The route is
 * additionally wrapped in `RequireCapability`, but that gate is derived from
 * the capability snapshot and can disagree with a live grant that was revoked
 * or delegated away — so the query classifies a `42501`/`PGRST301` response as
 * `forbidden` and the UI renders an explicit message instead of an empty list.
 */

export interface StationWarehouse {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly isActive: boolean;
}

export interface StationWithWarehouses extends StationWarehouse {
  readonly warehouses: readonly StationWarehouse[];
}

export type StationsDirectoryErrorCode = 'unavailable' | 'forbidden' | 'network' | 'unknown';

export class StationsDirectoryError extends Error {
  readonly code: StationsDirectoryErrorCode;

  constructor(code: StationsDirectoryErrorCode) {
    super(code);
    this.name = 'StationsDirectoryError';
    this.code = code;
  }
}

export const STATIONS_DIRECTORY_QUERY_KEY = ['project-settings', 'stations-directory'] as const;

/**
 * Single nested projection.
 *
 * The `!station_id` hint pins the embed to the `warehouses.station_id` foreign
 * key. Today `warehouses` has exactly one FK, so the hint is optional — but an
 * unqualified embed silently fails with PGRST300/PGRST201 the moment a second
 * relationship appears, and the failure mode is an empty screen rather than an
 * error. See `src/hooks/postgrest-embeds.test.ts` for the incident this guards.
 * The hint must NOT be aliased: the response key stays `warehouses`.
 */
export const STATIONS_SELECT =
  'id, code, name, is_active, warehouses!station_id(id, code, name, is_active)';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function parseWarehouse(value: unknown): StationWarehouse | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = readString(value.id);
  const code = readString(value.code);
  const name = readString(value.name);
  if (id === null || code === null || name === null) {
    return null;
  }
  return { id, code, name, isActive: value.is_active === true };
}

/** Codes are zero-padded (`ST-01`, `WH-001`), so a plain string order is correct. */
function byCode<T extends { readonly code: string }>(a: T, b: T): number {
  if (a.code === b.code) {
    return 0;
  }
  return a.code < b.code ? -1 : 1;
}

/**
 * Normalize one nested response into the render model.
 *
 * Rows missing a required scalar are dropped rather than throwing: a single
 * malformed row must not blank the whole directory. Ordering is applied here
 * rather than trusted from the server so the render order is deterministic
 * regardless of how PostgREST orders an embedded collection.
 */
export function parseStationsDirectory(raw: unknown): readonly StationWithWarehouses[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const stations: StationWithWarehouses[] = [];
  for (const row of raw) {
    if (!isRecord(row)) {
      continue;
    }
    const id = readString(row.id);
    const code = readString(row.code);
    const name = readString(row.name);
    if (id === null || code === null || name === null) {
      continue;
    }
    const warehouses = (Array.isArray(row.warehouses) ? row.warehouses : [])
      .map(parseWarehouse)
      .filter((entry): entry is StationWarehouse => entry !== null)
      .sort(byCode);

    stations.push({
      id,
      code,
      name,
      isActive: row.is_active === true,
      warehouses,
    });
  }

  return stations.sort(byCode);
}

/** Map a transport/PostgREST failure onto a value-free, translatable code. */
export function classifyStationsError(error: unknown): StationsDirectoryErrorCode {
  if (error instanceof StationsDirectoryError) {
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

export function useStationsDirectory(options?: { readonly enabled?: boolean }) {
  const enabled = options?.enabled ?? true;

  return useQuery({
    queryKey: STATIONS_DIRECTORY_QUERY_KEY,
    enabled,
    queryFn: async (): Promise<readonly StationWithWarehouses[]> => {
      const supabase = getSupabase();
      if (supabase === null) {
        throw new StationsDirectoryError('unavailable');
      }

      const { data, error } = await supabase
        .from('stations')
        .select(STATIONS_SELECT)
        .order('code', { ascending: true })
        .order('code', { referencedTable: 'warehouses', ascending: true });

      if (error !== null && error !== undefined) {
        throw new StationsDirectoryError(classifyStationsError(error));
      }

      return parseStationsDirectory(data);
    },
  });
}
