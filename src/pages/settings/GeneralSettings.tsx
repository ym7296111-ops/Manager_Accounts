import {
  AlertCircle,
  Check,
  ImagePlus,
  Loader2,
  Lock,
  RefreshCw,
  ShieldAlert,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router';
import {
  IDENTITY_ERROR_KEYS,
  useAppIdentityAdmin,
  type AppIdentityErrorCode,
  type SaveAppIdentityInput,
} from '@/hooks/useAppIdentity';
import { useI18n } from '@/i18n/I18nContext';
import {
  BrandingFileError,
  MAX_BRANDING_BYTES,
  validateBrandingFile,
  type AppIdentity,
  type IdentityAssetKind,
} from '@/lib/branding';

/**
 * General & Branding Settings (renders inside SettingsPage for `general`).
 *
 * * Capability gate: without `settings.manage` or `*` the screen is a 403.
 * * ONE DOM tree serves both layouts through `@container` queries: form + live
 *   preview side by side on wide containers, stacked on narrow ones.
 * * Dropzones preview files as `blob:` URLs locally; Storage upload + the
 *   `admin_update_app_identity` RPC run together on confirm.
 */

const FIELD_CLASS =
  'w-full rounded-lg border border-input bg-background px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground outline-none transition-shadow focus:border-primary/60 focus:ring-2 focus:ring-primary/25';

const PRIMARY_BUTTON_CLASS =
  'inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold transition-opacity hover:opacity-90 aria-disabled:cursor-not-allowed aria-disabled:opacity-60 disabled:cursor-not-allowed disabled:opacity-60';

const ACCEPT_LOGO = 'image/png,image/jpeg,image/webp,image/svg+xml';
const ACCEPT_FAVICON = 'image/png,image/jpeg,image/webp,image/svg+xml,image/x-icon,.ico';

interface IdentityDraft {
  nameAr: string;
  nameEn: string;
  adminEmail: string;
  phone: string;
  logoFile: File | null;
  faviconFile: File | null;
  logoPreview: string | null;
  faviconPreview: string | null;
  clearLogo: boolean;
  clearFavicon: boolean;
}

function draftFrom(identity: AppIdentity): IdentityDraft {
  return {
    nameAr: identity.nameAr,
    nameEn: identity.nameEn,
    adminEmail: identity.adminEmail ?? '',
    phone: identity.phone ?? '',
    logoFile: null,
    faviconFile: null,
    logoPreview: null,
    faviconPreview: null,
    clearLogo: false,
    clearFavicon: false,
  };
}

function isDraftDirty(draft: IdentityDraft, identity: AppIdentity): boolean {
  return (
    draft.nameAr.trim() !== identity.nameAr ||
    draft.nameEn.trim() !== identity.nameEn ||
    draft.adminEmail.trim() !== (identity.adminEmail ?? '') ||
    draft.phone.trim() !== (identity.phone ?? '') ||
    draft.logoFile !== null ||
    draft.faviconFile !== null ||
    draft.clearLogo ||
    draft.clearFavicon
  );
}

function revokeIfBlob(url: string | null): void {
  if (url !== null && url.startsWith('blob:')) {
    URL.revokeObjectURL(url);
  }
}

function SkeletonScreen() {
  const { t } = useI18n();
  return (
    <div className="@container" aria-busy="true">
      <div role="status" className="sr-only">
        {t('identity.loading')}
      </div>
      <div className="grid grid-cols-1 gap-4 @3xl:grid-cols-[minmax(0,1fr)_minmax(18rem,22rem)]">
        <div className="border-border bg-card h-96 animate-pulse rounded-2xl border motion-reduce:animate-none" />
        <div className="border-border bg-card h-64 animate-pulse rounded-2xl border motion-reduce:animate-none" />
      </div>
    </div>
  );
}

interface ConfirmDialogProps {
  busy: boolean;
  error: string | null;
  summary: readonly string[];
  onConfirm: () => void;
  onCancel: () => void;
}

function ConfirmDialog({ busy, error, summary, onConfirm, onCancel }: ConfirmDialogProps) {
  const { t } = useI18n();
  const panelRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const bodyId = useId();

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelRef.current?.focus();
    return () => previous?.focus();
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (!busy) {
        onCancel();
      }
      return;
    }
    if (event.key !== 'Tab') {
      return;
    }
    const focusables = Array.from(
      panelRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    );
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (first === undefined || last === undefined) {
      return;
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div
      className="bg-foreground/50 fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) {
          onCancel();
        }
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        onKeyDown={handleKeyDown}
        className="bg-card text-card-foreground animate-scale-in border-border w-full max-w-md rounded-2xl border p-5 shadow-xl motion-reduce:animate-none"
      >
        <h2 id={titleId} className="text-card-foreground text-base font-semibold">
          {t('identity.confirm.title')}
        </h2>
        <p id={bodyId} className="text-muted-foreground mt-2 text-sm leading-relaxed">
          {t('identity.confirm.body')}
        </p>
        <ul className="mt-3 list-disc space-y-1 ps-5 text-sm">
          {summary.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        {error !== null && (
          <p role="alert" className="text-destructive mt-3 text-sm">
            {error}
          </p>
        )}
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            ref={cancelRef}
            type="button"
            disabled={busy}
            onClick={onCancel}
            className={`${PRIMARY_BUTTON_CLASS} border-border bg-background`}
          >
            {t('identity.confirm.cancel')}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className={`${PRIMARY_BUTTON_CLASS} bg-primary text-primary-foreground`}
          >
            {busy && (
              <Loader2
                className="size-4 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            )}
            {t('identity.confirm.save')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

interface DropzoneProps {
  kind: IdentityAssetKind;
  preview: string | null;
  liveUrl: string | null;
  cleared: boolean;
  disabled: boolean;
  describedBy: string;
  onFile: (file: File) => void;
  onClear: () => void;
  error: string | null;
}

function AssetDropzone({
  kind,
  preview,
  liveUrl,
  cleared,
  disabled,
  describedBy,
  onFile,
  onClear,
  error,
}: DropzoneProps) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const [dragOver, setDragOver] = useState(false);
  const shown = cleared ? null : (preview ?? liveUrl);
  const accept = kind === 'logo' ? ACCEPT_LOGO : ACCEPT_FAVICON;
  const label = kind === 'logo' ? t('identity.logo.label') : t('identity.favicon.label');
  const hint = kind === 'logo' ? t('identity.logo.hint') : t('identity.favicon.hint');

  const handleFiles = (list: FileList | null) => {
    const file = list?.[0];
    if (file) {
      onFile(file);
    }
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragOver(false);
    if (!disabled) {
      handleFiles(event.dataTransfer.files);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={inputId} className="text-sm font-medium">
          {label}
        </label>
        {(shown !== null || liveUrl !== null) && (
          <button
            type="button"
            disabled={disabled}
            onClick={onClear}
            className="text-muted-foreground hover:text-destructive inline-flex items-center gap-1 text-xs font-semibold"
          >
            <Trash2 className="size-3.5" aria-hidden="true" />
            {t('identity.asset.remove')}
          </button>
        )}
      </div>
      <div
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled}
        aria-describedby={describedBy}
        onClick={() => {
          if (!disabled) {
            inputRef.current?.click();
          }
        }}
        onKeyDown={(event) => {
          if (disabled) {
            return;
          }
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragOver={(event) => {
          event.preventDefault();
          if (!disabled) {
            setDragOver(true);
          }
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={[
          'border-input bg-muted/40 flex min-h-36 cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border border-dashed px-4 py-5 text-center transition-colors',
          dragOver ? 'border-primary bg-primary/5' : '',
          disabled ? 'cursor-not-allowed opacity-60' : 'hover:border-primary/50',
        ].join(' ')}
      >
        {shown !== null ? (
          <img
            src={shown}
            alt={label}
            className={
              kind === 'logo' ? 'max-h-24 max-w-full object-contain' : 'size-12 object-contain'
            }
          />
        ) : (
          <span className="bg-primary/10 text-primary grid size-12 place-items-center rounded-xl">
            <ImagePlus className="size-6" aria-hidden="true" />
          </span>
        )}
        <span className="text-muted-foreground flex items-center gap-2 text-xs">
          <Upload className="size-3.5" aria-hidden="true" />
          {t('identity.asset.drop')}
        </span>
        <span className="text-muted-foreground text-[11px]">{hint}</span>
      </div>
      <input
        ref={inputRef}
        id={inputId}
        type="file"
        accept={accept}
        className="sr-only"
        disabled={disabled}
        onChange={(event: ChangeEvent<HTMLInputElement>) => {
          handleFiles(event.target.files);
          event.target.value = '';
        }}
      />
      {error !== null && (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}
    </div>
  );
}

export default function GeneralSettings() {
  const { t, locale } = useI18n();
  const admin = useAppIdentityAdmin();
  const { identity } = admin;
  const [draft, setDraft] = useState<IdentityDraft>(() => draftFrom(identity));
  const [baselineStamp, setBaselineStamp] = useState(identity.updatedAt);
  const [logoError, setLogoError] = useState<string | null>(null);
  const [faviconError, setFaviconError] = useState<string | null>(null);
  const [formError, setFormError] = useState<AppIdentityErrorCode | null>(null);
  const [success, setSuccess] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const liveId = useId();
  const logoHintId = useId();
  const faviconHintId = useId();
  const nameArId = useId();
  const nameEnId = useId();
  const emailId = useId();
  const phoneId = useId();

  if (identity.updatedAt !== baselineStamp && !isDraftDirty(draft, identity)) {
    setDraft(draftFrom(identity));
    setBaselineStamp(identity.updatedAt);
  }

  useEffect(() => {
    return () => {
      revokeIfBlob(draft.logoPreview);
      revokeIfBlob(draft.faviconPreview);
    };
    // Revoke the previews that existed when this effect was created; the
    // latest blobs are revoked explicitly on replace/clear/reset.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dirty = isDraftDirty(draft, identity);

  useEffect(() => {
    if (!dirty) {
      return;
    }
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [dirty]);

  const applyFile = useCallback(
    async (kind: IdentityAssetKind, file: File) => {
      const setErr = kind === 'logo' ? setLogoError : setFaviconError;
      setErr(null);
      try {
        await validateBrandingFile(kind, file);
      } catch (caught) {
        const code =
          caught instanceof BrandingFileError ? caught.code : ('unknown' as AppIdentityErrorCode);
        setErr(t(IDENTITY_ERROR_KEYS[code]));
        return;
      }
      const preview = URL.createObjectURL(file);
      setDraft((current) => {
        if (kind === 'logo') {
          revokeIfBlob(current.logoPreview);
          return { ...current, logoFile: file, logoPreview: preview, clearLogo: false };
        }
        revokeIfBlob(current.faviconPreview);
        return { ...current, faviconFile: file, faviconPreview: preview, clearFavicon: false };
      });
    },
    [t],
  );

  const clearAsset = useCallback((kind: IdentityAssetKind) => {
    setDraft((current) => {
      if (kind === 'logo') {
        revokeIfBlob(current.logoPreview);
        return { ...current, logoFile: null, logoPreview: null, clearLogo: true };
      }
      revokeIfBlob(current.faviconPreview);
      return { ...current, faviconFile: null, faviconPreview: null, clearFavicon: true };
    });
    if (kind === 'logo') {
      setLogoError(null);
    } else {
      setFaviconError(null);
    }
  }, []);

  const resetDraft = useCallback(() => {
    setDraft((current) => {
      revokeIfBlob(current.logoPreview);
      revokeIfBlob(current.faviconPreview);
      return draftFrom(identity);
    });
    setLogoError(null);
    setFaviconError(null);
    setFormError(null);
    setSuccess(false);
    setBaselineStamp(identity.updatedAt);
  }, [identity]);

  const summary = useMemo(() => {
    const items: string[] = [];
    if (draft.nameAr.trim() !== identity.nameAr || draft.nameEn.trim() !== identity.nameEn) {
      items.push(t('identity.diff.names'));
    }
    if (draft.adminEmail.trim() !== (identity.adminEmail ?? '')) {
      items.push(t('identity.diff.email'));
    }
    if (draft.phone.trim() !== (identity.phone ?? '')) {
      items.push(t('identity.diff.phone'));
    }
    if (draft.logoFile !== null) {
      items.push(t('identity.diff.logoReplace'));
    } else if (draft.clearLogo) {
      items.push(t('identity.diff.logoClear'));
    }
    if (draft.faviconFile !== null) {
      items.push(t('identity.diff.faviconReplace'));
    } else if (draft.clearFavicon) {
      items.push(t('identity.diff.faviconClear'));
    }
    return items;
  }, [draft, identity, t]);

  const handleSave = async () => {
    setFormError(null);
    setSuccess(false);
    const payload: SaveAppIdentityInput = {
      nameAr: draft.nameAr,
      nameEn: draft.nameEn,
      adminEmail: draft.adminEmail,
      phone: draft.phone,
      logoFile: draft.logoFile,
      faviconFile: draft.faviconFile,
      clearLogo: draft.clearLogo,
      clearFavicon: draft.clearFavicon,
      expectedUpdatedAt: identity.updatedAt,
    };
    const result = await admin.save(payload);
    if (!result.ok) {
      setFormError(result.code);
      return;
    }
    setDraft((current) => {
      revokeIfBlob(current.logoPreview);
      revokeIfBlob(current.faviconPreview);
      return draftFrom(result.identity);
    });
    setBaselineStamp(result.identity.updatedAt);
    setConfirmOpen(false);
    setSuccess(true);
  };

  const previewLogo = draft.clearLogo ? null : (draft.logoPreview ?? admin.logoUrl);
  const previewFavicon = draft.clearFavicon ? null : (draft.faviconPreview ?? admin.faviconUrl);
  const previewName =
    locale === 'en'
      ? draft.nameEn.trim() || identity.nameEn
      : draft.nameAr.trim() || identity.nameAr;

  let content: ReactNode;
  if (admin.isAccessLoading || admin.canManage === null) {
    content = <SkeletonScreen />;
  } else if (!admin.configured) {
    content = (
      <div className="@container">
        <div className="bg-card flex flex-col items-center gap-4 rounded-2xl border border-dashed px-6 py-14 text-center">
          <AlertCircle className="text-warning size-8" aria-hidden="true" />
          <h2 className="text-base font-semibold">{t('identity.error.title')}</h2>
          <p className="text-muted-foreground max-w-md text-sm">
            {t('identity.error.unavailable')}
          </p>
        </div>
      </div>
    );
  } else if (!admin.canManage) {
    content = (
      <div className="@container">
        <section className="border-destructive/30 bg-card mx-auto max-w-xl rounded-2xl border p-8 text-center">
          <ShieldAlert className="text-destructive mx-auto size-10" aria-hidden="true" />
          <p className="text-destructive mt-3 text-xs font-bold">{t('identity.denied.code')}</p>
          <h2 className="mt-1 text-xl font-bold">{t('identity.denied.title')}</h2>
          <p className="text-muted-foreground mt-2 text-sm">{t('identity.denied.body')}</p>
          <Link
            to="/"
            className={`${PRIMARY_BUTTON_CLASS} bg-primary text-primary-foreground mt-5`}
          >
            {t('identity.denied.back')}
          </Link>
        </section>
      </div>
    );
  } else {
    content = (
      <div className="@container space-y-4" aria-busy={admin.isSaving}>
        <div className="border-border bg-card/95 sticky top-0 z-10 flex flex-col gap-3 rounded-2xl border p-4 shadow-sm @3xl:flex-row @3xl:items-center @3xl:justify-between">
          <p className="text-muted-foreground text-sm">
            {dirty ? t('identity.dirty', { count: summary.length }) : t('identity.clean')}
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={!dirty || admin.isSaving}
              onClick={resetDraft}
              className={`${PRIMARY_BUTTON_CLASS} border-border bg-background`}
            >
              <X className="size-4" aria-hidden="true" />
              {t('identity.reset')}
            </button>
            <button
              type="button"
              disabled={!dirty || admin.isSaving}
              onClick={() => {
                setFormError(null);
                setConfirmOpen(true);
              }}
              className={`${PRIMARY_BUTTON_CLASS} bg-primary text-primary-foreground`}
            >
              {t('identity.save')}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 @3xl:grid-cols-[minmax(0,1fr)_minmax(18rem,22rem)] @3xl:items-start">
          <form
            className="border-border bg-card space-y-6 rounded-2xl border p-5 shadow-sm sm:p-6"
            onSubmit={(event) => {
              event.preventDefault();
              if (dirty && !admin.isSaving) {
                setConfirmOpen(true);
              }
            }}
          >
            <fieldset className="space-y-4">
              <legend className="text-base font-semibold">{t('identity.section.names')}</legend>
              <div>
                <label htmlFor={nameArId} className="mb-1.5 block text-sm font-medium">
                  {t('identity.field.nameAr')}
                </label>
                <input
                  id={nameArId}
                  dir="rtl"
                  value={draft.nameAr}
                  maxLength={80}
                  required
                  className={FIELD_CLASS}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, nameAr: event.target.value }))
                  }
                />
              </div>
              <div>
                <label htmlFor={nameEnId} className="mb-1.5 block text-sm font-medium">
                  {t('identity.field.nameEn')}
                </label>
                <input
                  id={nameEnId}
                  dir="ltr"
                  value={draft.nameEn}
                  maxLength={80}
                  required
                  className={FIELD_CLASS}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, nameEn: event.target.value }))
                  }
                />
              </div>
            </fieldset>

            <fieldset className="space-y-4">
              <legend className="text-base font-semibold">{t('identity.section.contact')}</legend>
              <div>
                <label htmlFor={emailId} className="mb-1.5 block text-sm font-medium">
                  {t('identity.field.email')}
                </label>
                <input
                  id={emailId}
                  type="email"
                  dir="ltr"
                  value={draft.adminEmail}
                  placeholder="support@example.com"
                  className={FIELD_CLASS}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, adminEmail: event.target.value }))
                  }
                />
              </div>
              <div>
                <label htmlFor={phoneId} className="mb-1.5 block text-sm font-medium">
                  {t('identity.field.phone')}
                </label>
                <input
                  id={phoneId}
                  type="tel"
                  dir="ltr"
                  value={draft.phone}
                  placeholder="+201000000000"
                  className={FIELD_CLASS}
                  aria-describedby={`${phoneId}-hint`}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, phone: event.target.value }))
                  }
                />
                <p id={`${phoneId}-hint`} className="text-muted-foreground mt-1 text-xs">
                  {t('identity.field.phoneHint')}
                </p>
              </div>
            </fieldset>

            <fieldset className="space-y-4">
              <legend className="text-base font-semibold">{t('identity.section.assets')}</legend>
              <p id={logoHintId} className="sr-only">
                {t('identity.logo.hint')}
              </p>
              <p id={faviconHintId} className="sr-only">
                {t('identity.favicon.hint')}
              </p>
              <div className="grid grid-cols-1 gap-4 @md:grid-cols-2">
                <AssetDropzone
                  kind="logo"
                  preview={draft.logoPreview}
                  liveUrl={draft.clearLogo ? null : admin.logoUrl}
                  cleared={draft.clearLogo}
                  disabled={admin.isSaving}
                  describedBy={logoHintId}
                  error={logoError}
                  onFile={(file) => {
                    void applyFile('logo', file);
                  }}
                  onClear={() => clearAsset('logo')}
                />
                <AssetDropzone
                  kind="favicon"
                  preview={draft.faviconPreview}
                  liveUrl={draft.clearFavicon ? null : admin.faviconUrl}
                  cleared={draft.clearFavicon}
                  disabled={admin.isSaving}
                  describedBy={faviconHintId}
                  error={faviconError}
                  onFile={(file) => {
                    void applyFile('favicon', file);
                  }}
                  onClear={() => clearAsset('favicon')}
                />
              </div>
              <p className="text-muted-foreground text-xs">
                {t('identity.asset.limit', { size: Math.round(MAX_BRANDING_BYTES / 1024) })}
              </p>
            </fieldset>
          </form>

          <aside className="border-border bg-card space-y-4 rounded-2xl border p-5 shadow-sm @3xl:sticky @3xl:top-24">
            <h2 className="text-sm font-semibold">{t('identity.preview.title')}</h2>
            <div className="border-sidebar-border bg-sidebar rounded-xl border p-3">
              <p className="text-muted-foreground mb-2 text-[11px] font-semibold tracking-wide uppercase">
                {t('identity.preview.sidebar')}
              </p>
              <div className="flex items-center gap-3">
                {previewLogo !== null ? (
                  <img src={previewLogo} alt="" className="size-9 rounded-lg object-contain" />
                ) : (
                  <span className="bg-sidebar-primary text-sidebar-primary-foreground grid size-9 place-items-center rounded-lg">
                    <Lock className="size-4" aria-hidden="true" />
                  </span>
                )}
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">{previewName}</p>
                  <p className="text-muted-foreground truncate text-[11px]">{t('app.tagline')}</p>
                </div>
              </div>
            </div>
            <div className="from-primary/90 rounded-xl bg-gradient-to-br to-slate-900 p-4 text-white">
              <p className="mb-3 text-[11px] font-semibold tracking-wide uppercase opacity-80">
                {t('identity.preview.login')}
              </p>
              <div className="flex items-center gap-3">
                {previewLogo !== null ? (
                  <img
                    src={previewLogo}
                    alt=""
                    className="size-10 rounded-lg bg-white/10 object-contain p-1"
                  />
                ) : null}
                <p className="text-lg font-bold">{previewName}</p>
              </div>
              <div className="mt-4 flex items-center gap-2 text-xs opacity-80">
                {previewFavicon !== null ? (
                  <img src={previewFavicon} alt="" className="size-4 object-contain" />
                ) : (
                  <span className="size-4 rounded-sm bg-white/30" />
                )}
                {t('identity.preview.favicon')}
              </div>
            </div>
          </aside>
        </div>

        <div id={liveId} className="sr-only" aria-live="polite">
          {success ? t('identity.success.saved') : ''}
        </div>
        {success && (
          <p role="status" className="text-success flex items-center gap-2 text-sm font-medium">
            <Check className="size-4" aria-hidden="true" />
            {t('identity.success.saved')}
          </p>
        )}
        {formError !== null && !confirmOpen && (
          <p role="alert" className="text-destructive flex items-center gap-2 text-sm">
            <AlertCircle className="size-4" aria-hidden="true" />
            {t(IDENTITY_ERROR_KEYS[formError])}
            <button
              type="button"
              onClick={() => admin.refresh()}
              className="text-foreground inline-flex items-center gap-1 text-xs font-semibold"
            >
              <RefreshCw className="size-3.5" aria-hidden="true" />
              {t('identity.retry')}
            </button>
          </p>
        )}
      </div>
    );
  }

  return (
    <>
      {content}
      {confirmOpen && (
        <ConfirmDialog
          busy={admin.isSaving}
          error={formError === null ? null : t(IDENTITY_ERROR_KEYS[formError])}
          summary={summary}
          onCancel={() => {
            if (!admin.isSaving) {
              setConfirmOpen(false);
            }
          }}
          onConfirm={() => {
            void handleSave();
          }}
        />
      )}
    </>
  );
}
