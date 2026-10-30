import { createClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  APS_LETTER_LINE_SELECT,
  APS_LETTER_SELECT,
  ApsLettersError,
  classifyApsLettersError,
  fetchApsLetterDetail,
  fetchApsLettersPage,
  parseApsLetter,
  parseApsLetterLine,
} from '@/hooks/useApsLetters';
import {
  EMPTY_LETTER_FILTERS,
  formatLetterAmount,
  parseLetterAmount,
  readLetterSearch,
  writeLetterFilters,
} from '@/lib/apsLetters';

const { getClient } = vi.hoisted(() => ({ getClient: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ getSupabase: getClient }));

const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const header = (number = 1) => ({
  id: id(number),
  letter_number: String(number),
  letter_number_raw: `00${number}`,
  letter_date: '2026-10-27',
  letter_type: 'inbound',
  status: 'approved',
  counterparty_code: 'IN-001',
  counterparty_name: 'شركة تجريبية',
  source_total: '0.00',
  destination_total: '9999999999999999.99',
  cancel_reason: null,
  settlement_reason: null,
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

type Captured = { readonly url: URL; readonly method: string };
let transportSequence = 0;
function setupTransport(
  handler: (url: URL, method: string) => Promise<Response> | Response,
): Captured[] {
  const requests: Captured[] = [];
  const client = createClient('https://aps-test.invalid', 'public-test-key', {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storageKey: `aps-test-${transportSequence++}`,
    },
    global: {
      fetch: (input, init) => {
        const url = new URL(
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        );
        const method = init?.method ?? 'GET';
        requests.push({ url, method });
        return Promise.resolve(handler(url, method));
      },
    },
  });
  getClient.mockReturnValue(client);
  return requests;
}

function allowRead(url: URL) {
  if (url.pathname.endsWith('/rpc/aps_can_read_letters')) return json(true);
  if (url.pathname.endsWith('/rpc/aps_can_create_letters')) return json(false);
  return null;
}

describe('APS letter reads', () => {
  beforeEach(() => getClient.mockReset());

  it('sends every filter and a validated keyset cursor to PostgREST before limiting', async () => {
    const requests = setupTransport(
      (url) => allowRead(url) ?? json(Array.from({ length: 26 }, (_, i) => header(i + 1))),
    );
    const result = await fetchApsLettersPage(
      { type: 'transfer', status: 'approved', from: '2026-10-01', to: '2026-10-31' },
      { date: '2026-10-27', id: id(100) },
    );

    expect(result.letters).toHaveLength(25);
    expect(result.nextCursor).toEqual({ date: '2026-10-27', id: id(25) });
    const query = requests.find(({ url }) => url.pathname.endsWith('/letters'))!;
    expect(query.method).toBe('GET');
    expect(query.url.searchParams.get('select')).toContain('source_total::text');
    expect(query.url.searchParams.get('select')).toContain('destination_total::text');
    expect(query.url.searchParams.get('letter_type')).toBe(
      'in.(internal_transfer,external_transfer)',
    );
    expect(query.url.searchParams.get('status')).toBe('eq.approved');
    expect(query.url.searchParams.getAll('letter_date')).toEqual([
      'gte.2026-10-01',
      'lte.2026-10-31',
    ]);
    expect(query.url.searchParams.get('or')).toBe(
      `(letter_date.lt.2026-10-27,and(letter_date.eq.2026-10-27,id.lt.${id(100)}))`,
    );
    expect(query.url.searchParams.get('order')).toBe('letter_date.desc,id.desc');
    expect(query.url.searchParams.get('limit')).toBe('26');
    expect(
      requests
        .filter(({ method }) => method !== 'GET')
        .map(({ url }) => url.pathname)
        .sort(),
    ).toEqual(['/rest/v1/rpc/aps_can_create_letters', '/rest/v1/rpc/aps_can_read_letters']);
  });

  it('permits creators to see their RLS-filtered own drafts even without the read capability', async () => {
    const requests = setupTransport((url) => {
      if (url.pathname.endsWith('/rpc/aps_can_read_letters')) return json(false);
      if (url.pathname.endsWith('/rpc/aps_can_create_letters')) return json(true);
      return json([{ ...header(), status: 'draft' }]);
    });
    const result = await fetchApsLettersPage({ ...EMPTY_LETTER_FILTERS, status: 'draft' }, null);
    expect(result.letters[0]?.status).toBe('draft');
    expect(
      requests.find(({ url }) => url.pathname.endsWith('/letters'))?.url.searchParams.get('status'),
    ).toBe('eq.draft');
  });

  it('keeps a visible settlement draft returned by RLS without applying a client-side draft exclusion', async () => {
    const requests = setupTransport(
      (url) =>
        allowRead(url) ?? json([{ ...header(), letter_type: 'settlement', status: 'draft' }]),
    );
    const result = await fetchApsLettersPage(EMPTY_LETTER_FILTERS, null);
    expect(result.letters).toHaveLength(1);
    expect(result.letters[0]).toMatchObject({ type: 'settlement', status: 'draft' });
    expect(
      requests.find(({ url }) => url.pathname.endsWith('/letters'))?.url.searchParams.has('status'),
    ).toBe(false);
  });

  it('shows forbidden instead of an empty list when both server access predicates are false', async () => {
    const requests = setupTransport((url) =>
      url.pathname.includes('/rpc/') ? json(false) : json([]),
    );
    await expect(fetchApsLettersPage(EMPTY_LETTER_FILTERS, null)).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect(requests.some(({ url }) => url.pathname.endsWith('/letters'))).toBe(false);
  });

  it('classifies an actual 403 and a failed network request separately', async () => {
    setupTransport(
      (url) => allowRead(url) ?? json({ code: '42501', message: 'permission denied' }, 403),
    );
    await expect(fetchApsLettersPage(EMPTY_LETTER_FILTERS, null)).rejects.toMatchObject({
      code: 'forbidden',
    });
    setupTransport(() => Promise.reject(new TypeError('Failed to fetch')));
    await expect(fetchApsLettersPage(EMPTY_LETTER_FILTERS, null)).rejects.toMatchObject({
      code: 'network',
    });
    expect(classifyApsLettersError(new TypeError('offline'))).toBe('network');
  });

  it('reads snapshotted names with the line, without embedding or querying directories', async () => {
    const requests = setupTransport((url) => {
      const allowed = allowRead(url);
      if (allowed) return allowed;
      if (url.pathname.endsWith('/letters')) return json([header()]);
      if (url.pathname.endsWith('/letter_lines'))
        return json([
          {
            id: id(10),
            line_number: 1,
            direction: 'in',
            warehouse_id: id(20),
            classification_id: id(30),
            amount: '123.45',
            warehouse_name: 'المخزن عند حفظ السطر',
            classification_name: 'التصنيف عند حفظ السطر',
          },
        ]);
      return json({ message: 'unexpected request' }, 404);
    });
    const detail = await fetchApsLetterDetail(id(1));
    expect(detail?.letter.number).toBe('001');
    expect(detail?.lines).toEqual([
      {
        id: id(10),
        lineNumber: 1,
        direction: 'in',
        warehouseId: id(20),
        classificationId: id(30),
        amount: '123.45',
        warehouseName: 'المخزن عند حفظ السطر',
        classificationName: 'التصنيف عند حفظ السطر',
      },
    ]);
    const query = requests.find(({ url }) => url.pathname.endsWith('/letter_lines'))!;
    expect(query.url.searchParams.get('select')).toContain('warehouse_name');
    expect(query.url.searchParams.get('select')).toContain('classification_name');
    expect(query.url.searchParams.get('select')).not.toMatch(
      /\b(?:warehouses|classifications)\s*(?:!|\()/,
    );
    expect(requests.some(({ url }) => /\/(warehouses|classifications)$/.test(url.pathname))).toBe(
      false,
    );
    expect(query.url.searchParams.get('letter_id')).toBe(`eq.${id(1)}`);
    expect(query.url.searchParams.get('limit')).toBe('500');
    expect(APS_LETTER_SELECT).toContain('::text');
    expect(APS_LETTER_LINE_SELECT).toContain('amount::text');
  });

  it('fails visibly if a line has missing or blank snapshot names', () => {
    const row = {
      id: id(10),
      line_number: 1,
      direction: 'in',
      warehouse_id: id(20),
      classification_id: id(30),
      warehouse_name: 'مخزن',
      classification_name: 'تصنيف',
      amount: '1.00',
    };
    expect(() => parseApsLetterLine({ ...row, warehouse_name: null })).toThrow(ApsLettersError);
    expect(() => parseApsLetterLine({ ...row, classification_name: '  ' })).toThrow(
      ApsLettersError,
    );
  });

  it('does not reveal whether an inaccessible letter exists or query its lines', async () => {
    const requests = setupTransport((url) => allowRead(url) ?? json([]));
    await expect(fetchApsLetterDetail(id(77))).resolves.toBeNull();
    expect(requests.some(({ url }) => url.pathname.endsWith('/letter_lines'))).toBe(false);
  });

  it('keeps numeric(18,2) amounts exact even beyond the JavaScript safe integer limit', () => {
    expect(parseLetterAmount('9999999999999999.99')).toBe('9999999999999999.99');
    expect(formatLetterAmount('9999999999999999.99', 'en')).toBe('9,999,999,999,999,999.99');
    expect(formatLetterAmount('9999999999999999.99', 'ar')).toBe('٩٬٩٩٩٬٩٩٩٬٩٩٩٬٩٩٩٬٩٩٩٫٩٩');
    expect(parseLetterAmount(123.45)).toBeNull();
    expect(() => parseApsLetter({ ...header(), source_total: 123.45 })).toThrow(ApsLettersError);
  });

  it('rejects malformed dates, ranges and injected cursors rather than fetching an unfiltered page', async () => {
    const requests = setupTransport(() => json(true));
    expect(readLetterSearch(new URLSearchParams('from=2026-02-30')).valid).toBe(false);
    expect(readLetterSearch(new URLSearchParams('from=2026-10-20&to=2026-10-01')).valid).toBe(
      false,
    );
    expect(readLetterSearch(new URLSearchParams('type=unexpected')).valid).toBe(false);
    expect(readLetterSearch(new URLSearchParams('cursor=2026-10-01_abc,or(id.eq.x)')).valid).toBe(
      false,
    );
    await expect(
      fetchApsLettersPage({ ...EMPTY_LETTER_FILTERS, from: '2026-02-30' }, null),
    ).rejects.toMatchObject({ code: 'invalid' });
    expect(requests).toHaveLength(0);
  });

  it('preserves unrelated URL parameters and resets the cursor when a filter changes', () => {
    const initial = new URLSearchParams(`type=inbound&cursor=2026-10-27_${id(1)}&other=kept`);
    const next = writeLetterFilters(initial, { ...EMPTY_LETTER_FILTERS, status: 'draft' });
    expect(next.toString()).toBe('other=kept&status=draft');
  });
});
