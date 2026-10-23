import { env } from '@/lib/env';
import { getSupabase } from '@/lib/supabase';

/**
 * Shared identity/branding helpers (pure + storage I/O).
 *
 * The live row lives in `public.app_identity_settings`. Bytes live in the
 * public bucket `public-branding` under immutable `identity/{kind}/{uuid}.ext`
 * keys. This module never talks to React.
 */

export const BRANDING_BUCKET = 'public-branding';
export const IDENTITY_STORAGE_KEY = 'admin-system:identity';
export const APP_IDENTITY_QUERY_KEY = ['app-identity'] as const;
export const DEFAULT_FAVICON_HREF = '/favicon.svg';
export const DEFAULT_FAVICON_TYPE = 'image/svg+xml';
export const MAX_BRANDING_BYTES = 512 * 1024;
export const MAX_RASTER_EDGE = 2048;
export const IDENTITY_CHANNEL = 'app-identity-live';

export type IdentityAssetKind = 'logo' | 'favicon';

export interface AppIdentity {
  readonly nameAr: string;
  readonly nameEn: string;
  readonly adminEmail: string | null;
  readonly phone: string | null;
  readonly logoPath: string | null;
  readonly logoHash: string | null;
  readonly faviconPath: string | null;
  readonly faviconHash: string | null;
  readonly assetsRevision: number;
  readonly updatedAt: string;
  readonly updatedBy: string | null;
}

export interface IdentitySnapshot {
  readonly v: 1;
  readonly nameAr: string;
  readonly nameEn: string;
  readonly logoPath: string | null;
  readonly faviconPath: string | null;
  readonly logoUrl: string | null;
  readonly faviconUrl: string | null;
  readonly faviconType: string | null;
  readonly assetsRevision: number;
}

const LOGO_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']);
const FAVICON_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/svg+xml',
  'image/x-icon',
  'image/vnd.microsoft.icon',
]);
const MIME_TO_EXT: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
};
const EXT_TO_MIME: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNullableString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function asPositiveInt(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1) {
    return value;
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number.parseInt(value, 10);
    return parsed >= 1 ? parsed : fallback;
  }
  return fallback;
}

export function fallbackIdentity(): AppIdentity {
  const fromEnv = env.appName.trim();
  return {
    nameAr: fromEnv === '' ? 'نظام الإدارة' : fromEnv,
    nameEn: 'Admin System',
    adminEmail: null,
    phone: null,
    logoPath: null,
    logoHash: null,
    faviconPath: null,
    faviconHash: null,
    assetsRevision: 1,
    updatedAt: '1970-01-01T00:00:00.000Z',
    updatedBy: null,
  };
}

export function parseIdentity(value: unknown): AppIdentity | null {
  if (!isRecord(value)) {
    return null;
  }
  const nameAr = asString(value['name_ar'] ?? value['nameAr']).trim();
  const nameEn = asString(value['name_en'] ?? value['nameEn']).trim();
  if (nameAr.length < 2 || nameEn.length < 2) {
    return null;
  }
  return {
    nameAr,
    nameEn,
    adminEmail: asNullableString(value['admin_email'] ?? value['adminEmail']),
    phone: asNullableString(value['phone']),
    logoPath: asNullableString(value['logo_path'] ?? value['logoPath']),
    logoHash: asNullableString(value['logo_hash'] ?? value['logoHash']),
    faviconPath: asNullableString(value['favicon_path'] ?? value['faviconPath']),
    faviconHash: asNullableString(value['favicon_hash'] ?? value['faviconHash']),
    assetsRevision: asPositiveInt(value['assets_revision'] ?? value['assetsRevision'], 1),
    updatedAt: asString(value['updated_at'] ?? value['updatedAt'], '1970-01-01T00:00:00.000Z'),
    updatedBy: asNullableString(value['updated_by'] ?? value['updatedBy']),
  };
}

export function displayNameFor(identity: AppIdentity, locale: 'ar' | 'en'): string {
  return locale === 'en' ? identity.nameEn : identity.nameAr;
}

export function mimeFromPath(path: string | null): string | undefined {
  if (path === null) {
    return undefined;
  }
  const dot = path.lastIndexOf('.');
  if (dot < 0) {
    return undefined;
  }
  const ext = path.slice(dot + 1).toLowerCase();
  return EXT_TO_MIME[ext];
}

export function brandingPublicUrl(path: string | null): string | null {
  if (path === null || path === '') {
    return null;
  }
  const client = getSupabase();
  if (client === null) {
    return null;
  }
  const { data } = client.storage.from(BRANDING_BUCKET).getPublicUrl(path);
  const url = data.publicUrl.trim();
  return url === '' ? null : url;
}

export function isSafeHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function snapshotFrom(identity: AppIdentity): IdentitySnapshot {
  return {
    v: 1,
    nameAr: identity.nameAr,
    nameEn: identity.nameEn,
    logoPath: identity.logoPath,
    faviconPath: identity.faviconPath,
    logoUrl: brandingPublicUrl(identity.logoPath),
    faviconUrl: brandingPublicUrl(identity.faviconPath),
    faviconType: mimeFromPath(identity.faviconPath) ?? null,
    assetsRevision: identity.assetsRevision,
  };
}

