import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';

/** Review-only harness: real APS screens/hooks with synthetic in-memory data. */
export default defineConfig({
  root: fileURLToPath(new URL('./src/dev/aps-preview', import.meta.url)),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      {
        find: /^@\/lib\/supabase$/,
        replacement: fileURLToPath(
          new URL('./src/dev/aps-preview/memorySupabase.ts', import.meta.url),
        ),
      },
      {
        find: /^@\/context\/AuthContext$/,
        replacement: fileURLToPath(
          new URL('./src/dev/aps-preview/previewAuth.tsx', import.meta.url),
        ),
      },
      {
        find: /^@\/hooks\/useAuthCapabilities$/,
        replacement: fileURLToPath(
          new URL('./src/dev/aps-preview/previewCapabilities.tsx', import.meta.url),
        ),
      },
      {
        find: /^@\/context\/BrandingContext$/,
        replacement: fileURLToPath(
          new URL('./src/dev/aps-preview/previewBranding.ts', import.meta.url),
        ),
      },
      {
        find: /^@\/components\/layout\/NotificationsProvider$/,
        replacement: fileURLToPath(
          new URL('./src/dev/aps-preview/previewNotifications.tsx', import.meta.url),
        ),
      },
      {
        find: /^@\/components\/layout\/NotificationBell$/,
        replacement: fileURLToPath(
          new URL('./src/dev/aps-preview/previewNotifications.tsx', import.meta.url),
        ),
      },
      { find: '@', replacement: fileURLToPath(new URL('./src', import.meta.url)) },
    ],
  },
  server: {
    host: '0.0.0.0',
    port: 4174,
    strictPort: true,
    allowedHosts: true,
  },
});
