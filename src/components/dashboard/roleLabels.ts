import type { RoleDistributionItem } from '@/hooks/useExecutiveDashboard';
import type { Locale, TranslationKey } from '@/i18n/I18nContext';

/**
 * Known system roles → dictionary keys.
 *
 * Custom roles fall back to the bilingual `name_ar` / `name_en` columns that
 * the RPC returns, so a role created after this build still renders correctly
 * instead of showing a raw slug.
 */
const ROLE_KEYS: Readonly<Record<string, TranslationKey>> = {
  owner: 'dashboard.role.owner',
  super_admin: 'dashboard.role.super_admin',
  admin: 'dashboard.role.admin',
  editor: 'dashboard.role.editor',
  viewer: 'dashboard.role.viewer',
  executive: 'dashboard.role.executive',
  no_role: 'dashboard.roles.no_role',
};

export function roleLabel(
  slug: string,
  fallback: { readonly nameAr: string; readonly nameEn: string },
  locale: Locale,
  t: (key: TranslationKey) => string,
): string {
  const key = ROLE_KEYS[slug];
  if (key !== undefined) {
    return t(key);
  }
  return locale === 'ar' ? fallback.nameAr : fallback.nameEn;
}

export function roleSlugLabel(
  slug: string,
  locale: Locale,
  t: (key: TranslationKey) => string,
): string {
  return roleLabel(slug, { nameAr: slug, nameEn: slug }, locale, t);
}

export type { RoleDistributionItem };
