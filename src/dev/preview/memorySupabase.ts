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
 * * a party is a name under one of two roots (`inbound` / `outbound`): its code
 *   is minted per branch (`IN-001` / `OUT-001`), a payload carrying `code` — or
 *   `branch` on update — is rejected, and a branch outside the two roots is
 *   refused with 23514;
 * * the issuer register is a flat list of two-letter codes: `code` is refused on
 *   update (it is the identity), a duplicate is refused case-insensitively with
 *   23505, the name falls back to the code when blank, and there is no delete
 *   privilege at all — a used code is deactivated, like the database allows;
 * * sister companies form a two-level tree: `SIS-001` for a parent company and
 *   `SIS-001-01` for its first branch, `parent_id`/`code`/`level` are refused
 *   on update, and deleting a company that still has branches raises 23503;
 * * a fiscal-year insert derives its name and generates twelve months, a
 *   period edit writes only `current_period`, and opening balances upsert on
 *   `(fiscal_year_id, warehouse_id, classification_id)`;
 * * the opening-balance freeze is honoured: a year flipped to
 *   `opening_balances_locked` refuses new balances (42501) and filters deletes,
 *   which is what the RLS policies do.
 *
 * What it does NOT reproduce: authentication, RLS, concurrency and the audit
 * trigger/logs. Those remain database responsibilities and are checked by the
 * real-stack E2E flow and database audit.
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

interface FiscalYearPreviewRow {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  is_active: boolean;
  is_closed: boolean;
  supplements_open: boolean;
  /**
   * Mirrors `fiscal_years.opening_balances_locked` (20261112000000). The real
   * enforcement is the RLS policies on `opening_balances`; this copy exists so
   * the preview can disable the same controls and refuse the same writes.
   */
  opening_balances_locked: boolean;
  created_at: string;
  updated_at: string;
}

interface FiscalMonthPreviewRow {
  id: string;
  fiscal_year_id: string;
  month_number: number;
  name: string;
  start_date: string;
  end_date: string;
  current_period: number;
  is_closed: boolean;
  created_at: string;
  updated_at: string;
}

interface OpeningBalancePreviewRow {
  id: string;
  fiscal_year_id: string;
  warehouse_id: string;
  classification_id: string;
  amount: number;
  created_at: string;
  updated_at: string;
}

const MONTH_NAMES = [
  'يناير',
  'فبراير',
  'مارس',
  'أبريل',
  'مايو',
  'يونيو',
  'يوليو',
  'أغسطس',
  'سبتمبر',
  'أكتوبر',
  'نوفمبر',
  'ديسمبر',
] as const;

function fiscalDate(year: number, monthIndex: number, day: number): string {
  const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  const date = new Date(Date.UTC(year, monthIndex, Math.min(day, lastDay)));
  return date.toISOString().slice(0, 10);
}

function addFiscalMonths(startDate: string, amount: number): string {
  const [yearText = '1970', monthText = '1', dayText = '1'] = startDate.split('-');
  const baseYear = Number(yearText);
  const baseMonth = Number(monthText) - 1;
  const targetMonth = baseMonth + amount;
  const targetYear = baseYear + Math.floor(targetMonth / 12);
  return fiscalDate(targetYear, targetMonth % 12, Number(dayText));
}

