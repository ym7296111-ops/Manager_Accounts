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
 *   regression in the client shows up in the preview instead of hiding;
 * * party codes are minted per type (`LOC-001` / `FRN-001` / `CUS-001`), a
 *   payload carrying `code` — or `type` on update — is rejected, and the
 *   retired `internal` / `sister_company` types are refused with 23514;
 * * sister companies form a two-level tree: `SIS-001` for a parent company and
 *   `SIS-001-01` for its first branch, `parent_id`/`code`/`level` are refused
 *   on update, and deleting a company that still has branches raises 23503.
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

interface PartyPreviewRow {
  id: string;
  type: string;
  code: string;
  name: string;
  tax_number: string | null;
  commercial_register: string | null;
  address: string | null;
  contact_person: string | null;
  phone: string | null;
  email: string | null;
  credit_limit: number | null;
  payment_terms: number | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

const PARTY_PREFIX: Record<string, string> = {
  local_supplier: 'LOC',
  foreign_supplier: 'FRN',
  customer: 'CUS',
};

/** Mirrors the parties block of `supabase/seed.sql` row for row (one per type). */
const parties: PartyPreviewRow[] = [
  {
    id: 'p-loc',
    type: 'local_supplier',
    code: 'LOC-001',
    name: 'شركة النيل للتوريدات الصناعية',
    tax_number: '123456789',
    commercial_register: '101010',
    address: 'المنطقة الصناعية، مدينة السادس من أكتوبر',
    contact_person: 'أحمد سامي',
    phone: '+20238200000',
    email: 'sales@nile-supplies.example.com',
    credit_limit: 250000,
    payment_terms: 30,
    is_active: true,
    created_at: nowIso(),
    updated_at: nowIso(),
  },
  {
    id: 'p-cus',
    type: 'customer',
    code: 'CUS-001',
    name: 'مؤسسة الأفق للتجارة والتوزيع',
    tax_number: '987654321',
    commercial_register: '202020',
    address: 'شارع الجمهورية، القاهرة',
    contact_person: 'منى خليل',
    phone: '+20225700000',
    email: 'purchases@horizon-trade.example.com',
    credit_limit: 150000,
    payment_terms: 60,
    is_active: true,
    created_at: nowIso(),
    updated_at: nowIso(),
  },
  {
    id: 'p-frn',
    type: 'foreign_supplier',
    code: 'FRN-001',
    name: 'Nile Trading GmbH',
    tax_number: 'DE-556677',
    commercial_register: 'HRB-99881',
    address: 'Hafenstraße 12, Hamburg',
    contact_person: 'Lena Fischer',
    phone: '+494012345678',
    email: 'orders@nile-trading.example.com',
    credit_limit: 500000,
    payment_terms: 15,
    is_active: true,
    created_at: nowIso(),
    updated_at: nowIso(),
  },
];

/** Every per-type sequence has already issued its `001` to the seed above. */
const partySequences: Record<string, number> = {
  local_supplier: 1,
  foreign_supplier: 1,
  customer: 1,
};

/** Mirrors `parties_before_write`: prefix by type, padded to three digits. */
function mintPartyCode(type: string): string {
  const next = (partySequences[type] ?? 0) + 1;
  partySequences[type] = next;
  return `${PARTY_PREFIX[type]}-${next < 1000 ? String(next).padStart(3, '0') : String(next)}`;
}

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

const PARTY_EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/i;

function partyOptionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** The parties CHECK family, so the preview refuses what the database refuses. */
function checkPartyConstraints(row: {
  type: string;
  email: string | null;
  credit_limit: number | null;
  payment_terms: number | null;
}) {
  if (row.email !== null && !PARTY_EMAIL.test(row.email)) {
    throw new DbError('23514', 'parties_email_check');
  }
  if (row.credit_limit !== null && row.credit_limit < 0) {
    throw new DbError('23514', 'parties_credit_limit_non_negative');
  }
  if (row.payment_terms !== null && ![0, 15, 30, 60, 90].includes(row.payment_terms)) {
    throw new DbError('23514', 'parties_payment_terms_check');
  }
  if (!(row.type in PARTY_PREFIX)) {
    throw new DbError('23514', 'parties_type_check');
  }
}

function insertParty(payload: Record<string, unknown>): PartyPreviewRow {
  /* The trigger would overwrite a sent code; rejecting it here makes a client
     regression visible in the preview instead of silently tolerated. */
  if ('code' in payload) {
    throw new DbError('42501', 'preview: the client must not write "code"');
  }
  const type = typeof payload.type === 'string' ? payload.type : '';
  if (!(type in PARTY_PREFIX)) {
    throw new DbError('23514', 'parties_type_check');
  }

  const row: PartyPreviewRow = {
    id: id('party'),
    type,
    /* Minted before the CHECKs run, like the trigger: a refused insert still
       burns a sequence number, exactly as in the database. */
    code: mintPartyCode(type),
    name: writeName(payload.name),
    tax_number: partyOptionalText(payload.tax_number),
    commercial_register: partyOptionalText(payload.commercial_register),
    address: partyOptionalText(payload.address),
    contact_person: partyOptionalText(payload.contact_person),
    phone: partyOptionalText(payload.phone),
    email: partyOptionalText(payload.email),
    credit_limit: typeof payload.credit_limit === 'number' ? payload.credit_limit : null,
    payment_terms: typeof payload.payment_terms === 'number' ? payload.payment_terms : null,
    is_active: payload.is_active === undefined ? true : payload.is_active === true,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  checkPartyConstraints(row);
  parties.push(row);
  return { ...row };
}

function updateParty(
  payload: Record<string, unknown>,
  filters: readonly (readonly [string, unknown])[],
): PartyPreviewRow {
  /* The database refuses a CHANGED type/code with 22023; the preview refuses
     their mere presence, so a client that starts sending either fails here. */
  if ('code' in payload || 'type' in payload) {
    throw new DbError('42501', 'preview: type and code are write-once (insert only)');
  }
  const row = matchOne(parties, filters);
  if (row === null) {
    throw new DbError('PGRST116', 'JSON object requested, 0 rows returned');
  }

  if ('name' in payload) {
    row.name = writeName(payload.name);
  }
  if ('tax_number' in payload) {
    row.tax_number = partyOptionalText(payload.tax_number);
  }
  if ('commercial_register' in payload) {
    row.commercial_register = partyOptionalText(payload.commercial_register);
  }
  if ('address' in payload) {
    row.address = partyOptionalText(payload.address);
  }
  if ('contact_person' in payload) {
    row.contact_person = partyOptionalText(payload.contact_person);
  }
  if ('phone' in payload) {
    row.phone = partyOptionalText(payload.phone);
  }
  if ('email' in payload) {
    row.email = partyOptionalText(payload.email);
  }
  if ('credit_limit' in payload) {
    row.credit_limit = typeof payload.credit_limit === 'number' ? payload.credit_limit : null;
  }
  if ('payment_terms' in payload) {
    row.payment_terms = typeof payload.payment_terms === 'number' ? payload.payment_terms : null;
  }
  if ('is_active' in payload) {
    row.is_active = payload.is_active === true;
  }

  checkPartyConstraints(row);
  row.updated_at = nowIso();
  return { ...row };
}

function deleteParty(filters: readonly (readonly [string, unknown])[]): PartyPreviewRow[] {
  const row = matchOne(parties, filters);
  if (row === null) {
    return [];
  }
  parties.splice(parties.indexOf(row), 1);
  return [{ ...row }];
}

interface SisterCompanyPreviewRow {
  id: string;
  parent_id: string | null;
  level: number;
  code: string;
  name: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

/** Mirrors the sister-companies block of `supabase/seed.sql`. */
const sisterCompanies: SisterCompanyPreviewRow[] = [
  {
    id: 'sc-parent',
    parent_id: null,
    level: 1,
    code: 'SIS-001',
    name: 'الشركة المتحدة للخدمات اللوجستية',
    is_active: true,
    created_at: nowIso(),
    updated_at: nowIso(),
  },
  {
    id: 'sc-branch-1',
    parent_id: 'sc-parent',
    level: 2,
    code: 'SIS-001-01',
    name: 'المتحدة للنقل الثقيل',
    is_active: true,
    created_at: nowIso(),
    updated_at: nowIso(),
  },
  {
    id: 'sc-branch-2',
    parent_id: 'sc-parent',
    level: 2,
    code: 'SIS-001-02',
    name: 'المتحدة للتخليص الجمركي',
    is_active: false,
    created_at: nowIso(),
    updated_at: nowIso(),
  },
];

/** The seed already issued SIS-001 to the first parent company. */
let sisterRootSequence = 1;

function pad3(value: number): string {
  return value < 1000 ? String(value).padStart(3, '0') : String(value);
}

function pad2(value: number): string {
  return value < 100 ? String(value).padStart(2, '0') : String(value);
}

/** Mirrors `sister_companies_before_write`: derived level and code, write-once tree. */
function insertSisterCompany(payload: Record<string, unknown>): SisterCompanyPreviewRow {
  if ('code' in payload || 'level' in payload) {
    throw new DbError('42501', 'preview: the client must not write "code" or "level"');
  }
  const name = writeName(payload.name);
  const parentId = typeof payload.parent_id === 'string' ? payload.parent_id : null;

  let level: number;
  let code: string;

  if (parentId === null) {
    level = 1;
    sisterRootSequence += 1;
    code = `SIS-${pad3(sisterRootSequence)}`;
  } else {
    const parent = sisterCompanies.find((row) => row.id === parentId);
    if (parent === undefined) {
      throw new DbError('23503', 'sister_companies: parent does not exist');
    }
    if (parent.level !== 1) {
      throw new DbError('22023', 'sister_companies: a branch cannot have branches');
    }
    level = 2;
    const highest = sisterCompanies
      .filter((row) => row.parent_id === parentId)
      .reduce((max, row) => Math.max(max, Number(row.code.slice(parent.code.length + 1)) || 0), 0);
    code = `${parent.code}-${pad2(highest + 1)}`;
  }

  const row: SisterCompanyPreviewRow = {
    id: id('sister'),
    parent_id: parentId,
    level,
    code,
    name,
    is_active: payload.is_active === undefined ? true : payload.is_active === true,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  sisterCompanies.push(row);
  return { ...row };
}

function updateSisterCompany(
  payload: Record<string, unknown>,
  filters: readonly (readonly [string, unknown])[],
): SisterCompanyPreviewRow {
  /* parent_id, code and level are write-once; the database refuses a change
     with 22023, the preview refuses their presence so a regression shows up. */
  for (const column of ['code', 'level', 'parent_id'] as const) {
    if (column in payload) {
      throw new DbError('42501', `preview: ${column} is write-once (insert only)`);
    }
  }
  const row = matchOne(sisterCompanies, filters);
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

function deleteSisterCompany(
  filters: readonly (readonly [string, unknown])[],
): SisterCompanyPreviewRow[] {
  const row = matchOne(sisterCompanies, filters);
  if (row === null) {
    return [];
  }
  if (sisterCompanies.some((child) => child.parent_id === row.id)) {
    throw new DbError(
      '23503',
      'update or delete on table "sister_companies" violates foreign key constraint',
    );
  }
  sisterCompanies.splice(sisterCompanies.indexOf(row), 1);
  return [{ ...row }];
}

function runSisterCompany(
  operation: 'insert' | 'update' | 'delete' | 'select',
  payload: Record<string, unknown> | undefined,
  filters: readonly (readonly [string, unknown])[],
  single: boolean,
): Outcome {
  try {
    if (operation === 'insert') {
      const row = insertSisterCompany(payload ?? {});
      return { data: single ? row : [row], error: null };
    }
    if (operation === 'update') {
      const row = updateSisterCompany(payload ?? {}, filters);
      return { data: single ? row : [row], error: null };
    }
    if (operation === 'delete') {
      return { data: deleteSisterCompany(filters), error: null };
    }
    const rows = sisterCompanies
      .slice()
      .sort((a, b) => a.code.localeCompare(b.code, 'en', { numeric: true }))
      .map((row) => ({ ...row }));
    return { data: rows, error: null };
  } catch (error) {
    if (error instanceof DbError) {
      return { data: null, error };
    }
    throw error;
  }
}

function runParty(
  operation: 'insert' | 'update' | 'delete' | 'select',
  payload: Record<string, unknown> | undefined,
  filters: readonly (readonly [string, unknown])[],
  single: boolean,
): Outcome {
  try {
    if (operation === 'insert') {
      const row = insertParty(payload ?? {});
      return { data: single ? row : [row], error: null };
    }
    if (operation === 'update') {
      const row = updateParty(payload ?? {}, filters);
      return { data: single ? row : [row], error: null };
    }
    if (operation === 'delete') {
      return { data: deleteParty(filters), error: null };
    }
    const rows = parties
      .slice()
      .sort((a, b) => a.code.localeCompare(b.code, 'en', { numeric: true }))
      .map((row) => ({ ...row }));
    return { data: rows, error: null };
  } catch (error) {
    if (error instanceof DbError) {
      return { data: null, error };
    }
    throw error;
  }
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
    if (table === 'parties') {
      return runParty(operation, payload, filters, single);
    }
    if (table === 'sister_companies') {
      return runSisterCompany(operation, payload, filters, single);
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
      addBranch: (parentName: string, name: string) => string;
      list: () => readonly PreviewRow[];
      listSisterCompanies: () => readonly SisterCompanyPreviewRow[];
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
    addBranch: (parentName, name) => {
      const parent = sisterCompanies.find((row) => row.name === parentName);
      if (parent === undefined) {
        throw new Error(`preview: no sister company named "${parentName}"`);
      }
      return insertSisterCompany({ name, parent_id: parent.id }).id;
    },
    list: () => classifications.map((row) => ({ ...row })),
    listSisterCompanies: () => sisterCompanies.map((row) => ({ ...row })),
  };
}
