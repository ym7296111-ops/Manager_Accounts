import { createClient } from '@supabase/supabase-js';

/**
 * PREVIEW ONLY. A synthetic transport for the real Supabase/PostgREST client.
 * It does not contact Supabase and does not simulate authentication or RLS.
 * All names, numbers and identifiers below are fictional review data.
 */
const uid = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;

const letters = [
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

const lines = [
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

function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function previewFetch(input: RequestInfo | URL): Promise<Response> {
  await Promise.resolve();
  const url = new URL(
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
  );
  const scenario = new URLSearchParams(window.location.search).get('scenario');
  if (scenario === 'network') throw new TypeError('Failed to fetch');
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
