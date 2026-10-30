import { useI18n } from '@/i18n/I18nContext';

export function useBranding() {
  const { locale } = useI18n();
  return { displayName: locale === 'ar' ? 'نظام الإدارة' : 'Admin System', logoUrl: null };
}
