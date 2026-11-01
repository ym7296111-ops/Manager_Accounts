import { describe, expect, it } from 'vitest';
import {
  entryHasReclassification,
  entryScreenPeriod,
  entryTotal,
  entryTransferTotals,
  fiscalYearLabel,
  isLetterCode,
  joinLetterCode,
  letterCodeIncomplete,
  newEntryForm,
  normalizeEntryAmount,
  normalizeLetterCode,
  runningEntryPeriod,
  searchWarehouses,
  splitLetterCode,
  centsToSignedAmount,
  groupEntryLines,
  partyCodeNumber,
  signedAmountToCents,
  smallestCodeParty,
  validateEntry,
  warehouseLabel,
  type EntryForm,
  type EntryOptions,
} from '@/lib/apsLetterEntry';

const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const options: EntryOptions = {
  years: [
    {
      id: id(400),
      name: '2026',
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      active: true,
      closed: false,
      supplementsOpen: false,
    },
  ],
  months: [
    {
      id: id(300),
      yearId: id(400),
      monthNumber: 3,
      name: 'مارس',
      startDate: '2026-03-01',
      endDate: '2026-03-31',
      period: 2,
      closed: false,
    },
  ],
  warehouses: [
    {
      id: id(100),
      name: 'احتياطي',
      code: 'WH-001',
      stationName: 'غرب القاهرة',
      stationCode: 'ST-01',
    },
  ],
  classifications: [
    { id: id(201), name: 'حديد', code: 'CL-001' },
    { id: id(202), name: 'تشغيل', code: 'CL-002' },
  ],
  parties: [
    { id: id(501), name: 'وارد', code: 'IN-001', branch: 'inbound' },
    { id: id(502), name: 'منصرف', code: 'OUT-001', branch: 'outbound' },
  ],
  sisters: [{ id: id(601), name: 'شقيقة', code: 'SIS-001' }],
  issuers: [{ id: id(701), code: 'YM', name: 'ياسر' }],
};

function validForm(patch: Partial<EntryForm> = {}): EntryForm {
  return {
    ...newEntryForm(),
    number: '2458',
    letterCode: 'YM:63',
    yearId: id(400),
    partyId: id(501),
    lines: [
      {
        key: 'line-1',
        partyId: id(501),
        warehouseId: id(100),
        classificationId: id(201),
        amount: '120.50',
      },
    ],
    ...patch,
  };
}

/* One transfer is a free list of rows: a source row and a destination row are
   two independent entries, never two halves of one pair. */
const transferForm = (amount = '50', destinationClassification = id(201)) =>
  validForm({
    type: 'internal_transfer',
    partyId: '',
    lines: [
      {
        key: 'line-out',
        partyId: '',
        warehouseId: id(100),
        classificationId: id(201),
        direction: 'out',
        amount,
      },
      {
        key: 'line-in',
        partyId: '',
        warehouseId: id(100),
        classificationId: destinationClassification,
        direction: 'in',
        amount,
      },
    ],
  });

