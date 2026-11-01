import { createClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApsEntryError,
  approveEntryLetter,
  classifyEntryError,
  fetchEntryDraft,
  fetchEntryOptions,
  parseEntryDraft,
  parseEntryOptions,
  saveEntryDraft,
} from '@/hooks/useApsLetterEntry';
import { newEntryForm, type EntryForm } from '@/lib/apsLetterEntry';

const { getClient } = vi.hoisted(() => ({ getClient: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ getSupabase: getClient }));

const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const actor = id(1);

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
type Captured = { readonly url: URL; readonly body: string };
let sequence = 0;
function setupTransport(handler: (url: URL, body: string) => Response) {
  const requests: Captured[] = [];
  const client = createClient('https://entry-test.invalid', 'public-test-key', {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storageKey: `entry-test-${sequence++}`,
    },
    global: {
      fetch: (input, init) => {
        const url = new URL(
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        );
        const body = typeof init?.body === 'string' ? init.body : '';
        requests.push({ url, body });
        return Promise.resolve(handler(url, body));
      },
    },
  });
  getClient.mockReturnValue(client);
  return requests;
}

const optionsPayload = {
  fiscal_years: [
    {
      id: id(400),
      name: '2026',
      start_date: '2026-01-01',
      end_date: '2026-12-31',
      is_active: true,
      is_closed: false,
      supplements_open: false,
    },
  ],
  fiscal_months: [
    {
      id: id(300),
      fiscal_year_id: id(400),
      month_number: 3,
      name: 'مارس',
      start_date: '2026-03-01',
      end_date: '2026-03-31',
      current_period: 2,
      is_closed: false,
    },
  ],
  warehouses: [
    {
      id: id(100),
      name: 'احتياطي',
      code: 'WH-001',
      station_name: 'غرب القاهرة',
      station_code: 'ST-01',
    },
  ],
  classifications: [{ id: id(201), name: 'حديد', code: 'CL-001' }],
  parties: [{ id: id(501), name: 'جهة', code: 'IN-001', branch: 'inbound' }],
  sister_companies: [{ id: id(601), name: 'شقيقة', code: 'SIS-001' }],
  issuers: [{ id: id(701), code: 'YM', name: 'ياسر' }],
};

function draftHeader(overrides: Record<string, unknown> = {}) {
  return {
    id: id(900),
    fiscal_year_id: id(400),
    letter_type: 'inbound',
    letter_number: '7',
    letter_number_raw: '007',
    letter_date: '2026-03-02',
    issuer_reference: 'YM:42',
    party_id: id(501),
    sister_company_id: null,
    reclassification_note: null,
    status: 'draft',
    created_by: actor,
    updated_at: '2026-03-04T10:00:00+00:00',
    ...overrides,
  };
}
function draftLine(overrides: Record<string, unknown> = {}) {
  return {
    id: id(950),
    direction: 'in',
    warehouse_id: id(100),
    classification_id: id(201),
    amount: '10.00',
    // The new schema has no pairing column; legacy fixtures add it explicitly.
    ...overrides,
  };
}

