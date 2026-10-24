import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '@/i18n/I18nContext';
import PreviewApp from '@/dev/preview/PreviewApp';
import '@/dev/preview/preview.css';

/**
 * Local review harness for the Project Settings screen.
 *
 * It mounts the REAL `ProjectSettings` screen (same tabs, same panel, same
 * `Classifications` tree and hook) and only replaces the two things this
 * sandbox cannot provide: a session behind the capability guard
 * (`RequireCapabilityPassthrough`) and a database (the react-query cache is
 * primed instead).
 *
 * The hooks run unmodified: `@/lib/supabase` is aliased to
 * `memorySupabase.ts` (see `vite.preview.config.ts`), an in-memory client that
 * mints codes and derives `level`/`is_leaf` like the database triggers do. That
 * makes create / rename / toggle / delete clickable here, including the
 * refusal to delete a node that still has children.
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
