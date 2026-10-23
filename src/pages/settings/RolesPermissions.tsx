import {
  AlertCircle,
  Check,
  KeyRound,
  Loader2,
  Lock,
  RefreshCw,
  ShieldAlert,
  Users,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router';
import { EmptyState } from '@/components/ui/EmptyState';
import { useAuthCapabilities, WILDCARD_CAPABILITY } from '@/hooks/useAuthCapabilities';
import {
  PERMISSION_CATALOG_ERROR_KEYS,
  PermissionCatalogError,
  isProtectedPermissionSlug,
  usePermissionCatalog,
  type PermissionCatalogEntry,
  type PermissionCatalogErrorCode,
} from '@/hooks/usePermissionCatalog';
import {
  ROLES_BLOCKER_KEYS,
  ROLES_ERROR_KEYS,
  ROLES_PROTECTED_KEYS,
  useRolesManagement,
  type GroupToggleState,
  type ManagedRole,
  type PermissionGroup,
  type PermissionItem,
  type ProtectedReason,
  type RolesManagementErrorCode,
  type SaveRolePermissionsResult,
} from '@/hooks/useRolesManagement';
import { useI18n, type TranslationKey } from '@/i18n/I18nContext';

/**
 * Roles & Permissions screen (renders inside SettingsPage for section `roles`).
 *
 * * Capability gate: without the `super_admin` grant the screen shows a clean
 *   translated 403 panel (Access Denied) instead of a misleading matrix.
 * * ONE DOM tree serves both layouts through container queries: a master-detail
 *   split (roles column + permission grid) on wide containers that stacks into
 *   flexible cards on narrow ones — independent of the viewport, because the
 *   sidebar collapse changes the content width.
 * * Permissions are grouped by their `module` into `fieldset`/`legend` sets;
 *   the group master checkbox drives the NATIVE `indeterminate` property and
 *   bulk clearing skips protected leaves one by one (jointly load-bearing
 *   pairs can never be cleared together).
 * * Lockout guards: critical checkboxes (Self-Demotion Guard and the
 *   `super_admin`-keeps-`*` invariant) stay visible but `aria-disabled`, with
 *   the reason linked via `aria-describedby`. The database refuses the same
 *   violations again if a stale UI ever reaches the RPC.
 * * Bulk saves go through an accessible confirmation dialog (portal, focus
 *   trap, Escape, least-destructive action focused first) summarizing the
 *   exact diff before it is written and audited.
 * * The delegation section below the matrix is the owner's policy surface
 *   for `permissions.is_delegatable`: immediate RPC toggles (no draft),
 *   protected permissions shown as badges, refetch after every write.
 */

/* ----------------------------------------------------------------- consts */

const MODULE_KEYS: Readonly<Record<string, TranslationKey>> = {
  system: 'roles.module.system',
  dashboard: 'roles.module.dashboard',
  workspace: 'roles.module.workspace',
  app: 'roles.module.app',
};

const ACTION_BUTTON_CLASS =
  'inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-opacity hover:opacity-90 aria-disabled:cursor-not-allowed aria-disabled:opacity-60';

const PRIMARY_BUTTON_CLASS =
  'inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold transition-opacity hover:opacity-90 aria-disabled:cursor-not-allowed aria-disabled:opacity-60';

/** Failures worth offering a retry for (never for permission classes). */
const RETRYABLE_CODES: ReadonlySet<RolesManagementErrorCode> = new Set([
  'network',
  'unknown',
  'rate-limited',
]);

const SKELETON_GROUPS = 3;
const SKELETON_ROWS = 4;

/* -------------------------------------------------------------- helpers */

function useDateTimeFormatter(): (value: string | number) => string {
  const { locale } = useI18n();
  const formatter = useMemo(
    () =>
      new Intl.DateTimeFormat(locale === 'ar' ? 'ar-EG' : 'en-GB', {
        dateStyle: 'medium',
        timeStyle: 'short',
      }),
    [locale],
  );
  return useCallback(
    (value: string | number) => {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? '—' : formatter.format(date);
    },
    [formatter],
  );
}

function useModuleLabel(): (module: string) => string {
  const { t } = useI18n();
  return useCallback(
    (module: string) => {
      const key = MODULE_KEYS[module];
      return key !== undefined ? t(key) : module;
    },
    [t],
  );
}

/* --------------------------------------------------------------- pieces */

function RoleBadges({ role }: { role: ManagedRole }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {role.heldByActor && (
        <span className="bg-primary/10 text-primary border-primary/30 inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium">
          {t('roles.role.you')}
        </span>
      )}
      {role.isSystem && (
        <span className="border-border bg-muted text-muted-foreground inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium">
          {t('roles.role.systemBadge')}
        </span>
      )}
    </div>
  );
}

