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
 *   2. `@/lib/supabase` → `src/dev/preview/memorySupabase.ts`, an in-memory
 *      stand-in that mints codes and derives `level`/`is_leaf` the way the
 *      database triggers do, so the write path is clickable end to end.
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
      /* Exact match first: the client. Without this the hooks would receive
         `null` and every panel would show its "not configured" state. */
      {
        find: /^@\/lib\/supabase$/,
        replacement: fileURLToPath(new URL('./src/dev/preview/memorySupabase.ts', import.meta.url)),
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
