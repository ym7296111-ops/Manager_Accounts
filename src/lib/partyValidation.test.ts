import { describe, expect, it } from 'vitest';
import {
  PARTY_BRANCHES,
  isPartyBranch,
  validatePartyForm,
  type PartyFormRaw,
} from '@/lib/partyValidation';

function raw(patch: Partial<PartyFormRaw> = {}): PartyFormRaw {
  return {
    name: 'شركة النيل للتوريدات',
    ...patch,
  };
}

describe('party branch helpers', () => {
  it('accepts exactly the two roots, in tree order', () => {
    expect(PARTY_BRANCHES).toEqual(['inbound', 'outbound']);
    expect(isPartyBranch('inbound')).toBe(true);
    expect(isPartyBranch('outbound')).toBe(true);
  });

  it('refuses everything the schema no longer has', () => {
    for (const retired of [
      'local_supplier',
      'foreign_supplier',
      'customer',
      'supplier',
      'internal',
      'sister_company',
      '',
      'INBOUND',
      ' inbound ',
      null,
      undefined,
      1,
    ]) {
      expect(isPartyBranch(retired)).toBe(false);
    }
  });
});

describe('validatePartyForm', () => {
  it('normalizes a valid name and carries nothing else', () => {
    const result = validatePartyForm(raw({ name: '  شركة النيل للتوريدات  ' }), 'inbound');

    expect(result).toEqual({ ok: true, value: { name: 'شركة النيل للتوريدات' } });
    if (result.ok) {
      expect(Object.keys(result.value)).toEqual(['name']);
    }
  });

  it('reports a missing name as required', () => {
    expect(validatePartyForm(raw({ name: '' }), 'inbound')).toEqual({
      ok: false,
      errors: { name: 'required' },
    });
    expect(validatePartyForm(raw({ name: '   ' }), 'outbound')).toEqual({
      ok: false,
      errors: { name: 'required' },
    });
  });

  it('reports a one-character name as too short', () => {
    expect(validatePartyForm(raw({ name: 'ش' }), 'inbound')).toEqual({
      ok: false,
      errors: { name: 'tooShort' },
    });
  });

  it('accepts a name under either root', () => {
    expect(validatePartyForm(raw(), 'inbound').ok).toBe(true);
    expect(validatePartyForm(raw(), 'outbound').ok).toBe(true);
  });

  it('fails closed when the branch is pinned away from the form', () => {
    /* The tree pins a dialog to the root it was opened from: a tampered form
       must not be able to mint a code from the other root's sequence. */
    expect(() => validatePartyForm(raw(), 'outbound', ['inbound'])).toThrow();
    expect(() => validatePartyForm(raw(), 'inbound', ['outbound'])).toThrow();
  });

  it('fails closed for a branch outside the two roots', () => {
    expect(() => validatePartyForm(raw(), 'vendor' as never)).toThrow();
  });
});