interface PermissionRowProps {
  permission: PermissionItem;
  selected: boolean;
  reason: ProtectedReason | null;
  busy: boolean;
  onToggle: (permission: PermissionItem) => void;
  onBlockedAttempt: (reason: ProtectedReason) => void;
}

/**
 * One permission checkbox. Protected leaves stay focusable and explained
 * (`aria-disabled` + `aria-describedby`) instead of being silently `disabled`
 * and disappearing from the tab order.
 */
function PermissionRow({
  permission,
  selected,
  reason,
  busy,
  onToggle,
  onBlockedAttempt,
}: PermissionRowProps) {
  const { t, locale } = useI18n();
  const inputId = useId();
  const descId = useId();
  const reasonId = useId();
  const inert = reason !== null || busy;
  const name = locale === 'ar' ? permission.nameAr : permission.nameEn;

  const describedBy =
    [permission.description !== null ? descId : null, reason !== null ? reasonId : null]
      .filter((id): id is string => id !== null)
      .join(' ') || undefined;

  return (
    <div className="flex items-start gap-2.5">
      <input
        id={inputId}
        type="checkbox"
        checked={selected}
        aria-disabled={inert ? true : undefined}
        aria-describedby={describedBy}
        onClick={(event) => {
          if (inert) {
            /* Prevent the native toggle entirely — the state never moves. */
            event.preventDefault();
            if (reason !== null) {
              onBlockedAttempt(reason);
            }
          }
        }}
        onChange={() => {
          if (inert) {
            return;
          }
          onToggle(permission);
        }}
        className={`mt-0.5 size-4 shrink-0 rounded ${inert ? 'opacity-60' : 'accent-primary cursor-pointer'}`}
      />
      <div className="min-w-0 flex-1">
        <label
          htmlFor={inputId}
          className={`text-foreground block text-sm font-medium ${inert ? 'cursor-not-allowed opacity-80' : 'cursor-pointer'}`}
        >
          <bdi dir="auto">{name}</bdi>
          <bdi dir="ltr" className="text-muted-foreground ms-1.5 text-xs font-normal">
            {permission.slug}
          </bdi>
        </label>
        {permission.description !== null && (
          <p id={descId} className="text-muted-foreground mt-0.5 text-xs leading-relaxed">
            {permission.description}
          </p>
        )}
        {reason !== null && (
          <p
            id={reasonId}
            className="text-warning mt-1 flex items-start gap-1.5 text-xs leading-relaxed"
          >
            <ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <span>
              {t(ROLES_PROTECTED_KEYS[reason])}{' '}
              <span className="sr-only">{t('roles.item.protectedLabel')}</span>
            </span>
          </p>
        )}
      </div>
    </div>
  );
}

interface GroupFieldsetProps {
  group: PermissionGroup;
  state: GroupToggleState;
  selectedIds: ReadonlySet<string>;
  protectedReasons: ReadonlyMap<string, ProtectedReason>;
  busy: boolean;
  onToggleGroup: (checked: boolean) => void;
  onTogglePermission: (permission: PermissionItem) => void;
  onBlockedAttempt: (reason: ProtectedReason | null) => void;
}

/** One logical group: `fieldset` + `legend` + master checkbox + leaves. */
function GroupFieldset({
  group,
  state,
  selectedIds,
  protectedReasons,
  busy,
  onToggleGroup,
  onTogglePermission,
  onBlockedAttempt,
}: GroupFieldsetProps) {
  const { t } = useI18n();
  const moduleLabel = useModuleLabel();
  const masterRef = useRef<HTMLInputElement>(null);

  /* Native indeterminate: a DOM property, not an attribute. */
  useEffect(() => {
    if (masterRef.current !== null) {
      masterRef.current.indeterminate = state === 'some';
    }
  }, [state]);

  const label = moduleLabel(group.module);
  const selectedCount = group.permissions.filter((permission) =>
    selectedIds.has(permission.id),
  ).length;

  return (
    <fieldset className="border-border bg-card rounded-2xl border px-4 pt-2 pb-4">
      <legend className="text-foreground px-1 text-sm font-semibold">{label}</legend>

      <div className="border-border flex flex-wrap items-center justify-between gap-2 border-b pb-3">
        <label className="flex cursor-pointer items-center gap-2.5">
          <input
            ref={masterRef}
            type="checkbox"
            checked={state === 'all'}
            aria-disabled={busy ? true : undefined}
            onChange={(event) => {
              if (busy) {
                return;
              }
              onToggleGroup(event.target.checked);
            }}
            className="accent-primary size-4 shrink-0 cursor-pointer rounded"
          />
          <span className="text-foreground text-sm font-medium">
            {t('roles.group.selectAll', { group: label })}
          </span>
        </label>
        <p className="text-muted-foreground text-xs tabular-nums">
          {t('roles.group.summary', { selected: selectedCount, total: group.permissions.length })}
        </p>
      </div>

      <div className="mt-3 space-y-3">
        {group.permissions.map((permission) => (
          <PermissionRow
            key={permission.id}
            permission={permission}
            selected={selectedIds.has(permission.id)}
            reason={protectedReasons.get(permission.id) ?? null}
            busy={busy}
            onToggle={onTogglePermission}
            onBlockedAttempt={onBlockedAttempt}
          />
        ))}
      </div>
    </fieldset>
  );
}

