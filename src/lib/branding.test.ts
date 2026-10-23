import { afterEach, describe, expect, it } from 'vitest';
import {
  IDENTITY_STORAGE_KEY,
  fallbackIdentity,
  isSafeHttpsUrl,
  parseIdentity,
  readStoredSnapshot,
  replaceFavicon,
  writeStoredSnapshot,
  type IdentitySnapshot,
} from '@/lib/branding';

describe('branding helpers', () => {
  afterEach(() => {
    window.localStorage.clear();
    document.head.querySelectorAll('link[rel~="icon"]').forEach((node) => node.remove());
  });

  it('parses a snake_case singleton row and rejects empty names', () => {
    const parsed = parseIdentity({
      name_ar: 'نظام الإدارة',
      name_en: 'Admin System',
      admin_email: 'support@example.com',
      phone: '+201000000000',
      logo_path: null,
      logo_hash: null,
      favicon_path: null,
      favicon_hash: null,
      assets_revision: 4,
      updated_at: '2026-10-01T00:00:00Z',
      updated_by: null,
    });
    expect(parsed?.nameAr).toBe('نظام الإدارة');
    expect(parsed?.assetsRevision).toBe(4);
    expect(parseIdentity({ name_ar: 'x', name_en: 'Admin System' })).toBeNull();
  });

  it('only persists https favicon URLs in the boot snapshot', () => {
    expect(
      isSafeHttpsUrl('https://example.supabase.co/storage/v1/object/public/public-branding/a.png'),
    ).toBe(true);
    expect(isSafeHttpsUrl('http://evil.example/x')).toBe(false);
    expect(isSafeHttpsUrl('javascript:alert(1)')).toBe(false);
  });

  it('round-trips the localStorage snapshot used by the boot script', () => {
    const snapshot: IdentitySnapshot = {
      v: 1,
      nameAr: 'نظام الإدارة',
      nameEn: 'Admin System',
      logoPath: null,
      faviconPath: 'identity/favicon/11111111-1111-4111-8111-111111111111.svg',
      logoUrl: null,
      faviconUrl: 'https://example.invalid/favicon.svg',
      faviconType: 'image/svg+xml',
      assetsRevision: 2,
    };
    writeStoredSnapshot(snapshot);
    expect(window.localStorage.getItem(IDENTITY_STORAGE_KEY)).toContain('Admin System');
    expect(readStoredSnapshot()).toEqual(snapshot);
  });

  it('rejects a poisoned snapshot whose favicon is not https', () => {
    window.localStorage.setItem(
      IDENTITY_STORAGE_KEY,
      JSON.stringify({
        v: 1,
        nameAr: 'نظام الإدارة',
        nameEn: 'Admin System',
        logoPath: null,
        faviconPath: null,
        logoUrl: null,
        faviconUrl: 'javascript:alert(1)',
        faviconType: null,
        assetsRevision: 1,
      }),
    );
    expect(readStoredSnapshot()).toBeNull();
  });

  it('replaces every icon link instead of mutating href in place', () => {
    const stale = document.createElement('link');
    stale.rel = 'icon';
    stale.href = '/favicon.svg';
    document.head.appendChild(stale);
    replaceFavicon('https://example.invalid/new-icon.png', 'image/png');
    const icons = document.head.querySelectorAll('link[rel~="icon"]');
    expect(icons).toHaveLength(1);
    expect(icons[0]?.getAttribute('href')).toContain('new-icon.png');
    expect(icons[0]?.getAttribute('type')).toBe('image/png');
    expect(stale.isConnected).toBe(false);
  });

  it('falls back to the baked-in product name', () => {
    expect(fallbackIdentity().nameAr.length).toBeGreaterThan(1);
    expect(fallbackIdentity().logoPath).toBeNull();
  });
});
