import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PostgrestError } from '@supabase/supabase-js';
import { useAuth } from '@/context/AuthContext';
import { useBranding } from '@/context/BrandingContext';
import type { TranslationKey } from '@/i18n/I18nContext';
import {
  APP_IDENTITY_QUERY_KEY,
  BRANDING_BUCKET,
  BrandingFileError,
  hashFile,
  objectKeyFor,
  parseIdentity,
  snapshotFrom,
  validateBrandingFile,
  writeStoredSnapshot,
  type AppIdentity,
  type IdentityAssetKind,
} from '@/lib/branding';
import { getSupabase } from '@/lib/supabase';

export type AppIdentityErrorCode =
  | 'unavailable'
  | 'forbidden'
  | 'validation'
  | 'unsupported-type'
  | 'file-too-large'
  | 'invalid-dimensions'
  | 'invalid-asset'
  | 'version-conflict'
  | 'in-flight'
  | 'network'
  | 'unknown';

export const IDENTITY_ERROR_KEYS: Record<AppIdentityErrorCode, TranslationKey> = {
  unavailable: 'identity.error.unavailable',
  forbidden: 'identity.error.forbidden',
  validation: 'identity.error.validation',
  'unsupported-type': 'identity.error.unsupportedType',
  'file-too-large': 'identity.error.fileTooLarge',
  'invalid-dimensions': 'identity.error.invalidDimensions',
  'invalid-asset': 'identity.error.invalidAsset',
  'version-conflict': 'identity.error.versionConflict',
  'in-flight': 'identity.error.inFlight',
  network: 'identity.error.network',
  unknown: 'identity.error.unknown',
};

export class AppIdentityError extends Error {
  readonly code: AppIdentityErrorCode;
  constructor(code: AppIdentityErrorCode) {
    super(code);
    this.code = code;
    this.name = 'AppIdentityError';
  }
}

export interface SaveAppIdentityInput {
  readonly nameAr: string;
  readonly nameEn: string;
  readonly adminEmail: string;
  readonly phone: string;
  readonly logoFile: File | null;
  readonly faviconFile: File | null;
  readonly clearLogo: boolean;
  readonly clearFavicon: boolean;
  readonly expectedUpdatedAt: string | null;
}

export type SaveAppIdentityResult =
  | { readonly ok: true; readonly identity: AppIdentity }
  | { readonly ok: false; readonly code: AppIdentityErrorCode };