interface DialogShellProps {
  title: string;
  body: ReactNode;
  error: RolesManagementErrorCode | null;
  busy: boolean;
  confirmLabel: string;
  cancelLabel: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Accessible confirmation dialog: portal + focus trap + Escape. */
function DialogShell({
  title,
  body,
  error,
  busy,
  confirmLabel,
  cancelLabel,
  destructive = false,
  onConfirm,
  onCancel,
}: DialogShellProps) {
  const { t } = useI18n();
  const panelRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const bodyId = useId();
  const errorId = useId();

  /* Focus the least destructive action first; restore the trigger on close. */
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
        'button:not([aria-disabled="true"]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
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
          {title}
        </h2>
        <div id={bodyId} className="text-muted-foreground mt-2 space-y-2 text-sm leading-relaxed">
          {body}
        </div>

        {error !== null && (
          <div
            id={errorId}
            role="alert"
            className="border-destructive/40 bg-destructive/10 text-destructive mt-4 flex items-center gap-2.5 rounded-xl border px-4 py-3 text-sm"
          >
            <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
            <span>{t(ROLES_ERROR_KEYS[error])}</span>
          </div>
        )}

        <div className="mt-5 flex flex-col-reverse gap-2.5 sm:flex-row sm:justify-end">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            aria-disabled={busy}
            className="border-border bg-background text-foreground hover:bg-accent inline-flex items-center justify-center gap-2 rounded-lg border px-4 py-2.5 text-sm font-semibold transition-colors aria-disabled:cursor-not-allowed aria-disabled:opacity-60"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            aria-disabled={busy}
            className={`${PRIMARY_BUTTON_CLASS} ${
              destructive
                ? 'bg-destructive text-destructive-foreground'
                : 'bg-primary text-primary-foreground'
            }`}
          >
            {busy && (
              <Loader2
                className="size-4 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            )}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function SkeletonScreen() {
  const { t } = useI18n();
  return (
    <div className="@container" aria-busy="true">
      <div role="status" className="sr-only">
        {t('roles.loading')}
      </div>
      <div className="grid grid-cols-1 gap-4 @4xl:grid-cols-[minmax(0,15rem)_minmax(0,1fr)] @4xl:items-start">
        {/* Roles column geometry */}
        <div className="flex flex-col gap-2">
          {Array.from({ length: 4 }, (_, index) => (
            <div
              key={index}
              className="border-border bg-card h-16 animate-pulse rounded-xl border motion-reduce:animate-none"
            />
          ))}
        </div>
        {/* Matrix geometry — same wrappers as the real groups */}
        <div className="space-y-4">
          {Array.from({ length: SKELETON_GROUPS }, (_, groupIndex) => (
            <div
              key={groupIndex}
              className="border-border bg-card space-y-3 rounded-2xl border p-4"
            >
              <div className="bg-muted h-4 w-32 animate-pulse rounded motion-reduce:animate-none" />
              {Array.from({ length: SKELETON_ROWS }, (_, rowIndex) => (
                <div key={rowIndex} className="flex items-center gap-2.5">
                  <div className="bg-muted size-4 animate-pulse rounded motion-reduce:animate-none" />
                  <div
                    className="bg-muted h-3.5 animate-pulse rounded motion-reduce:animate-none"
                    style={{ width: `${55 + ((rowIndex * 13) % 35)}%` }}
                  />
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Owner-configured delegation policy: which catalogue permissions may be
 * granted to an individual user (Manage delegations). Every toggle writes
 * through `admin_set_permission_delegatable` (owner/super_admin, audited)
 * and then refetches — the server always wins. Protected permissions
 * (`*`, `roles.manage`) can never be delegatable (database trigger), so
 * they render an explained badge instead of a toggle.
 */
function DelegatablePermissionsSection() {
  const { t, locale } = useI18n();
  const moduleLabel = useModuleLabel();
  const { permissions, isLoading, error, refresh, setDelegatable } = usePermissionCatalog();
  const [pendingSlug, setPendingSlug] = useState<string | null>(null);
  const [opError, setOpError] = useState<PermissionCatalogErrorCode | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const headingId = useId();

  const displayName = useCallback(
    (entry: PermissionCatalogEntry) => (locale === 'ar' ? entry.nameAr : entry.nameEn),
    [locale],
  );

  const handleToggle = useCallback(
    async (entry: PermissionCatalogEntry) => {
      const next = !entry.isDelegatable;
      setOpError(null);
      setAnnouncement('');
      setPendingSlug(entry.slug);
      try {
        await setDelegatable(entry.slug, next);
        setAnnouncement(
          t(next ? 'roles.delegatable.enabled' : 'roles.delegatable.disabled', {
            permission: displayName(entry),
          }),
        );
      } catch (caught) {
        setOpError(caught instanceof PermissionCatalogError ? caught.code : 'unknown');
      } finally {
        setPendingSlug(null);
      }
    },
    [setDelegatable, displayName, t],
  );

  return (
    <section
      aria-labelledby={headingId}
      data-testid="delegatable-permissions"
      className="border-border bg-card rounded-2xl border p-4"
    >
      <div className="space-y-1">
        <h2 id={headingId} className="text-foreground text-base font-semibold">
          {t('roles.delegatable.title')}
        </h2>
        <p className="text-muted-foreground text-xs leading-relaxed">
          {t('roles.delegatable.description')}
        </p>
      </div>

      {opError !== null && (
        <div
          role="alert"
          className="border-destructive/40 bg-destructive/10 text-destructive mt-3 flex items-center gap-2.5 rounded-xl border px-4 py-3 text-sm"
        >
          <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
          <span>{t(PERMISSION_CATALOG_ERROR_KEYS[opError])}</span>
        </div>
      )}

      {announcement !== '' && (
        <div
          role="status"
          className="border-success/40 bg-success/10 text-success mt-3 flex items-center gap-2.5 rounded-xl border px-4 py-3 text-sm"
        >
          <Check className="size-4 shrink-0" aria-hidden="true" />
          <span>{announcement}</span>
        </div>
      )}

      {isLoading ? (
        <p className="text-muted-foreground mt-4 text-sm">{t('common.loading')}</p>
      ) : error !== null && permissions.length === 0 ? (
        <div
          role="alert"
          className="border-destructive/40 bg-destructive/10 text-destructive mt-4 flex items-center gap-2.5 rounded-xl border px-4 py-3 text-sm"
        >
          <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
          <span className="flex-1">{t(PERMISSION_CATALOG_ERROR_KEYS[error])}</span>
          <button
            type="button"
            onClick={() => void refresh()}
            className="underline-offset-2 hover:underline"
          >
            {t('roles.retry')}
          </button>
        </div>
      ) : permissions.length === 0 ? (
        <p className="text-muted-foreground mt-4 text-sm">{t('roles.delegatable.empty')}</p>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-border text-muted-foreground border-b text-xs">
                <th scope="col" className="py-2 pe-3 text-start font-medium">
                  {t('roles.delegatable.columnPermission')}
                </th>
                <th scope="col" className="py-2 pe-3 text-start font-medium">
                  {t('roles.delegatable.columnModule')}
                </th>
                <th scope="col" className="py-2 text-end font-medium">
                  {t('roles.delegatable.columnDelegatable')}
                </th>
              </tr>
            </thead>
            <tbody>
              {permissions.map((entry) => {
                const name = displayName(entry);
                const busy = pendingSlug === entry.slug;
                return (
                  <tr
                    key={entry.id}
                    data-testid={`delegatable-row-${entry.slug}`}
                    className="border-border border-b last:border-b-0"
                  >
                    <td className="py-2.5 pe-3">
                      <bdi dir="auto" className="text-foreground font-medium">
                        {name}
                      </bdi>{' '}
                      <bdi dir="ltr" className="text-muted-foreground text-xs">
                        {entry.slug}
                      </bdi>
                    </td>
                    <td className="text-muted-foreground py-2.5 pe-3 text-xs">
                      {moduleLabel(entry.module)}
                    </td>
                    <td className="py-2.5">
                      <div className="flex items-center justify-end">
                        {isProtectedPermissionSlug(entry.slug) ? (
                          <span
                            data-testid={`delegatable-protected-${entry.slug}`}
                            title={t('roles.delegatable.protectedHint')}
                            className="border-border bg-muted text-muted-foreground inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium"
                          >
                            <Lock className="size-3" aria-hidden="true" />
                            {t('roles.delegatable.protected')}
                          </span>
                        ) : (
                          <button
                            type="button"
                            role="switch"
                            aria-checked={entry.isDelegatable}
                            aria-label={t('roles.delegatable.toggleLabel', { permission: name })}
                            disabled={busy}
                            onClick={() => void handleToggle(entry)}
                            data-testid={`delegatable-toggle-${entry.slug}`}
                            className={[
                              'relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-60',
                              entry.isDelegatable
                                ? 'border-primary bg-primary'
                                : 'border-input bg-muted',
                            ].join(' ')}
                          >
                            <span
                              className={[
                                'bg-background pointer-events-none inline-block size-4 rounded-full shadow-xs transition-transform',
                                entry.isDelegatable
                                  ? 'translate-x-5 rtl:-translate-x-5'
                                  : 'translate-x-0.5 rtl:-translate-x-0.5',
                              ].join(' ')}
                            />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/* ----------------------------------------------------------------- page */

export default function RolesPermissions() {
  const { t, locale } = useI18n();
  const formatDateTime = useDateTimeFormatter();
  const moduleLabel = useModuleLabel();
  const {
    roles,
    groups,
    actorIsSuperAdmin: matrixActorIsSuperAdmin,
    isInitialLoading,
    isRefreshing,
    fetchError,
    lastSyncedAt,
    refresh,
    selectedRole,
    selectRole,
    draft,
    protectedReasons,
    saveBlocker,
    togglePermission,
    toggleGroup,
    getGroupState,
    resetDraft,
    isSaving,
    save,
  } = useRolesManagement();

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingRoleId, setPendingRoleId] = useState<string | null>(null);
  const [opError, setOpError] = useState<RolesManagementErrorCode | null>(null);
  const [success, setSuccess] = useState<{ role: string; granted: number; revoked: number } | null>(
    null,
  );
  const [liveMessage, setLiveMessage] = useState('');
  const saveBlockerId = useId();

  const displayName = useCallback(
    (role: ManagedRole) => (locale === 'ar' ? role.nameAr : role.nameEn),
    [locale],
  );

  /* Nothing selected yet: open the first role once the catalog arrives. */
  useEffect(() => {
    if (selectedRole === null && roles.length > 0) {
      const first = roles[0];
      if (first !== undefined) {
        selectRole(first.id);
      }
    }
  }, [selectedRole, roles, selectRole]);

  /* Unsaved changes guard for reload/close (in-app switching has a dialog). */
  const isDirty = draft?.isDirty ?? false;
  useEffect(() => {
    if (!isDirty) {
      return;
    }
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isDirty]);

  const handleSelectRole = useCallback(
    (roleId: string) => {
      if (selectedRole !== null && roleId === selectedRole.id) {
        return;
      }
      if (draft?.isDirty === true) {
        setPendingRoleId(roleId);
        return;
      }
      setLiveMessage('');
      selectRole(roleId);
    },
    [selectedRole, draft, selectRole],
  );

  const handleTogglePermission = useCallback(
    (permission: PermissionItem) => {
      const reason = togglePermission(permission.id);
      if (reason !== null) {
        setLiveMessage(t(ROLES_PROTECTED_KEYS[reason]));
      }
    },
    [togglePermission, t],
  );

  const handleToggleGroup = useCallback(
    (group: PermissionGroup, checked: boolean) => {
      const summary = toggleGroup(group.module, checked);
      const label = moduleLabel(group.module);
      const base = checked
        ? t('roles.group.announceChecked', { count: summary.added, group: label })
        : t('roles.group.announceUnchecked', { count: summary.removed, group: label });
      const kept =
        summary.keptProtected > 0
          ? ` ${t('roles.group.announceKept', { count: summary.keptProtected })}`
          : '';
      setLiveMessage(`${base}${kept}`);
    },
    [toggleGroup, moduleLabel, t],
  );

  const handleBlockedAttempt = useCallback(
    (reason: ProtectedReason | null) => {
      if (reason !== null) {
        setLiveMessage(t(ROLES_PROTECTED_KEYS[reason]));
      }
    },
    [t],
  );

  const handleOpenConfirm = useCallback(() => {
    if (saveBlocker !== null) {
      setLiveMessage(t(ROLES_BLOCKER_KEYS[saveBlocker]));
      return;
    }
    setOpError(null);
    setConfirmOpen(true);
  }, [saveBlocker, t]);

  const handleConfirmSave = useCallback(async () => {
    setOpError(null);
    const result: SaveRolePermissionsResult = await save();
    if (result.ok) {
      const name = selectedRole !== null ? displayName(selectedRole) : '';
      setSuccess({ role: name, granted: result.granted.length, revoked: result.revoked.length });
      setConfirmOpen(false);
      setLiveMessage('');
    } else {
      setOpError(result.code);
    }
  }, [save, selectedRole, displayName]);

  const handleDiscard = useCallback(() => {
    resetDraft();
    setLiveMessage('');
  }, [resetDraft]);

  const handleConfirmSwitch = useCallback(() => {
    if (pendingRoleId !== null) {
      selectRole(pendingRoleId);
    }
    setPendingRoleId(null);
    setLiveMessage('');
  }, [pendingRoleId, selectRole]);

  /* Smart Hiding (screen + button layer): granting/revoking permissions on a
     role needs `*` on the server (`admin_set_role_permissions` → is_admin()).
     `roles.manage` alone is refused by design (RBAC audit F3). The capability
     channel answers when it is authoritative; otherwise the matrix-derived flag
     keeps the exact same surface as before.
     TODO: when the backend accepts `roles.manage` for this RPC, widen the gate
     to `roles.manage` OR `*`. */
  const capabilities = useAuthCapabilities();
  const actorIsSuperAdmin = capabilities.isAuthoritative
    ? capabilities.hasCapability(WILDCARD_CAPABILITY)
    : matrixActorIsSuperAdmin;

  /* Content-state machine: loading → error → denied → empty → screen.
     A failed refresh over existing rows never blanks the screen. */
  let content: ReactNode;
  if (isInitialLoading) {
    content = <SkeletonScreen />;
  } else if (fetchError !== null && roles.length === 0) {
    content = (
      <div
        role="alert"
        className="bg-card flex flex-col items-center gap-4 rounded-2xl border border-dashed px-6 py-14 text-center"
      >
        <span className="bg-destructive/10 text-destructive grid size-14 place-items-center rounded-2xl">
          <AlertCircle className="size-6" aria-hidden="true" />
        </span>
        <div className="space-y-1.5">
          <h2 className="text-card-foreground text-base font-semibold">{t('roles.error.title')}</h2>
          <p className="text-muted-foreground mx-auto max-w-md text-sm">
            {t(ROLES_ERROR_KEYS[fetchError])}
          </p>
        </div>
        {RETRYABLE_CODES.has(fetchError) && (
          <button
            type="button"
            onClick={refresh}
            className={`${PRIMARY_BUTTON_CLASS} bg-primary text-primary-foreground`}
          >
            <RefreshCw className="size-4" aria-hidden="true" />
            {t('roles.retry')}
          </button>
        )}
      </div>
    );
  } else if (!actorIsSuperAdmin) {
    /* 403 Access Denied — capability gate, not an empty matrix. */
    content = (
      <div className="bg-card animate-fade-in flex flex-col items-center gap-4 rounded-2xl border border-dashed px-6 py-14 text-center">
        <span className="bg-destructive/10 text-destructive grid size-14 place-items-center rounded-2xl">
          <Lock className="size-6" aria-hidden="true" />
        </span>
        <div className="space-y-1.5">
          <p className="text-destructive text-xs font-semibold tracking-widest">
            {t('roles.denied.code')}
          </p>
          <h2 className="text-card-foreground text-base font-semibold">
            {t('roles.denied.title')}
          </h2>
          <p className="text-muted-foreground mx-auto max-w-md text-sm">{t('roles.denied.body')}</p>
        </div>
        <Link to="/" className={`${PRIMARY_BUTTON_CLASS} bg-primary text-primary-foreground`}>
          {t('roles.denied.back')}
        </Link>
      </div>
    );
  } else if (roles.length === 0) {
    content = (
      <EmptyState
        icon={KeyRound}
        title={t('roles.empty.title')}
        description={t('roles.empty.body')}
      />
    );
  } else {
    content = (
      <div className="@container">
        <div className="grid grid-cols-1 gap-4 @4xl:grid-cols-[minmax(0,15rem)_minmax(0,1fr)] @4xl:items-start">
          {/* Roles column — stacked cards on mobile, fixed column on desktop */}
          <nav aria-label={t('roles.list.label')} className="@4xl:sticky @4xl:top-4">
            <ul role="list" className="flex flex-col gap-2">
              {roles.map((role) => {
                const isSelected = selectedRole?.id === role.id;
                return (
                  <li key={role.id}>
                    <button
                      type="button"
                      aria-current={isSelected ? 'true' : undefined}
                      onClick={() => handleSelectRole(role.id)}
                      className={`border-border flex w-full flex-col items-start gap-1.5 rounded-xl border p-3 text-start transition-colors ${
                        isSelected ? 'bg-primary/10 border-primary/40' : 'bg-card hover:bg-accent'
                      }`}
                    >
                      <span className="text-foreground flex w-full items-center gap-2 text-sm font-semibold">
                        <bdi dir="auto" className="min-w-0 flex-1 truncate">
                          {displayName(role)}
                        </bdi>
                      </span>
                      <RoleBadges role={role} />
                      <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs tabular-nums">
                        <Users className="size-3.5" aria-hidden="true" />
                        {t('roles.role.usersCount', { count: role.assignedUserCount })}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>

          {/* Permission matrix */}
          <div className="space-y-4">
            {selectedRole !== null && draft !== null && (
              <>
                <div className="border-border bg-card space-y-3 rounded-2xl border p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-foreground text-base font-semibold">
                      <bdi dir="auto">{displayName(selectedRole)}</bdi>
                    </h2>
                    <RoleBadges role={selectedRole} />
                  </div>

                  {/* Save bar: dirty summary + blocker reason + actions */}
                  <div className="border-border flex flex-wrap items-center gap-2.5 border-t pt-3">
                    {isDirty && (
                      <span className="border-warning/30 bg-warning/10 text-warning inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium">
                        {t('roles.dirty', {
                          count: draft.grantedIds.length + draft.revokedIds.length,
                        })}
                      </span>
                    )}
                    <div className="ms-auto flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={handleDiscard}
                        aria-disabled={!isDirty || isSaving}
                        className="border-border bg-background text-foreground hover:bg-accent inline-flex items-center justify-center gap-2 rounded-lg border px-4 py-2 text-sm font-semibold transition-colors aria-disabled:cursor-not-allowed aria-disabled:opacity-60"
                      >
                        {t('roles.discard')}
                      </button>
                      <button
                        type="button"
                        onClick={handleOpenConfirm}
                        aria-disabled={saveBlocker !== null || isSaving || !actorIsSuperAdmin}
                        aria-describedby={saveBlocker !== null ? saveBlockerId : undefined}
                        title={
                          saveBlocker !== null ? t(ROLES_BLOCKER_KEYS[saveBlocker]) : undefined
                        }
                        className={`${ACTION_BUTTON_CLASS} bg-primary text-primary-foreground`}
                      >
                        {isSaving ? (
                          <Loader2
                            className="size-4 animate-spin motion-reduce:animate-none"
                            aria-hidden="true"
                          />
                        ) : (
                          <Check className="size-4" aria-hidden="true" />
                        )}
                        {t('roles.save')}
                      </button>
                    </div>
                    {saveBlocker !== null && saveBlocker !== 'noop' && (
                      <p id={saveBlockerId} className="text-warning w-full text-xs">
                        {t(ROLES_BLOCKER_KEYS[saveBlocker])}
                      </p>
                    )}
                  </div>

                  {draft.baselineIds.size === 0 && (
                    <p className="text-muted-foreground text-xs">{t('roles.matrix.emptyHint')}</p>
                  )}
                </div>

                {groups.map((group) => (
                  <GroupFieldset
                    key={group.module}
                    group={group}
                    state={getGroupState(group.module)}
                    selectedIds={draft.selectedIds}
                    protectedReasons={protectedReasons}
                    busy={isSaving}
                    onToggleGroup={(checked) => handleToggleGroup(group, checked)}
                    onTogglePermission={handleTogglePermission}
                    onBlockedAttempt={handleBlockedAttempt}
                  />
                ))}
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <section className="space-y-4">
      {/* Operation result (polite) — never steals focus. */}
      {success !== null && (
        <div
          role="status"
          className="border-success/40 bg-success/10 text-success flex items-center gap-2.5 rounded-xl border px-4 py-3 text-sm"
        >
          <Check className="size-4 shrink-0" aria-hidden="true" />
          <span className="flex-1">
            {t('roles.success.saved', {
              role: success.role,
              granted: success.granted,
              revoked: success.revoked,
            })}
          </span>
          <button
            type="button"
            aria-label={t('roles.confirm.cancel')}
            onClick={() => setSuccess(null)}
            className="text-success/80 hover:text-success grid size-7 place-items-center rounded-lg transition-colors"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>
      )}

      {/* Toolbar: count · sync state · manual refresh */}
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="text-muted-foreground inline-flex items-center gap-1.5 text-sm">
          <KeyRound className="size-4" aria-hidden="true" />
          {t('roles.count', { count: roles.length })}
        </span>

        {isRefreshing ? (
          <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
            <Loader2
              className="size-3.5 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
            {t('roles.syncing')}
          </span>
        ) : (
          lastSyncedAt !== null && (
            <span className="text-muted-foreground text-xs">
              {t('roles.lastSynced', { time: formatDateTime(lastSyncedAt) })}
            </span>
          )
        )}

        <button
          type="button"
          onClick={refresh}
          aria-disabled={isRefreshing}
          className="border-border bg-card text-foreground hover:bg-accent ms-auto inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-colors aria-disabled:cursor-not-allowed aria-disabled:opacity-60"
        >
          <RefreshCw
            className={`size-4 ${isRefreshing ? 'animate-spin motion-reduce:animate-none' : ''}`}
            aria-hidden="true"
          />
          {t('roles.refresh')}
        </button>
      </div>

      {/* Live regions for screen readers: bulk actions + refetch progress. */}
      <p role="status" className="sr-only">
        {liveMessage}
      </p>
      <p role="status" className="sr-only">
        {isRefreshing ? t('roles.syncing') : ''}
      </p>

      {/* Non-blocking banner: a failed refresh over data we can still show. */}
      {fetchError !== null && roles.length > 0 && !isInitialLoading && (
        <div
          role="alert"
          className="border-destructive/40 bg-destructive/10 text-destructive flex items-center gap-2.5 rounded-xl border px-4 py-3 text-sm"
        >
          <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
          <span className="flex-1">{t(ROLES_ERROR_KEYS[fetchError])}</span>
          {RETRYABLE_CODES.has(fetchError) && (
            <button
              type="button"
              onClick={refresh}
              className="text-destructive underline-offset-2 hover:underline"
            >
              {t('roles.retry')}
            </button>
          )}
        </div>
      )}

      {content}

      {/* Delegation policy: same owner/super_admin surface as the matrix. */}
      {actorIsSuperAdmin && !isInitialLoading && <DelegatablePermissionsSection />}

      {confirmOpen && selectedRole !== null && draft !== null && (
        <DialogShell
          title={t('roles.confirm.title')}
          busy={isSaving}
          error={opError}
          confirmLabel={t('roles.confirm.save')}
          cancelLabel={t('roles.confirm.cancel')}
          onConfirm={() => void handleConfirmSave()}
          onCancel={() => {
            setConfirmOpen(false);
            setOpError(null);
          }}
          body={
            <>
              <p>
                {t('roles.confirm.body', {
                  role: displayName(selectedRole),
                })}
              </p>
              <p className="flex flex-wrap gap-2 text-xs">
                <span className="border-success/30 bg-success/10 text-success rounded-full border px-2.5 py-0.5 font-medium">
                  {t('roles.confirm.granted', { count: draft.grantedIds.length })}
                </span>
                <span className="border-destructive/30 bg-destructive/10 text-destructive rounded-full border px-2.5 py-0.5 font-medium">
                  {t('roles.confirm.revoked', { count: draft.revokedIds.length })}
                </span>
              </p>
              {selectedRole.isSystem && (
                <p className="border-warning/40 bg-warning/10 text-warning flex items-start gap-2 rounded-xl border px-3 py-2.5 text-xs">
                  <ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                  <span>
                    {t('roles.confirm.systemWarning', {
                      count: selectedRole.assignedUserCount,
                    })}
                  </span>
                </p>
              )}
            </>
          }
        />
      )}

      {pendingRoleId !== null && selectedRole !== null && (
        <DialogShell
          title={t('roles.switch.title')}
          busy={false}
          error={null}
          destructive
          confirmLabel={t('roles.switch.confirm')}
          cancelLabel={t('roles.switch.cancel')}
          onConfirm={handleConfirmSwitch}
          onCancel={() => setPendingRoleId(null)}
          body={
            <p>
              {t('roles.switch.body', {
                role: displayName(selectedRole),
              })}
            </p>
          }
        />
      )}
    </section>
  );
}