export function readStoredSnapshot(): IdentitySnapshot | null {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(IDENTITY_STORAGE_KEY);
    if (raw === null) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed['v'] !== 1) {
      return null;
    }
    const nameAr = asString(parsed['nameAr']).trim();
    const nameEn = asString(parsed['nameEn']).trim();
    if (nameAr.length < 2 || nameEn.length < 2) {
      return null;
    }
    const logoUrl = asNullableString(parsed['logoUrl']);
    const faviconUrl = asNullableString(parsed['faviconUrl']);
    if (logoUrl !== null && !isSafeHttpsUrl(logoUrl)) {
      return null;
    }
    if (faviconUrl !== null && !isSafeHttpsUrl(faviconUrl)) {
      return null;
    }
    return {
      v: 1,
      nameAr,
      nameEn,
      logoPath: asNullableString(parsed['logoPath']),
      faviconPath: asNullableString(parsed['faviconPath']),
      logoUrl,
      faviconUrl,
      faviconType: asNullableString(parsed['faviconType']),
      assetsRevision: asPositiveInt(parsed['assetsRevision'], 1),
    };
  } catch {
    return null;
  }
}

export function writeStoredSnapshot(snapshot: IdentitySnapshot): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.localStorage.setItem(IDENTITY_STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // Storage blocked (private mode): in-memory identity still works.
  }
}

export function replaceFavicon(href: string, type?: string): void {
  if (typeof document === 'undefined') {
    return;
  }
  const head = document.head;
  for (const node of Array.from(head.querySelectorAll('link[rel~="icon"]'))) {
    node.remove();
  }
  const link = document.createElement('link');
  link.rel = 'icon';
  link.href = href;
  if (type !== undefined && type !== '') {
    link.type = type;
  }
  head.appendChild(link);
}

export function applyDocumentFavicon(identity: AppIdentity): void {
  if (typeof document === 'undefined') {
    return;
  }
  const faviconUrl = brandingPublicUrl(identity.faviconPath);
  if (faviconUrl === null) {
    replaceFavicon(DEFAULT_FAVICON_HREF, DEFAULT_FAVICON_TYPE);
    return;
  }
  replaceFavicon(faviconUrl, mimeFromPath(identity.faviconPath));
}

/** Boot/standalone helper. The routed app composes its title in DocumentTitle. */
export function applyDocumentIdentity(identity: AppIdentity, locale: 'ar' | 'en'): void {
  if (typeof document === 'undefined') {
    return;
  }
  document.title = displayNameFor(identity, locale);
  applyDocumentFavicon(identity);
}

function extensionFor(file: File): string {
  const fromMime = MIME_TO_EXT[file.type];
  if (fromMime !== undefined) {
    return fromMime;
  }
  const name = file.name.toLowerCase();
  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? name.slice(dot + 1) : '';
  if (ext === 'jpeg') {
    return 'jpg';
  }
  if (ext === 'png' || ext === 'jpg' || ext === 'webp' || ext === 'svg' || ext === 'ico') {
    return ext;
  }
  throw new BrandingFileError('unsupported-type');
}

export type BrandingFileIssue = 'unsupported-type' | 'file-too-large' | 'invalid-dimensions';

export class BrandingFileError extends Error {
  readonly code: BrandingFileIssue;
  constructor(code: BrandingFileIssue) {
    super(code);
    this.code = code;
    this.name = 'BrandingFileError';
  }
}

function readRasterSize(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: image.naturalWidth, height: image.naturalHeight });
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new BrandingFileError('unsupported-type'));
    };
    image.src = url;
  });
}

export async function validateBrandingFile(kind: IdentityAssetKind, file: File): Promise<void> {
  if (file.size <= 0 || file.size > MAX_BRANDING_BYTES) {
    throw new BrandingFileError('file-too-large');
  }
  const allowed = kind === 'logo' ? LOGO_MIME : FAVICON_MIME;
  let mime = file.type;
  if (mime === '' || mime === 'application/octet-stream') {
    const ext = extensionFor(file);
    mime = EXT_TO_MIME[ext] ?? '';
  }
  if (!allowed.has(mime)) {
    throw new BrandingFileError('unsupported-type');
  }
  // Touch the extension mapper so a spoofed MIME still has to resolve.
  extensionFor(file);
  if (mime === 'image/svg+xml' || mime === 'image/x-icon' || mime === 'image/vnd.microsoft.icon') {
    return;
  }
  const size = await readRasterSize(file);
  if (
    size.width < 16 ||
    size.height < 16 ||
    size.width > MAX_RASTER_EDGE ||
    size.height > MAX_RASTER_EDGE
  ) {
    throw new BrandingFileError('invalid-dimensions');
  }
  if (kind === 'favicon' && size.width !== size.height) {
    throw new BrandingFileError('invalid-dimensions');
  }
}

export async function hashFile(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function objectKeyFor(kind: IdentityAssetKind, file: File): string {
  const ext = extensionFor(file);
  return `identity/${kind}/${crypto.randomUUID()}.${ext}`;
}

export const IDENTITY_SELECT_COLUMNS =
  'id,name_ar,name_en,admin_email,phone,logo_path,logo_hash,favicon_path,favicon_hash,assets_revision,updated_at,updated_by';
