/**
 * PREVIEW ONLY — an in-memory stand-in for the Supabase client.
 *
 * `vite.preview.config.ts` aliases `@/lib/supabase` to this module so the review
 * build can be clicked through without a project behind it. It is never part of
 * the production bundle (`npm run build` uses `vite.config.ts`) and it is not a
 * source of truth: the database triggers and RLS policies are.
 *
 * What it does reproduce, because the UI depends on it and a review that lied
 * about these would be worthless:
 *
 * * codes are minted server-side from a counter (`CLS-001` …), never taken from
 *   the payload — so a review can confirm the client really sends none;
 * * `level` is derived from `parent_id` at any depth (there is no ceiling), and a
 *   move or insert that would make a node its own ancestor raises 22023;
 * * `is_leaf` is derived from the child list and is kept in step on insert and
 *   on delete, including flipping the parent back to a leaf;
 * * deleting a node that still has children raises 23503 (ON DELETE RESTRICT);
 * * a payload carrying `code`, `level` or `is_leaf` is rejected outright, so a
 *   regression in the client shows up in the preview instead of hiding.
 *
 * What it does NOT reproduce: authentication, RLS, concurrency and the audit
 * trail. Those are exercised by the unit tests, the DB audit and Playwright
 * against a real stack.
 */

export interface PreviewRow {
  id: string;
  parent_id: string | null;
  code: string;
  name: string;
  level: number;
  is_leaf: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

interface SimpleRow {
  id: string;
  [key: string]: unknown;
}

const DERIVED = ['code', 'level', 'is_leaf'] as const;

/** A PostgREST-shaped failure: `code` is SQLSTATE (or `PGRST…`), as on the wire. */
class DbError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'DbError';
  }
}

/**
 * Seed mirrors `supabase/seed.sql` row for row and code for code, plus one deep
 * branch (`مخزون ← وقود ← سولار ← سولار تشغيل ← ديزل معدات`) so the review build
 * exercises five levels — the shape the old three-level ceiling forbade.
 */
const CLASSIFICATION_SEED: ReadonlyArray<
  readonly [id: string, parent: string | null, name: string, isActive: boolean]
> = [
  ['c-mat', null, 'المواد والمستلزمات', true],
  ['c-srv', null, 'الخدمات', true],
  ['c-stock', null, 'مخزون', true],
  ['g-raw', 'c-mat', 'المواد الخام', true],
  ['g-ops', 'c-mat', 'مستلزمات التشغيل', true],
  ['g-maint', 'c-srv', 'خدمات الصيانة', false],
  ['g-fuel', 'c-stock', 'وقود', true],
  ['i-steel', 'g-raw', 'حديد وصلب', true],
  ['i-wood', 'g-raw', 'أخشاب', true],
  ['i-plastic', 'g-raw', 'بلاستيك ومطاط', false],
  ['i-oil', 'g-ops', 'زيوت وشحوم', true],
  ['i-parts', 'g-ops', 'قطع غيار', true],
  ['i-periodic', 'g-maint', 'صيانة دورية', true],
  ['i-repair', 'g-maint', 'إصلاح أعطال', true],
  ['d-solar', 'g-fuel', 'سولار', true],
  ['d-solar-ops', 'd-solar', 'سولار تشغيل', true],
  ['d-diesel', 'd-solar-ops', 'ديزل معدات', true],
  ['d-diesel-heavy', 'd-diesel', 'ديزل آليات ثقيلة', true],
];

/* The seed consumes CLS-001 … CLS-012, so the counter starts where the seed
   ends; `mintCode` advances before formatting, which keeps the numbers aligned
   with the rows they are printed on. */
let sequence = 0;
let rowSequence = 0;

