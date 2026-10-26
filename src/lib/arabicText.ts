/**
 * Arabic-aware search normalization for the classification picker.
 *
 * Project names are typed by people, and the same word arrives with different
 * hamza carriers (`أخشاب` / `اخشاب`), a `ة` where the other writer used `ه`
 * (`مواد تعبئة` / `مواد تعبيه`), an `ى` that should match `ي` (`مستشفى` /
 * `مستشفي`), or with harakat left over from a copy-paste. A picker that misses
 * those variants reads as "the search is broken", so both sides of the
 * comparison are folded here.
 *
 * What is deliberately **not** done: stripping the definite article `ال`. It is
 * tempting and wrong — `ال` is a real prefix in some roots, and removing it
 * would make `التزام` match `زام`. The fold set below is the one that is
 * unambiguous in Arabic orthography.
 *
 * The result is only ever compared against another folded string; it is never
 * displayed.
 */

const TASHKEEL = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED]/g;
const TATWEEL = /\u0640/g;

/** Arabic-Indic and Eastern Arabic-Indic digits → ASCII, so `٠١٢` finds `012`. */
const ARABIC_DIGITS = /[\u0660-\u0669\u06F0-\u06F9]/g;

function foldArabicDigits(text: string): string {
  return text.replace(ARABIC_DIGITS, (digit) => {
    const code = digit.codePointAt(0) ?? 0;
    const base = code >= 0x06f0 ? 0x06f0 : 0x0660;
    return String(code - base);
  });
}

export function normalizeArabicText(value: string): string {
  return foldArabicDigits(
    value
      .normalize('NFKC')
      .replace(TASHKEEL, '')
      .replace(TATWEEL, '')
      .replace(/[\u0622\u0623\u0625\u0671]/g, '\u0627') // آ أ إ ٱ → ا
      .replace(/\u0629/g, '\u0647') // ة → ه
      .replace(/\u0649/g, '\u064a') // ى → ي
      .replace(/\u0624/g, '\u0648') // ؤ → و
      .replace(/\u0626/g, '\u064a'), // ئ → ي
  )
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Every whitespace-separated token must appear in the haystack, in any order:
 * searching «مواد حديد» finds «حديد وصلب — مواد» while `includes` alone would
 * not. Empty queries match everything, which is what an untouched picker shows.
 */
export function matchesSearch(query: string, haystack: string): boolean {
  const normalizedQuery = normalizeArabicText(query);
  if (normalizedQuery === '') {
    return true;
  }
  const normalizedHaystack = normalizeArabicText(haystack);
  return normalizedQuery.split(' ').every((token) => normalizedHaystack.includes(token));
}

export interface SearchableClassification {
  readonly code: string;
  readonly name: string;
}

/**
 * Filter by code **or** name. The code is part of the haystack so a user who
 * knows `CLS-014` does not have to read the list; codes are compared with their
 * separators intact, which is how they are minted.
 */
export function searchClassifications<T extends SearchableClassification>(
  entries: readonly T[],
  query: string,
): readonly T[] {
  const trimmed = query.trim();
  if (trimmed === '') {
    return entries;
  }
  const normalized = normalizeArabicText(trimmed);
  const tokens = normalized.split(' ');
  return entries.filter((entry) => {
    const haystack = normalizeArabicText(`${entry.code} ${entry.name}`);
    return tokens.every((token) => haystack.includes(token));
  });
}