function previousDay(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function createFiscalMonths(year: FiscalYearPreviewRow): FiscalMonthPreviewRow[] {
  return Array.from({ length: 12 }, (_, index) => {
    const monthStart = [addFiscalMonths(year.start_date, index), year.end_date].sort()[0]!;
    const nextStart = [addFiscalMonths(year.start_date, index + 1), year.end_date].sort()[0]!;
    const monthEnd =
      index === 11 ? year.end_date : [previousDay(nextStart), year.end_date].sort()[0]!;
    const date = new Date(`${monthStart}T00:00:00.000Z`);
    const monthName = MONTH_NAMES[date.getUTCMonth()] ?? 'يناير';
    return {
      id: id('fiscal-month'),
      fiscal_year_id: year.id,
      month_number: index + 1,
      name: `${monthName} ${date.getUTCFullYear()}`,
      start_date: monthStart,
      end_date: monthEnd < monthStart ? monthStart : monthEnd,
      current_period: 1,
      is_closed: false,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
  });
}

const fiscalYears: FiscalYearPreviewRow[] = [
  {
    id: 'fy-preview-2025',
    name: '2025-2026',
    start_date: '2025-07-01',
    end_date: '2026-06-30',
    is_active: true,
    is_closed: false,
    supplements_open: false,
    opening_balances_locked: false,
    created_at: nowIso(),
    updated_at: nowIso(),
  },
];

const fiscalMonths = createFiscalMonths(fiscalYears[0]!);
if (fiscalMonths[0] !== undefined) {
  fiscalMonths[0].current_period = 3;
}

const openingBalances: OpeningBalancePreviewRow[] = [
  {
    id: 'ob-preview-steel',
    fiscal_year_id: 'fy-preview-2025',
    warehouse_id: 'w-1',
    classification_id: 'i-steel',
    amount: 125000.5,
    created_at: nowIso(),
    updated_at: nowIso(),
  },
  {
    id: 'ob-preview-wood',
    fiscal_year_id: 'fy-preview-2025',
    warehouse_id: 'w-1',
    classification_id: 'i-wood',
    amount: 52500,
    created_at: nowIso(),
    updated_at: nowIso(),
  },
  /* Two balances that no longer have a writable leaf underneath them, so the
     review section is visible in the preview build and in screenshots:
     «المواد الخام» gained children after the balance was entered, and
     «بلاستيك ومطاط» was deactivated. Both stay inside the warehouse total. */
  {
    id: 'ob-preview-raw',
    fiscal_year_id: 'fy-preview-2025',
    warehouse_id: 'w-1',
    classification_id: 'g-raw',
    amount: 40000,
    created_at: nowIso(),
    updated_at: nowIso(),
  },
  {
    id: 'ob-preview-plastic',
    fiscal_year_id: 'fy-preview-2025',
    warehouse_id: 'w-1',
    classification_id: 'i-plastic',
    amount: 7500,
    created_at: nowIso(),
    updated_at: nowIso(),
  },
];

interface PartyPreviewRow {
  id: string;
  branch: string;
  code: string;
  name: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

const PARTY_PREFIX: Record<string, string> = {
  inbound: 'IN',
  outbound: 'OUT',
};

/** Mirrors the parties block of `supabase/seed.sql` row for row. */
const parties: PartyPreviewRow[] = [
  {
    id: 'p-in-1',
    branch: 'inbound',
    code: 'IN-001',
    name: 'شركة النيل للتوريدات الصناعية',
    is_active: true,
    created_at: nowIso(),
    updated_at: nowIso(),
  },
  {
    id: 'p-in-2',
    branch: 'inbound',
    code: 'IN-002',
    name: 'Nile Trading GmbH',
    is_active: true,
    created_at: nowIso(),
    updated_at: nowIso(),
  },
  {
    id: 'p-out-1',
    branch: 'outbound',
    code: 'OUT-001',
    name: 'مؤسسة الأفق للتجارة والتوزيع',
    is_active: true,
    created_at: nowIso(),
    updated_at: nowIso(),
  },
];

/** Each branch sequence has already issued the codes the seed holds. */
const partySequences: Record<string, number> = {
  inbound: 2,
  outbound: 1,
};

/** Mirrors `parties_before_write`: prefix by branch, padded to three digits. */
function mintPartyCode(branch: string): string {
  const next = (partySequences[branch] ?? 0) + 1;
  partySequences[branch] = next;
  return `${PARTY_PREFIX[branch]}-${next < 1000 ? String(next).padStart(3, '0') : String(next)}`;
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

/** The parties CHECK family, so the preview refuses what the database refuses. */
function checkPartyConstraints(row: { branch: string }) {
  if (!(row.branch in PARTY_PREFIX)) {
    throw new DbError('23514', 'parties_branch_check');
  }
}

function insertParty(payload: Record<string, unknown>): PartyPreviewRow {
  /* The trigger would overwrite a sent code; rejecting it here makes a client
     regression visible in the preview instead of silently tolerated. */
  if ('code' in payload) {
    throw new DbError('42501', 'preview: the client must not write "code"');
  }
  const branch = typeof payload.branch === 'string' ? payload.branch : '';
  if (!(branch in PARTY_PREFIX)) {
    throw new DbError('23514', 'parties_branch_check');
  }

  const row: PartyPreviewRow = {
    id: id('party'),
    branch,
    /* Minted before the CHECKs run, like the trigger: a refused insert still
       burns a sequence number, exactly as in the database. */
    code: mintPartyCode(branch),
    name: writeName(payload.name),
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
  /* The database refuses a CHANGED branch/code with 22023; the preview refuses
     their mere presence, so a client that starts sending either fails here. */
  if ('code' in payload || 'branch' in payload) {
    throw new DbError('42501', 'preview: branch and code are write-once (insert only)');
  }
  const row = matchOne(parties, filters);
  if (row === null) {
    throw new DbError('PGRST116', 'JSON object requested, 0 rows returned');
  }

  if ('name' in payload) {
    row.name = writeName(payload.name);
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

/**
 * The issuer register (`public.issuers`): `code` is the identity, `name` is
 * optional, and a used code is deactivated rather than deleted — the table
 * grants `select, insert, update` only.
 */
interface IssuerPreviewRow {
  id: string;
  code: string;
  name: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

const issuers: IssuerPreviewRow[] = [
  {
    id: 'issuer-ym',
    code: 'YM',
    name: 'ياسر',
    is_active: true,
    created_at: nowIso(),
    updated_at: nowIso(),
  },
  {
    id: 'issuer-aa',
    code: 'AA',
    name: 'أحمد عبد الله',
    is_active: true,
    created_at: nowIso(),
    updated_at: nowIso(),
  },
];

/** `issuers_code_format check (code ~ '^[A-Za-z]{2}$')`. */
function writeIssuerCode(value: unknown): string {
  const code = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!/^[A-Z]{2}$/.test(code)) {
    throw new DbError('23514', 'issuers_code_format');
  }
  if (issuers.some((row) => row.code.toUpperCase() === code)) {
    throw new DbError('23505', 'issuers_code_upper_key');
  }
  return code;
}

function insertIssuer(payload: Record<string, unknown>): IssuerPreviewRow {
  if ('id' in payload || 'created_at' in payload) {
    throw new DbError('42501', 'preview: the client must not write server columns');
  }
  const code = writeIssuerCode(payload.code);
  const name = typeof payload.name === 'string' ? payload.name.trim() : '';
  const row: IssuerPreviewRow = {
    id: id('issuer'),
    code,
    /* `issuers.name` is `not null`: a blank name is stored as the code, which
       is what the client sends after `validateIssuerName`. */
    name: name === '' ? code : name,
    is_active: payload.is_active !== false,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  if ([...row.name].length > 120) {
    throw new DbError('23514', 'issuers_name_not_blank');
  }
  issuers.push(row);
  return { ...row };
}

function updateIssuer(
  payload: Record<string, unknown>,
  filters: readonly (readonly [string, unknown])[],
): IssuerPreviewRow {
  /* The two letters are the identity: an update that carried them would rewrite
     the prefix of every letter already recorded against the row. */
  if ('id' in payload || 'code' in payload) {
    throw new DbError('42501', 'preview: code is write-once (insert only)');
  }
  const row = matchOne(issuers, filters);
  if (row === null) {
    throw new DbError('PGRST116', 'JSON object requested, 0 rows returned');
  }
  if ('name' in payload) {
    const name = typeof payload.name === 'string' ? payload.name.trim() : '';
    if (name === '' || [...name].length > 120) {
      throw new DbError('23514', 'issuers_name_not_blank');
    }
    row.name = name;
  }
  if ('is_active' in payload) {
    row.is_active = payload.is_active === true;
  }
  row.updated_at = nowIso();
  return { ...row };
}

function runIssuer(
  operation: 'insert' | 'update' | 'delete' | 'select',
  payload: Record<string, unknown> | undefined,
  filters: readonly (readonly [string, unknown])[],
  single: boolean,
): Outcome {
  try {
    if (operation === 'insert') {
      const row = insertIssuer(payload ?? {});
      return { data: single ? row : [row], error: null };
    }
    if (operation === 'update') {
      const row = updateIssuer(payload ?? {}, filters);
      return { data: single ? row : [row], error: null };
    }
    if (operation === 'delete') {
      /* No delete grant exists on the table: the preview refuses it the way the
         database would (42501) instead of pretending the row vanished. */
      throw new DbError('42501', 'permission denied for table issuers');
    }
    const rows = issuers
      .slice()
      .sort((a, b) => a.code.localeCompare(b.code, 'en', { sensitivity: 'base' }))
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

type PreviewPayload = Record<string, unknown> | readonly Record<string, unknown>[];
type FiscalPreviewTable = 'fiscal_years' | 'fiscal_months' | 'opening_balances';

function onePayload(payload: PreviewPayload | undefined): Record<string, unknown> {
  if (Array.isArray(payload)) {
    return (payload[0] as Record<string, unknown> | undefined) ?? {};
  }
  return (payload as Record<string, unknown> | undefined) ?? {};
}

function matchesFilters(
  row: Record<string, unknown>,
  filters: readonly (readonly [string, unknown])[],
): boolean {
  return filters.every(([column, value]) => row[column] === value);
}

/**
 * Honours the one embed the fiscal screens ask for: `classifications!...(...)`
 * on `opening_balances`. Real PostgREST returns exactly the requested columns,
 * and the editor's «needs review» state is derived from this embed — a preview
 * that silently dropped it would show every saved balance as unreadable.
 */
function withBalanceEmbed(
  row: OpeningBalancePreviewRow,
  columns: string | undefined,
): Record<string, unknown> {
  if (columns === undefined || !columns.includes('classifications!')) {
    return { ...row };
  }
  const classification = classifications.find((entry) => entry.id === row.classification_id);
  return {
    ...row,
    classifications:
      classification === undefined
        ? null
        : {
            id: classification.id,
            code: classification.code,
            name: classification.name,
            is_leaf: classification.is_leaf,
            is_active: classification.is_active,
          },
  };
}

function runFiscal(
  table: FiscalPreviewTable,
  operation: 'insert' | 'upsert' | 'update' | 'delete' | 'select',
  payload: PreviewPayload | undefined,
  filters: readonly (readonly [string, unknown])[],
  single: boolean,
  columns: string | undefined,
): Outcome {
  try {
    if (table === 'fiscal_years') {
      if (operation === 'insert') {
        const input = onePayload(payload);
        if ('name' in input) {
          throw new DbError('42501', 'preview: the year name is derived by the database');
        }
        const startDate = typeof input.start_date === 'string' ? input.start_date : '';
        const endDate = typeof input.end_date === 'string' ? input.end_date : '';
        if (
          !/^\d{4}-\d{2}-\d{2}$/.test(startDate) ||
          !/^\d{4}-\d{2}-\d{2}$/.test(endDate) ||
          startDate >= endDate
        ) {
          throw new DbError('23514', 'fiscal_years_valid_date_range');
        }
        const name = `${startDate.slice(0, 4)}-${endDate.slice(0, 4)}`;
        if (fiscalYears.some((year) => year.name === name)) {
          throw new DbError('23505', 'fiscal_years_name_key');
        }
        const row: FiscalYearPreviewRow = {
          id: id('fiscal-year'),
          name,
          start_date: startDate,
          end_date: endDate,
          is_active: false,
          is_closed: false,
          supplements_open: false,
          opening_balances_locked: false,
          created_at: nowIso(),
          updated_at: nowIso(),
        };
        fiscalYears.push(row);
        fiscalMonths.push(...createFiscalMonths(row));
        return { data: single ? { ...row } : [{ ...row }], error: null };
      }

      if (operation === 'update') {
        const row = matchOne(fiscalYears, filters);
        if (row === null) {
          throw new DbError('PGRST116', 'JSON object requested, 0 rows returned');
        }
        const input = onePayload(payload);
        const editable = ['is_active', 'opening_balances_locked'];
        if (Object.keys(input).some((key) => !editable.includes(key))) {
          throw new DbError(
            '42501',
            'preview: only activation and the opening-balance freeze are exposed here',
          );
        }
        if ('is_active' in input && input.is_active !== true) {
          throw new DbError('23514', 'fiscal_years_is_active_check');
        }
        if (
          'opening_balances_locked' in input &&
          typeof input.opening_balances_locked !== 'boolean'
        ) {
          throw new DbError('23514', 'fiscal_years_opening_balances_locked_check');
        }
        if (!('is_active' in input) && !('opening_balances_locked' in input)) {
          throw new DbError('23514', 'preview: nothing to update');
        }
        if ('opening_balances_locked' in input) {
          row.opening_balances_locked = input.opening_balances_locked as boolean;
          row.updated_at = nowIso();
          return { data: single ? { ...row } : [{ ...row }], error: null };
        }
        for (const year of fiscalYears) {
          year.is_active = year.id === row.id;
          year.updated_at = nowIso();
        }
        return { data: single ? { ...row } : [{ ...row }], error: null };
      }

      if (operation === 'select') {
        const rows = fiscalYears
          .filter((row) => matchesFilters(row as unknown as Record<string, unknown>, filters))
          .slice()
          .sort((a, b) => b.start_date.localeCompare(a.start_date))
          .map((row) => ({ ...row }));
        return { data: single ? (rows[0] ?? null) : rows, error: null };
      }

      return { data: [], error: null };
    }

    if (table === 'fiscal_months') {
      if (operation === 'update') {
        const row = matchOne(fiscalMonths, filters);
        if (row === null) {
          throw new DbError('PGRST116', 'JSON object requested, 0 rows returned');
        }
        const input = onePayload(payload);
        if (Object.keys(input).some((key) => key !== 'current_period')) {
          throw new DbError('42501', 'preview: only current_period is editable');
        }
        const period = Number(input.current_period);
        if (!Number.isSafeInteger(period) || period < 1) {
          throw new DbError('23514', 'fiscal_months_current_period_positive');
        }
        row.current_period = period;
        row.updated_at = nowIso();
        return { data: single ? { ...row } : [{ ...row }], error: null };
      }

      if (operation === 'select') {
        const rows = fiscalMonths
          .filter((row) => matchesFilters(row as unknown as Record<string, unknown>, filters))
          .slice()
          .sort((a, b) => a.month_number - b.month_number)
          .map((row) => ({ ...row }));
        return { data: single ? (rows[0] ?? null) : rows, error: null };
      }

      return { data: [], error: null };
    }

    const yearById = (fiscalYearId: unknown): FiscalYearPreviewRow | undefined =>
      fiscalYears.find((year) => year.id === fiscalYearId);

    if (operation === 'upsert') {
      const incoming = Array.isArray(payload) ? payload : payload === undefined ? [] : [payload];
      const saved: OpeningBalancePreviewRow[] = [];
      for (const value of incoming) {
        const input = value as Record<string, unknown>;
        const fiscalYearId = typeof input.fiscal_year_id === 'string' ? input.fiscal_year_id : '';
        const warehouseId = typeof input.warehouse_id === 'string' ? input.warehouse_id : '';
        const classificationId =
          typeof input.classification_id === 'string' ? input.classification_id : '';
        const amountText =
          typeof input.amount === 'string' || typeof input.amount === 'number'
            ? String(input.amount)
            : '';
        const year = yearById(fiscalYearId);
        if (year !== undefined && year.opening_balances_locked) {
          // The real database answers an INSERT into a frozen year with the RLS
          // violation 42501; the preview must not pretend the save worked.
          throw new DbError('42501', 'preview: opening balances are locked for this year');
        }
        if (
          year === undefined ||
          !warehouses.some((warehouse) => warehouse.id === warehouseId) ||
          !classifications.some((classification) => classification.id === classificationId) ||
          !/^\d{1,16}(?:\.\d{1,2})?$/.test(amountText) ||
          !Number.isFinite(Number(amountText)) ||
          Number(amountText) < 0
        ) {
          throw new DbError('23514', 'opening_balances_amount_non_negative');
        }
        const existing = openingBalances.find(
          (row) =>
            row.fiscal_year_id === fiscalYearId &&
            row.warehouse_id === warehouseId &&
            row.classification_id === classificationId,
        );
        if (existing !== undefined) {
          existing.amount = Number(amountText);
          existing.updated_at = nowIso();
          saved.push({ ...existing });
        } else {
          const row: OpeningBalancePreviewRow = {
            id: id('opening-balance'),
            fiscal_year_id: fiscalYearId,
            warehouse_id: warehouseId,
            classification_id: classificationId,
            amount: Number(amountText),
            created_at: nowIso(),
            updated_at: nowIso(),
          };
          openingBalances.push(row);
          saved.push({ ...row });
        }
      }
      const projected = saved.map((row) => withBalanceEmbed(row, columns));
      return { data: single ? (projected[0] ?? null) : projected, error: null };
    }

    if (operation === 'delete') {
      const removed: OpeningBalancePreviewRow[] = [];
      for (let index = openingBalances.length - 1; index >= 0; index -= 1) {
        const row = openingBalances[index]!;
        if (!matchesFilters(row as unknown as Record<string, unknown>, filters)) {
          continue;
        }
        /* RLS filters a delete in a frozen year to zero rows instead of
           failing — the client then reports it as "already deleted". */
        if (yearById(row.fiscal_year_id)?.opening_balances_locked) {
          continue;
        }
        removed.unshift(row);
        openingBalances.splice(index, 1);
      }
      const projected = removed.map((row) => withBalanceEmbed(row, columns));
      return { data: single ? (projected[0] ?? null) : projected, error: null };
    }

    if (operation === 'select') {
      const rows = openingBalances
        .filter((row) => matchesFilters(row as unknown as Record<string, unknown>, filters))
        .slice()
        .sort(
          (a, b) =>
            a.warehouse_id.localeCompare(b.warehouse_id) ||
            a.classification_id.localeCompare(b.classification_id),
        )
        .map((row) => withBalanceEmbed(row, columns));
      return { data: single ? (rows[0] ?? null) : rows, error: null };
    }

    return { data: [], error: null };
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
  operation: 'insert' | 'upsert' | 'update' | 'delete' | 'select',
  payload?: PreviewPayload,
): Builder {
  const filters: Array<readonly [string, unknown]> = [];
  let single = false;
  let columns: string | undefined;

  const execute = (): Outcome => {
    if (table === 'fiscal_years' || table === 'fiscal_months' || table === 'opening_balances') {
      return runFiscal(table, operation, payload, filters, single, columns);
    }
    if (table === 'classifications') {
      return runClassification(
        operation as 'insert' | 'update' | 'delete' | 'select',
        onePayload(payload),
        filters,
        single,
      );
    }
    if (table === 'parties') {
      return runParty(
        operation as 'insert' | 'update' | 'delete' | 'select',
        onePayload(payload),
        filters,
        single,
      );
    }
    if (table === 'issuers') {
      return runIssuer(
        operation as 'insert' | 'update' | 'delete' | 'select',
        onePayload(payload),
        filters,
        single,
      );
    }
    if (table === 'sister_companies') {
      return runSisterCompany(
        operation as 'insert' | 'update' | 'delete' | 'select',
        onePayload(payload),
        filters,
        single,
      );
    }
    if (operation === 'select' && table === 'stations') {
      return { data: projectStations(), error: null };
    }
    return { data: [], error: null };
  };

  const chain: Builder = {
    select: (projection?: string) => {
      columns = projection;
      return chain;
    },
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
    insert: (payload: PreviewPayload) => Builder;
    upsert: (payload: PreviewPayload, options?: { onConflict?: string }) => Builder;
    update: (payload: PreviewPayload) => Builder;
    delete: () => Builder;
  };
}

const client: PreviewSupabaseClient = {
  from: (table: string) => ({
    select: (columns?: string) => builder(table, 'select', undefined).select(columns),
    insert: (payload: PreviewPayload) => builder(table, 'insert', payload),
    upsert: (payload: PreviewPayload) => builder(table, 'upsert', payload),
    update: (payload: PreviewPayload) => builder(table, 'update', payload),
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
