import { useQuery } from '@tanstack/react-query';
import { classifyPostgrestReadError } from '@/hooks/postgrestReadError';
import { getSupabase } from '@/lib/supabase';

/**
 * Sister companies (`['project-settings', 'sister-companies']`).
 *
 * A two-level tree: a parent company (level 1, `SIS-001`) and its branches
 * (level 2, `SIS-001-01`, `SIS-001-02`). The rows arrive flat, exactly as the
 * database stores them, and are assembled here — the depth is fixed at two by
 * `sister_companies_before_write` and `sister_companies_level_check`, so a
 * level-3 row cannot exist; the parser still refuses one rather than inventing
 * a shape the UI cannot render.
 *
 * `code`, `level` and `parent_id` are the server's. The client sends `name`
 * (and `parent_id` once, on insert, to choose the branch's company); nothing
 * else. `useSisterCompaniesMutations` is built so no write payload can carry
 * a derived column, and the trigger refuses a changed `parent_id` or `code`
 * with 22023.
 *
 * Authorization is the database's (`project.settings:manage`, via the four
 * RLS policies). A denied read is classified as `forbidden` so the screen
 * renders an explanation instead of an empty tree that reads as "no sister
 * companies yet".
 */

export interface SisterCompany {
  readonly id: string;
  readonly parentId: string | null;
  /** 1 for a parent company, 2 for a branch. */
  readonly level: number;
  readonly code: string;
  readonly name: string;
  readonly isActive: boolean;
  readonly branches: readonly SisterCompany[];
}

export type SisterCompaniesErrorCode = 'unavailable' | 'forbidden' | 'network' | 'unknown';

export class SisterCompaniesError extends Error {
  readonly code: SisterCompaniesErrorCode;

  constructor(code: SisterCompaniesErrorCode) {
    super(code);
    this.name = 'SisterCompaniesError';
    this.code = code;
  }
}

export const SISTER_COMPANIES_QUERY_KEY = ['project-settings', 'sister-companies'] as const;

/** Every column the tree renders or the dialog prefills — no more. */
export const SISTER_COMPANIES_SELECT = 'id, parent_id, level, code, name, is_active';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** `SIS-001` sorts before `SIS-001-01`, so numeric order is creation order. */
const CODE_COLLATOR = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

interface MutableNode {
  id: string;
  parentId: string | null;
  level: number;
  code: string;
  name: string;
  isActive: boolean;
  branches: MutableNode[];
}

/**
 * Normalize the flat response into the two-level tree.
 *
 * Malformed rows are dropped instead of throwing (one bad row must not blank
 * the screen), as are orphans: a branch whose parent is missing or is itself a
 * branch cannot be placed, and the UI has no third level to put it on. The
 * database's FK and CHECK make both cases unreachable; the parser is simply
 * not willing to build a tree that the screen would render wrongly.
 */
export function parseSisterCompanies(raw: unknown): readonly SisterCompany[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const nodes = new Map<string, MutableNode>();

  for (const row of raw) {
    if (!isRecord(row)) {
      continue;
    }
    const id = readString(row.id);
    const code = readString(row.code);
    const name = readString(row.name);
    const level = typeof row.level === 'number' ? row.level : null;
    if (id === null || code === null || name === null) {
      continue;
    }
    if (level !== 1 && level !== 2) {
      continue;
    }
    const parentId = level === 2 ? readString(row.parent_id) : null;
    if (level === 2 && parentId === null) {
      continue;
    }
    if (nodes.has(id)) {
      continue;
    }
    nodes.set(id, {
      id,
      parentId,
      level,
      code,
      name,
      isActive: row.is_active === true,
      branches: [],
    });
  }

  const roots: MutableNode[] = [];

  for (const node of nodes.values()) {
    if (node.level === 1) {
      roots.push(node);
      continue;
    }
    const parent = node.parentId === null ? undefined : nodes.get(node.parentId);
    if (parent === undefined || parent.level !== 1) {
      continue;
    }
    parent.branches.push(node);
  }

  const sortBranches = (node: MutableNode) => {
    node.branches.sort((a, b) => CODE_COLLATOR.compare(a.code, b.code));
  };

  roots.sort((a, b) => CODE_COLLATOR.compare(a.code, b.code));
  for (const root of roots) {
    sortBranches(root);
  }

  return roots;
}

export function classifySisterCompaniesError(error: unknown): SisterCompaniesErrorCode {
  if (error instanceof SisterCompaniesError) {
    return error.code;
  }
  return classifyPostgrestReadError(error);
}

export function useSisterCompanies(options?: { readonly enabled?: boolean }) {
  const enabled = options?.enabled ?? true;

  return useQuery({
    queryKey: SISTER_COMPANIES_QUERY_KEY,
    enabled,
    queryFn: async (): Promise<readonly SisterCompany[]> => {
      const supabase = getSupabase();
      if (supabase === null) {
        throw new SisterCompaniesError('unavailable');
      }

      const { data, error } = await supabase
        .from('sister_companies')
        .select(SISTER_COMPANIES_SELECT)
        .order('code', { ascending: true });

      if (error !== null && error !== undefined) {
        throw new SisterCompaniesError(classifySisterCompaniesError(error));
      }

      return parseSisterCompanies(data);
    },
  });
}
