import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '@/i18n/I18nContext';
import PreviewApp from '@/dev/preview/PreviewApp';
import '@/dev/preview/preview.css';

/**
 * Local review harness for the Project Settings screen.
 *
 * It mounts the REAL `ProjectSettings` screen (same tabs, fiscal panels,
 * directory trees and hooks) and replaces only the capability guard and
 * Supabase transport with preview-only stand-ins.
 *
 * The hooks run unmodified: `@/lib/supabase` is aliased to
 * `memorySupabase.ts` (see `vite.preview.config.ts`), an in-memory client that
 * mirrors the fiscal-year/month trigger behavior and opening-balance upsert
 * shape alongside the existing directory triggers. Authentication, RLS and
 * the real audit trigger are not simulated here; the live database remains
 * authoritative.
 *
 * Run with: `npm run preview:ui` (see `vite.preview.config.ts`).
 */

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 0, retry: false, refetchOnWindowFocus: false },
  },
});

const container = document.getElementById('root');

if (container !== null) {
  createRoot(container).render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <PreviewApp />
      </I18nProvider>
    </QueryClientProvider>,
  );
}
