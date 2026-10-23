import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from 'react';
import {
  APPEARANCE_GROUP,
  LOCALIZATION_CHANNEL,
  LOCALIZATION_QUERY_KEY,
  LOCALIZATION_SELECT_COLUMNS,
  LOCALIZATION_STORAGE_KEY,
  parseLocalizationRows,
  settingsFromStoredSnapshot,
  snapshotFrom,
  writeStoredSnapshot,
  type LocalizationSettings,
} from '@/lib/localization';
import { getSupabase } from '@/lib/supabase';

/**
 * Localization defaults provider (screen 6's "multi-tenant theme" backbone).
 *
 * * One TanStack Query entry (`['localization-settings']`) is the source of
 *   truth for the system-wide defaults (locale, direction, theme, timezone,
 *   weekend profile). Anonymous visitors may read them — the login screen
 *   resolves defaults before authentication.
 * * Supabase Realtime on `public.app_settings` is an invalidation signal
 *   ONLY — events never patch client state; the refetch goes through RLS.
 * * A versioned localStorage snapshot (`admin-system:localization`) is kept
 *   fresh after every fetch/save so the boot script in index.html can apply
 *   the correct language, direction and theme before first paint (zero flash).
 * * Cross-tab resync is immediate: the `storage` event invalidates the cache
 *   the moment another tab writes a newer snapshot.
 *
 * The provider feeds defaults down into ThemeProvider / I18nProvider through
 * props; those two remain the single writers of `<html lang dir>` and the
 * painted color mode.
 */

export interface LocalizationContextValue {
  readonly settings: LocalizationSettings;
  readonly isLoading: boolean;
  readonly refresh: () => void;
}

const LocalizationContext = createContext<LocalizationContextValue | null>(null);
LocalizationContext.displayName = 'LocalizationContext';

async function fetchLocalizationSettings(): Promise<LocalizationSettings> {
  const cached = settingsFromStoredSnapshot();
  const client = getSupabase();
  if (client === null) {
    return cached;
  }

  const { data, error } = await client
    .from('app_settings')
    .select(LOCALIZATION_SELECT_COLUMNS)
    .eq('group_slug', APPEARANCE_GROUP);
  if (error !== null) {
    return cached;
  }

  const parsed = parseLocalizationRows(data);
  if (parsed === null) {
    return cached;
  }
  writeStoredSnapshot(snapshotFrom(parsed));
  return parsed;
}

export interface LocalizationProviderProps {
  children: ReactNode;
}

export function LocalizationProvider({ children }: LocalizationProviderProps) {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: LOCALIZATION_QUERY_KEY,
    queryFn: fetchLocalizationSettings,
    staleTime: 5 * 60 * 1000,
    retry: false,
    placeholderData: settingsFromStoredSnapshot,
  });

  const settings = query.data ?? settingsFromStoredSnapshot();

  /* Realtime is an invalidation signal only — never a state patcher. */
  useEffect(() => {
    const client = getSupabase();
    if (client === null) {
      return;
    }
    const channel = client
      .channel(LOCALIZATION_CHANNEL)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'app_settings',
          filter: `group_slug=eq.${APPEARANCE_GROUP}`,
        },
        () => {
          void queryClient.invalidateQueries({ queryKey: LOCALIZATION_QUERY_KEY });
        },
      )
      .subscribe();
    return () => {
      void client.removeChannel(channel);
    };
  }, [queryClient]);

  /* Immediate cross-tab resync when another tab stores a newer snapshot. */
  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== LOCALIZATION_STORAGE_KEY) {
        return;
      }
      void queryClient.invalidateQueries({ queryKey: LOCALIZATION_QUERY_KEY });
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, [queryClient]);

  /* Keep the boot snapshot fresh so the next cold start paints correctly. */
  useEffect(() => {
    writeStoredSnapshot(snapshotFrom(settings));
  }, [settings]);

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: LOCALIZATION_QUERY_KEY });
  }, [queryClient]);

  const value = useMemo<LocalizationContextValue>(
    () => ({ settings, isLoading: query.isLoading, refresh }),
    [settings, query.isLoading, refresh],
  );

  return <LocalizationContext.Provider value={value}>{children}</LocalizationContext.Provider>;
}

/**
 * Read the system-wide localization defaults.
 * Throws outside of {@link LocalizationProvider} so a missing provider is
 * caught immediately instead of silently falling back to build defaults.
 */
export function useLocalization(): LocalizationContextValue {
  const context = useContext(LocalizationContext);
  if (context === null) {
    throw new Error(
      'useLocalization must be used inside a <LocalizationProvider>. Wrap your app root first.',
    );
  }
  return context;
}
