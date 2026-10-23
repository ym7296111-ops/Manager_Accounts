import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import type { PostgrestError } from '@supabase/supabase-js';
import { MODULE_RANK } from '@/hooks/useRolesManagement';
import type { TranslationKey } from '@/i18n/I18nContext';
import { getSupabase } from '@/lib/supabase';

/**
 * Permission catalogue data layer — the read/write path for owner-configured
 * capability delegation (`public.permissions.is_delegatable`, migration
 * 20261030000000).
 *
 * * Reads come straight from `public.permissions` (readable by every
 *   authenticated user): ONE small table, sorted client-side by module rank,
 *   so Roles & Permissions (the toggle surface) and the delegation dialog
 *   (the grant surface) always agree on what is delegatable right now.
 *   There is NO hardcoded slug list anywhere in the client anymore.
 * * Writes go through `admin_set_permission_delegatable` — owner/super-admin
 *   only, audited server-side. The browser passes its own verified user id
 *   as `p_executor_id`; the RPC binds it to `auth.uid()` and re-checks the
 *   role, so a tampered client gains nothing.
 * * `*` and `roles.manage` are PROTECTED: the database trigger refuses to
 *   flag them delegatable under any context. The mirror constant below
 *   exists only so the UI renders a badge instead of a doomed toggle — the
 *   database is the authority.
 */

/* ------------------------------------------------------------------ types */

/** One entry of `public.permissions`, plus its delegatability flag. */
export interface PermissionCatalogEntry {
  readonly id: string;
  readonly slug: string;
  readonly module: string;
  readonly nameAr: string;
  readonly nameEn: string;
  readonly description: string | null;
  readonly isDelegatable: boolean;
}

/** Normalized, locale-independent failure codes for the catalogue surface. */
export type PermissionCatalogErrorCode =
  'unavailable' | 'forbidden' | 'not-found' | 'protected' | 'network' | 'unknown';

export class PermissionCatalogError extends Error {
  readonly code: PermissionCatalogErrorCode;

  constructor(code: PermissionCatalogErrorCode) {
    super(code);
    this.name = 'PermissionCatalogError';
    this.code = code;
  }
}

/** Every failure code → its bilingual dictionary key. */
export const PERMISSION_CATALOG_ERROR_KEYS: Record<PermissionCatalogErrorCode, TranslationKey> = {
  unavailable: 'roles.delegatable.error.unavailable',
  forbidden: 'roles.delegatable.error.forbidden',
  'not-found': 'roles.delegatable.error.notFound',
  protected: 'roles.delegatable.error.protected',
  network: 'roles.delegatable.error.network',
  unknown: 'roles.delegatable.error.unknown',
};

/* -------------------------------------------------------------- constants */

/** The single cache key for the catalogue (shared by the page and dialog). */
export const PERMISSION_CATALOG_QUERY_KEY = ['permission-catalog'] as const;

/**
 * Slugs the database refuses to ever flag delegatable (`permissions_guard_delegatable`).
 * UI mirror only — used to render the "Protected" badge instead of a toggle.
 */
export const PROTECTED_PERMISSION_SLUGS: ReadonlySet<string> = new Set(['*', 'roles.manage']);

export function isProtectedPermissionSlug(slug: string): boolean {
  return PROTECTED_PERMISSION_SLUGS.has(slug);
}

/** Defence against a runaway catalogue response; the table is tiny. */
const CATALOG_MAX_ROWS = 500;

const CATALOG_COLUMNS = 'id, slug, module, name_ar, name_en, description, is_delegatable';

/* ------------------------------------------------------------ error mapping */

function mapPostgrestError(error: PostgrestError): PermissionCatalogError {
  const message = error.message.toLowerCase();

  /* Named RPC refusals first: they share SQLSTATEs with generic denials. */
  if (message.includes('permission_is_protected')) {
    return new PermissionCatalogError('protected');
  }
  if (message.includes('invalid_capability')) {
    return new PermissionCatalogError('not-found');
  }
  if (error.code === '42501' || message.includes('permission_denied')) {
    return new PermissionCatalogError('forbidden');
  }
  if (error.code === 'P0002') {
    return new PermissionCatalogError('not-found');
  }
  /* Missing table/RPC → the migration has not been applied in this environment. */
  if (error.code === 'PGRST202' || error.code === 'PGRST205') {
    return new PermissionCatalogError('unavailable');
  }
  if (message.includes('failed to fetch') || message.includes('network')) {
    return new PermissionCatalogError('network');
  }
  return new PermissionCatalogError('unknown');
}

function toErrorCode(caught: unknown): PermissionCatalogErrorCode {
  if (caught instanceof PermissionCatalogError) {
    return caught.code;
  }
  if (caught instanceof TypeError) {
    return 'network';
  }
  return 'unknown';
}

