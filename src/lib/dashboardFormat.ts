import type { Locale } from '@/i18n/I18nContext';

/**
 * Formatting helpers for the executive dashboard.
 *
 * The dashboard is bilingual, and the numbers it renders come from the
 * database unchanged (counts, percentages, timestamps). Centralising the
 * Intl plumbing keeps every card, chart label and activity row consistent.
 *
 * Numerals: Arabic locale uses the `-u-nu-latn` extension on purpose. An
 * administrative console mixes Latin identifiers (slugs, UTC, e-mail masks)
 * with Arabic prose; Latin digits keep that mix readable and match the digits
 * already used by the rest of the shell. The choice is documented in the
 * README's Executive Dashboard section.
 */

/** BCP-47 locale used for dashboard numbers (Latin digits in both languages). */
export function dashboardNumberLocale(locale: Locale): string {
  return locale === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB';
}

/** Locale used for relative timestamps and dates. */
function dashboardDateTimeLocale(locale: Locale): string {
  return locale === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB';
}

/** Group-separated integer, e.g. `1,204`. */
export function formatDashboardNumber(value: number, locale: Locale): string {
  if (!Number.isFinite(value)) {
    return '—';
  }
  return new Intl.NumberFormat(dashboardNumberLocale(locale)).format(value);
}

/** Percentage with at most one decimal place, without the `%` sign. */
export function formatDashboardPercent(part: number, whole: number, locale: Locale): string {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) {
    return formatDashboardNumber(0, locale);
  }
  const formatter = new Intl.NumberFormat(dashboardNumberLocale(locale), {
    maximumFractionDigits: 1,
  });
  return formatter.format((part / whole) * 100);
}

/**
 * Localised `date + time` for the `title` attribute of a relative time.
 *
 * `timeZone` is the PROJECT time zone the RPC echoes in its response: the
 * instant is rendered in the project's frame, so the numbers and the times
 * on screen always agree no matter where the viewer's browser sits. An
 * unknown zone name (a corrupt setting the RPC already fell back from, or
 * an older cached payload) degrades to the browser zone instead of throwing.
 */
export function formatDashboardDateTime(value: string, locale: Locale, timeZone?: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '—';
  }
  const base: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' };
  try {
    return new Intl.DateTimeFormat(dashboardDateTimeLocale(locale), {
      ...base,
      ...(timeZone ? { timeZone } : {}),
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat(dashboardDateTimeLocale(locale), base).format(date);
  }
}

/**
 * Human relative time (`5 minutes ago` / `قبل 5 دقائق`).
 *
 * `now` is injectable so tests never depend on the wall clock. `timeZone`
 * only affects the absolute fallback used past 30 days.
 */
export function formatDashboardRelative(
  value: string,
  locale: Locale,
  now = Date.now(),
  timeZone?: string,
): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '—';
  }

  const formatter = new Intl.RelativeTimeFormat(dashboardDateTimeLocale(locale), {
    numeric: 'auto',
  });
  const seconds = Math.round((date.getTime() - now) / 1000);
  const absolute = Math.abs(seconds);

  if (absolute < 60) {
    return formatter.format(0, 'second');
  }
  if (absolute < 3_600) {
    return formatter.format(Math.round(seconds / 60), 'minute');
  }
  if (absolute < 86_400) {
    return formatter.format(Math.round(seconds / 3_600), 'hour');
  }
  if (absolute < 2_592_000) {
    return formatter.format(Math.round(seconds / 86_400), 'day');
  }
  return formatDashboardDateTime(value, locale, timeZone);
}

/**
 * `YYYY-MM-DD` (as returned by the RPC for one project-timezone calendar
 * bucket) → short localised label. Parsed as a plain calendar date, never as
 * a local-time instant, so the bucket label cannot drift one day in a
 * negative-offset browser time zone.
 */
export function formatDashboardDay(day: string, locale: Locale): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (match === null) {
    return day;
  }
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return new Intl.DateTimeFormat(dashboardDateTimeLocale(locale), {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(date);
}
