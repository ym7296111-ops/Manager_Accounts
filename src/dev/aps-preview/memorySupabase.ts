import { createClient } from '@supabase/supabase-js';

/**
 * PREVIEW ONLY. A synthetic transport for the real Supabase/PostgREST client.
 * It does not contact Supabase and does not simulate authentication or RLS.
 * All names, numbers and identifiers below are fictional review data.
 */
const uid = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;

const sampleLetters = [
  {
    id: uid(1),
    letter_type: 'inbound',
    letter_number: '2458',
    letter_number_raw: '2458',
    letter_date: '2026-10-29',
    status: 'approved',
    counterparty_code: 'IN-014',
    counterparty_name: 'شركة النيل للمستلزمات',
    source_total: '0.00',
    destination_total: '183450.00',
    cancel_reason: null,
    settlement_reason: null,
  },
  {
    id: uid(2),
    letter_type: 'outbound',
    letter_number: '2457',
    letter_number_raw: '2457',
    letter_date: '2026-10-28',
    status: 'approved',
    counterparty_code: 'OUT-006',
    counterparty_name: 'إدارة التشغيل والصيانة',
    source_total: '42900.50',
    destination_total: '0.00',
    cancel_reason: null,
    settlement_reason: null,
  },
  {
    id: uid(3),
    letter_type: 'internal_transfer',
    letter_number: '2456',
    letter_number_raw: '2456',
    letter_date: '2026-10-27',
    status: 'approved',
    counterparty_code: null,
    counterparty_name: null,
    source_total: '32000.00',
    destination_total: '32000.00',
    cancel_reason: null,
    settlement_reason: null,
  },
  {
    id: uid(4),
    letter_type: 'external_transfer',
    letter_number: '2455',
    letter_number_raw: '2455',
    letter_date: '2026-10-26',
    status: 'approved',
    counterparty_code: 'SIS-002',
    counterparty_name: 'الشركة الشقيقة — فرع القاهرة',
    source_total: '0.00',
    destination_total: '15750.00',
    cancel_reason: null,
    settlement_reason: null,
  },
  {
    id: uid(5),
    letter_type: 'outbound',
    letter_number: '2454',
    letter_number_raw: '2454',
    letter_date: '2026-10-25',
    status: 'draft',
    counterparty_code: 'OUT-003',
    counterparty_name: 'قسم المشروعات',
    source_total: '9200.00',
    destination_total: '0.00',
    cancel_reason: null,
    settlement_reason: null,
  },
  {
    id: uid(6),
    letter_type: 'settlement',
    letter_number: '2453',
    letter_number_raw: '2453',
    letter_date: '2026-10-24',
    status: 'approved',
    counterparty_code: null,
    counterparty_name: null,
    source_total: '0.00',
    destination_total: '350.00',
    cancel_reason: null,
    settlement_reason: 'تصحيح فرق الجرد بعد المراجعة.',
  },
  {
    id: uid(7),
    letter_type: 'inbound',
    letter_number: '2452',
    letter_number_raw: '2452',
    letter_date: '2026-10-22',
    status: 'cancelled',
    counterparty_code: 'IN-008',
    counterparty_name: 'شركة الأفق للتوريدات',
    source_total: '0.00',
    destination_total: '12680.00',
    cancel_reason: 'تم إلغاء الخطاب لوجود خطأ في المستند الورقي.',
    settlement_reason: null,
  },
];

// The mock is intentionally small and ephemeral; it is not an RLS or database simulator.
const entryOptions = {
  fiscal_years: [
    {
      id: uid(401),
      name: 'السنة المالية 2026',
      start_date: '2026-01-01',
      end_date: '2026-12-31',
      is_active: true,
      is_closed: false,
      supplements_open: false,
    },
  ],
  warehouses: [
    { id: uid(101), name: 'مخزن المواد الخام', code: 'WH-001' },
    { id: uid(102), name: 'مخزن التشغيل الرئيسي', code: 'WH-002' },
    { id: uid(103), name: 'مخزن قطع الغيار', code: 'WH-003' },
  ],
  classifications: [
    { id: uid(201), name: 'حديد وصلب', code: 'CL-001' },
    { id: uid(202), name: 'مستلزمات التشغيل', code: 'CL-002' },
    { id: uid(203), name: 'قطع غيار', code: 'CL-003' },
  ],
  parties: [
    { id: uid(501), name: 'شركة النيل للمستلزمات', code: 'IN-014', branch: 'inbound' },
    { id: uid(502), name: 'إدارة التشغيل والصيانة', code: 'OUT-006', branch: 'outbound' },
    { id: uid(503), name: 'قسم المشروعات', code: 'OUT-003', branch: 'outbound' },
  ],
  sister_companies: [{ id: uid(601), name: 'الشركة الشقيقة — فرع القاهرة', code: 'SIS-002' }],
};

