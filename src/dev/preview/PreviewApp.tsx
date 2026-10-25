import { useLayoutEffect } from 'react';
import ProjectSettings from '@/pages/settings/ProjectSettings';

/**
 * Mounts the real Project Settings screen and opens the parties tab before
 * the first paint. Only the capability guard and the query cache are
 * substituted (see `vite.preview.config.ts` and `main.tsx`).
 */
export default function PreviewApp() {
  useLayoutEffect(() => {
    document.getElementById('project-settings-tab-parties')?.click();
  }, []);

  return <ProjectSettings />;
}