function mintCode(): string {
  sequence += 1;
  return `CLS-${sequence < 1000 ? String(sequence).padStart(3, '0') : String(sequence)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function id(prefix: string): string {
  rowSequence += 1;
  return `${prefix}-${rowSequence}`;
}

const classifications: PreviewRow[] = [];

/** Load the seed, deriving `level` and `is_leaf` the way the triggers do. */
function seed() {
  for (const [rowId, parentId, name, isActive] of CLASSIFICATION_SEED) {
    classifications.push({
      id: rowId,
      parent_id: parentId,
      code: mintCode(),
      name,
      level: 1,
      is_leaf: true,
      is_active: isActive,
      created_at: nowIso(),
      updated_at: nowIso(),
    });
  }
  for (const row of classifications) {
    row.level = levelOf(row.parent_id);
    row.is_leaf = !classifications.some((child) => child.parent_id === row.id);
  }
}
seed();

/** Mirrors `classifications_before_write`: 1 for a root, parent + 1 otherwise. */
function levelOf(parentId: string | null): number {
  if (parentId === null) {
    return 1;
  }
  const parent = classifications.find((row) => row.id === parentId);
  if (parent === undefined) {
    throw new DbError('23503', 'classifications: parent does not exist');
  }
  return parent.level + 1;
}

function refreshLeaf(parentId: string | null) {
  if (parentId === null) {
    return;
  }
  const parent = classifications.find((row) => row.id === parentId);
  if (parent !== undefined) {
    parent.is_leaf = !classifications.some((child) => child.parent_id === parent.id);
  }
}

const stations: SimpleRow[] = [
  { id: 's-1', code: 'ST-01', name: 'المحطة الرئيسية', is_active: true },
  { id: 's-2', code: 'ST-02', name: 'محطة الصيانة', is_active: true },
  { id: 's-3', code: 'ST-03', name: 'محطة الوقود الشمالية', is_active: false },
];

const warehouses: SimpleRow[] = [
  { id: 'w-1', station_id: 's-1', code: 'WH-001', name: 'مخزن المواد الخام', is_active: true },
  { id: 'w-2', station_id: 's-1', code: 'WH-002', name: 'مخزن قطع الغيار', is_active: true },
  { id: 'w-3', station_id: 's-1', code: 'WH-003', name: 'مخزن المرتجعات', is_active: false },
  { id: 'w-4', station_id: 's-2', code: 'WH-004', name: 'مخزن العدد والأدوات', is_active: true },
];

function writeName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (name === '') {
    throw new DbError('23514', 'classifications_name_not_blank');
  }
  return name;
}

function rejectDerivedColumns(payload: Record<string, unknown>) {
  for (const column of DERIVED) {
    if (column in payload) {
      throw new DbError('42501', `preview: the client must not write "${column}"`);
    }
  }
}

function insertClassification(payload: Record<string, unknown>): PreviewRow {
  rejectDerivedColumns(payload);
  const name = writeName(payload.name);
  const parent = typeof payload.parent_id === 'string' ? payload.parent_id : null;
  const level = levelOf(parent);

  const row: PreviewRow = {
    id: id('preview'),
    parent_id: parent,
    code: mintCode(),
    name,
    level,
    is_leaf: true,
    is_active: payload.is_active === undefined ? true : payload.is_active === true,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  classifications.push(row);
  refreshLeaf(parent);
  return row;
}

function updateClassification(
  payload: Record<string, unknown>,
  filters: readonly (readonly [string, unknown])[],
): PreviewRow | null {
  rejectDerivedColumns(payload);
  if ('parent_id' in payload) {
    /* The UI must not offer reparenting; if it ever does, fail here loudly. */
    throw new DbError('42501', 'preview: parent_id is write-once (insert only)');
  }
  const row = matchOne(classifications, filters);
  if (row === null) {
    throw new DbError('PGRST116', 'JSON object requested, 0 rows returned');
  }
  if ('name' in payload) {
    row.name = writeName(payload.name);
  }
  if ('is_active' in payload) {
    row.is_active = payload.is_active === true;
  }
  row.updated_at = nowIso();
  return { ...row };
}

function deleteClassification(filters: readonly (readonly [string, unknown])[]): PreviewRow[] {
  const row = matchOne(classifications, filters);
  if (row === null) {
    return [];
  }
  if (classifications.some((child) => child.parent_id === row.id)) {
    throw new DbError(
      '23503',
      'update or delete on table "classifications" violates foreign key constraint',
    );
  }
  const index = classifications.indexOf(row);
  classifications.splice(index, 1);
  refreshLeaf(row.parent_id);
  return [{ ...row }];
}

function matchOne<T extends { id: string }>(
  rows: T[],
  filters: readonly (readonly [string, unknown])[],
): T | null {
  const found = rows.filter((row) =>
    filters.every(([column, value]) => (row as Record<string, unknown>)[column] === value),
  );
  return found[0] ?? null;
}

/** Only the columns the screen renders; enough to keep the shape honest. */
function projectClassification(row: PreviewRow): Record<string, unknown> {
  return { ...row };
}

function projectStations(): Record<string, unknown>[] {
  return stations.map((station) => ({
    ...station,
    warehouses: warehouses
      .filter((warehouse) => warehouse.station_id === station.id)
      .map((warehouse) => ({
        id: warehouse.id,
        code: warehouse.code,
        name: warehouse.name,
        is_active: warehouse.is_active,
      })),
  }));
}

type Outcome = { data: unknown; error: DbError | null };

function runClassification(
  operation: 'insert' | 'update' | 'delete' | 'select',
  payload: Record<string, unknown> | undefined,
  filters: readonly (readonly [string, unknown])[],
  single: boolean,
): Outcome {
  try {
    if (operation === 'insert') {
      const row = insertClassification(payload ?? {});
      return {
        data: single ? projectClassification(row) : [projectClassification(row)],
        error: null,
      };
    }
    if (operation === 'update') {
      const row = updateClassification(payload ?? {}, filters);
      return { data: single ? row : row === null ? [] : [row], error: null };
    }
    if (operation === 'delete') {
      return { data: deleteClassification(filters), error: null };
    }
    const rows = classifications
      .slice()
      .sort((a, b) => a.code.localeCompare(b.code, 'en', { numeric: true }))
      .filter((row) => filters.every(([column, value]) => row[column as 'id'] === value));
    return { data: rows.map(projectClassification), error: null };
  } catch (error) {
    if (error instanceof DbError) {
      return { data: null, error };
    }
    throw error;
  }
}

interface Builder extends PromiseLike<Outcome> {
  select: (columns?: string) => Builder;
  order: (column: string, options?: unknown) => Builder;
  eq: (column: string, value: unknown) => Builder;
  single: () => Promise<Outcome>;
}

/**
 * The subset of the PostgREST builder the hooks actually chain. `eq` collects
 * filters, `select`/`order` are recorded and ignored, and the object is
 * thenable so `await supabase.from(…).select(…)` resolves like the real client.
 */
function builder(
  table: string,
  operation: 'insert' | 'update' | 'delete' | 'select',
  payload?: Record<string, unknown>,
): Builder {
  const filters: Array<readonly [string, unknown]> = [];
  let single = false;

  const execute = (): Outcome => {
    if (table === 'classifications') {
      return runClassification(operation, payload, filters, single);
    }
    if (operation === 'select' && table === 'stations') {
      return { data: projectStations(), error: null };
    }
    return { data: [], error: null };
  };

  const chain: Builder = {
    select: () => chain,
    order: () => chain,
    eq: (column, value) => {
      filters.push([column, value] as const);
      return chain;
    },
    single: () => {
      single = true;
      return Promise.resolve(execute());
    },
    then: (onFulfilled, onRejected) => Promise.resolve(execute()).then(onFulfilled, onRejected),
  };
  return chain;
}

export interface PreviewSupabaseClient {
  from: (table: string) => {
    select: (columns?: string) => Builder;
    insert: (payload: Record<string, unknown>) => Builder;
    update: (payload: Record<string, unknown>) => Builder;
    delete: () => Builder;
  };
}

const client: PreviewSupabaseClient = {
  from: (table: string) => ({
    select: (columns?: string) => builder(table, 'select', undefined).select(columns),
    insert: (payload: Record<string, unknown>) => builder(table, 'insert', payload),
    update: (payload: Record<string, unknown>) => builder(table, 'update', payload),
    delete: () => builder(table, 'delete'),
  }),
};

/** Same signature as the real `getSupabase()`, minus the "not configured" case. */
export function getSupabase(): PreviewSupabaseClient {
  return client;
}

/**
 * A second writer, so the review can stage the one race the UI cannot produce
 * on its own: two admins, one adding a child while the other deletes what was
 * a leaf a moment ago. Exposed on `window` for `scripts/preview/screenshots.mjs`
 * and for anyone clicking around; it is not reachable from application code and
 * does not exist in the production bundle.
 */
declare global {
  interface Window {
    __previewDb?: {
      addChild: (parentName: string, name: string) => string;
      list: () => readonly PreviewRow[];
    };
  }
}

if (typeof window !== 'undefined') {
  window.__previewDb = {
    addChild: (parentName, name) => {
      const parent = classifications.find((row) => row.name === parentName);
      if (parent === undefined) {
        throw new Error(`preview: no node named "${parentName}"`);
      }
      return insertClassification({ name, parent_id: parent.id }).id;
    },
    list: () => classifications.map((row) => ({ ...row })),
  };
}
