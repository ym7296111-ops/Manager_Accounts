import { describe, expect, it } from 'vitest';
import {
  INBOUND_PARTY_TYPES,
  OUTBOUND_PARTY_TYPES,
  PARTY_TYPES,
  isInboundPartyType,
  isPartyPaymentTerms,
  isPartyType,
  isValidPartyEmail,
  partyTypesForScope,
  roundCreditLimit,
  validatePartyForm,
  type PartyFormRaw,
} from '@/lib/partyValidation';

function raw(patch: Partial<PartyFormRaw> = {}): PartyFormRaw {
  return {
    type: 'local_supplier',
    name: 'شركة النيل للتوريدات',
    taxNumber: '',
    commercialRegister: '',
    address: '',
    contactPerson: '',
    phone: '',
    email: '',
    creditLimit: '',
    paymentTerms: '',
    ...patch,
  };
}

describe('party type helpers', () => {
  it('accepts exactly the three CHECK types', () => {
    expect(PARTY_TYPES).toEqual(['local_supplier', 'foreign_supplier', 'customer']);
    expect(isPartyType('local_supplier')).toBe(true);
    expect(isPartyType('foreign_supplier')).toBe(true);
    expect(isPartyType('customer')).toBe(true);
    expect(isPartyType('')).toBe(false);
    expect(isPartyType('vendor')).toBe(false);
    expect(isPartyType(null)).toBe(false);
    expect(isPartyType(42)).toBe(false);
  });

  it('retires the old vocabulary: supplier, sister_company and internal are not types', () => {
    expect(isPartyType('supplier')).toBe(false);
    expect(isPartyType('sister_company')).toBe(false);
    expect(isPartyType('internal')).toBe(false);
  });

  it('splits the types across the two sub-tabs', () => {
    expect(INBOUND_PARTY_TYPES).toEqual(['local_supplier', 'foreign_supplier']);
    expect(OUTBOUND_PARTY_TYPES).toEqual(['customer']);
    expect(partyTypesForScope('inbound')).toEqual(['local_supplier', 'foreign_supplier']);
    expect(partyTypesForScope('outbound')).toEqual(['customer']);

    expect(isInboundPartyType('local_supplier')).toBe(true);
    expect(isInboundPartyType('foreign_supplier')).toBe(true);
    expect(isInboundPartyType('customer')).toBe(false);
  });

  it('accepts exactly the payment-terms set', () => {
    for (const days of [0, 15, 30, 60, 90]) {
      expect(isPartyPaymentTerms(days)).toBe(true);
    }
    expect(isPartyPaymentTerms(45)).toBe(false);
    expect(isPartyPaymentTerms(-30)).toBe(false);
    expect(isPartyPaymentTerms(Number.NaN)).toBe(false);
  });
});

describe('isValidPartyEmail', () => {
  it('mirrors the parties_email_check pattern', () => {
    expect(isValidPartyEmail('sales@nile-supplies.example.com')).toBe(true);
    expect(isValidPartyEmail('A@B.COM')).toBe(true);
    expect(isValidPartyEmail('not-an-email')).toBe(false);
    expect(isValidPartyEmail('a@b')).toBe(false);
    expect(isValidPartyEmail('a b@c.com')).toBe(false);
    expect(isValidPartyEmail('a@c.d')).toBe(false);
  });
});

describe('roundCreditLimit', () => {
  it('rounds to the numeric(18, 2) scale the column stores', () => {
    expect(roundCreditLimit(0)).toBe(0);
    expect(roundCreditLimit(1500.5)).toBe(1500.5);
    expect(roundCreditLimit(99.999)).toBe(100);
    expect(roundCreditLimit(250000)).toBe(250000);
  });
});