interface PreviewLetter {
  id: string;
  letter_type: string;
  letter_number: string;
  letter_number_raw: string;
  letter_date: string;
  status: string;
  counterparty_code: string | null;
  counterparty_name: string | null;
  source_total: string;
  destination_total: string;
  cancel_reason: string | null;
  settlement_reason: string | null;
  fiscal_year_id: string;
  party_id: string | null;
  sister_company_id: string | null;
  reclassification_reason: string | null;
  created_by: string;
  updated_at: string;
}
const letters: PreviewLetter[] = sampleLetters.map((item) => ({
  ...item,
  fiscal_year_id: uid(401),
  party_id:
    item.letter_type === 'inbound'
      ? uid(501)
      : item.letter_type === 'outbound'
        ? uid(item.id === uid(5) ? 503 : 502)
        : null,
  sister_company_id: item.letter_type === 'external_transfer' ? uid(601) : null,
  reclassification_reason: null,
  created_by: uid(1),
  updated_at: '2026-10-30T12:00:00.000Z',
}));

type Direction = 'in' | 'out';
function line(
  id: number,
  letter: number,
  number: number,
  direction: Direction,
  amount: string,
  warehouse: number,
  classification: number,
) {
  const warehouses = [
    { id: uid(101), name: 'مخزن المواد الخام' },
    { id: uid(102), name: 'مخزن التشغيل الرئيسي' },
    { id: uid(103), name: 'مخزن قطع الغيار' },
  ];
  const classifications = [
    { id: uid(201), name: 'حديد وصلب' },
    { id: uid(202), name: 'مستلزمات التشغيل' },
    { id: uid(203), name: 'قطع غيار' },
  ];
  const store = warehouses[warehouse]!;
  const classificationRow = classifications[classification]!;
  return {
    id: uid(id),
    letter_id: uid(letter),
    line_number: number,
    direction,
    warehouse_id: store.id,
    classification_id: classificationRow.id,
    warehouse_name: store.name,
    classification_name: classificationRow.name,
    amount,
  };
}

const sampleLines = [
  line(301, 1, 1, 'in', '120000.00', 0, 0),
  line(302, 1, 2, 'in', '63450.00', 0, 1),
  line(303, 2, 1, 'out', '42900.50', 2, 2),
  line(304, 3, 1, 'out', '32000.00', 0, 0),
  line(305, 3, 2, 'in', '32000.00', 1, 0),
  line(306, 4, 1, 'in', '15750.00', 2, 2),
  line(307, 5, 1, 'out', '9200.00', 1, 1),
  line(308, 6, 1, 'in', '350.00', 0, 0),
  line(309, 7, 1, 'in', '12680.00', 0, 0),
];
interface PreviewLine {
  id: string;
  letter_id: string;
  line_number: number;
  direction: Direction;
  warehouse_id: string;
  classification_id: string;
  warehouse_name: string;
  classification_name: string;
  amount: string;
  paired_line_id: string | null;
}
const lines: PreviewLine[] = sampleLines.map((item) => ({
  ...item,
  paired_line_id: item.id === uid(305) ? uid(304) : null,
}));

