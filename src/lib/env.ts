/**
 * Central, validated access point for every Vite environment variable.
 * Vercel exposes repository/project environment variables to the build step,
 * so `import.meta.env` values are baked in at build time.
 */

export interface AppEnv {
  /** Product name displayed across the shell. */
  readonly appName: string;
  /** Public origin of the deployment (no trailing slash). */
  readonly appUrl: string;
  /** Supabase project URL. */
  readonly supabaseUrl: string;
  /** Supabase anon (public) API key. */
  readonly supabaseAnonKey: string;
  /** True when running `vite dev`. */
  readonly isDev: boolean;
  /** True when running a production build (`vite build` / `vite preview`). */
  readonly isProd: boolean;
  /** True when both Supabase variables are present and well formed. */
  readonly isSupabaseConfigured: boolean;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

const supabaseUrl = trimTrailingSlash(import.meta.env.VITE_SUPABASE_URL ?? '');
const supabaseAnonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY ?? '').trim();

const isSupabaseConfigured = supabaseUrl !== '' && supabaseAnonKey !== '' && isHttpUrl(supabaseUrl);

export const env: AppEnv = Object.freeze({
  appName: import.meta.env.VITE_APP_NAME?.trim() || 'نظام الإدارة',
  appUrl: trimTrailingSlash(
    import.meta.env.VITE_APP_URL?.trim() ||
      (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:5173'),
  ),
  supabaseUrl,
  supabaseAnonKey,
  isDev: import.meta.env.DEV,
  isProd: import.meta.env.PROD,
  isSupabaseConfigured,
});

/**
 * Fails fast with an actionable message instead of letting supabase-js
 * crash later with an opaque configuration error.
 */
export function assertSupabaseConfigured(): void {
  if (env.isSupabaseConfigured) {
    return;
  }

  throw new Error(
    [
      'Supabase is not configured. Set these environment variables and rebuild:',
      '  VITE_SUPABASE_URL=https://<project-ref>.supabase.co',
      '  VITE_SUPABASE_ANON_KEY=<anon key>',
      'Local: add them to .env.local (see .env.example).',
      'Vercel: Project Settings -> Environment Variables, then redeploy.',
    ].join('\n'),
  );
}
