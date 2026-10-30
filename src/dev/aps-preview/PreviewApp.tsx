import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Link, Navigate, Route, Routes } from 'react-router';
import { RequireCapability } from '@/components/auth/RequireCapability';
import { ThemeProvider } from '@/context/ThemeContext';
import { I18nProvider, useI18n } from '@/i18n/I18nContext';
import DashboardLayout from '@/layouts/DashboardLayout';
import { APS_LETTERS_READ_REQUIREMENT } from '@/lib/apsLetters';
import ApsLetterDetailPage from '@/pages/workspaces/ApsLetterDetailPage';
import ApsLettersPage from '@/pages/workspaces/ApsLettersPage';
import ApsWorkspaceLayout from '@/pages/workspaces/ApsWorkspaceLayout';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

function ReviewBanner() {
  const { locale, dir } = useI18n();
  const ar = locale === 'ar';
  const current = new URLSearchParams(window.location.search).get('scenario') ?? 'normal';
  return (
    <div
      dir={dir}
      className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 bg-amber-100 px-4 py-2 text-xs leading-relaxed text-amber-950"
    >
      <strong>
        {ar
          ? 'معاينة للمراجعة ببيانات خيالية — لا تتصل بـ Supabase ولا تختبر RLS.'
          : 'Review preview with fictional data — no Supabase connection or RLS testing.'}
      </strong>
      <label className="flex items-center gap-2">
        {ar ? 'الحالة:' : 'Scenario:'}
        <select
          value={current}
          onChange={(event) => {
            const url = new URL(window.location.href);
            if (event.target.value === 'normal') url.searchParams.delete('scenario');
            else url.searchParams.set('scenario', event.target.value);
            window.location.assign(url.toString());
          }}
          className="rounded-md border border-amber-300 bg-white px-2 py-1 text-xs"
        >
          <option value="normal">{ar ? 'بيانات تجريبية' : 'Sample letters'}</option>
          <option value="empty">{ar ? 'لا توجد خطابات' : 'Empty list'}</option>
          <option value="forbidden">403</option>
          <option value="network">{ar ? 'خطأ اتصال' : 'Network error'}</option>
          <option value="restricted">
            {ar ? 'الدليل محجوب، والأسماء محفوظة' : 'Directory denied; snapshots visible'}
          </option>
        </select>
      </label>
    </div>
  );
}

function PreviewFallback() {
  const { locale } = useI18n();
  const ar = locale === 'ar';
  return (
    <section className="border-border bg-card mx-auto max-w-xl rounded-2xl border p-8 text-center">
      <h1 className="text-foreground text-lg font-bold">
        {ar
          ? 'هذه المعاينة مخصصة لاستعراض خطابات APS فقط'
          : 'This preview only covers APS letter browsing'}
      </h1>
      <Link
        to="/workspaces/aps/letters"
        className="text-primary mt-5 inline-flex min-h-11 items-center text-sm font-semibold"
      >
        {ar ? 'العودة إلى استعراض الخطابات' : 'Back to letter browsing'}
      </Link>
    </section>
  );
}

export default function PreviewApp() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider defaultTheme="light">
        <I18nProvider defaultLocale="ar">
          <BrowserRouter>
            <ReviewBanner />
            <Routes>
              <Route path="/" element={<DashboardLayout />}>
                <Route index element={<Navigate to="/workspaces/aps/letters" replace />} />
                <Route path="workspaces/aps" element={<ApsWorkspaceLayout />}>
                  <Route index element={<Navigate to="letters" replace />} />
                  <Route
                    path="letters"
                    element={
                      <RequireCapability requirement={APS_LETTERS_READ_REQUIREMENT}>
                        <ApsLettersPage />
                      </RequireCapability>
                    }
                  />
                  <Route
                    path="letters/:letterId"
                    element={
                      <RequireCapability requirement={APS_LETTERS_READ_REQUIREMENT}>
                        <ApsLetterDetailPage />
                      </RequireCapability>
                    }
                  />
                </Route>
                <Route path="*" element={<PreviewFallback />} />
              </Route>
            </Routes>
          </BrowserRouter>
        </I18nProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
