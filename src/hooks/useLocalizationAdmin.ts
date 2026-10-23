import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PostgrestError } from '@supabase/supabase-js';
import { useAuth } from '@/context/AuthContext';
import { useLocalization } from '@/context/LocalizationProvider';
import type { TranslationKey } from '@/i18n/I18nContext';
import {
  DIRECTION_FOR_LOCALE,
  LOCALIZATION_QUERY_KEY,
  SETTING_KEY,
  normalizeWeekendDays,
  parseLocalizationResponse,
  snapshotFrom,
  writeStoredSnapshot,
  type DefaultTheme,
  type LocalizationSettings,
  type SupportedLocale,
} from '@/lib/localization';
import { getSupabase } from '@/lib/supabase';

/**
 * Admin-side adapter for the Localization & Multi-Theme screen (6 of 7).
 *
 * * `canManage` is resolved through the `can_manage_appearance()` helper
 *   (`*` or `settings.manage` on an active profile).
 * * Saving goes through the single audited RPC
 *   `admin_update_appearance_settings`; the response snapshot updates the
 *   shared cache and the localStorage boot snapshot BEFORE Realtime arrives.
 * * Error codes are normalized to printable, locale-independent values.
 */

export type LocalizationErrorCode =
  | 'unavailable'
  | 'forbidden'
  | 'validation'
  | 'version-conflict'
  | 'in-flight'
  | 'network'
  | 'unknown';

export const LOCALIZATION_ERROR_KEYS: Record<LocalizationErrorCode, TranslationKey> = {
  unavailable: 'appearance.error.unavailable',
  forbidden: 'appearance.error.forbidden',
  validation: 'appearance.error.validation',
  'version-conflict': 'appearance.error.versionConflict',
  'in-flight': 'appearance.error.inFlight',
  network: 'appearance.error.network',
  unknown: 'appearance.error.unknown',
};

export class LocalizationError extends Error {
  readonly code: LocalizationErrorCode;
  constructor(code: LocalizationErrorCode) {
    super(code);
    this.code = code;
    this.name = 'LocalizationError';
  }
}

export interface SaveLocalizationInput {
  readonly defaultLocale: SupportedLocale;
  readonly defaultTheme: DefaultTheme;
  readonly timezone: string;
  readonly weekendDays: readonly number[];
  readonly expectedUpdatedAt: string | null;
}

export type SaveLocalizationResult =
  | { readonly ok: true; readonly settings: LocalizationSettings }
  | { readonly ok: false; readonly code: LocalizationErrorCode };

export function toLocalizationErrorCode(error: unknown): LocalizationErrorCode {
  if (error instanceof LocalizationError) {
    return error.code;
  }
  const e = error as Partial<PostgrestError> & { status?: number; message?: string };
  const message = (e.message ?? '').toLowerCase();
  if (e.code === '42501') {
    return 'forbidden';
  }
  if (e.code === '22023') {
    return 'validation';
  }
  if (e.code === 'LOC02') {
    return 'version-conflict';
  }
  if (e.code === 'P0002' || e.code === 'PGRST116' || e.status === 404) {
    return 'unavailable';
  }
  if (e.status === 429) {
    return 'in-flight';
  }
  if (error instanceof TypeError || message.includes('fetch') || message.includes('network')) {
    return 'network';
  }
  return 'unknown';
}

function clientOrThrow() {
  const client = getSupabase();
  if (client === null) {
    throw new LocalizationError('unavailable');
  }
  return client;
}

export interface LocalizationAdminApi {
  readonly settings: LocalizationSettings;
  readonly canManage: boolean | null;
  readonly isAccessLoading: boolean;
  readonly isSaving: boolean;
  readonly configured: boolean;
  readonly refresh: () => void;
  readonly save: (input: SaveLocalizationInput) => Promise<SaveLocalizationResult>;
}

export function useLocalizationAdmin(): LocalizationAdminApi {
  const queryClient = useQueryClient();
  const { session, configured, loading: authLoading } = useAuth();
  const { settings, refresh } = useLocalization();

  const accessQuery = useQuery({
    queryKey: ['appearance-can-manage', session?.user.id],
    enabled: Boolean(session?.user.id) && configured,
    retry: false,
    queryFn: async (): Promise<boolean> => {
      const response: { data: unknown; error: PostgrestError | null } =
        await clientOrThrow().rpc('can_manage_appearance');
      if (response.error !== null) {
        throw new LocalizationError(toLocalizationErrorCode(response.error));
      }
      return response.data === true;
    },
  });

  const saveMutation = useMutation({
    mutationFn: async (input: SaveLocalizationInput): Promise<LocalizationSettings> => {
      const expected =
        input.expectedUpdatedAt === null || input.expectedUpdatedAt.startsWith('1970-')
          ? null
          : input.expectedUpdatedAt;
      const response: { data: unknown; error: PostgrestError | null } = await clientOrThrow().rpc(
        'admin_update_appearance_settings',
        {
          p_settings: {
            [SETTING_KEY.defaultLocale]: input.defaultLocale,
            [SETTING_KEY.defaultDirection]: DIRECTION_FOR_LOCALE[input.defaultLocale],
            [SETTING_KEY.defaultTheme]: input.defaultTheme,
            [SETTING_KEY.defaultTimezone]: input.timezone.trim(),
            [SETTING_KEY.weekendDays]: normalizeWeekendDays(input.weekendDays),
          },
          p_expected_updated_at: expected,
        },
      );
      if (response.error !== null) {
        throw new LocalizationError(toLocalizationErrorCode(response.error));
      }
      const parsed = parseLocalizationResponse(response.data);
      if (parsed === null) {
        throw new LocalizationError('unknown');
      }
      writeStoredSnapshot(snapshotFrom(parsed));
      queryClient.setQueryData(LOCALIZATION_QUERY_KEY, parsed);
      return parsed;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: LOCALIZATION_QUERY_KEY });
    },
  });

  const save = async (input: SaveLocalizationInput): Promise<SaveLocalizationResult> => {
    try {
      const next = await saveMutation.mutateAsync(input);
      return { ok: true, settings: next };
    } catch (caught) {
      return { ok: false, code: toLocalizationErrorCode(caught) };
    }
  };

  const canManage: boolean | null = !configured
    ? false
    : authLoading || (Boolean(session?.user.id) && accessQuery.isLoading)
      ? null
      : (accessQuery.data ?? false);

  return {
    settings,
    canManage,
    isAccessLoading: authLoading || accessQuery.isLoading,
    isSaving: saveMutation.isPending,
    configured,
    refresh,
    save,
  };
}
