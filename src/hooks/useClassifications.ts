import { useQuery } from '@tanstack/react-query';
import { classifyPostgrestReadError } from '@/hooks/postgrestReadError';
import { getSupabase } from '@/lib/supabase';

/**
 * Classifications directory (`['project-settings', 'classifications']`).
 *
 * One flat read returns every row; the tree is assembled here, at any depth. The
 * expected volume is a few dozen rows, so there is no pagination, no cursor and
 * no per-level lazy fetch — and one request is also the only way to guarantee
 * the tree is internally consistent (three sequential reads could observe a
 * concurrent insert between levels).
 *
 * The database owns the shape: `level` and `is_leaf` are derived by triggers
 * from `parent_id`, codes are sequence-minted (`CLS-001`), and every row is
 * RLS-gated by `can_manage_project_settings()` (`project.settings:manage`).
 * The UI therefore never sends `level`, `is_leaf` or `code`, and it does not
 * trust the wire `level` either: the level is re-derived from the parent links
 * it received, exactly as the server derives it, so a malformed row cannot
 * claim a level that contradicts where it is rendered.
 *
 * Authorization: the route is wrapped in `RequireCapability`, but that gate
 * reads a capability snapshot and can disagree with a live grant that was
 * revoked or delegated away. A `42501`/`PGRST301` read is classified as
 * `forbidden` so the screen renders an explicit message instead of an empty
 * tree (which would read as "no classifications yet").
 */

/** One node of the rendered tree. `level` is derived, never taken from the wire. */
export interface ClassificationNode {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  /** 1 = main classification, 2+ = sub-classification. Derived, never capped. */
  readonly level: number;
  /** Mirrors the server's derived flag; true only when the node has no children. */
  readonly isLeaf: boolean;
  readonly isActive: boolean;
  readonly children: readonly ClassificationNode[];
}

export type ClassificationsErrorCode = 'unavailable' | 'forbidden' | 'network' | 'unknown';

export class ClassificationsError extends Error {
  readonly code: ClassificationsErrorCode;

  constructor(code: ClassificationsErrorCode) {
    super(code);
    this.name = 'ClassificationsError';
    this.code = code;
  }
}

export const CLASSIFICATIONS_QUERY_KEY = ['project-settings', 'classifications'] as const;

/**
 * The columns the tree renders — and nothing else. `level` is intentionally
 * absent: it is derived client-side from `parent_id`, so the read cannot go
 * stale against the trigger, and `is_leaf` is only used to keep the flag
 * coherent for the future letter-creation screen.
 */
export const CLASSIFICATIONS_SELECT = 'id, parent_id, code, name, is_leaf, is_active';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** A parent reference is either absent/null (root) or a non-empty string. */
function readParentId(value: unknown): { readonly ok: boolean; readonly value: string | null } {
  if (value === undefined || value === null) {
    return { ok: true, value: null };
  }
  if (typeof value === 'string' && value.trim() !== '') {
    return { ok: true, value };
  }
  return { ok: false, value: null };
}

interface MutableNode {
  id: string;
  code: string;
  name: string;
  parentId: string | null;
  isLeaf: boolean;
  isActive: boolean;
  level: number;
  children: MutableNode[];
}

/**
 * Codes are zero-padded (`CLS-001`), so an ordinal comparison is right up to
 * 999 — but `CLS-1000` sorts before `CLS-101` in plain string order. The
 * numeric-aware collator keeps creation order intact past the padding width,
 * and it is applied here rather than trusted from the server so render order is
 * deterministic regardless of the wire order.
 */
const CODE_COLLATOR = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

function byCode<T extends { readonly code: string }>(a: T, b: T): number {
  return CODE_COLLATOR.compare(a.code, b.code);
}

/**
 * Normalize the flat response into the render tree.
 *
 * Malformed rows are dropped rather than throwing: one bad row must not blank
 * the screen. A row whose `parent_id` points at an id that is not in the
 * payload (an orphan) is kept in the map but is unreachable from every root, so
 * it simply never renders — the same is true for a cycle, which cannot contain
 * a root because every node has at most one parent. That is also why the walk
 * below cannot loop: it only ever visits children of nodes reachable from a
 * root, and a functional parent map makes a reachable cycle impossible.
 */
export function parseClassifications(raw: unknown): readonly ClassificationNode[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const byId = new Map<string, MutableNode>();

  for (const row of raw) {
    if (!isRecord(row)) {
      continue;
    }
    const id = readString(row.id);
    const code = readString(row.code);
    const name = readString(row.name);
    const parent = readParentId(row.parent_id);
    if (id === null || code === null || name === null || !parent.ok) {
      continue;
    }
    /* A duplicate id cannot exist in the table (primary key); first one wins. */
    if (byId.has(id)) {
      continue;
    }
    byId.set(id, {
      id,
      code,
      name,
      parentId: parent.value,
      isLeaf: row.is_leaf === true,
      isActive: row.is_active === true,
      level: 1,
      children: [],
    });
  }

  const roots: MutableNode[] = [];

  for (const node of byId.values()) {
    if (node.parentId === null) {
      roots.push(node);
      continue;
    }
    const parent = byId.get(node.parentId);
    if (parent === undefined || parent.id === node.id) {
      /* Unreachable (orphan or self-reference): kept out of the rendered tree. */
      continue;
    }
    parent.children.push(node);
  }

  /* Derive the level from the built structure (mirrors the server trigger) and
     order every sibling list by code. Roots are level 1 by definition. */
  const finalize = (node: MutableNode): ClassificationNode => {
    node.children.sort(byCode);
    return {
      id: node.id,
      code: node.code,
      name: node.name,
      level: node.level,
      isLeaf: node.isLeaf,
      isActive: node.isActive,
      children: node.children.map((child) => {
        child.level = node.level + 1;
        return finalize(child);
      }),
    };
  };

  return roots.sort(byCode).map(finalize);
}

export function classifyClassificationsError(error: unknown): ClassificationsErrorCode {
  if (error instanceof ClassificationsError) {
    return error.code;
  }
  return classifyPostgrestReadError(error);
}

export function useClassifications(options?: { readonly enabled?: boolean }) {
  const enabled = options?.enabled ?? true;

  return useQuery({
    queryKey: CLASSIFICATIONS_QUERY_KEY,
    enabled,
    queryFn: async (): Promise<readonly ClassificationNode[]> => {
      const supabase = getSupabase();
      if (supabase === null) {
        throw new ClassificationsError('unavailable');
      }

      const { data, error } = await supabase
        .from('classifications')
        .select(CLASSIFICATIONS_SELECT)
        .order('code', { ascending: true });

      if (error !== null && error !== undefined) {
        throw new ClassificationsError(classifyClassificationsError(error));
      }

      return parseClassifications(data);
    },
  });
}
