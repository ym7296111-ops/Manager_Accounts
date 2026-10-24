import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';

/**
 * Review-only Vite config for `src/dev/preview`.
 *
 * Purpose: render the real Project Settings screen — including the real
 * Classifications tree — in a browser that has no Supabase project behind it.
 * Two substitutions, nothing else:
 *
 *   1. `@/components/auth/RequireAuth` → a pass-through `RequireCapability`
 *      (there is no session to derive capabilities from in a preview).
 *   2. The react-query cache is primed in `src/dev/preview/main.tsx`.
 *
 * This config is never used by `npm run build`, which still builds `index.html`
 * with `vite.config.ts`. Run it with `npm run preview:ui`.
 */
export default defineConfig({
  root: fileURLToPath(new URL('./src/dev/preview', import.meta.url)),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      /* Exact match first: the module that needs replacing. */
      {
        find: /^@\/components\/auth\/RequireAuth$/,
        replacement: fileURLToPath(
          new URL('./src/dev/preview/RequireCapabilityPassthrough.tsx', import.meta.url),
        ),
      },
      { find: '@', replacement: fileURLToPath(new URL('./src', import.meta.url)) },
    ],
  },
  server: {
    host: '0.0.0.0',
    port: 4173,
    strictPort: true,
    /* The sandbox serves the dev server through a proxied preview host. */
    allowedHosts: true,
  },
});
