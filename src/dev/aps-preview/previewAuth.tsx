import { useI18n } from '@/i18n/I18nContext';

/** Synthetic identity only for the review harness; no production authentication. */
export function useAuth() {
  const { locale } = useI18n();
  return {
    session: {
      user: {
        id: '00000000-0000-4000-8000-000000000001',
        email: 'review@example.invalid',
        user_metadata: { full_name: locale === 'ar' ? 'مستخدم تجريبي' : 'Review User' },
      },
    },
    approvalStatus: 'approved',
    loading: false,
    configured: true,
    signOut: () => Promise.resolve({ error: null }),
  };
}
