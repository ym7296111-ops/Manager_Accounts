import { describe, expect, it } from 'vitest';
import {
  entryHasReclassification,
  entryPeriod,
  entryTotal,
  newEntryForm,
  normalizeEntryAmount,
  searchIssuers,
  searchWarehouses,
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
    date: '2026-03-04',
    yearId: id(400),
    partyId: id(501),
    lines: [
      {
        key: 'line-1',
        warehouseId: id(100),
        classificationId: id(201),
        destinationWarehouseId: '',
        destinationClassificationId: '',
        amount: '120.50',
      },
    ],
    ...patch,
  };
}

const transferForm = (amount = '50', destinationClassification = id(201)) =>
  validForm({
    type: 'internal_transfer',
    partyId: '',
    lines: [
      {
        key: 'pair-1',
        warehouseId: id(100),
        classificationId: id(201),
        destinationWarehouseId: id(100),
        destinationClassificationId: destinationClassification,
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
            { ...validForm().lines[0]!, key: 'b', amount: '9999999999999999' },
          ],
        }),
        options,
      ),
    ).toEqual({ code: 'total' });
  });

  it('requires a number, a date inside the chosen year, and the matching party branch', () => {
    expect(validateEntry(validForm({ number: '  ' }), options)).toEqual({ code: 'number' });
    expect(validateEntry(validForm({ number: 'a\u0007' }), options)).toEqual({ code: 'number' });
    expect(validateEntry(validForm({ number: 'x'.repeat(65) }), options)).toEqual({
      code: 'number',
    });
    expect(validateEntry(validForm({ yearId: id(999) }), options)).toEqual({ code: 'year' });
    expect(validateEntry(validForm({ date: '2027-01-01' }), options)).toEqual({ code: 'date' });
    expect(validateEntry(validForm({ date: '2026-02-30' }), options)).toEqual({ code: 'date' });
    expect(validateEntry(validForm({ partyId: id(502) }), options)).toEqual({ code: 'party' });
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

  it('requires complete pairs and a written reason when the classification changes', () => {
    expect(validateEntry(transferForm(), options)).toBeNull();
    expect(entryHasReclassification(transferForm())).toBe(false);
    expect(validateEntry(transferForm('10', id(202)), options)).toEqual({ code: 'reason' });
    expect(validateEntry({ ...transferForm('10', id(202)), reason: 'نق' }, options)).toEqual({
      code: 'reason',
    });
    expect(
      validateEntry({ ...transferForm('10', id(202)), reason: 'إعادة تصنيف' }, options),
    ).toBeNull();
    expect(
      validateEntry(
        transferForm().lines.length === 1
          ? {
              ...transferForm(),
              lines: [{ ...transferForm().lines[0]!, destinationClassificationId: '' }],
            }
          : transferForm(),
        options,
      ),
    ).toEqual({ code: 'lineReference', line: 1 });
  });

  it('labels a warehouse with its station and searches both, plus the issuer list', () => {
    expect(warehouseLabel(options.warehouses[0]!)).toBe('احتياطي - غرب القاهرة');
    expect(warehouseLabel({ name: 'احتياطي', stationName: null })).toBe('احتياطي');
    expect(searchWarehouses(options.warehouses, 'غرب').map((item) => item.id)).toEqual([id(100)]);
    expect(searchWarehouses(options.warehouses, 'WH-001').map((item) => item.id)).toEqual([
      id(100),
    ]);
    expect(searchWarehouses(options.warehouses, 'شرق')).toEqual([]);
    expect(searchIssuers(options.issuers, 'ياسر').map((item) => item.code)).toEqual(['YM']);
    expect(searchIssuers(options.issuers, 'ym').map((item) => item.code)).toEqual(['YM']);
    expect(searchIssuers(options.issuers, 'AA')).toEqual([]);
  });

  it('reads the running period from the periodic settings instead of guessing it', () => {
    expect(entryPeriod(validForm(), options)).toMatchObject({
      month: { name: 'مارس', period: 2 },
      year: { id: id(400) },
    });
    expect(entryPeriod(validForm({ date: '2026-07-01' }), options)).toBeNull();
    expect(entryPeriod(validForm({ date: '' }), options)).toBeNull();
    expect(entryPeriod(validForm({ yearId: '' }), options)).toBeNull();
  });

  it('accepts a listed issuer code and rejects anything else', () => {
    expect(
      validateEntry(validForm({ issuerCode: 'YM', issuerSequence: '0042' }), options),
    ).toBeNull();
    expect(validateEntry(validForm({ issuerCode: 'yy' }), options)).toEqual({ code: 'issuer' });
    expect(validateEntry(validForm({ issuerCode: 'ZZ' }), options)).toEqual({ code: 'issuer' });
    expect(validateEntry(validForm({ issuerSequence: 'x'.repeat(33) }), options)).toEqual({
      code: 'issuerSequence',
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
