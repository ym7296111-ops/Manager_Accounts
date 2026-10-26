import { useLayoutEffect } from 'react';
import ProjectSettings from '@/pages/settings/ProjectSettings';

/**
 * Mounts the real Project Settings screen and opens General → Annual settings
 * before the first paint. Only the capability guard and Supabase transport are
 * substituted (see `vite.preview.config.ts` and `memorySupabase.ts`).
 */
export default function PreviewApp() {
  useLayoutEffect(() => {
    document.getElementById('project-settings-tab-general')?.click();
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
