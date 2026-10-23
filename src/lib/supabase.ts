import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from './env';

/**
 * Lazily created, process-wide Supabase client.
 *
 * Returns `null` when the environment is not configured yet so callers can
 * degrade gracefully (banner + explicit error) instead of crashing the app.
 * `auth` state is persisted under a namespaced storage key to avoid clashes
 * when several apps share one origin (e.g. Vercel preview deployments).
 */
let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient | null {
  if (!env.isSupabaseConfigured) {
    return null;
  }

  if (client === null) {
    client = createClient(env.supabaseUrl, env.supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storageKey: 'admin-system:auth',
        flowType: 'pkce',
      },
    });
  }

  return client;
}