describe('APS letter entry validation', () => {
  it('accepts a complete inbound letter and computes its exact total', () => {
    expect(validateEntry(validForm(), options)).toBeNull();
    expect(entryTotal(validForm())).toBe('120.50');
  });

  it('folds Arabic digits and decimal separators without using Number', () => {
    expect(normalizeEntryAmount('١٢٣٤٫٥')).toBe('1234.50');
    expect(normalizeEntryAmount(' 12 ')).toBe('12.00');
    expect(entryTotal(validForm({ lines: [{ ...validForm().lines[0]!, amount: '١٢٣٤٫٥' }] }))).toBe(
      '1234.50',
    );
  });

  it('rejects zero, negative, over-precise and over-large amounts', () => {
    expect(normalizeEntryAmount('0')).toBeNull();
    expect(normalizeEntryAmount('-1')).toBeNull();
    expect(normalizeEntryAmount('1.001')).toBeNull();
    expect(normalizeEntryAmount('99999999999999999')).toBeNull();
    const amount = (value: string) =>
      validateEntry(validForm({ lines: [{ ...validForm().lines[0]!, amount: value }] }), options);
    expect(amount('-5')).toEqual({ code: 'amount', line: 1 });
    expect(amount('0')).toEqual({ code: 'amount', line: 1 });
    expect(amount('1.239')).toEqual({ code: 'amount', line: 1 });
    expect(
      validateEntry(
        validForm({
          lines: [
            { ...validForm().lines[0]!, key: 'a', amount: '9999999999999999' },
            // A different classification, so only the total cap can refuse it.
            {
              ...validForm().lines[0]!,
              key: 'b',
              classificationId: id(202),
              amount: '9999999999999999',
            },
          ],
        }),
        options,
      ),
    ).toEqual({ code: 'total' });
  });

  it('requires a numeric EPS number, the configured year and the matching party branch', () => {
    expect(validateEntry(validForm({ number: '  ' }), options)).toEqual({ code: 'number' });
    expect(validateEntry(validForm({ number: 'A12' }), options)).toEqual({ code: 'number' });
    expect(validateEntry(validForm({ number: '1'.repeat(65) }), options)).toEqual({
      code: 'number',
    });
    expect(validateEntry(validForm({ yearId: id(999) }), options)).toEqual({ code: 'period' });
    expect(validateEntry(validForm({ yearId: '' }), options)).toEqual({ code: 'period' });
    // The party lives on the line: a wrong-branch party there is refused with
    // its line number, while the header field alone no longer decides.
    expect(
      validateEntry(
        validForm({ lines: [{ ...validForm().lines[0]!, partyId: id(502) }] }),
        options,
      ),
    ).toEqual({ code: 'lineParty', line: 1 });
    expect(
      validateEntry(validForm({ lines: [{ ...validForm().lines[0]!, partyId: '' }] }), options),
    ).toEqual({ code: 'lineParty', line: 1 });
    expect(validateEntry(validForm({ type: 'external_transfer', partyId: '' }), options)).toEqual({
      code: 'sister',
    });
    expect(
      validateEntry(
        validForm({ type: 'external_transfer', partyId: '', sisterId: id(601) }),
        options,
      ),
    ).toBeNull();
  });

  it('refuses the same (party, warehouse, classification) twice but allows it across parties', () => {
    const line = validForm().lines[0]!;
    expect(
      validateEntry(validForm({ lines: [line, { ...line, key: 'line-2' }] }), options),
    ).toEqual({ code: 'duplicateLine', line: 2 });
    expect(
      validateEntry(
        validForm({
          type: 'outbound',
          lines: [
            { ...line, partyId: id(502) },
            { ...line, key: 'line-2', partyId: id(502), classificationId: id(202) },
          ],
        }),
        options,
      ),
    ).toBeNull();
  });

  it('groups lines into the party tree in first-appearance order', () => {
    const base = validForm().lines[0]!;
    const lines = [
      { ...base, key: 'a', partyId: id(501), warehouseId: id(100) },
      { ...base, key: 'b', partyId: id(502), warehouseId: id(100) },
      { ...base, key: 'c', partyId: id(501), warehouseId: id(101) },
      { ...base, key: 'd', partyId: id(501), warehouseId: id(100), classificationId: id(202) },
    ];
    const groups = groupEntryLines(lines);
    expect(groups.map((group) => group.partyId)).toEqual([id(501), id(502)]);
    expect(groups[0]?.warehouses.map((group) => group.warehouseId)).toEqual([id(100), id(101)]);
    expect(groups[0]?.warehouses[0]?.lines.map((line) => line.key)).toEqual(['a', 'd']);
  });

  it('picks the smallest numeric party code, never the lexicographic one', () => {
    const parties = [
      { id: id(1), name: 'a', code: 'OUT-1000' },
      { id: id(2), name: 'b', code: 'OUT-999' },
      { id: id(3), name: 'c', code: 'OUT-001' },
    ];
    expect(smallestCodeParty(parties)?.code).toBe('OUT-001');
    expect(partyCodeNumber('IN-014')).toBe(14n);
    expect(partyCodeNumber('XX')).toBeNull();
  });

  it('round-trips signed balance amounts without Number', () => {
    expect(signedAmountToCents('-3980.00')).toBe(-398000n);
    expect(signedAmountToCents('0.05')).toBe(5n);
    expect(centsToSignedAmount(-5n)).toBe('-0.05');
    expect(centsToSignedAmount(102000n)).toBe('1020.00');
  });

  it('accepts free transfer lines and never demands a destination on a row', () => {
    expect(validateEntry(transferForm(), options)).toBeNull();
    expect(entryHasReclassification(transferForm())).toBe(false);
    /* One source row feeding two destinations is a legal transfer: nothing ties
       the rows together, so the extra destination row is simply another line. */
    const oneToTwo = transferForm();
    expect(
      validateEntry(
        {
          ...oneToTwo,
          lines: [
            ...oneToTwo.lines,
            {
              key: 'line-in-2',
              partyId: '',
              warehouseId: id(100),
              classificationId: id(201),
              direction: 'in',
              amount: '50',
            },
          ],
        },
        options,
      ),
    ).toBeNull();
    /* An empty reference is still refused, and the error names the row. */
    expect(
      validateEntry(
        {
          ...transferForm(),
          lines: [{ ...transferForm().lines[0]!, warehouseId: '' }],
        },
        options,
      ),
    ).toEqual({ code: 'lineReference', line: 1 });
  });

  it('treats the reclassification statement as optional but notices a change', () => {
    expect(entryHasReclassification(transferForm('10', id(202)))).toBe(true);
    /* Different classifications no longer gate the save: the statement is
       optional on a draft and on approval. */
    expect(validateEntry(transferForm('10', id(202)), options)).toBeNull();
    expect(validateEntry(transferForm('10', id(202)), options)).toBeNull();
    /* A bad amount is still an error, whatever the classifications say. */
    expect(validateEntry(transferForm('0', id(202)), options)).toEqual({ code: 'amount', line: 1 });
  });

  it('measures each transfer side and reports the difference', () => {
    expect(entryTransferTotals(transferForm().lines)).toEqual({
      source: '50.00',
      destination: '50.00',
      difference: '0.00',
      balanced: true,
    });
    const unbalanced = transferForm();
    const totals = entryTransferTotals([
      ...unbalanced.lines,
      { ...unbalanced.lines[1]!, key: 'b' },
    ]);
    expect(totals).toEqual({
      source: '50.00',
      destination: '100.00',
      difference: '-50.00',
      balanced: false,
    });
    /* An unfinished row makes the meter say "not yet", never zero. */
    expect(entryTransferTotals([{ ...unbalanced.lines[0]!, amount: '' }])).toEqual({
      source: null,
      destination: '0.00',
      difference: null,
      balanced: null,
    });
  });

  it('labels a warehouse with its station and searches both', () => {
    expect(warehouseLabel(options.warehouses[0]!)).toBe('احتياطي - غرب القاهرة');
    expect(warehouseLabel({ name: 'احتياطي', stationName: null })).toBe('احتياطي');
    expect(searchWarehouses(options.warehouses, 'غرب').map((item) => item.id)).toEqual([id(100)]);
    expect(searchWarehouses(options.warehouses, 'WH-001').map((item) => item.id)).toEqual([
      id(100),
    ]);
    expect(searchWarehouses(options.warehouses, 'شرق')).toEqual([]);
  });

  it('reads the running period from the periodic settings instead of guessing it', () => {
    expect(runningEntryPeriod(options, '2026-03-04')).toMatchObject({
      month: { name: 'مارس', period: 2 },
      year: { id: id(400) },
    });
    expect(runningEntryPeriod(options, '2026-07-01')).toBeNull();
    expect(
      runningEntryPeriod(
        { ...options, years: options.years.map((year) => ({ ...year, active: false })) },
        '2026-07-01',
      ),
    ).toBeNull();
  });

  it('states the period the database resolved, not the browser clock', () => {
    const july = {
      id: id(310),
      yearId: id(400),
      monthNumber: 7,
      name: 'يوليو 2026',
      startDate: '2026-07-01',
      endDate: '2026-07-31',
      period: 1,
      closed: false,
    };
    const october = {
      id: id(311),
      yearId: id(400),
      monthNumber: 10,
      name: 'أكتوبر 2026',
      startDate: '2026-10-01',
      endDate: '2026-10-31',
      period: 2,
      closed: false,
    };
    const months = { ...options, months: [july, october] };
    const withActive = {
      ...months,
      activePeriod: {
        monthId: july.id,
        yearId: id(400),
        monthNumber: 7,
        name: july.name,
        startDate: july.startDate,
        endDate: july.endDate,
        period: 1,
        closed: false,
        projectToday: '2026-10-15',
        containsToday: false,
      },
    };
    // The clock would have answered October; the database says July.
    expect(runningEntryPeriod(months, '2026-10-15')).toMatchObject({
      month: { name: 'أكتوبر 2026', period: 2 },
    });
    expect(entryScreenPeriod(withActive, null, '2026-10-15')).toMatchObject({
      month: { name: 'يوليو 2026', period: 1 },
      year: { id: id(400) },
    });
    // A draft keeps the month it was written in, even after the period moved.
    expect(entryScreenPeriod(withActive, '2026-10-04', '2026-10-15')).toMatchObject({
      month: { name: 'أكتوبر 2026', period: 2 },
    });
    // A pre-A.3 database sends no period: the clock rule is the fallback.
    expect(entryScreenPeriod(months, null, '2026-10-15')).toMatchObject({
      month: { name: 'أكتوبر 2026' },
    });
    expect(entryScreenPeriod(months, null, '2026-12-15')).toBeNull();
    // A period whose month is not in the list never invents a statement.
    expect(entryScreenPeriod({ ...withActive, months: [october] }, null, '2026-12-15')).toBeNull();
  });

  it('writes the fiscal year the way the paper does', () => {
    expect(fiscalYearLabel('2026-2027')).toBe('2026/2027');
    expect(fiscalYearLabel(' السنة المالية 2026 ')).toBe('السنة المالية 2026');
  });

  it('builds the letter code as YM:63 from whatever the keyboard sends', () => {
    expect(normalizeLetterCode('ym')).toBe('YM');
    expect(normalizeLetterCode('ym63')).toBe('YM:63');
    expect(normalizeLetterCode('YM:63')).toBe('YM:63');
    expect(normalizeLetterCode('y m : 6 3')).toBe('YM:63');
    expect(normalizeLetterCode('٦٣')).toBe('');
    expect(normalizeLetterCode('يم63')).toBe('');
    expect(normalizeLetterCode('y1')).toBe('Y');
    expect(normalizeLetterCode('ymm63')).toBe('YM:63');
    expect(normalizeLetterCode('ym63aa')).toBe('YM:63');
    expect(isLetterCode('YM:63')).toBe(true);
    expect(isLetterCode('YM:')).toBe(false);
    expect(isLetterCode('YM63')).toBe(false);
    expect(isLetterCode('ym:63')).toBe(false);
    expect(letterCodeIncomplete('')).toBe(false);
    expect(letterCodeIncomplete('YM')).toBe(true);
  });

  it('composes the two entry controls into the one stored column', () => {
    // The dropdown holds the code, the field holds the digits, and the colon is
    // printed between them — `issuer_reference` is still one column.
    expect(joinLetterCode('YM', '63')).toBe('YM:63');
    expect(joinLetterCode('YM', '')).toBe('YM');
    expect(joinLetterCode('', '63')).toBe('');
    expect(splitLetterCode('YM:63')).toEqual({ code: 'YM', number: '63' });
    expect(splitLetterCode('YM:0063')).toEqual({ code: 'YM', number: '0063' });
    expect(splitLetterCode('YM')).toEqual({ code: 'YM', number: '' });
    expect(splitLetterCode('')).toEqual({ code: '', number: '' });
    // Anything the field is fed is folded to the stored shape first.
    expect(splitLetterCode('ym٦٣')).toEqual({ code: 'YM', number: '63' });
    expect(splitLetterCode('يم')).toEqual({ code: '', number: '' });
  });

  it('accepts a registered issuer prefix and rejects anything else', () => {
    expect(validateEntry(validForm({ letterCode: 'YM:63' }), options)).toBeNull();
    expect(validateEntry(validForm({ letterCode: '' }), options)).toBeNull();
    expect(validateEntry(validForm({ letterCode: 'YM' }), options)).toEqual({
      code: 'letterCode',
    });
    expect(validateEntry(validForm({ letterCode: 'YM:0063' }), options)).toBeNull();
    expect(validateEntry(validForm({ letterCode: 'ZZ:1' }), options)).toEqual({
      code: 'issuerCode',
    });
  });

  it('rejects an empty list and a mismatched reference', () => {
    expect(validateEntry(validForm({ lines: [] }), options)).toEqual({ code: 'lines' });
    expect(
      validateEntry(
        validForm({ lines: [{ ...validForm().lines[0]!, warehouseId: id(999) }] }),
        options,
      ),
    ).toEqual({ code: 'lineReference', line: 1 });
  });
});
