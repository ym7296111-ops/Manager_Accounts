import { describe, expect, it } from 'vitest';
import { matchesSearch, normalizeArabicText, searchClassifications } from '@/lib/arabicText';

/**
 * The picker's search (design study §4.3, U4).
 *
 * The point of the fold is that a person typing quickly on a phone produces a
 * different spelling than the one stored in the database. Each `it` below is a
 * spelling pair that really occurs in Arabic project names — not a synthetic
 * normalization table.
 */
describe('normalizeArabicText', () => {
  it('folds the four hamza carriers onto a bare alef', () => {
    expect(normalizeArabicText('أخشاب')).toBe('اخشاب');
    expect(normalizeArabicText('إصلاح')).toBe('اصلاح');
    expect(normalizeArabicText('آلات')).toBe('الات');
    expect(normalizeArabicText('ٱستلام')).toBe('استلام');
  });

  it('folds ta-marbuta onto ha and alef-maqsura onto ya', () => {
    expect(normalizeArabicText('مواد تعبئة')).toBe('مواد تعبيه');
    expect(normalizeArabicText('مستشفى')).toBe('مستشفي');
  });

  it('folds waw-hamza and ya-hamza onto their bare carriers', () => {
    expect(normalizeArabicText('مؤونة')).toBe('موونه');
    expect(normalizeArabicText('مؤونه')).toBe('موونه');
    expect(normalizeArabicText('رئيسي')).toBe('رييسي');
  });

  it('strips tashkeel, tatweel and collapses whitespace', () => {
    expect(normalizeArabicText('حَديدٌ وَصَلْب')).toBe('حديد وصلب');
    expect(normalizeArabicText('حـــديد')).toBe('حديد');
    expect(normalizeArabicText('  حديد    وصلب  ')).toBe('حديد وصلب');
  });

  it('maps Arabic-Indic digits onto ASCII and lowercases codes', () => {
    expect(normalizeArabicText('CLS-٠٠٤')).toBe('cls-004');
    expect(normalizeArabicText('رمز ۱۲۳')).toBe('رمز 123');
  });

  it('keeps the definite article — ال is part of the word, not noise', () => {
    /* Stripping `ال` would make «التزام» match «زام», which is wrong. */
    expect(normalizeArabicText('التزام')).toBe('التزام');
    expect(normalizeArabicText('التزام')).not.toBe(normalizeArabicText('زام'));
  });
});

describe('matchesSearch', () => {
  it('matches every folded spelling variant', () => {
    expect(matchesSearch('اخشاب', 'أخشاب')).toBe(true);
    expect(matchesSearch('أخشاب', 'اخشاب')).toBe(true);
    expect(matchesSearch('تعبيه', 'مواد تعبئة')).toBe(true);
    expect(matchesSearch('مستشفي', 'مستشفى')).toBe(true);
  });

  it('requires every whitespace-separated token, in any order', () => {
    expect(matchesSearch('وصلب حديد', 'حديد وصلب')).toBe(true);
    expect(matchesSearch('حديد خشب', 'حديد وصلب')).toBe(false);
  });

  it('treats an empty query as "match everything"', () => {
    expect(matchesSearch('', 'anything')).toBe(true);
    expect(matchesSearch('   ', 'anything')).toBe(true);
  });
});

describe('searchClassifications', () => {
  const entries = [
    { code: 'CLS-001', name: 'حديد وصلب' },
    { code: 'CLS-002', name: 'أخشاب' },
    { code: 'CLS-003', name: 'مواد تعبئة' },
    { code: 'CLS-1000', name: 'زيوت وشحوم' },
  ];

  it('returns everything for an empty query, without copying', () => {
    expect(searchClassifications(entries, '')).toBe(entries);
  });

  it('finds a row by its name with a folded spelling', () => {
    expect(searchClassifications(entries, 'اخشاب')).toEqual([entries[1]]);
    expect(searchClassifications(entries, 'تعبيه')).toEqual([entries[2]]);
  });

  it('finds a row by its code, case- and digit-insensitively', () => {
    expect(searchClassifications(entries, 'cls-003')).toEqual([entries[2]]);
    expect(searchClassifications(entries, 'CLS-١٠٠٠')).toEqual([entries[3]]);
  });

  it('returns nothing when nothing matches', () => {
    expect(searchClassifications(entries, 'بلاستيك')).toEqual([]);
  });
});
