import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { useI18n } from '@/i18n/I18nContext';
import {
  APP_IDENTITY_QUERY_KEY,
  IDENTITY_CHANNEL,
  IDENTITY_SELECT_COLUMNS,
  applyDocumentIdentity,
  brandingPublicUrl,
  displayNameFor,
  fallbackIdentity,
  parseIdentity,
  readStoredSnapshot,
  snapshotFrom,
  writeStoredSnapshot,
  type AppIdentity,
} from '@/lib/branding';
import { getSupabase } from '@/lib/supabase';

/**
 * Live application identity.
 *
 * * One TanStack Query entry (`['app-identity']`) is the source of truth for
 *   the login screen, the sidebar brand, document title and favicon.
 * * Supabase Realtime on `public.app_identity_settings` is an invalidation
 *   signal ONLY — events never patch client state.
 * * A public localStorage snapshot (`admin-system:identity`) lets the boot
 *   script in index.html apply title + favicon before first paint.
 */

export interface BrandingContextValue {
  readonly identity: AppIdentity;
  readonly displayName: string;
  readonly logoUrl: string | null;
  readonly faviconUrl: string | null;
  readonly isLoading: boolean;
  readonly refresh: () => void;
}

const BrandingContext = createContext<BrandingContextValue | null>(null);
BrandingContext.displayName = 'BrandingContext';

function identityFromSnapshot(): AppIdentity {
  const snapshot = readStoredSnapshot();
  const base = fallbackIdentity();
  if (snapshot === null) {
    return base;
  }
  return {
    ...base,
    nameAr: snapshot.nameAr,
    nameEn: snapshot.nameEn,
    logoPath: snapshot.logoPath,
    faviconPath: snapshot.faviconPath,
    assetsRevision: snapshot.assetsRevision,
  };
}

async function fetchIdentity(): Promise<AppIdentity> {
  const cached = identityFromSnapshot();
  const client = getSupabase();
  if (client === null) {
    return cached;
  }
  const { data, error } = await client
    .from('app_identity_settings')
    .select(IDENTITY_SELECT_COLUMNS)
    .eq('id', true)
    .maybeSingle();
  if (error !== null) {
    return cached;
  }
  const parsed = parseIdentity(data);
  if (parsed === null) {
    return cached;
  }
  writeStoredSnapshot(snapshotFrom(parsed));
  return parsed;
}

export interface BrandingProviderProps {
  children: ReactNode;
}

export function BrandingProvider({ children }: BrandingProviderProps) {
  const { locale } = useI18n();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: APP_IDENTITY_QUERY_KEY,
    queryFn: fetchIdentity,
    staleTime: 5 * 60 * 1000,
    retry: false,
    placeholderData: identityFromSnapshot,
  });

  const identity = query.data ?? identityFromSnapshot();

  useEffect(() => {
    const client = getSupabase();
    if (client === null) {
      return;
    }
    const channel = client
      .channel(IDENTITY_CHANNEL)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'app_identity_settings' },
        () => {
          void queryClient.invalidateQueries({ queryKey: APP_IDENTITY_QUERY_KEY });
        },
      )
      .subscribe();
    return () => {
      void client.removeChannel(channel);
    };
  }, [queryClient]);

  useEffect(() => {
    applyDocumentIdentity(identity, locale);
    writeStoredSnapshot(snapshotFrom(identity));
  }, [identity, locale]);

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: APP_IDENTITY_QUERY_KEY });
  }, [queryClient]);

  const value = useMemo<BrandingContextValue>(() => {
    return {
      identity,
      displayName: displayNameFor(identity, locale),
      logoUrl: brandingPublicUrl(identity.logoPath),
      faviconUrl: brandingPublicUrl(identity.faviconPath),
      isLoading: query.isLoading,
      refresh,
    };
  }, [identity, locale, query.isLoading, refresh]);

  return <BrandingContext.Provider value={value}>{children}</BrandingContext.Provider>;
}

export function useBranding(): BrandingContextValue {
  const context = useContext(BrandingContext);
  if (context === null) {
    throw new Error(
      'useBranding must be used inside a <BrandingProvider>. Wrap your app root first.',
    );
  }
  return context;
}