interface MockEntryLine {
  amount: string;
  warehouse_id?: string;
  classification_id?: string;
  source_warehouse_id?: string;
  source_classification_id?: string;
  destination_warehouse_id?: string;
  destination_classification_id?: string;
}
interface MockEntrySave {
  p_letter_id: string;
  p_expected_updated_at: string | null;
  p_fiscal_year_id: string;
  p_letter_type: string;
  p_letter_number: string;
  p_letter_date: string;
  p_party_id: string | null;
  p_sister_company_id: string | null;
  p_direction: Direction | null;
  p_reclassification_reason: string | null;
  p_lines: MockEntryLine[];
}
let versionNumber = 0;
function nextVersion() {
  versionNumber += 1;
  return new Date(Date.now() + versionNumber).toISOString();
}
function cents(amount: string) {
  const [whole = '0', decimals = ''] = amount.split('.');
  return BigInt(whole) * 100n + BigInt(decimals.padEnd(2, '0'));
}
function monetary(value: bigint) {
  return `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
}
function saveMockDraft(input: MockEntrySave): Response {
  const current = letters.find((item) => item.id === input.p_letter_id);
  if (current && input.p_expected_updated_at === null)
    return response({ code: 'P0001', message: 'aps_entry_id_exists' }, 400);
  if (
    input.p_expected_updated_at !== null &&
    (!current || current.updated_at !== input.p_expected_updated_at)
  )
    return response({ code: 'P0001', message: 'aps_entry_stale_draft' }, 400);
  if (
    letters.some(
      (item) =>
        item.id !== input.p_letter_id &&
        item.fiscal_year_id === input.p_fiscal_year_id &&
        item.letter_number.toUpperCase().trim() === input.p_letter_number.toUpperCase().trim(),
    )
  )
    return response({ code: '23505', message: 'Preview duplicate number' }, 409);

  const created: PreviewLine[] = [];
  function add(
    direction: Direction,
    warehouseId: string | undefined,
    classificationId: string | undefined,
    amount: string,
    pair: string | null = null,
  ) {
    const store = entryOptions.warehouses.find((item) => item.id === warehouseId);
    const classification = entryOptions.classifications.find(
      (item) => item.id === classificationId,
    );
    if (!store || !classification) throw new Error('Invalid preview option');
    const id = crypto.randomUUID();
    created.push({
      id,
      letter_id: input.p_letter_id,
      line_number: created.length + 1,
      direction,
      warehouse_id: store.id,
      classification_id: classification.id,
      warehouse_name: store.name,
      classification_name: classification.name,
      amount,
      paired_line_id: pair,
    });
    return id;
  }
  for (const item of input.p_lines) {
    if (input.p_letter_type === 'internal_transfer') {
      const out = add('out', item.source_warehouse_id, item.source_classification_id, item.amount);
      add(
        'in',
        item.destination_warehouse_id,
        item.destination_classification_id,
        item.amount,
        out,
      );
    } else {
      const direction =
        input.p_letter_type === 'inbound'
          ? 'in'
          : input.p_letter_type === 'outbound'
            ? 'out'
            : input.p_direction;
      if (direction === null) throw new Error('Invalid preview direction');
      add(direction, item.warehouse_id, item.classification_id, item.amount);
    }
  }
  const totalOut = monetary(
    created
      .filter((line) => line.direction === 'out')
      .reduce((sum, line) => sum + cents(line.amount), 0n),
  );
  const totalIn = monetary(
    created
      .filter((line) => line.direction === 'in')
      .reduce((sum, line) => sum + cents(line.amount), 0n),
  );
  const party = entryOptions.parties.find((item) => item.id === input.p_party_id);
  const sister = entryOptions.sister_companies.find(
    (item) => item.id === input.p_sister_company_id,
  );
  const updatedAt = nextVersion();
  const next: PreviewLetter = {
    id: input.p_letter_id,
    letter_type: input.p_letter_type,
    letter_number: input.p_letter_number,
    letter_number_raw: input.p_letter_number,
    letter_date: input.p_letter_date,
    status: 'draft',
    counterparty_code: party?.code ?? sister?.code ?? null,
    counterparty_name: party?.name ?? sister?.name ?? null,
    source_total: totalOut,
    destination_total: totalIn,
    cancel_reason: null,
    settlement_reason: null,
    fiscal_year_id: input.p_fiscal_year_id,
    party_id: input.p_party_id,
    sister_company_id: input.p_sister_company_id,
    reclassification_reason: input.p_reclassification_reason,
    created_by: uid(1),
    updated_at: updatedAt,
  };
  if (current) letters.splice(letters.indexOf(current), 1, next);
  else letters.push(next);
  for (let index = lines.length - 1; index >= 0; index--) {
    if (lines[index]?.letter_id === input.p_letter_id) lines.splice(index, 1);
  }
  lines.push(...created);
  return response({ id: input.p_letter_id, updated_at: updatedAt });
}

function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function previewFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  await Promise.resolve();
  const url = new URL(
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
  );
  const scenario = new URLSearchParams(window.location.search).get('scenario');
  if (scenario === 'network') throw new TypeError('Failed to fetch');
  if (url.pathname.endsWith('/rpc/aps_letter_entry_options')) {
    return scenario === 'forbidden'
      ? response({ code: '42501', message: 'Preview denied' }, 403)
      : response(entryOptions);
  }
  if (url.pathname.endsWith('/rpc/aps_save_letter_draft')) {
    const payload = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as MockEntrySave;
    const saved = saveMockDraft(payload);
    if (saved.ok && scenario === 'save-unknown')
      throw new TypeError('Preview response lost after save');
    return saved;
  }
  if (url.pathname.endsWith('/rpc/aps_approve_letter')) {
    if (scenario === 'approval-fails')
      return response({ code: '22023', message: 'Preview approval refused' }, 400);
    const payload = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
      p_letter_id: string;
    };
    const letter = letters.find((item) => item.id === payload.p_letter_id);
    if (!letter || letter.status !== 'draft')
      return response({ code: '22023', message: 'Preview draft unavailable' }, 400);
    letter.status = 'approved';
    letter.updated_at = nextVersion();
    if (scenario === 'approval-unknown')
      throw new TypeError('Preview response lost after approval');
    return response(null);
  }
  if (
    url.pathname.endsWith('/rpc/aps_can_read_letters') ||
    url.pathname.endsWith('/rpc/aps_can_create_letters')
  ) {
    return response(scenario !== 'forbidden');
  }
  if (url.pathname.endsWith('/letters')) {
    if (scenario === 'empty') return response([]);
    let result = [...letters];
    const idFilter = url.searchParams.get('id');
    const type = url.searchParams.get('letter_type');
    const status = url.searchParams.get('status');
    if (idFilter?.startsWith('eq.'))
      result = result.filter((item) => item.id === idFilter.slice(3));
    if (type?.startsWith('eq.'))
      result = result.filter((item) => item.letter_type === type.slice(3));
    if (type?.startsWith('in.'))
      result = result.filter((item) =>
        ['internal_transfer', 'external_transfer'].includes(item.letter_type),
      );
    if (status?.startsWith('eq.'))
      result = result.filter((item) => item.status === status.slice(3));
    for (const filter of url.searchParams.getAll('letter_date')) {
      if (filter.startsWith('gte.'))
        result = result.filter((item) => item.letter_date >= filter.slice(4));
      if (filter.startsWith('lte.'))
        result = result.filter((item) => item.letter_date <= filter.slice(4));
    }
    const cursor = url.searchParams
      .get('or')
      ?.match(
        /letter_date\.lt\.(\d{4}-\d{2}-\d{2}),and\(letter_date\.eq\.\d{4}-\d{2}-\d{2},id\.lt\.([0-9a-f-]+)\)/i,
      );
    if (cursor?.[1] && cursor[2]) {
      const [date, id] = [cursor[1], cursor[2]];
      result = result.filter(
        (item) => item.letter_date < date || (item.letter_date === date && item.id < id),
      );
    }
    result.sort((a, b) => b.letter_date.localeCompare(a.letter_date) || b.id.localeCompare(a.id));
    return response(result.slice(0, Number(url.searchParams.get('limit') ?? 26)));
  }
  if (url.pathname.endsWith('/letter_lines')) {
    const letterId = url.searchParams.get('letter_id')?.replace(/^eq\./, '');
    return response(lines.filter((item) => item.letter_id === letterId));
  }
  // This simulated denial demonstrates that the snapshots need no directory
  // request. It is only a review scenario and is not a test of real RLS.
  if (
    scenario === 'restricted' &&
    (url.pathname.endsWith('/warehouses') || url.pathname.endsWith('/classifications'))
  ) {
    return response({ code: '42501', message: 'Preview directory access denied' }, 403);
  }
  return response({ code: 'PGRST404', message: 'Preview endpoint not found' }, 404);
}

const client = createClient('https://aps-review.invalid', 'fictional-review-key', {
  global: { fetch: previewFetch },
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

export function getSupabase() {
  return client;
}
