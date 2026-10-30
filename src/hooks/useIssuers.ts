import { useQuery } from '@tanstack/react-query';
import { classifyPostgrestReadError } from '@/hooks/postgrestReadError';
import { isIssuerCode } from '@/lib/issuers';
import { getSupabase } from '@/lib/supabase';

/**
 * Issuers (`['project-settings', 'issuers']`) — the controlled list of the two
 * Latin letters that identify who issued a paper letter.
 *
 * The list is small and flat, so it is read whole (active and inactive rows) and
 * sorted by `code`: the settings tab shows both states, while the entry screen
 * offers only the active ones (the server already filters the dropdown with
 * `aps_letter_entry_options`).
 *
 * Reading is part of reading or creating a letter; managing the list is
 * `project.settings:manage`, enforced by RLS on `public.issuers`. A denied read
 * is classified as `forbidden` so the tab explains itself instead of rendering
 * an empty list that reads as "no issuers yet".
 */

export interface Issuer {
  readonly id: string;
  /** Canonical upper-case two-letter code; the row's identity. */
  readonly code: string;
  readonly name: string;
  readonly isActive: boolean;
}

export type IssuersErrorCode = 'unavailable' | 'forbidden' | 'network' | 'unknown';

export class IssuersError extends Error {
  readonly code: IssuersErrorCode;

  constructor(code: IssuersErrorCode) {
    super(code);
    this.name = 'IssuersError';
    this.code = code;
  }
}

export const ISSUERS_QUERY_KEY = ['project-settings', 'issuers'] as const;

/** Every column the table renders or the dialog prefills — no more. */
export const ISSUERS_SELECT = 'id, code, name, is_active';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

const CODE_COLLATOR = new Intl.Collator('en', { sensitivity: 'base' });

/**
 * Normalize the response into rows the screen can render.
 *
 * A malformed row is dropped instead of throwing (one bad row must not blank
 * the tab). A code that is not two Latin letters cannot exist under the
 * database CHECK, and `issuerLabel`/the entry dropdown would misread it, so it
 * is dropped too.
 *
 * The stored code keeps the case the administrator typed; uniqueness is
 * case-insensitive on the server, so it is up-cased here for display and for
 * the codes the entry screen compares against.
 */
export function parseIssuers(raw: unknown): readonly Issuer[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const rows: Issuer[] = [];
  const seen = new Set<string>();

  for (const row of raw) {
    if (!isRecord(row)) {
      continue;
    }
    const id = readString(row.id);
    const rawCode = readString(row.code);
    const name = readString(row.name);
    if (id === null || rawCode === null || name === null) {
      continue;
    }
    const code = rawCode.toUpperCase();
    if (!isIssuerCode(code) || seen.has(code)) {
      continue;
    }
    seen.add(code);
    rows.push({ id, code, name, isActive: row.is_active === true });
  }

  rows.sort((a, b) => CODE_COLLATOR.compare(a.code, b.code));
  return rows;
}

export function classifyIssuersError(error: unknown): IssuersErrorCode {
  if (error instanceof IssuersError) {
    return error.code;
  }
  return classifyPostgrestReadError(error);
}

export function useIssuers(options?: { readonly enabled?: boolean }) {
  const enabled = options?.enabled ?? true;

  return useQuery({
    queryKey: ISSUERS_QUERY_KEY,
    enabled,
    queryFn: async (): Promise<readonly Issuer[]> => {
      const supabase = getSupabase();
      if (supabase === null) {
        throw new IssuersError('unavailable');
      }

      const { data, error } = await supabase
        .from('issuers')
        .select(ISSUERS_SELECT)
        .order('code', { ascending: true });

      if (error !== null && error !== undefined) {
        throw new IssuersError(classifyIssuersError(error));
      }

      return parseIssuers(data);
    },
  });
}
