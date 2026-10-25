import { describe, expect, it } from 'vitest';
import {
  isPartyPaymentTerms,
  isPartyType,
  isValidPartyEmail,
  roundCreditLimit,
  supportsCreditTerms,
  validatePartyForm,
  type PartyFormRaw,
} from '@/lib/partyValidation';

function raw(patch: Partial<PartyFormRaw> = {}): PartyFormRaw {
  return {
    type: 'supplier',
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
  it('accepts exactly the four CHECK types', () => {
    expect(isPartyType('supplier')).toBe(true);
    expect(isPartyType('customer')).toBe(true);
    expect(isPartyType('sister_company')).toBe(true);
    expect(isPartyType('internal')).toBe(true);
    expect(isPartyType('')).toBe(false);
    expect(isPartyType('vendor')).toBe(false);
    expect(isPartyType(null)).toBe(false);
    expect(isPartyType(42)).toBe(false);
  });

  it('grants credit terms to suppliers and customers only', () => {
    expect(supportsCreditTerms('supplier')).toBe(true);
    expect(supportsCreditTerms('customer')).toBe(true);
    expect(supportsCreditTerms('sister_company')).toBe(false);
    expect(supportsCreditTerms('internal')).toBe(false);
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
  it('normalizes a full supplier form (trim, nulls, parsed credit terms)', () => {
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
        type: 'supplier',
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

  it('requires the one-time type choice', () => {
    const result = validatePartyForm(raw({ type: '' }));
    expect(result).toEqual({ ok: false, errors: { type: 'required' } });
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

  it('rejects negative, non-numeric and out-of-set credit values for credit types', () => {
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

  it('strips credit terms for sister companies instead of carrying them through', () => {
    const result = validatePartyForm(
      raw({ type: 'sister_company', creditLimit: '5000', paymentTerms: '30' }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.creditLimit).toBeNull();
      expect(result.value.paymentTerms).toBeNull();
    }
  });

  it('ignores leftover credit garbage for internal parties (the fields are not rendered)', () => {
    /* A user can pick "customer", type into the credit fields, then switch to
       "internal": the hidden leftovers must neither block the submit nor leak
       into the normalized values. */
    const result = validatePartyForm(
      raw({ type: 'internal', creditLimit: 'garbage', paymentTerms: '999' }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.creditLimit).toBeNull();
      expect(result.value.paymentTerms).toBeNull();
    }
  });
});