describe('validatePartyForm', () => {
  it('normalizes a full local-supplier form (trim, nulls, parsed credit terms)', () => {
    const result = validatePartyForm(
      raw({
        name: '  شركة النيل للتوريدات الصناعية  ',
        taxNumber: ' 123456789 ',
        commercialRegister: '',
        address: ' المنطقة الصناعية ',
        contactPerson: ' أحمد سامي ',
        phone: ' +20238200000 ',
        email: ' sales@nile-supplies.example.com ',
        creditLimit: ' 250000 ',
        paymentTerms: '30',
      }),
    );

    expect(result).toEqual({
      ok: true,
      value: {
        type: 'local_supplier',
        name: 'شركة النيل للتوريدات الصناعية',
        taxNumber: '123456789',
        commercialRegister: null,
        address: 'المنطقة الصناعية',
        contactPerson: 'أحمد سامي',
        phone: '+20238200000',
        email: 'sales@nile-supplies.example.com',
        creditLimit: 250000,
        paymentTerms: 30,
      },
    });
  });

  it('accepts a foreign supplier with its own type', () => {
    const result = validatePartyForm(raw({ type: 'foreign_supplier', name: 'Nile Trading GmbH' }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.type).toBe('foreign_supplier');
      expect(result.value.name).toBe('Nile Trading GmbH');
    }
  });

  it('requires the one-time type choice', () => {
    const result = validatePartyForm(raw({ type: '' }));
    expect(result).toEqual({ ok: false, errors: { type: 'required' } });
  });

  it('refuses a type outside the sub-tab it was opened from', () => {
    /* The outbound tab allows customers only: a tampered form that asks for a
       local supplier must be refused before it can mint from LOC. */
    const result = validatePartyForm(raw({ type: 'local_supplier' }), OUTBOUND_PARTY_TYPES);
    expect(result).toEqual({ ok: false, errors: { type: 'required' } });

    const inbound = validatePartyForm(raw({ type: 'customer' }), INBOUND_PARTY_TYPES);
    expect(inbound).toEqual({ ok: false, errors: { type: 'required' } });

    const customer = validatePartyForm(raw({ type: 'customer' }), OUTBOUND_PARTY_TYPES);
    expect(customer.ok).toBe(true);
  });

  it('reports the shared name rule (required, then two characters)', () => {
    expect(validatePartyForm(raw({ name: '   ' }))).toEqual({
      ok: false,
      errors: { name: 'required' },
    });
    expect(validatePartyForm(raw({ name: 'ش' }))).toEqual({
      ok: false,
      errors: { name: 'tooShort' },
    });
  });

  it('rejects a malformed email but allows an empty one', () => {
    expect(validatePartyForm(raw({ email: 'not-an-email' }))).toEqual({
      ok: false,
      errors: { email: 'invalidEmail' },
    });
    const empty = validatePartyForm(raw({ email: '  ' }));
    expect(empty.ok).toBe(true);
    if (empty.ok) {
      expect(empty.value.email).toBeNull();
    }
  });

  it('keeps an explicit zero distinct from an unspecified credit limit and term', () => {
    const zeroes = validatePartyForm(raw({ creditLimit: '0', paymentTerms: '0' }));
    expect(zeroes.ok).toBe(true);
    if (zeroes.ok) {
      expect(zeroes.value.creditLimit).toBe(0);
      expect(zeroes.value.paymentTerms).toBe(0);
    }

    const unset = validatePartyForm(raw({ creditLimit: '', paymentTerms: '' }));
    expect(unset.ok).toBe(true);
    if (unset.ok) {
      expect(unset.value.creditLimit).toBeNull();
      expect(unset.value.paymentTerms).toBeNull();
    }
  });

  it('rejects negative, non-numeric and out-of-set credit values', () => {
    expect(validatePartyForm(raw({ creditLimit: '-5' }))).toEqual({
      ok: false,
      errors: { creditLimit: 'invalidCreditLimit' },
    });
    expect(validatePartyForm(raw({ creditLimit: 'abc' }))).toEqual({
      ok: false,
      errors: { creditLimit: 'invalidCreditLimit' },
    });
    expect(validatePartyForm(raw({ paymentTerms: '45' }))).toEqual({
      ok: false,
      errors: { paymentTerms: 'invalidPaymentTerms' },
    });
  });

  it('carries credit terms for customers too — every remaining type is a counterparty', () => {
    const result = validatePartyForm(
      raw({ type: 'customer', creditLimit: '5000', paymentTerms: '30' }),
      OUTBOUND_PARTY_TYPES,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.creditLimit).toBe(5000);
      expect(result.value.paymentTerms).toBe(30);
    }
  });
});
