import { useQuery } from '@tanstack/react-query';
import { classifyPostgrestReadError } from '@/hooks/postgrestReadError';
import type { PartyBranch } from '@/lib/database.types';
import { isPartyBranch } from '@/lib/partyValidation';
import { getSupabase } from '@/lib/supabase';

/**
 * Parties directory (`['project-settings', 'parties']`).
 *
 * One flat read returns every party; the screen groups them under the tree's
 * two fixed roots — `inbound` («جهات الوارد») and `outbound` («أغراض الصرف»).
 * The expected volume is a few dozen rows, so there is no pagination and no
 * server-side filtering.
 *
 * A party is identity only: `branch`, `name`, `code`, `is_active`. The
 * commercial profile columns (tax number, commercial register, address,
 * contact person, phone, email, credit limit, payment terms) were retired in
 * 20261109000000 — there is no field to read them from, and no hook carries
 * them. Codes are minted by the `parties_before_write` trigger from one
 * sequence per branch (`IN-001` / `OUT-001`); the UI never sends a code.
 * Sister companies are *not* parties: they are their own tree
 * (`useSisterCompanies`), mounted by their own tab.
 *
 * Authorization: the route is wrapped in `RequireCapability`, but that gate
 * reads a capability snapshot and can disagree with a live grant that was
 * revoked or delegated away. A `42501`/`PGRST301` read is classified as
 * `forbidden` so the screen renders an explicit message instead of an empty
 * directory (which would read as "no parties yet").
 */

/** One party, as rendered. Identity only: branch, name, code, active flag. */
export interface Party {
  readonly id: string;
  readonly branch: PartyBranch;
  readonly code: string;
  readonly name: string;
  readonly isActive: boolean;
}

export type PartiesErrorCode = 'unavailable' | 'forbidden' | 'network' | 'unknown';

export class PartiesError extends Error {
  readonly code: PartiesErrorCode;

  constructor(code: PartiesErrorCode) {
    super(code);
    this.name = 'PartiesError';
    this.code = code;
  }
}

export const PARTIES_QUERY_KEY = ['project-settings', 'parties'] as const;

/** Every column a party has — no more. */
export const PARTIES_SELECT = 'id, branch, code, name, is_active';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * Codes are zero-padded to three digits (`IN-001`), so an ordinal comparison
 * is right up to 999 — but `IN-1000` sorts before `IN-101` in plain string
 * order. The numeric-aware collator keeps creation order intact past the
 * padding width.
 */
const CODE_COLLATOR = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** Branch order is fixed by the tree: inbound first, outbound second. */
const BRANCH_ORDER: Record<PartyBranch, number> = { inbound: 0, outbound: 1 };

function byBranchThenCode(a: Party, b: Party): number {
  const byBranch = BRANCH_ORDER[a.branch] - BRANCH_ORDER[b.branch];
  return byBranch !== 0 ? byBranch : CODE_COLLATOR.compare(a.code, b.code);
}

/**
 * Normalize the flat response into the render list.
 *
 * Malformed rows are dropped rather than throwing: one bad row must not blank
 * the screen. That includes a `branch` outside the two roots — the tree has no
 * root to hang it under, and the database cannot produce one anyway.
 */
export function parseParties(raw: unknown): readonly Party[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const seen = new Set<string>();
  const parties: Party[] = [];

  for (const row of raw) {
    if (!isRecord(row)) {
      continue;
    }
    const id = readString(row.id);
    const code = readString(row.code);
    const name = readString(row.name);
    if (id === null || code === null || name === null || !isPartyBranch(row.branch)) {
      continue;
    }
    /* A duplicate id cannot exist in the table (primary key); first one wins. */
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);

    parties.push({
      id,
      branch: row.branch,
      code,
      name,
      isActive: row.is_active === true,
    });
  }

  return parties.sort(byBranchThenCode);
}

export function classifyPartiesError(error: unknown): PartiesErrorCode {
  if (error instanceof PartiesError) {
    return error.code;
  }
  return classifyPostgrestReadError(error);
}

export function useParties(options?: { readonly enabled?: boolean }) {
  const enabled = options?.enabled ?? true;

  return useQuery({
    queryKey: PARTIES_QUERY_KEY,
    enabled,
    queryFn: async (): Promise<readonly Party[]> => {
      const supabase = getSupabase();
      if (supabase === null) {
        throw new PartiesError('unavailable');
      }

      const { data, error } = await supabase
        .from('parties')
        .select(PARTIES_SELECT)
        .order('code', { ascending: true });

      if (error !== null && error !== undefined) {
        throw new PartiesError(classifyPartiesError(error));
      }

      return parseParties(data);
    },
  });
}
