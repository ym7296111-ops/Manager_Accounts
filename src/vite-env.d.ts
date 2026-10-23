/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Supabase project URL, e.g. https://abcdefghijklmnop.supabase.co */
  readonly VITE_SUPABASE_URL: string;
  /** Supabase anon (public) API key */
  readonly VITE_SUPABASE_ANON_KEY: string;
  /** Human readable application name shown in the shell */
  readonly VITE_APP_NAME?: string;
  /** Public origin of the deployment, used in absolute links */
  readonly VITE_APP_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