describe('APS letter entry transport', () => {
  beforeEach(() => getClient.mockReset());

  it('parses only complete, active entry choices', () => {
    const options = parseEntryOptions(optionsPayload);
    expect(options.years[0]).toMatchObject({ id: id(400), active: true, closed: false });
    expect(options.parties[0]).toMatchObject({ branch: 'inbound' });
    expect(() => parseEntryOptions({ ...optionsPayload, parties: [{ id: id(501) }] })).toThrow(
      ApsEntryError,
    );
    expect(() => parseEntryOptions({ ...optionsPayload, warehouses: null })).toThrow(ApsEntryError);
    expect(() =>
      parseEntryOptions({
        ...optionsPayload,
        fiscal_years: [{ ...optionsPayload.fiscal_years[0], is_active: 'true' }],
      }),
    ).toThrow(ApsEntryError);
  });

  // A.3 stopped sending `is_active` on the year rows and added the active period
  // plus a per-month `contains_today`. The screen must keep loading: the year
  // flag is inferred from the period, and the period itself is presentation
  // state that a broken payload may not turn into a blank screen.
  const activePeriodPayload = {
    fiscal_month_id: id(300),
    fiscal_year_id: id(400),
    month_number: 3,
    name: 'مارس 2026',
    period_number: 2,
    start_date: '2026-03-01',
    end_date: '2026-03-31',
    is_closed: false,
    fiscal_year_name: '2026',
    fiscal_year_is_active: true,
    fiscal_year_is_closed: false,
    supplements_open: false,
    project_today: '2026-03-15',
    contains_today: true,
  };
  const a3Payload = {
    ...optionsPayload,
    active_period: activePeriodPayload,
    fiscal_years: [
      {
        id: id(400),
        name: '2026',
        start_date: '2026-01-01',
        end_date: '2026-12-31',
        is_closed: false,
        supplements_open: false,
      },
    ],
    fiscal_months: [{ ...optionsPayload.fiscal_months[0], contains_today: true }],
  };

  it('parses the A.3 payload: no year flag, an active period, a today suggestion', () => {
    const options = parseEntryOptions(a3Payload);
    expect(options.years[0]).toMatchObject({ id: id(400), active: true });
    expect(options.months[0].containsToday).toBe(true);
    expect(options.activePeriod).toMatchObject({
      monthId: id(300),
      yearId: id(400),
      monthNumber: 3,
      period: 2,
      closed: false,
      projectToday: '2026-03-15',
      containsToday: true,
    });
  });

  it('keeps the screen usable when the period fields are missing or malformed', () => {
    // A pre-A.3 database: no period and no suggestion, the year flag still there.
    const legacy = parseEntryOptions(optionsPayload);
    expect(legacy.activePeriod ?? null).toBeNull();
    expect(legacy.years[0].active).toBe(true);
    expect(legacy.months[0].containsToday ?? null).toBeNull();
    // No period at all: nothing is invented, and the list still parses.
    expect(
      parseEntryOptions({ ...a3Payload, active_period: null }).activePeriod ?? null,
    ).toBeNull();
    expect(parseEntryOptions({ ...a3Payload, active_period: null }).years[0].active).toBe(false);
    // An unreadable period is ignored, not fatal.
    const broken = parseEntryOptions({ ...a3Payload, active_period: { fiscal_month_id: 'x' } });
    expect(broken.activePeriod ?? null).toBeNull();
    expect(broken.years).toHaveLength(1);
    // A year flag that is present but wrong is still a corruption, not a variant.
    expect(() =>
      parseEntryOptions({
        ...a3Payload,
        fiscal_years: [{ ...a3Payload.fiscal_years[0], is_active: 'true' }],
      }),
    ).toThrow(ApsEntryError);
  });

  it('reads the creator-only choices through the RPC and never a directory table', async () => {
    const requests = setupTransport(() => json(optionsPayload));
    await expect(fetchEntryOptions()).resolves.toMatchObject({
      warehouses: [
        {
          id: id(100),
          name: 'احتياطي',
          code: 'WH-001',
          stationName: 'غرب القاهرة',
          stationCode: 'ST-01',
        },
      ],
      issuers: [{ code: 'YM', name: 'ياسر' }],
      months: [{ monthNumber: 3, name: 'مارس', period: 2 }],
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url.pathname).toBe('/rest/v1/rpc/aps_letter_entry_options');
  });

  it('loads only the caller own draft header and lines without a directory embed', async () => {
    const requests = setupTransport((url) =>
      url.pathname.endsWith('/letters')
        ? json(draftHeader())
        : json([
            draftLine({ party_id: id(502) }),
            draftLine({ id: id(951), amount: '2.50', party_id: null }),
          ]),
    );
    const draft = await fetchEntryDraft(id(900), actor);
    expect(draft).toMatchObject({ id: id(900), updatedAt: '2026-03-04T10:00:00+00:00' });
    // The date is read (never written) so the balance badges can be read as
    // of the day the draft carries.
    expect(draft.letterDate).toBe('2026-03-02');
    expect(draft.form).toMatchObject({
      type: 'inbound',
      number: '007',
      letterCode: 'YM:42',
      partyId: id(501),
      // The party now travels on each line; a null one keeps the header party.
      lines: [
        { amount: '10.00', partyId: id(502) },
        { amount: '2.50', partyId: id(501) },
      ],
    });
    const header = requests.find(({ url }) => url.pathname.endsWith('/letters'))!;
    expect(header.url.searchParams.get('select')).not.toContain('warehouses(');
    expect(header.url.searchParams.get('select')).not.toContain('classifications(');
    const lines = requests.find(({ url }) => url.pathname.endsWith('/letter_lines'))!;
    expect(lines.url.searchParams.get('select')).toContain('amount::text');
    expect(lines.url.searchParams.get('select')).toContain('party_id');
    expect(header.url.searchParams.get('select')).toContain('issuer_reference');
    expect(header.url.searchParams.get('select')).toContain('letter_date');
    expect(header.url.searchParams.get('select')).toContain('reclassification_note');
    expect(lines.url.searchParams.get('select')).not.toContain('paired_line_id');
    expect(lines.url.searchParams.get('letter_id')).toBe(`eq.${id(900)}`);
  });

  it('falls back to the legacy statement column while the database migration is pending', async () => {
    const requests = setupTransport((url) => {
      if (!url.pathname.endsWith('/letters')) return json([draftLine()]);
      return url.searchParams.get('select')?.includes('reclassification_note')
        ? json(
            {
              code: '42703',
              message: 'column letters.reclassification_note does not exist',
              details: null,
              hint: null,
            },
            400,
          )
        : json(
            draftHeader({
              reclassification_note: undefined,
              reclassification_reason: 'بيان من المخطط القديم',
            }),
          );
    });

    const draft = await fetchEntryDraft(id(900), actor);
    expect(draft.form.reason).toBe('بيان من المخطط القديم');
    const headerRequests = requests.filter(({ url }) => url.pathname.endsWith('/letters'));
    expect(headerRequests).toHaveLength(2);
    expect(headerRequests[0]?.url.searchParams.get('select')).toContain('reclassification_note');
    expect(headerRequests[1]?.url.searchParams.get('select')).toContain('reclassification_reason');
  });

  it('refuses to edit a draft owned by someone else or one already approved', async () => {
    const transport = () => json(draftHeader({ created_by: id(2) }));
    setupTransport((url) =>
      url.pathname.endsWith('/letters') ? transport() : json([draftLine()]),
    );
    await expect(fetchEntryDraft(id(900), actor)).rejects.toMatchObject({ code: 'notFound' });
    setupTransport((url) =>
      url.pathname.endsWith('/letters')
        ? json(draftHeader({ status: 'approved' }))
        : json([draftLine()]),
    );
    await expect(fetchEntryDraft(id(900), actor)).rejects.toMatchObject({ code: 'notFound' });
  });

  it('reconstructs legacy pairs and free-line pairs for the current transfer screen', () => {
    const source = draftLine({ id: id(960), direction: 'out', amount: '12.00' });
    const destination = draftLine({ id: id(961), paired_line_id: id(960), amount: '12.00' });
    const draft = parseEntryDraft(
      draftHeader({
        letter_type: 'internal_transfer',
        party_id: null,
        reclassification_reason: 'نقل داخلي',
      }),
      [source, destination],
      actor,
    );
    expect(draft.form).toMatchObject({
      type: 'internal_transfer',
      partyId: '',
      reason: 'نقل داخلي',
      direction: 'in',
      lines: [
        {
          warehouseId: id(100),
          destinationWarehouseId: id(100),
          amount: '12.00',
        },
      ],
    });
    const freeDraft = parseEntryDraft(
      draftHeader({
        letter_type: 'internal_transfer',
        party_id: null,
        reclassification_note: 'بيان التحويل',
      }),
      [
        draftLine({ id: id(963), direction: 'out', amount: '8.00' }),
        draftLine({ id: id(964), amount: '8.00' }),
      ],
      actor,
    );
    expect(freeDraft.form).toMatchObject({
      reason: 'بيان التحويل',
      lines: [{ warehouseId: id(100), destinationWarehouseId: id(100), amount: '8.00' }],
    });
    // One source split across two free destinations cannot be represented by
    // the temporary pair-shaped screen; refuse it rather than reshaping it.
    expect(() =>
      parseEntryDraft(
        draftHeader({ letter_type: 'internal_transfer', party_id: null }),
        [
          draftLine({ id: id(965), direction: 'out', amount: '12.00' }),
          draftLine({ id: id(966), amount: '6.00' }),
          draftLine({ id: id(967), amount: '6.00' }),
        ],
        actor,
      ),
    ).toThrow(ApsEntryError);
    const broken = [source, draftLine({ id: id(962), paired_line_id: id(960), amount: '11.00' })];
    expect(() =>
      parseEntryDraft(
        draftHeader({ letter_type: 'internal_transfer', party_id: null }),
        broken,
        actor,
      ),
    ).toThrow(ApsEntryError);
    expect(() =>
      parseEntryDraft(
        draftHeader({ letter_type: 'internal_transfer', party_id: null }),
        [source],
        actor,
      ),
    ).toThrow(ApsEntryError);
    expect(() => parseEntryDraft(draftHeader(), [source], actor)).toThrow(ApsEntryError);
  });

  it('classifies conflicts, refusals and uncertain outcomes into stable codes', async () => {
    expect(classifyEntryError({ code: '23505', message: 'duplicate key' })).toBe('duplicate');
    expect(classifyEntryError({ code: 'P0001', message: 'aps_entry_stale_draft' })).toBe('stale');
    expect(classifyEntryError({ code: 'P0001', message: 'aps_entry_id_exists' })).toBe('existing');
    expect(classifyEntryError({ code: 'P0001', message: 'aps_entry_duplicate_letter_code' })).toBe(
      'duplicateLetterCode',
    );
    expect(classifyEntryError({ code: '42501' })).toBe('forbidden');
    expect(classifyEntryError({ code: '22023' })).toBe('invalid');
    expect(classifyEntryError(new TypeError('Failed to fetch'))).toBe('network');
    expect(classifyEntryError({ code: 'XX000' }, 503)).toBe('network');
    expect(classifyEntryError(new ApsEntryError('unavailable'))).toBe('unavailable');

    setupTransport(() => json({ code: '23505', message: 'duplicate key' }, 409));
    const form: EntryForm = {
      ...newEntryForm(),
      number: '7',
      yearId: id(400),
      partyId: id(501),
      lines: [
        {
          key: 'l1',
          partyId: '',
          warehouseId: id(100),
          classificationId: id(201),
          destinationWarehouseId: '',
          destinationClassificationId: '',
          amount: '5',
        },
      ],
    };
    await expect(saveEntryDraft(id(900), null, form)).rejects.toMatchObject({ code: 'duplicate' });
  });

  it('sends exact amounts, explicit nulls per type and the observed draft version', async () => {
    const requests = setupTransport(() =>
      json({ id: id(900), updated_at: '2026-03-04T11:00:00+00:00' }),
    );
    const form: EntryForm = {
      ...newEntryForm(),
      type: 'external_transfer',
      number: '007',
      letterCode: 'YM:7',
      yearId: id(400),
      partyId: id(501),
      sisterId: id(601),
      direction: 'out',
      reason: 'ignored',
      lines: [
        {
          key: 'l1',
          partyId: '',
          warehouseId: id(100),
          classificationId: id(201),
          destinationWarehouseId: id(100),
          destinationClassificationId: id(201),
          amount: '١٢٫٥',
        },
      ],
    };
    await expect(saveEntryDraft(id(900), '2026-03-04T10:00:00+00:00', form)).resolves.toEqual({
      id: id(900),
      updatedAt: '2026-03-04T11:00:00+00:00',
    });
    const body = JSON.parse(requests[0]!.body) as Record<string, unknown>;
    expect(requests[0]!.url.pathname).toBe('/rest/v1/rpc/aps_save_letter_draft');
    expect(body).toMatchObject({
      p_letter_id: id(900),
      p_issuer_reference: 'YM:7',
      p_expected_updated_at: '2026-03-04T10:00:00+00:00',
      p_letter_type: 'external_transfer',
      p_party_id: null,
      p_sister_company_id: id(601),
      p_direction: 'out',
      p_reclassification_note: null,
      p_lines: [{ warehouse_id: id(100), classification_id: id(201), amount: '12.50' }],
    });
    expect(body).not.toHaveProperty('p_reclassification_reason');

    const internalRequests = setupTransport(() =>
      json({ id: id(900), updated_at: '2026-03-04T11:00:00+00:00' }),
    );
    await saveEntryDraft(id(900), null, { ...form, type: 'internal_transfer' });
    const internalBody = JSON.parse(internalRequests[0]!.body) as Record<string, unknown>;
    expect(internalBody).toMatchObject({
      p_sister_company_id: null,
      p_direction: null,
      p_reclassification_note: 'ignored',
      p_lines: [
        {
          direction: 'out',
          warehouse_id: id(100),
          classification_id: id(201),
          amount: '12.50',
        },
        {
          direction: 'in',
          warehouse_id: id(100),
          classification_id: id(201),
          amount: '12.50',
        },
      ],
    });
    expect(internalBody).not.toHaveProperty('p_reclassification_reason');
  });

  it('falls back once to the legacy save signature while its migration is pending', async () => {
    const requests = setupTransport((_url, body) => {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      return 'p_reclassification_note' in parsed
        ? json(
            {
              code: 'PGRST202',
              message:
                'Could not find the function public.aps_save_letter_draft(p_reclassification_note) in the schema cache',
              details: null,
              hint: null,
            },
            404,
          )
        : json({ id: id(900), updated_at: '2026-03-04T11:00:00+00:00' });
    });
    const form: EntryForm = {
      ...newEntryForm(),
      type: 'internal_transfer',
      number: '9',
      yearId: id(400),
      reason: 'بيان نقل',
      lines: [
        {
          key: 'l1',
          partyId: '',
          warehouseId: id(100),
          classificationId: id(201),
          destinationWarehouseId: id(101),
          destinationClassificationId: id(202),
          amount: '4.25',
        },
      ],
    };

    await expect(saveEntryDraft(id(900), null, form)).resolves.toEqual({
      id: id(900),
      updatedAt: '2026-03-04T11:00:00+00:00',
    });
    expect(requests).toHaveLength(2);
    const firstBody = JSON.parse(requests[0]!.body) as Record<string, unknown>;
    expect(firstBody).toMatchObject({
      p_reclassification_note: 'بيان نقل',
      p_lines: [
        { direction: 'out', warehouse_id: id(100), classification_id: id(201), amount: '4.25' },
        { direction: 'in', warehouse_id: id(101), classification_id: id(202), amount: '4.25' },
      ],
    });
    expect(firstBody).not.toHaveProperty('p_reclassification_reason');
    const fallbackBody = JSON.parse(requests[1]!.body) as Record<string, unknown>;
    expect(fallbackBody).toMatchObject({
      p_reclassification_reason: 'بيان نقل',
      p_lines: [
        {
          source_warehouse_id: id(100),
          source_classification_id: id(201),
          destination_warehouse_id: id(101),
          destination_classification_id: id(202),
          amount: '4.25',
        },
      ],
    });
    expect(fallbackBody).not.toHaveProperty('p_reclassification_note');
  });

  it('sends the letter code as one field and never sends the letter date', async () => {
    const requests = setupTransport(() =>
      json({ id: id(900), updated_at: '2026-03-04T11:00:00+00:00' }),
    );
    const form: EntryForm = {
      ...newEntryForm(),
      number: '7',
      letterCode: 'YM:0042',
      yearId: id(400),
      partyId: id(501),
      lines: [
        {
          key: 'l1',
          partyId: '',
          warehouseId: id(100),
          classificationId: id(201),
          destinationWarehouseId: '',
          destinationClassificationId: '',
          amount: '5',
        },
      ],
    };
    await saveEntryDraft(id(900), null, form);
    const body = JSON.parse(requests[0]!.body) as Record<string, unknown>;
    expect(body).toMatchObject({ p_issuer_reference: 'YM:0042' });
    // The accounting date is the database's answer now: the screen never sends it.
    expect(body).not.toHaveProperty('p_letter_date');
    expect(body).not.toHaveProperty('p_issuer_code');
  });

  it('reads the station beside the warehouse and requires a two-letter issuer code', () => {
    const options = parseEntryOptions(optionsPayload);
    expect(options.warehouses[0]).toMatchObject({
      name: 'احتياطي',
      stationName: 'غرب القاهرة',
      stationCode: 'ST-01',
    });
    expect(options.issuers).toEqual([{ id: id(701), code: 'YM', name: 'ياسر' }]);
    expect(options.months[0]).toMatchObject({ name: 'مارس', period: 2, yearId: id(400) });
    expect(() =>
      parseEntryOptions({ ...optionsPayload, issuers: [{ id: id(701), code: 'Y', name: 'x' }] }),
    ).toThrow(ApsEntryError);
    expect(() => parseEntryOptions({ ...optionsPayload, issuers: undefined })).toThrow(
      ApsEntryError,
    );
    expect(() =>
      parseEntryOptions({
        ...optionsPayload,
        fiscal_months: [{ ...optionsPayload.fiscal_months[0], current_period: 0 }],
      }),
    ).toThrow(ApsEntryError);
  });

  it('approves only through aps_approve_letter', async () => {
    const requests = setupTransport(() => json(null));
    await approveEntryLetter(id(900));
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url.pathname).toBe('/rest/v1/rpc/aps_approve_letter');
    expect(JSON.parse(requests[0]!.body)).toEqual({ p_letter_id: id(900) });
  });
});
