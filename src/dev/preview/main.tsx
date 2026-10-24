import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import { CLASSIFICATIONS_QUERY_KEY } from '@/hooks/useClassifications';
import { STATIONS_DIRECTORY_QUERY_KEY } from '@/hooks/useStationsDirectory';
import { I18nProvider } from '@/i18n/I18nContext';
import PreviewApp from '@/dev/preview/PreviewApp';
import { CLASSIFICATIONS, STATIONS } from '@/dev/preview/previewData';
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
 * The primed cache is a QueryClient-level stub, not a component-level one: the
 * hooks still run their own selectors and tree building, and `staleTime` is
 * infinite so no request is attempted against an unconfigured client.
 *
 * Run with: `npm run preview:ui` (see `vite.preview.config.ts`).
 */

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: Infinity, retry: false, refetchOnWindowFocus: false },
  },
});

queryClient.setQueryData(CLASSIFICATIONS_QUERY_KEY, CLASSIFICATIONS);
queryClient.setQueryData(STATIONS_DIRECTORY_QUERY_KEY, STATIONS);

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
