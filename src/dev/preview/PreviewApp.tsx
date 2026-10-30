import { useLayoutEffect } from 'react';
import ProjectSettings from '@/pages/settings/ProjectSettings';

/**
 * Mounts the real Project Settings screen and opens General → Annual settings
 * (or the issuer register with `?tab=issuers`) before the first paint. Only the
 * capability guard and Supabase transport are substituted (see
 * `vite.preview.config.ts` and `memorySupabase.ts`).
 */
export default function PreviewApp() {
  useLayoutEffect(() => {
    /* `?tab=issuers` opens the issuer register; the general tab stays the
       default so the existing review screenshots are unchanged. */
    const requested = new URLSearchParams(window.location.search).get('tab');
    const tab = requested === 'issuers' ? 'issuers' : 'general';
    document.getElementById(`project-settings-tab-${tab}`)?.click();
  }, []);

  return (
    <div className="mx-auto max-w-6xl space-y-4 px-4 py-5 sm:px-6 lg:px-8">
      <div
        role="status"
        className="border-primary/20 bg-primary/5 rounded-xl border px-4 py-3 text-sm leading-relaxed"
      >
        معاينة تفاعلية ببيانات تجريبية محلية؛ لا تتصل بـ Supabase ولا تُنشئ سجلات تدقيق حقيقية.
      </div>
      <ProjectSettings />
    </div>
  );
}