/* ------------------------------------------------------- runtime parsing */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function parseEntry(value: unknown): PermissionCatalogEntry | null {
  if (!isRecord(value)) return null;
  const id = asString(value['id']);
  const slug = asString(value['slug']);
  if (id === '' || slug === '') return null;
  return {
    id,
    slug,
    module: asString(value['module']),
    nameAr: asString(value['name_ar']),
    nameEn: asString(value['name_en']),
    description: asNullableString(value['description']),
    isDelegatable: value['is_delegatable'] === true,
  };
}

/** Deterministic order: module rank (house order), then slug, then id. */
function compareEntries(a: PermissionCatalogEntry, b: PermissionCatalogEntry): number {
  const rankA = MODULE_RANK[a.module] ?? Number.MAX_SAFE_INTEGER;
  const rankB = MODULE_RANK[b.module] ?? Number.MAX_SAFE_INTEGER;
  return rankA - rankB || a.slug.localeCompare(b.slug) || a.id.localeCompare(b.id);
}

/** Validates the raw PostgREST rows; malformed rows are dropped, never guessed at. */
export function parsePermissionCatalog(data: unknown): readonly PermissionCatalogEntry[] {
  if (!Array.isArray(data)) return [];
  return data
    .map(parseEntry)
    .filter((entry): entry is PermissionCatalogEntry => entry !== null)
    .sort(compareEntries);
}

/* ------------------------------------------------------------------- fetch */

interface QueryResult {
  readonly data: unknown;
  readonly error: PostgrestError | null;
}

async function fetchCatalog(): Promise<readonly PermissionCatalogEntry[]> {
  const client = getSupabase();
  if (client === null) {
    throw new PermissionCatalogError('unavailable');
  }
  try {
    const { data, error } = (await client
      .from('permissions')
      .select(CATALOG_COLUMNS)
      .order('slug')
      .limit(CATALOG_MAX_ROWS)) as QueryResult;
    if (error !== null) {
      throw mapPostgrestError(error);
    }
    return parsePermissionCatalog(data);
  } catch (caught) {
    throw new PermissionCatalogError(toErrorCode(caught));
  }
}

/* -------------------------------------------------------------------- hook */

export interface PermissionCatalogApi {
  /** Every catalogue entry, deterministically ordered. */
  readonly permissions: readonly PermissionCatalogEntry[];
  /** Subset currently flagged `is_delegatable` (the grant surface). */
  readonly delegatable: readonly PermissionCatalogEntry[];
  /** Slug → entry, for label lookups of already-granted capabilities. */
  readonly bySlug: ReadonlyMap<string, PermissionCatalogEntry>;
  readonly isLoading: boolean;
  readonly error: PermissionCatalogErrorCode | null;
  readonly refresh: () => Promise<void>;
  /**
   * Owner/super-admin write path (`admin_set_permission_delegatable`).
   * Throws {@link PermissionCatalogError}; on success the catalogue refetches.
   */
  readonly setDelegatable: (slug: string, isDelegatable: boolean) => Promise<void>;
}

export function usePermissionCatalog(): PermissionCatalogApi {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: PERMISSION_CATALOG_QUERY_KEY,
    queryFn: fetchCatalog,
    staleTime: 30_000,
    retry: false,
  });

  const permissions = useMemo(() => query.data ?? [], [query.data]);
  const delegatable = useMemo(
    () => permissions.filter((entry) => entry.isDelegatable),
    [permissions],
  );
  const bySlug = useMemo(
    () => new Map(permissions.map((entry) => [entry.slug, entry] as const)),
    [permissions],
  );

  const refetchQuery = query.refetch;
  const refresh = useCallback(async () => {
    await refetchQuery();
  }, [refetchQuery]);

  const setDelegatable = useCallback(
    async (slug: string, isDelegatable: boolean) => {
      const client = getSupabase();
      if (client === null) {
        throw new PermissionCatalogError('unavailable');
      }
      try {
        /* The executor is the caller's own verified id — the RPC binds it
           to auth.uid(), so it can never be spoofed from the browser. */
        const {
          data: { user },
          error: authError,
        } = await client.auth.getUser();
        if (authError !== null || user === null) {
          throw new PermissionCatalogError('forbidden');
        }
        const { error } = (await client.rpc('admin_set_permission_delegatable', {
          p_permission_slug: slug,
          p_is_delegatable: isDelegatable,
          p_executor_id: user.id,
        })) as QueryResult;
        if (error !== null) {
          throw mapPostgrestError(error);
        }
      } catch (caught) {
        throw new PermissionCatalogError(toErrorCode(caught));
      }
      /* Server always wins: refetch the authoritative flags. */
      await queryClient.invalidateQueries({ queryKey: PERMISSION_CATALOG_QUERY_KEY });
    },
    [queryClient],
  );

  return {
    permissions,
    delegatable,
    bySlug,
    isLoading: query.isPending,
    error:
      query.error === null
        ? null
        : query.error instanceof PermissionCatalogError
          ? query.error.code
          : 'unknown',
    refresh,
    setDelegatable,
  };
}