function toErrorCode(error: unknown): AppIdentityErrorCode {
  if (error instanceof AppIdentityError) {
    return error.code;
  }
  if (error instanceof BrandingFileError) {
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
  if (e.code === 'BRD01') {
    return 'invalid-asset';
  }
  if (e.code === 'BRD02') {
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
    throw new AppIdentityError('unavailable');
  }
  return client;
}

async function uploadBrandingAsset(
  kind: IdentityAssetKind,
  file: File,
): Promise<{ path: string; hash: string }> {
  await validateBrandingFile(kind, file);
  const hash = await hashFile(file);
  const client = clientOrThrow();
  const path = objectKeyFor(kind, file);
  const { error } = await client.storage.from(BRANDING_BUCKET).upload(path, file, {
    cacheControl: '31536000',
    upsert: false,
    contentType: file.type === '' ? undefined : file.type,
  });
  if (error !== null) {
    throw new AppIdentityError(toErrorCode(error));
  }
  return { path, hash };
}

export type AppIdentityAdminScope = 'general' | 'project';

export interface AppIdentityAdminApi {
  readonly identity: AppIdentity;
  readonly logoUrl: string | null;
  readonly faviconUrl: string | null;
  readonly displayName: string;
  readonly canManage: boolean | null;
  readonly isIdentityLoading: boolean;
  readonly isAccessLoading: boolean;
  readonly isSaving: boolean;
  readonly configured: boolean;
  readonly refresh: () => void;
  readonly save: (input: SaveAppIdentityInput) => Promise<SaveAppIdentityResult>;
}

export function useAppIdentityAdmin(scope: AppIdentityAdminScope = 'general'): AppIdentityAdminApi {
  const queryClient = useQueryClient();
  const { session, configured, loading: authLoading } = useAuth();
  const branding = useBranding();

  const accessQuery = useQuery({
    queryKey: ['app-identity-can-manage', scope, session?.user.id],
    enabled: Boolean(session?.user.id) && configured,
    retry: false,
    queryFn: async (): Promise<boolean> => {
      const response: { data: unknown; error: PostgrestError | null } = await clientOrThrow().rpc(
        scope === 'project' ? 'can_manage_project_settings' : 'can_manage_app_identity',
      );
      if (response.error !== null) {
        throw new AppIdentityError(toErrorCode(response.error));
      }
      return response.data === true;
    },
  });

  const saveMutation = useMutation({
    mutationFn: async (input: SaveAppIdentityInput): Promise<AppIdentity> => {
      let logoPath: string | null = null;
      let logoHash: string | null = null;
      let faviconPath: string | null = null;
      let faviconHash: string | null = null;
      if (input.logoFile !== null) {
        const uploaded = await uploadBrandingAsset('logo', input.logoFile);
        logoPath = uploaded.path;
        logoHash = uploaded.hash;
      }
      if (input.faviconFile !== null) {
        const uploaded = await uploadBrandingAsset('favicon', input.faviconFile);
        faviconPath = uploaded.path;
        faviconHash = uploaded.hash;
      }
      const expected =
        input.expectedUpdatedAt === null || input.expectedUpdatedAt.startsWith('1970-')
          ? null
          : input.expectedUpdatedAt;
      const response: { data: unknown; error: PostgrestError | null } = await clientOrThrow().rpc(
        scope === 'project' ? 'admin_update_project_settings' : 'admin_update_app_identity',
        {
          p_name_ar: input.nameAr,
          p_name_en: input.nameEn,
          p_admin_email: input.adminEmail.trim() === '' ? null : input.adminEmail.trim(),
          p_phone: input.phone.trim() === '' ? null : input.phone.trim(),
          p_logo_path: logoPath,
          p_logo_hash: logoHash,
          p_favicon_path: faviconPath,
          p_favicon_hash: faviconHash,
          p_clear_logo: input.clearLogo && input.logoFile === null,
          p_clear_favicon: input.clearFavicon && input.faviconFile === null,
          p_expected_updated_at: expected,
        },
      );
      if (response.error !== null) {
        throw new AppIdentityError(toErrorCode(response.error));
      }
      const parsed = parseIdentity(response.data);
      if (parsed === null) {
        throw new AppIdentityError('unknown');
      }
      writeStoredSnapshot(snapshotFrom(parsed));
      queryClient.setQueryData(APP_IDENTITY_QUERY_KEY, parsed);
      return parsed;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: APP_IDENTITY_QUERY_KEY });
    },
  });

  const save = async (input: SaveAppIdentityInput): Promise<SaveAppIdentityResult> => {
    try {
      const identity = await saveMutation.mutateAsync(input);
      return { ok: true, identity };
    } catch (caught) {
      return { ok: false, code: toErrorCode(caught) };
    }
  };

  const canManage: boolean | null = !configured
    ? false
    : authLoading || (Boolean(session?.user.id) && accessQuery.isLoading)
      ? null
      : (accessQuery.data ?? false);

  return {
    identity: branding.identity,
    logoUrl: branding.logoUrl,
    faviconUrl: branding.faviconUrl,
    displayName: branding.displayName,
    canManage,
    isIdentityLoading: branding.isLoading,
    isAccessLoading: authLoading || accessQuery.isLoading,
    isSaving: saveMutation.isPending,
    configured,
    refresh: branding.refresh,
    save,
  };
}
