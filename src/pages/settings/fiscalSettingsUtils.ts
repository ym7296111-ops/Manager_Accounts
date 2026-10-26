import type { ClassificationNode } from '@/hooks/useClassifications';
import type { Locale } from '@/i18n/I18nContext';

export interface FlatClassification {
  readonly node: ClassificationNode;
  readonly depth: number;
  readonly path: readonly string[];
}

export function flattenClassifications(
  nodes: readonly ClassificationNode[],
  ancestors: readonly string[] = [],
): readonly FlatClassification[] {
  return nodes.flatMap((node) => {
    const path = [...ancestors, node.name];
    return [
      { node, depth: ancestors.length, path },
      ...flattenClassifications(node.children, path),
    ];
  });
}

export function deriveFiscalYearName(startDate: string, endDate: string): string {
  return `${startDate.slice(0, 4)}-${endDate.slice(0, 4)}`;
}

export function formatFiscalDate(value: string, locale: Locale): string {
  const date = new Date(`${value}T12:00:00.000Z`);
  if (!Number.isFinite(date.valueOf())) {
    return value;
  }
  return new Intl.DateTimeFormat(locale === 'ar' ? 'ar-EG' : 'en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

export function formatFiscalMonthName(value: string, locale: Locale): string {
  const date = new Date(`${value}T12:00:00.000Z`);
  if (!Number.isFinite(date.valueOf())) {
    return value;
  }
  return new Intl.DateTimeFormat(locale === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

export function normalizeAmountText(value: string): string | null {
  const trimmed = value.trim();
  if (!/^\d{1,16}(?:\.\d{0,2})?$/.test(trimmed)) {
    return null;
  }
  const [wholePart = '', fractionPart = ''] = trimmed.split('.');
  const whole = BigInt(wholePart);
  if (whole > 9_999_999_999_999_999n) {
    return null;
  }
  return `${whole.toString()}.${fractionPart.padEnd(2, '0')}`;
}

export function amountToCents(value: string | number): bigint | null {
  const normalized = normalizeAmountText(String(value));
  if (normalized === null) {
    return null;
  }
  const [whole = '0', fraction = '00'] = normalized.split('.');
  return BigInt(whole) * 100n + BigInt(fraction);
}

export function formatCents(cents: bigint, locale: Locale): string {
  const localeName = locale === 'ar' ? 'ar-EG' : 'en-GB';
  const whole = cents / 100n;
  const fraction = (cents % 100n).toString().padStart(2, '0');
  const integerFormatter = new Intl.NumberFormat(localeName, {
    maximumFractionDigits: 0,
    useGrouping: true,
  });
  const digitFormatter = new Intl.NumberFormat(localeName, {
    maximumFractionDigits: 0,
    useGrouping: false,
  });
  const decimalSeparator =
    new Intl.NumberFormat(localeName, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
      .formatToParts(1.1)
      .find((part) => part.type === 'decimal')?.value ?? '.';
  const digitMap = Array.from({ length: 10 }, (_, digit) => digitFormatter.format(digit));
  const localizedFraction = fraction.replace(/\d/g, (digit) => digitMap[Number(digit)] ?? digit);
  return `${integerFormatter.format(whole)}${decimalSeparator}${localizedFraction}`;
}

export function formatAmount(value: string | number, locale: Locale): string {
  const cents = amountToCents(value);
  return cents === null ? formatCents(0n, locale) : formatCents(cents, locale);
}
