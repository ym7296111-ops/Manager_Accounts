import { useQuery } from '@tanstack/react-query';
import { classifyPostgrestReadError } from '@/hooks/postgrestReadError';
import type { PartyPaymentTerms, PartyType } from '@/lib/database.types';
import { isPartyPaymentTerms, isPartyType } from '@/lib/partyValidation';
import { getSupabase } from '@/lib/supabase';

/**
 * Parties directory (`['project-settings', 'parties']`).
 *
 * One flat read returns every party. The expected volume is a few dozen
 * counterparties — suppliers, customers, sister companies and internal
 * departments — so there is no pagination and no server-side filtering; the
 * screen's type filter runs over this list, exactly as the schema was designed
 * for (see `20261106000000_parties_schema.sql`).
 *
 * Codes are minted by the `parties_before_write` trigger from a per-type
 * sequence (`SUP-001` / `CUS-001` / `SIS-001` / `INT-001`) and every row is
 * RLS-gated by `can_manage_project_settings()` (`project.settings:manage`).
 * The UI sends `type` once, on insert, and never sends `code`; both are
 * immutable afterwards (the trigger raises 22023), and `usePartiesMutations`
 * is built so no update payload can carry either.
 *
 * Authorization: the route is wrapped in `RequireCapability`, but that gate
 * reads a capability snapshot and can disagree with a live grant that was
 * revoked or delegated away. A `42501`/`PGRST301` read is classified as
 * `forbidden` so the screen renders an explicit message instead of an empty
 * directory (which would read as "no parties yet").
 */

/** One party, as rendered. Optional columns stay `null` when unset. */
export interface Party {
  readonly id: string;
  readonly type: PartyType;
  readonly code: string;
  readonly name: string;
  readonly taxNumber: string | null;
  readonly commercialRegister: string | null;
  readonly address: string | null;
  readonly contactPerson: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly creditLimit: number | null;
  readonly paymentTerms: PartyPaymentTerms | null;
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

/** Every column the directory renders or the edit dialog prefills — no more. */
export const PARTIES_SELECT =
  'id, type, code, name, tax_number, commercial_register, address, contact_person, phone, email, credit_limit, payment_terms, is_active';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** An optional text column: a non-blank string, or `null` for anything else. */
function readOptionalString(value: unknown): string | null {
  return readString(value);
}

/**
 * `numeric(18, 2)` arrives as a JSON number from PostgREST, but tolerate a
 * numeric string rather than dropping the value (or the row) if some proxy
 * stringifies it. A negative or non-finite value cannot exist behind the
 * CHECK, so it reads as unset instead of being trusted.
 */
function readCreditLimit(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }
  return null;
}

/** Only the CHECK set is a term; anything else reads as "unspecified". */
function readPaymentTerms(value: unknown): PartyPaymentTerms | null {
  return typeof value === 'number' && isPartyPaymentTerms(value) ? value : null;
}

/**
 * Codes are zero-padded to three digits (`SUP-001`), so an ordinal comparison
 * is right up to 999 — but `SUP-1000` sorts before `SUP-101` in plain string
 * order. The numeric-aware collator keeps creation order intact past the
 * padding width.
 */
const CODE_COLLATOR = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/**
 * The directory reads type by type in the same order the filter offers them
 * (suppliers, customers, sister companies, internal), each block in code
 * order. Applied here rather than trusted from the server, so the render
 * order is deterministic regardless of the wire order.
 */
const TYPE_ORDER: Record<PartyType, number> = {
  supplier: 0,
  customer: 1,
  sister_company: 2,
  internal: 3,
};

function byTypeThenCode(a: Party, b: Party): number {
  const byType = TYPE_ORDER[a.type] - TYPE_ORDER[b.type];
  return byType !== 0 ? byType : CODE_COLLATOR.compare(a.code, b.code);
}

/**
 * Normalize the flat response into the render list.
 *
 * Malformed rows are dropped rather than throwing: one bad row must not blank
 * the screen. That includes a `type` outside the CHECK set — the screen has
 * no badge to render for it, and the database cannot produce one anyway.
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
    if (id === null || code === null || name === null || !isPartyType(row.type)) {
      continue;
    }
    /* A duplicate id cannot exist in the table (primary key); first one wins. */
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);

    parties.push({
      id,
      type: row.type,
      code,
      name,
      taxNumber: readOptionalString(row.tax_number),
      commercialRegister: readOptionalString(row.commercial_register),
      address: readOptionalString(row.address),
      contactPerson: readOptionalString(row.contact_person),
      phone: readOptionalString(row.phone),
      email: readOptionalString(row.email),
      creditLimit: readCreditLimit(row.credit_limit),
      paymentTerms: readPaymentTerms(row.payment_terms),
      isActive: row.is_active === true,
    });
  }

  return parties.sort(byTypeThenCode);
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
