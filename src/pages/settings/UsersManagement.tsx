import {
  AlertCircle,
  Ban,
  Check,
  Clock,
  KeyRound,
  Loader2,
  Lock,
  Pen,
  RefreshCw,
  Shield,
  UserCheck,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router';
import DelegationExpiryBadge from '@/components/users/DelegationExpiryBadge';
import { useAuthCapabilities, WILDCARD_CAPABILITY } from '@/hooks/useAuthCapabilities';
import { useDelegatedUsers, type DelegatedCapability } from '@/hooks/useDelegatedUsers';
import {
  failureMessageKey,
  failureMessageKeyForRoleChange,
  getStatusChangeBlocker,
  INVITE_ROLES,
  inviteFailureMessageKey,
  nextStatusFor,
  passwordResetFailureMessageKey,
  useUsersManagement,
  USERS_BLOCKER_KEYS,
  USERS_ERROR_KEYS,
  type InviteRole,
  type ManagedUser,
  type StatusChangeBlocker,
  type UserManagementErrorCode,
  type UserStatus,
} from '@/hooks/useUsersManagement';
import { useI18n, type TranslationKey } from '@/i18n/I18nContext';
import { EmptyState } from '@/components/ui/EmptyState';
import { PasswordRevealDialog } from '@/components/ui/PasswordRevealDialog';
import DelegationDialog from '@/pages/settings/DelegationDialog';

/**
 * Users Management screen (renders inside SettingsPage for section `users`).
 *
 * * Capability gate (Phase 3A): the screen asks `hasCapability('*')` through
 *   `useAuthCapabilities` — the UI mirror of the server's `is_admin()` check
 *   inside `admin_set_user_status` — and never a role name. While the
 *   capability channel is silent the gate falls back to the hook's resolved
 *   actor flag, so an unresolved channel shows the same panel as before.
 * * Protected-user indicator (Phase 3A): rows with `isProtected === true`
 *   show a lock chip instead of the hidden system role name, disable every
 *   mutating action and explain why via a tooltip
 *   ("هذا الحساب محمي ولا يمكن تعديله من الواجهة").
 * * ONE DOM tree serves both layouts through container queries: a CSS-Grid
 *   data grid with ARIA table roles that reads as a table on wide containers
 *   and as stacked cards on narrow ones. Field labels are duplicated nowhere
 *   — each cell renders its label once (visible on mobile, hidden on desktop
 *   where the column headers name the cells).
 * * Lockout guards: the status control is fully inert on the current user's
 *   own row (Self-Suspension Guard) and on the last active super admin
 *   (Last-Admin Lockout), with a visible, translated reason.
 * * Every destructive change goes through an accessible confirmation dialog
 *   (portal, focus trap, Escape, least-destructive action focused first).
 */

/* ----------------------------------------------------------------- consts */

/**
 * Shared grid template for the header, the data rows and the skeletons, so
 * columns can never drift apart. `minmax(0, …)` lets text truncate instead
 * of overflowing.
 */
const ROW_GRID_COLS =
  'grid-cols-1 gap-2 @2xl:grid-cols-[minmax(0,2fr)_minmax(0,1.2fr)_minmax(0,14rem)_minmax(0,10.5rem)_minmax(0,9rem)] @2xl:items-center @2xl:gap-4';

const STATUS_KEYS: Record<UserStatus, TranslationKey> = {
  invited: 'users.status.invited',
  active: 'users.status.active',
  suspended: 'users.status.suspended',
};

/** Non-protected roles the approval dialog may grant (server re-validates). */
const APPROVAL_ROLES = ['viewer', 'editor', 'admin'] as const;
type ApprovalRole = (typeof APPROVAL_ROLES)[number];

const APPROVAL_ROLE_KEYS: Record<ApprovalRole, TranslationKey> = {
  viewer: 'users.approval.role.viewer',
  editor: 'users.approval.role.editor',
  admin: 'users.approval.role.admin',
};

/** Result banner payload — status changes and approvals word differently. */
interface SuccessBannerState {
  readonly key:
    | 'users.success.statusUpdated'
    | 'users.success.approved'
    | 'users.success.rejected'
    | 'users.success.roleChanged'
    | 'users.invite.success'
    | 'users.password.success';
  readonly name: string;
  readonly roleName?: string;
  readonly roles?: string;
}

const STATUS_ICONS: Record<UserStatus, LucideIcon> = {
  invited: Clock,
  active: Check,
  suspended: Ban,
};

const STATUS_BADGE_CLASS: Record<UserStatus, string> = {
  invited: 'border-warning/30 bg-warning/10 text-warning',
  active: 'border-success/30 bg-success/10 text-success',
  suspended: 'border-destructive/30 bg-destructive/10 text-destructive',
};

const ACTION_BUTTON_CLASS =
  'inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-opacity hover:opacity-90 aria-disabled:cursor-not-allowed aria-disabled:opacity-60';

const PRIMARY_BUTTON_CLASS =
  'inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold transition-opacity hover:opacity-90 aria-disabled:cursor-not-allowed aria-disabled:opacity-60';

/** Failures worth offering a retry for (never for permission classes). */
const RETRYABLE_CODES: ReadonlySet<UserManagementErrorCode> = new Set([
  'network',
  'unknown',
  'rate-limited',
]);

const SKELETON_ROWS = 5;

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

/* --------------------------------------------------------------- pieces */

interface FieldProps {
  label: string;
  children: ReactNode;
  rowHeader?: boolean;
}

/**
 * One grid cell. On narrow containers it pairs a visible label with its
 * value (card field); on wide containers the label leaves the a11y tree and
 * the column header names the cell instead — no double announcements.
 */
function Field({ label, children, rowHeader = false }: FieldProps) {
  return (
    <div
      role={rowHeader ? 'rowheader' : 'cell'}
      className="flex items-start justify-between gap-3 @2xl:block @2xl:min-w-0"
    >
      <span className="text-muted-foreground shrink-0 text-xs font-medium @2xl:hidden">
        {label}
      </span>
      <div className="min-w-0 flex-1 @2xl:flex-none">{children}</div>
    </div>
  );
}

function StatusBadge({ status }: { status: UserStatus }) {
  const { t } = useI18n();
  const Icon = STATUS_ICONS[status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${STATUS_BADGE_CLASS[status]}`}
    >
      <Icon className="size-3.5" aria-hidden="true" />
      {t(STATUS_KEYS[status])}
    </span>
  );
}

/**
 * Phase 3A — the protected-user indicator: a small lock chip with the
 * tooltip "هذا الحساب محمي ولا يمكن تعديله من الواجهة". It replaces the
 * system role name entirely, so `super_admin` is never rendered visually.
 */
function ProtectedAccountChip({ owner }: { owner: boolean }) {
  const { t } = useI18n();
  return (
    <span
      title={t(owner ? 'users.protected.ownerTooltip' : 'users.protected.tooltip')}
      className="border-primary/30 bg-primary/10 text-primary inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium"
    >
      <Lock className="size-3.5" aria-hidden="true" />
      {t('users.protected.badge')}
    </span>
  );
}

function DelegatedBadge({ slugs }: { slugs: readonly string[] }) {
  const { t } = useI18n();
  if (slugs.length === 0) {
    return null;
  }
  const tooltip = `${t('users.delegated.tooltip')}: ${slugs.join(', ')}`;
  return (
    <span
      title={tooltip}
      data-testid="delegated-user-badge"
      className="border-primary/30 bg-primary/10 text-primary inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium"
    >
      <Shield className="size-3.5" aria-hidden="true" />
      {t('users.delegated.badge')}
    </span>
  );
}

function RoleBadges({ user }: { user: ManagedUser }) {
  const { t, locale } = useI18n();
  /* Phase 3A: a protected account never renders role names — the lock chip
     (and its tooltip) is the only identity shown in this column. */
  if (user.isProtected) {
    return <ProtectedAccountChip owner={user.roles.some((role) => role.slug === 'owner')} />;
  }
  if (user.roles.length === 0) {
    return <span className="text-muted-foreground text-sm">{t('users.roles.none')}</span>;
  }
  return (
    <ul className="flex flex-wrap gap-1.5">
      {user.roles.map((role) => (
        <li
          key={role.slug}
          className="border-border bg-muted text-muted-foreground inline-flex items-center rounded-full border px-2 py-0.5 text-xs"
        >
          {locale === 'ar' ? role.nameAr : role.nameEn}
        </li>
      ))}
    </ul>
  );
}

const EMPTY_DELEGATIONS: readonly DelegatedCapability[] = [];

type UserLifecycleTab = 'all' | 'pending' | 'delegated' | 'rejected';

interface UserRowProps {
  user: ManagedUser;
  delegations?: readonly DelegatedCapability[];
  actorId: string | null;
  actorIsSuperAdmin: boolean;
  activeSuperAdmins: readonly ManagedUser[];
  pendingUserId: string | null;
  /** `*` held by the caller (server: is_admin()). */
  canAdminister: boolean;
  onAction: (user: ManagedUser) => void;
  onApproval: (user: ManagedUser, action: 'approve' | 'reject') => void;
  onEditRoles: (user: ManagedUser) => void;
  /** Admin-initiated password reset (owner/super_admin only). */
  onResetPassword: (user: ManagedUser) => void;
  onManageDelegations: (user: ManagedUser) => void;
  canApprove: boolean;
  /** `owner`/`super_admin` held by the caller — gates reset and delegation controls. */
  canResetPassword: boolean;
  canManageDelegations: boolean;
}

function UserRow({
  user,
  delegations = EMPTY_DELEGATIONS,
  actorId,
  actorIsSuperAdmin,
  activeSuperAdmins,
  pendingUserId,
  canAdminister,
  onAction,
  onApproval,
  onEditRoles,
  onResetPassword,
  onManageDelegations,
  canApprove,
  canResetPassword,
  canManageDelegations,
}: UserRowProps) {
  const { t } = useI18n();
  const formatDateTime = useDateTimeFormatter();
  const reasonId = useId();
  const isSelf = actorId !== null && user.id === actorId;
  const busy = pendingUserId === user.id;
  const delegatedSlugs = delegations.map((entry) => entry.slug);

  const nextStatus = nextStatusFor(user);
  const blocker: StatusChangeBlocker | null = getStatusChangeBlocker({
    target: user,
    actorId,
    actorIsSuperAdmin,
    nextStatus,
    activeSuperAdmins,
  });

  /* Phase 3A — protected-user indicator: every mutating action on this row
     is disabled and explains itself via the tooltip
     "هذا الحساب محمي ولا يمكن تعديله من الواجهة". */
  const isProtectedRow = user.isProtected;
  const actionReasonKey: TranslationKey | null = isProtectedRow
    ? user.roles.some((role) => role.slug === 'owner')
      ? 'users.protected.ownerTooltip'
      : 'users.protected.tooltip'
    : blocker !== null
      ? USERS_BLOCKER_KEYS[blocker]
      : null;
  /* Smart Hiding (button layer): status changes need `*` on the server
     (`admin_set_user_status` → is_admin()). `canAdminister` is resolved once by
     the screen. TODO: when the backend accepts `users.manage`, widen this gate
     (and the screen gate) to `users.manage` OR `*`. */
  const actionDisabled = isProtectedRow || blocker !== null || busy || !canAdminister;

  const actionLabel =
    nextStatus === 'suspended' ? t('users.action.suspend') : t('users.action.activate');
  const ActionIcon = nextStatus === 'suspended' ? Ban : UserCheck;

  return (
    <div
      role="row"
      className={`grid ${ROW_GRID_COLS} border-border bg-card rounded-xl border p-4 @2xl:rounded-none @2xl:border-x-0 @2xl:border-t-0 @2xl:p-3.5 @2xl:last:border-b-0`}
    >
      <Field label={t('users.col.user')} rowHeader>
        <div className="@2xl:flex @2xl:min-w-0 @2xl:items-center @2xl:gap-2">
          <p className="text-foreground truncate text-sm font-semibold">
            <bdi dir="auto">{user.fullName ?? user.email}</bdi>
          </p>
          <p className="text-muted-foreground truncate text-xs">
            <bdi dir="auto">{user.email}</bdi>
          </p>
          {isSelf && (
            <span className="bg-primary/10 text-primary border-primary/30 inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs font-medium">
              {t('users.you')}
            </span>
          )}
        </div>
      </Field>

      <Field label={t('users.col.roles')}>
        <RoleBadges user={user} />
      </Field>

      <Field label={t('users.col.status')}>
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusBadge status={user.status} />
          {delegations.length > 0 && <DelegationExpiryBadge delegations={delegations} />}
          {delegatedSlugs.length > 0 && <DelegatedBadge slugs={delegatedSlugs} />}
          <span className="text-muted-foreground text-xs">
            {t(`users.approval.${user.approvalStatus}`)}
          </span>
        </div>
      </Field>

      <Field label={t('users.col.created')}>
        <time dateTime={user.createdAt} className="text-muted-foreground text-sm tabular-nums">
          {formatDateTime(user.createdAt)}
        </time>
      </Field>

      <div role="cell" className="flex flex-col items-start gap-1.5 @2xl:items-start">
        <span className="text-muted-foreground text-xs font-medium @2xl:hidden">
          {t('users.col.action')}
        </span>
        {user.approvalStatus === 'pending' && canApprove && !isProtectedRow && (
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => onApproval(user, 'approve')}
              className={ACTION_BUTTON_CLASS}
            >
              {t('users.approval.approve')}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => onApproval(user, 'reject')}
              className={ACTION_BUTTON_CLASS}
            >
              {t('users.approval.reject')}
            </button>
          </div>
        )}
        {isProtectedRow ? (
          <ProtectedAccountChip owner={user.roles.some((role) => role.slug === 'owner')} />
        ) : canAdminister ? (
          <button
            type="button"
            aria-disabled={actionDisabled || user.approvalStatus !== 'approved'}
            aria-describedby={actionReasonKey !== null ? reasonId : undefined}
            title={actionReasonKey !== null ? t(actionReasonKey) : undefined}
            onClick={() => {
              if (actionDisabled || user.approvalStatus !== 'approved') {
                return;
              }
              onAction(user);
            }}
            className={`${ACTION_BUTTON_CLASS} ${
              nextStatus === 'suspended'
                ? 'bg-destructive text-destructive-foreground'
                : 'bg-primary text-primary-foreground'
            }`}
          >
            {busy ? (
              <Loader2
                className="size-4 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : (
              <ActionIcon className="size-4" aria-hidden="true" />
            )}
            {actionLabel}
          </button>
        ) : null}
        {user.approvalStatus === 'approved' && !isProtectedRow && canAdminister && (
          <button
            type="button"
            onClick={() => onEditRoles(user)}
            className="bg-muted text-muted-foreground hover:bg-accent hover:text-foreground mt-1.5 inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium transition-opacity hover:opacity-90"
            aria-label={t('users.role.changeTitle')}
          >
            <Pen className="size-3" aria-hidden="true" />
            {t('users.role.editButton')}
          </button>
        )}
        {/* Admin-initiated password reset. Visible only for an approved,
            non-protected row and only to owner/super_admin; the SQL gate
            re-checks all three (decision D6 blocks the original owner even if
            this control were rendered). */}
        {user.approvalStatus === 'approved' &&
          !isProtectedRow &&
          user.status === 'active' &&
          canResetPassword && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onResetPassword(user)}
              className="bg-muted text-muted-foreground hover:bg-accent hover:text-foreground inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              aria-label={t('users.password.reset')}
            >
              <KeyRound className="size-3" aria-hidden="true" />
              {t('users.password.reset')}
            </button>
          )}
        {canManageDelegations &&
          !isProtectedRow &&
          user.id !== actorId &&
          user.approvalStatus === 'approved' &&
          user.status === 'active' && (
            <button
              type="button"
              onClick={() => onManageDelegations(user)}
              className="bg-muted text-muted-foreground hover:bg-accent hover:text-foreground inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium transition-opacity hover:opacity-90"
              aria-label={t('users.delegation.manage')}
            >
              <KeyRound className="size-3" aria-hidden="true" />
              {t('users.delegation.manage')}
            </button>
          )}
        {actionReasonKey !== null && !isProtectedRow && (
          <span id={reasonId} className="text-destructive text-xs @2xl:hidden">
            {t(actionReasonKey)}
          </span>
        )}
      </div>
    </div>
  );
}

function SkeletonTable() {
  const { t } = useI18n();
  return (
    <div className="@container">
      <div
        aria-busy="true"
        className="@2xl:border-border @2xl:bg-card @2xl:overflow-hidden @2xl:rounded-2xl @2xl:border"
      >
        <div role="status" className="sr-only">
          {t('users.loading')}
        </div>
        {/* Header geometry */}
        <div className={`hidden @2xl:grid ${ROW_GRID_COLS} border-border border-b px-4 py-3`}>
          {[2.2, 1.3, 0.9, 1.1, 0.9].map((weight, index) => (
            <div
              key={`${index}-${weight}`}
              className="bg-muted h-3 animate-pulse rounded motion-reduce:animate-none"
              style={{ width: `${weight * 2.2}rem`, maxWidth: '100%' }}
            />
          ))}
        </div>
        {/* Row skeletons — same geometry as the real rows to prevent layout shift */}
        <div className="flex flex-col gap-3 @2xl:gap-0">
          {Array.from({ length: SKELETON_ROWS }, (_, index) => (
            <div
              key={index}
              className={`grid ${ROW_GRID_COLS} border-border bg-card rounded-xl border p-4 @2xl:rounded-none @2xl:border-x-0 @2xl:border-t-0 @2xl:p-3.5 @2xl:last:border-b-0`}
            >
              {[70, 45, 30, 55, 40].map((width, cellIndex) => (
                <div key={cellIndex} className="flex flex-col gap-2 @2xl:block">
                  <div
                    className="bg-muted h-3 animate-pulse rounded motion-reduce:animate-none @2xl:hidden"
                    style={{ width: '3.5rem' }}
                  />
                  <div
                    className="bg-muted h-4 animate-pulse rounded motion-reduce:animate-none"
                    style={{ width: `${width}%`, maxWidth: '100%' }}
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

interface ConfirmStatusDialogProps {
  user: ManagedUser;
  nextStatus: UserStatus;
  busy: boolean;
  /** Resolved message key of the last failed operation (see `failureMessageKey`). */
  error: TranslationKey | null;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Accessible confirmation dialog: portal + focus trap + Escape. */
function ConfirmStatusDialog({
  user,
  nextStatus,
  busy,
  error,
  onConfirm,
  onCancel,
}: ConfirmStatusDialogProps) {
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

  const displayName = user.fullName ?? user.email;

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
          {t('users.confirm.title')}
        </h2>
        <p id={bodyId} className="text-muted-foreground mt-2 text-sm leading-relaxed">
          {t('users.confirm.body', {
            name: displayName,
            status: t(STATUS_KEYS[nextStatus]),
          })}
        </p>

        {error !== null && (
          <div
            id={errorId}
            role="alert"
            className="border-destructive/40 bg-destructive/10 text-destructive mt-4 flex items-center gap-2.5 rounded-xl border px-4 py-3 text-sm"
          >
            <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
            <span>{t(error)}</span>
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
            {t('users.confirm.cancel')}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            aria-disabled={busy}
            className={`${PRIMARY_BUTTON_CLASS} ${
              nextStatus === 'suspended'
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
            {nextStatus === 'suspended' ? t('users.confirm.suspend') : t('users.confirm.activate')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

interface ConfirmApprovalDialogProps {
  user: ManagedUser;
  role: ApprovalRole;
  /** Delegated approvers can only grant the basic viewer role. */
  canAssignAdministrativeRole: boolean;
  busy: boolean;
  /** Resolved message key of the last failed operation (see `failureMessageKey`). */
  error: TranslationKey | null;
  onRoleChange: (role: ApprovalRole) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Accessible approval dialog: portal + focus trap + Escape, with the target
 * role picker. The server re-validates that the granted role exists and is not
 * protected (`owner` / `is_super_admin` can never be granted at approval).
 */
function ConfirmApprovalDialog({
  user,
  role,
  canAssignAdministrativeRole,
  busy,
  error,
  onRoleChange,
  onConfirm,
  onCancel,
}: ConfirmApprovalDialogProps) {
  const { t } = useI18n();
  const panelRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const bodyId = useId();
  const roleId = useId();
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

  const displayName = user.fullName ?? user.email;

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
          {t('users.approval.dialog.title')}
        </h2>
        <p id={bodyId} className="text-muted-foreground mt-2 text-sm leading-relaxed">
          {t('users.approval.dialog.body', { name: displayName })}
        </p>

        <div className="mt-4">
          <label htmlFor={roleId} className="mb-1.5 block text-sm font-medium">
            {t('users.approval.dialog.roleLabel')}
          </label>
          <select
            id={roleId}
            value={role}
            disabled={busy}
            onChange={(event) => onRoleChange(event.target.value as ApprovalRole)}
            className="border-input bg-background text-foreground focus:border-primary/60 focus:ring-primary/25 w-full rounded-lg border px-3.5 py-2.5 text-sm outline-none focus:ring-2"
          >
            {(canAssignAdministrativeRole ? APPROVAL_ROLES : (['viewer'] as const)).map((value) => (
              <option key={value} value={value}>
                {t(APPROVAL_ROLE_KEYS[value])}
              </option>
            ))}
          </select>
        </div>

        {error !== null && (
          <div
            id={errorId}
            role="alert"
            className="border-destructive/40 bg-destructive/10 text-destructive mt-4 flex items-center gap-2.5 rounded-xl border px-4 py-3 text-sm"
          >
            <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
            <span>{t(error)}</span>
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
            {t('users.confirm.cancel')}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            aria-disabled={busy}
            className={`${PRIMARY_BUTTON_CLASS} bg-primary text-primary-foreground`}
          >
            {busy && (
              <Loader2
                className="size-4 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            )}
            {t('users.approval.dialog.confirm')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Roles that can be assigned to users via the role-management dialog.
 * Protected system roles (owner, super_admin) are excluded: the RPC rejects
 * them and the UI shows a lock chip instead. */
const ASSIGNABLE_ROLES = ['viewer', 'editor', 'admin', 'executive'] as const;
type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

const ASSIGNABLE_ROLE_KEYS: Record<AssignableRole, TranslationKey> = {
  viewer: 'users.role.role.viewer',
  editor: 'users.role.role.editor',
  admin: 'users.role.role.admin',
  executive: 'users.role.role.executive',
};

function extractAssignableRoles(user: ManagedUser): AssignableRole[] {
  return user.roles
    .map((role) => role.slug)
    .filter((slug): slug is AssignableRole =>
      (ASSIGNABLE_ROLES as readonly string[]).includes(slug),
    );
}

interface ConfirmRoleDialogProps {
  user: ManagedUser;
  selectedRoles: readonly AssignableRole[];
  busy: boolean;
  error: TranslationKey | null;
  onRoleChange: (role: AssignableRole, selected: boolean) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

function ConfirmRoleDialog({
  user,
  selectedRoles,
  busy,
  error,
  onRoleChange,
  onConfirm,
  onCancel,
}: ConfirmRoleDialogProps) {
  const { t } = useI18n();
  const panelRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const bodyId = useId();
  const errorId = useId();

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelRef.current?.focus();
    return () => previous?.focus();
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (!busy) onCancel();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusables = Array.from(
      panelRef.current?.querySelectorAll<HTMLElement>(
        'button:not([aria-disabled="true"]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    );
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (first && last) {
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  };

  const displayName = user.fullName ?? user.email;
  const showLastRoleWarning = user.roles.length > 0 && selectedRoles.length === 0;

  return createPortal(
    <div
      className="bg-foreground/50 fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
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
          {t('users.role.changeTitle')}
        </h2>
        <p id={bodyId} className="text-muted-foreground mt-2 text-sm leading-relaxed">
          {t('users.role.changeBody', { name: displayName })}
        </p>

        <div className="mt-4 space-y-2">
          <p className="text-muted-foreground text-xs font-medium">
            {t('users.role.currentLabel')}:{' '}
            {user.roles.length === 0
              ? t('users.role.unassigned')
              : user.roles
                  .map((r) =>
                    (ASSIGNABLE_ROLES as readonly string[]).includes(r.slug)
                      ? t(ASSIGNABLE_ROLE_KEYS[r.slug as AssignableRole])
                      : r.nameEn,
                  )
                  .join(', ')}
          </p>
          <fieldset className="space-y-1.5">
            <legend className="text-muted-foreground text-xs font-medium">
              {t('users.role.selectLabel')}
            </legend>
            {ASSIGNABLE_ROLES.map((role) => {
              const isSelected = selectedRoles.includes(role);
              return (
                <label
                  key={role}
                  className={`flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 transition-colors ${isSelected ? 'border-primary/40 bg-primary/5' : 'border-border bg-background hover:bg-accent/50'}`}
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => onRoleChange(role, !isSelected)}
                    disabled={busy}
                    className="border-input text-primary focus:ring-primary mt-0.5 rounded"
                  />
                  <span className="text-sm font-medium">{t(ASSIGNABLE_ROLE_KEYS[role])}</span>
                </label>
              );
            })}
          </fieldset>
        </div>

        {showLastRoleWarning && (
          <div
            role="status"
            data-testid="last-role-warning"
            className="border-warning/40 bg-warning/10 text-warning mt-4 flex items-center gap-2.5 rounded-xl border px-4 py-3 text-sm"
          >
            <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
            <span>{t('users.role.lastRoleWarning')}</span>
          </div>
        )}

        {error !== null && (
          <div
            id={errorId}
            role="alert"
            className="border-destructive/40 bg-destructive/10 text-destructive mt-4 flex items-center gap-2.5 rounded-xl border px-4 py-3 text-sm"
          >
            <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
            <span>{t(error)}</span>
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
            {t('users.role.dialog.cancel')}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            aria-disabled={busy}
            className={`${PRIMARY_BUTTON_CLASS} bg-primary text-primary-foreground`}
          >
            {busy && (
              <Loader2
                className="size-4 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            )}
            {t('users.role.dialog.confirm')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* Roles an invitation may grant (decision D5: `executive` is included).
 * The SQL RPC re-validates against the same allow-list. */
const INVITE_ROLE_KEYS: Record<InviteRole, TranslationKey> = {
  viewer: 'users.role.role.viewer',
  editor: 'users.role.role.editor',
  admin: 'users.role.role.admin',
  executive: 'users.role.role.executive',
};

interface InviteUserDialogProps {
  email: string;
  fullName: string;
  role: InviteRole;
  busy: boolean;
  error: TranslationKey | null;
  onEmailChange: (value: string) => void;
  onFullNameChange: (value: string) => void;
  onRoleChange: (role: InviteRole) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Invitation form: portal + focus trap + Escape, matching the other dialogs on
 * this screen. Unlike the confirmation dialogs it focuses the first field
 * rather than Cancel — this is a form, not a destructive confirmation.
 *
 * The temporary-password notice is a fixed line, not an opt-in checkbox
 * (decision D3: no "force change" flag exists in the data model).
 */
function InviteUserDialog({
  email,
  fullName,
  role,
  busy,
  error,
  onEmailChange,
  onFullNameChange,
  onRoleChange,
  onConfirm,
  onCancel,
}: InviteUserDialogProps) {
  const { t } = useI18n();
  const panelRef = useRef<HTMLDivElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const bodyId = useId();
  const emailId = useId();
  const nameId = useId();
  const roleId = useId();
  const errorId = useId();

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    emailRef.current?.focus();
    return () => previous?.focus();
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (!busy) onCancel();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusables = Array.from(
      panelRef.current?.querySelectorAll<HTMLElement>(
        'button:not([aria-disabled="true"]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    );
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (first && last) {
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  };

  const submit = () => {
    /* The browser's own validity check plus the hook's format guard; this only
       avoids spending a round trip on an empty address. */
    if (busy || email.trim() === '') return;
    onConfirm();
  };

  return createPortal(
    <div
      className="bg-foreground/50 fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('users.invite.dialog.title')}
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        onKeyDown={handleKeyDown}
        className="bg-card text-card-foreground animate-scale-in border-border w-full max-w-md rounded-2xl border p-5 shadow-xl motion-reduce:animate-none"
      >
        <h2 id={titleId} className="text-card-foreground text-base font-semibold">
          {t('users.invite.dialog.title')}
        </h2>
        <p id={bodyId} className="text-muted-foreground mt-2 text-sm leading-relaxed">
          {t('users.invite.dialog.body')}
        </p>

        <form
          className="mt-4 space-y-3.5"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div>
            <label htmlFor={emailId} className="mb-1.5 block text-sm font-medium">
              {t('users.invite.field.email')}
            </label>
            <input
              ref={emailRef}
              id={emailId}
              type="email"
              required
              autoComplete="off"
              dir="ltr"
              value={email}
              disabled={busy}
              onChange={(event) => onEmailChange(event.target.value)}
              className="border-input bg-background text-foreground focus:border-primary/60 focus:ring-primary/25 w-full rounded-lg border px-3.5 py-2.5 text-sm outline-none focus:ring-2"
            />
          </div>

          <div>
            <label htmlFor={nameId} className="mb-1.5 block text-sm font-medium">
              {t('users.invite.field.fullName')}
            </label>
            <input
              id={nameId}
              type="text"
              autoComplete="off"
              dir="auto"
              value={fullName}
              disabled={busy}
              onChange={(event) => onFullNameChange(event.target.value)}
              className="border-input bg-background text-foreground focus:border-primary/60 focus:ring-primary/25 w-full rounded-lg border px-3.5 py-2.5 text-sm outline-none focus:ring-2"
            />
          </div>

          <div>
            <label htmlFor={roleId} className="mb-1.5 block text-sm font-medium">
              {t('users.invite.field.role')}
            </label>
            <select
              id={roleId}
              value={role}
              disabled={busy}
              onChange={(event) => onRoleChange(event.target.value as InviteRole)}
              className="border-input bg-background text-foreground focus:border-primary/60 focus:ring-primary/25 w-full rounded-lg border px-3.5 py-2.5 text-sm outline-none focus:ring-2"
            >
              {INVITE_ROLES.map((value) => (
                <option key={value} value={value}>
                  {t(INVITE_ROLE_KEYS[value])}
                </option>
              ))}
            </select>
          </div>

          {error !== null && (
            <div
              id={errorId}
              role="alert"
              className="border-destructive/40 bg-destructive/10 text-destructive flex items-center gap-2.5 rounded-xl border px-4 py-3 text-sm"
            >
              <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
              <span>{t(error)}</span>
            </div>
          )}

          <div className="flex flex-col-reverse gap-2.5 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={onCancel}
              aria-disabled={busy}
              className="border-border bg-background text-foreground hover:bg-accent inline-flex items-center justify-center gap-2 rounded-lg border px-4 py-2.5 text-sm font-semibold transition-colors aria-disabled:cursor-not-allowed aria-disabled:opacity-60"
            >
              {t('users.invite.dialog.cancel')}
            </button>
            <button
              type="submit"
              aria-disabled={busy || email.trim() === ''}
              className={`${PRIMARY_BUTTON_CLASS} bg-primary text-primary-foreground`}
            >
              {busy && (
                <Loader2
                  className="size-4 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
              )}
              {t('users.invite.dialog.confirm')}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}

interface ResetPasswordDialogProps {
  user: ManagedUser;
  busy: boolean;
  error: TranslationKey | null;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Confirmation for an admin-initiated password reset. Cancel is focused first:
 * the action invalidates a credential someone may be using right now.
 */
function ResetPasswordDialog({ user, busy, error, onConfirm, onCancel }: ResetPasswordDialogProps) {
  const { t } = useI18n();
  const panelRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const bodyId = useId();
  const errorId = useId();

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelRef.current?.focus();
    return () => previous?.focus();
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (!busy) onCancel();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusables = Array.from(
      panelRef.current?.querySelectorAll<HTMLElement>(
        'button:not([aria-disabled="true"]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    );
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (first && last) {
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  };

  const displayName = user.fullName ?? user.email;

  return createPortal(
    <div
      className="bg-foreground/50 fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('users.password.dialog.title')}
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        onKeyDown={handleKeyDown}
        className="bg-card text-card-foreground animate-scale-in border-border w-full max-w-md rounded-2xl border p-5 shadow-xl motion-reduce:animate-none"
      >
        <h2 id={titleId} className="text-card-foreground text-base font-semibold">
          {t('users.password.dialog.title')}
        </h2>
        <p id={bodyId} className="text-muted-foreground mt-2 text-sm leading-relaxed">
          {t('users.password.dialog.body', { name: displayName })}
        </p>

        {error !== null && (
          <div
            id={errorId}
            role="alert"
            className="border-destructive/40 bg-destructive/10 text-destructive mt-4 flex items-center gap-2.5 rounded-xl border px-4 py-3 text-sm"
          >
            <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
            <span>{t(error)}</span>
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
            {t('users.password.dialog.cancel')}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            aria-disabled={busy}
            className={`${PRIMARY_BUTTON_CLASS} bg-primary text-primary-foreground`}
          >
            {busy && (
              <Loader2
                className="size-4 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            )}
            {t('users.password.dialog.confirm')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* ----------------------------------------------------------------- page */

export default function UsersManagement() {
  const { t } = useI18n();
  const formatDateTime = useDateTimeFormatter();
  const {
    users,
    actorId,
    actorIsSuperAdmin,
    actorCanApprove,
    activeSuperAdmins,
    isInitialLoading,
    isRefreshing,
    fetchError,
    lastSyncedAt,
    realtimeState,
    pendingUserId,
    refresh,
    setUserStatus,
    approveUser,
    rejectUser,
    changeUserRole,
    inviteUser,
    resetUserPassword,
    actorCanInvite,
  } = useUsersManagement();

  /* Phase 3A — capability gate: `hasCapability('*')` (the UI mirror of the
     server's `is_admin()` check), never a role name. While the capability
     channel is silent the hook's resolved actor flag keeps the gate exact. */
  const capabilities = useAuthCapabilities();
  const canAdministerUsers = capabilities.isAuthoritative
    ? capabilities.hasCapability(WILDCARD_CAPABILITY)
    : actorIsSuperAdmin;
  const canViewApprovalQueue =
    canAdministerUsers ||
    (capabilities.isAuthoritative && capabilities.hasCapability('users.approve'));

  const { delegatedUsers, refresh: refreshDelegatedUsers } = useDelegatedUsers({
    enabled: canAdministerUsers,
  });
  const [activeTab, setActiveTab] = useState<UserLifecycleTab>('all');

  const delegatedCount = useMemo(
    () =>
      users.filter(
        (user) =>
          user.approvalStatus !== 'rejected' && (delegatedUsers.get(user.id)?.length ?? 0) > 0,
      ).length,
    [users, delegatedUsers],
  );

  const filteredUsers = useMemo(() => {
    switch (activeTab) {
      case 'pending':
        return users.filter((user) => user.approvalStatus === 'pending');
      case 'delegated':
        return users.filter(
          (user) =>
            user.approvalStatus !== 'rejected' && (delegatedUsers.get(user.id)?.length ?? 0) > 0,
        );
      case 'rejected':
        return users.filter((user) => user.approvalStatus === 'rejected');
      case 'all':
      default:
        return users.filter(
          (user) => user.approvalStatus !== 'rejected' && user.status !== 'suspended',
        );
    }
  }, [users, delegatedUsers, activeTab]);

  const [pending, setPending] = useState<{ user: ManagedUser; nextStatus: UserStatus } | null>(
    null,
  );
  const [approvalDialog, setApprovalDialog] = useState<{
    user: ManagedUser;
    role: ApprovalRole;
  } | null>(null);
  /* The failed operation's message key — a specific `messageKey` when the
     result carries one (P1 approval wire codes), else USERS_ERROR_KEYS[code]. */
  const [opError, setOpError] = useState<TranslationKey | null>(null);
  const [success, setSuccess] = useState<SuccessBannerState | null>(null);
  const [roleDialog, setRoleDialog] = useState<ManagedUser | null>(null);
  const [roleChangeError, setRoleChangeError] = useState<TranslationKey | null>(null);
  const [selectedRoles, setSelectedRoles] = useState<readonly AssignableRole[]>([]);

  /* Admin invite + password reset. The revealed credential is held in state
     ONLY while the dialog is open and is dropped on close (decision D1). */
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteForm, setInviteForm] = useState<{
    email: string;
    fullName: string;
    role: InviteRole;
  }>({ email: '', fullName: '', role: 'viewer' });
  const [inviteError, setInviteError] = useState<TranslationKey | null>(null);
  const [inviteBusy, setInviteBusy] = useState(false);
  const [resetTarget, setResetTarget] = useState<ManagedUser | null>(null);
  const [resetError, setResetError] = useState<TranslationKey | null>(null);
  const [resetBusy, setResetBusy] = useState(false);
  const [delegationTarget, setDelegationTarget] = useState<ManagedUser | null>(null);
  const [revealed, setRevealed] = useState<{
    password: string;
    notice: TranslationKey | null;
  } | null>(null);

  const handleApproval = useCallback(
    (user: ManagedUser, action: 'approve' | 'reject') => {
      setOpError(null);
      if (action === 'approve' && actorCanInvite) {
        /* Only role administrators can choose a signup role. */
        setApprovalDialog({ user, role: 'viewer' });
        return;
      }
      void (async () => {
        const result =
          action === 'approve' ? await approveUser(user.id, 'viewer') : await rejectUser(user.id);
        if (result.ok) {
          setSuccess({
            key: action === 'approve' ? 'users.success.approved' : 'users.success.rejected',
            name: user.fullName ?? user.email,
            roleName: action === 'approve' ? t(APPROVAL_ROLE_KEYS.viewer) : undefined,
          });
        } else {
          setOpError(failureMessageKey(result));
        }
      })();
    },
    [actorCanInvite, approveUser, rejectUser, t],
  );

  const handleApprovalConfirm = useCallback(async () => {
    if (approvalDialog === null) {
      return;
    }
    setOpError(null);
    const result = await approveUser(approvalDialog.user.id, approvalDialog.role);
    if (result.ok) {
      setSuccess({
        key: 'users.success.approved',
        name: approvalDialog.user.fullName ?? approvalDialog.user.email,
        roleName: t(APPROVAL_ROLE_KEYS[approvalDialog.role]),
      });
      setApprovalDialog(null);
    } else {
      setOpError(failureMessageKey(result));
    }
  }, [approvalDialog, approveUser, t]);

  const handleAction = useCallback(
    (user: ManagedUser) => {
      /* Phase 3A: protected accounts are never actionable from the UI. */
      if (user.isProtected) {
        return;
      }
      const nextStatus = nextStatusFor(user);
      const blocker = getStatusChangeBlocker({
        target: user,
        actorId,
        actorIsSuperAdmin,
        nextStatus,
        activeSuperAdmins,
      });
      if (blocker !== null) {
        return;
      }
      setOpError(null);
      setPending({ user, nextStatus });
    },
    [actorId, actorIsSuperAdmin, activeSuperAdmins],
  );

  const handleConfirm = useCallback(async () => {
    if (pending === null) {
      return;
    }
    setOpError(null);
    const result = await setUserStatus(pending.user.id, pending.nextStatus);
    if (result.ok) {
      setSuccess({
        key: 'users.success.statusUpdated',
        name: pending.user.fullName ?? pending.user.email,
      });
      setPending(null);
    } else {
      setOpError(failureMessageKey(result));
    }
  }, [pending, setUserStatus]);

  const handleCancel = useCallback(() => {
    setPending(null);
    setOpError(null);
  }, []);

  const handleApprovalCancel = useCallback(() => {
    setApprovalDialog(null);
    setOpError(null);
  }, []);

  const handleEditRoles = useCallback((user: ManagedUser) => {
    setOpError(null);
    setRoleChangeError(null);
    setSelectedRoles(extractAssignableRoles(user));
    setRoleDialog(user);
  }, []);

  const handleRoleChange = useCallback((role: AssignableRole, selected: boolean) => {
    setSelectedRoles((previous) =>
      selected
        ? previous.includes(role)
          ? previous
          : [...previous, role]
        : previous.filter((r) => r !== role),
    );
  }, []);

  const handleRoleConfirm = useCallback(async () => {
    if (roleDialog === null) return;
    const initialRoles = extractAssignableRoles(roleDialog);
    const unchanged =
      selectedRoles.length === initialRoles.length &&
      selectedRoles.every((role) => initialRoles.includes(role));
    if (unchanged) {
      setRoleChangeError('users.role.error.noChanges');
      return;
    }
    setRoleChangeError(null);
    const result = await changeUserRole(roleDialog.id, selectedRoles as string[]);
    if (result.ok) {
      setSuccess({
        key: 'users.success.roleChanged',
        name: roleDialog.fullName ?? roleDialog.email,
        roles: result.roles.length > 0 ? result.roles.join(', ') : t('users.role.unassigned'),
      });
      setRoleDialog(null);
      setSelectedRoles([]);
    } else {
      setRoleChangeError(failureMessageKeyForRoleChange(result));
    }
  }, [changeUserRole, roleDialog, selectedRoles, t]);

  const handleRoleCancel = useCallback(() => {
    setRoleDialog(null);
    setSelectedRoles([]);
    setRoleChangeError(null);
  }, []);

  const handleOpenInvite = useCallback(() => {
    setOpError(null);
    setInviteError(null);
    setInviteForm({ email: '', fullName: '', role: 'viewer' });
    setInviteOpen(true);
  }, []);

  const handleInviteCancel = useCallback(() => {
    setInviteOpen(false);
    setInviteError(null);
  }, []);

  const handleInviteConfirm = useCallback(async () => {
    setInviteError(null);
    setInviteBusy(true);
    try {
      const result = await inviteUser({
        email: inviteForm.email,
        fullName: inviteForm.fullName,
        targetRole: inviteForm.role,
      });
      if (!result.ok) {
        setInviteError(inviteFailureMessageKey(result));
        return;
      }
      /* Close the form before revealing: two stacked dialogs would put the
         credential behind a focus trap the user has already dismissed. */
      setInviteOpen(false);
      setRevealed({ password: result.tempPassword, notice: null });
      setSuccess({
        key: 'users.invite.success',
        name: inviteForm.fullName.trim() !== '' ? inviteForm.fullName.trim() : inviteForm.email,
        roleName: t(INVITE_ROLE_KEYS[inviteForm.role]),
      });
    } finally {
      setInviteBusy(false);
    }
  }, [inviteForm, inviteUser, t]);

  const handleOpenResetPassword = useCallback((user: ManagedUser) => {
    setOpError(null);
    setResetError(null);
    setResetTarget(user);
  }, []);

  const handleResetPasswordCancel = useCallback(() => {
    setResetTarget(null);
    setResetError(null);
  }, []);

  const handleResetPasswordConfirm = useCallback(async () => {
    if (resetTarget === null) return;
    const target = resetTarget;
    setResetError(null);
    setResetBusy(true);
    try {
      const result = await resetUserPassword(target.id);
      if (!result.ok) {
        setResetError(passwordResetFailureMessageKey(result));
        return;
      }
      setResetTarget(null);
      /* A missing audit row is reported next to the credential, not hidden
         behind the success banner: the operator is the only one who can act
         on it, and only while the password is still on screen. */
      setRevealed({
        password: result.tempPassword,
        notice: result.auditRecorded ? null : 'users.password.auditMissing',
      });
      setSuccess({ key: 'users.password.success', name: target.fullName ?? target.email });
    } finally {
      setResetBusy(false);
    }
  }, [resetTarget, resetUserPassword]);

  const handleRevealClose = useCallback(() => {
    /* Drop the credential on the way out — it is never cached or stored. */
    setRevealed(null);
  }, []);

  const handleRefresh = useCallback(() => {
    refresh();
    void refreshDelegatedUsers();
  }, [refresh, refreshDelegatedUsers]);

  const handleOpenDelegations = useCallback((user: ManagedUser) => {
    setDelegationTarget(user);
  }, []);
  const handleDelegationsChanged = useCallback(async () => {
    await Promise.all([capabilities.refetch(), refreshDelegatedUsers()]);
  }, [capabilities, refreshDelegatedUsers]);

  const realtimeLabel =
    realtimeState === 'live'
      ? t('users.realtime.live')
      : realtimeState === 'connecting'
        ? t('users.realtime.connecting')
        : t('users.realtime.offline');
  const realtimeDotClass =
    realtimeState === 'live'
      ? 'bg-success'
      : realtimeState === 'connecting'
        ? 'bg-warning'
        : 'bg-muted-foreground';

  /* Content-state machine: loading → error → denied → empty → table.
     A failed refresh over existing rows never blanks the screen. */
  let content: ReactNode;
  if (isInitialLoading) {
    content = <SkeletonTable />;
  } else if (fetchError !== null && users.length === 0) {
    content = (
      <div
        role="alert"
        className="bg-card flex flex-col items-center gap-4 rounded-2xl border border-dashed px-6 py-14 text-center"
      >
        <span className="bg-destructive/10 text-destructive grid size-14 place-items-center rounded-2xl">
          <AlertCircle className="size-6" aria-hidden="true" />
        </span>
        <div className="space-y-1.5">
          <h2 className="text-card-foreground text-base font-semibold">{t('users.error.title')}</h2>
          <p className="text-muted-foreground mx-auto max-w-md text-sm">
            {t(USERS_ERROR_KEYS[fetchError])}
          </p>
        </div>
        {RETRYABLE_CODES.has(fetchError) && (
          <button
            type="button"
            onClick={handleRefresh}
            className={`${PRIMARY_BUTTON_CLASS} bg-primary text-primary-foreground`}
          >
            <RefreshCw className="size-4" aria-hidden="true" />
            {t('users.retry')}
          </button>
        )}
      </div>
    );
  } else if (!canViewApprovalQueue) {
    /* Route-capability fallback — never misreport denied access as an empty table. */
    content = (
      <div className="bg-card animate-fade-in flex flex-col items-center gap-4 rounded-2xl border border-dashed px-6 py-14 text-center">
        <span className="bg-destructive/10 text-destructive grid size-14 place-items-center rounded-2xl">
          <Lock className="size-6" aria-hidden="true" />
        </span>
        <div className="space-y-1.5">
          <p className="text-destructive text-xs font-semibold tracking-widest">
            {t('users.denied.code')}
          </p>
          <h2 className="text-card-foreground text-base font-semibold">
            {t('users.denied.title')}
          </h2>
          <p className="text-muted-foreground mx-auto max-w-md text-sm">{t('users.denied.body')}</p>
        </div>
        <Link to="/" className={`${PRIMARY_BUTTON_CLASS} bg-primary text-primary-foreground`}>
          {t('users.denied.back')}
        </Link>
      </div>
    );
  } else if (filteredUsers.length === 0) {
    content = (
      <EmptyState icon={Users} title={t('users.empty.title')} description={t('users.empty.body')} />
    );
  } else {
    content = (
      <div className="@container">
        <div
          role="table"
          aria-label={t('users.table.label')}
          aria-busy={isRefreshing}
          className="@2xl:border-border @2xl:bg-card @2xl:overflow-hidden @2xl:rounded-2xl @2xl:border"
        >
          <div role="rowgroup" className="hidden @2xl:block">
            <div role="row" className={`grid ${ROW_GRID_COLS} border-border border-b px-4 py-3`}>
              {(
                [
                  'users.col.user',
                  'users.col.roles',
                  'users.col.status',
                  'users.col.created',
                  'users.col.action',
                ] as const
              ).map((key) => (
                <div
                  key={key}
                  role="columnheader"
                  className="text-muted-foreground text-xs font-semibold tracking-wide"
                >
                  {t(key)}
                </div>
              ))}
            </div>
          </div>

          <div role="rowgroup" className="flex flex-col gap-3 @2xl:gap-0">
            {filteredUsers.map((user) => (
              <UserRow
                key={user.id}
                user={user}
                delegations={delegatedUsers.get(user.id) ?? EMPTY_DELEGATIONS}
                actorId={actorId}
                actorIsSuperAdmin={actorIsSuperAdmin}
                activeSuperAdmins={activeSuperAdmins}
                pendingUserId={pendingUserId}
                canAdminister={canAdministerUsers}
                canApprove={actorCanApprove}
                canResetPassword={actorCanInvite}
                onAction={handleAction}
                onApproval={(user, action) => void handleApproval(user, action)}
                onEditRoles={handleEditRoles}
                onResetPassword={handleOpenResetPassword}
                onManageDelegations={handleOpenDelegations}
                canManageDelegations={actorCanInvite}
              />
            ))}
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
            {t(success.key, {
              name: success.name,
              role: success.roleName ?? '',
              roles: success.roles ?? '',
            })}
          </span>
          <button
            type="button"
            aria-label={t('users.confirm.cancel')}
            onClick={() => setSuccess(null)}
            className="text-success/80 hover:text-success grid size-7 place-items-center rounded-lg transition-colors"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>
      )}

      {opError !== null && pending === null && approvalDialog === null && (
        <p role="alert" className="text-destructive text-sm">
          {t(opError)}
        </p>
      )}
      {canAdministerUsers && (
        <div
          className="border-border bg-muted/50 inline-flex flex-wrap items-center gap-1 rounded-xl border p-1"
          role="tablist"
          aria-label={t('users.approval.filter')}
        >
          {(['all', 'pending', 'delegated', 'rejected'] as const).map((tab) => {
            const selected = activeTab === tab;
            const label =
              tab === 'delegated'
                ? `${t('users.filter.delegated')} (${delegatedCount})`
                : t(`users.filter.${tab}`);
            return (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => setActiveTab(tab)}
                className={`rounded-lg px-3 py-1 text-sm font-medium transition-colors ${
                  selected
                    ? 'bg-primary text-primary-foreground shadow-xs'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
      )}
      {/* Toolbar: count · realtime health · sync state · manual refresh */}
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="text-muted-foreground inline-flex items-center gap-1.5 text-sm">
          <Users className="size-4" aria-hidden="true" />
          {t('users.count', { count: filteredUsers.length })}
        </span>

        <span className="border-border bg-card text-muted-foreground inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs">
          <span className={`size-1.5 rounded-full ${realtimeDotClass}`} aria-hidden="true" />
          {realtimeLabel}
        </span>

        {isRefreshing ? (
          <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
            <Loader2
              className="size-3.5 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
            {t('users.syncing')}
          </span>
        ) : (
          lastSyncedAt !== null && (
            <span className="text-muted-foreground text-xs">
              {t('users.lastSynced', { time: formatDateTime(lastSyncedAt) })}
            </span>
          )
        )}

        <button
          type="button"
          onClick={handleRefresh}
          aria-disabled={isRefreshing}
          className="border-border bg-card text-foreground hover:bg-accent ms-auto inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-colors aria-disabled:cursor-not-allowed aria-disabled:opacity-60"
        >
          <RefreshCw
            className={`size-4 ${isRefreshing ? 'animate-spin motion-reduce:animate-none' : ''}`}
            aria-hidden="true"
          />
          {t('users.refresh')}
        </button>

        {/* Decision D2: inviting is owner/super_admin only, so the control is
            absent — not disabled — for everyone else. The RPC re-checks. */}
        {actorCanInvite && (
          <button
            type="button"
            onClick={handleOpenInvite}
            className={`${PRIMARY_BUTTON_CLASS} bg-primary text-primary-foreground`}
          >
            <UserPlus className="size-4" aria-hidden="true" />
            {t('users.invite.title')}
          </button>
        )}
      </div>

      {/* Live region for screen readers while a refetch is running. */}
      <p role="status" className="sr-only">
        {isRefreshing ? t('users.syncing') : ''}
      </p>

      {/* Non-blocking banner: a failed refresh over data we can still show. */}
      {fetchError !== null && users.length > 0 && !isInitialLoading && (
        <div
          role="alert"
          className="border-destructive/40 bg-destructive/10 text-destructive flex items-center gap-2.5 rounded-xl border px-4 py-3 text-sm"
        >
          <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
          <span className="flex-1">{t(USERS_ERROR_KEYS[fetchError])}</span>
          {RETRYABLE_CODES.has(fetchError) && (
            <button
              type="button"
              onClick={handleRefresh}
              className="text-destructive underline-offset-2 hover:underline"
            >
              {t('users.retry')}
            </button>
          )}
        </div>
      )}

      {content}

      {pending !== null && (
        <ConfirmStatusDialog
          user={pending.user}
          nextStatus={pending.nextStatus}
          busy={pendingUserId !== null}
          error={opError}
          onConfirm={() => void handleConfirm()}
          onCancel={handleCancel}
        />
      )}

      {approvalDialog !== null && (
        <ConfirmApprovalDialog
          user={approvalDialog.user}
          role={approvalDialog.role}
          canAssignAdministrativeRole={canAdministerUsers}
          busy={pendingUserId !== null}
          error={opError}
          onRoleChange={(role) => setApprovalDialog({ user: approvalDialog.user, role })}
          onConfirm={() => void handleApprovalConfirm()}
          onCancel={handleApprovalCancel}
        />
      )}

      {roleDialog !== null && (
        <ConfirmRoleDialog
          user={roleDialog}
          selectedRoles={selectedRoles}
          busy={pendingUserId !== null}
          error={roleChangeError}
          onRoleChange={handleRoleChange}
          onConfirm={() => void handleRoleConfirm()}
          onCancel={handleRoleCancel}
        />
      )}

      {inviteOpen && (
        <InviteUserDialog
          email={inviteForm.email}
          fullName={inviteForm.fullName}
          role={inviteForm.role}
          busy={inviteBusy}
          error={inviteError}
          onEmailChange={(email) => setInviteForm((form) => ({ ...form, email }))}
          onFullNameChange={(fullName) => setInviteForm((form) => ({ ...form, fullName }))}
          onRoleChange={(role) => setInviteForm((form) => ({ ...form, role }))}
          onConfirm={() => void handleInviteConfirm()}
          onCancel={handleInviteCancel}
        />
      )}

      {resetTarget !== null && (
        <ResetPasswordDialog
          user={resetTarget}
          busy={resetBusy}
          error={resetError}
          onConfirm={() => void handleResetPasswordConfirm()}
          onCancel={handleResetPasswordCancel}
        />
      )}

      {delegationTarget !== null && (
        <DelegationDialog
          user={delegationTarget}
          onClose={() => setDelegationTarget(null)}
          onChanged={handleDelegationsChanged}
        />
      )}

      {/* One-time credential. Rendered last so it sits above the form that
          produced it, and only ever with a password in hand. */}
      {revealed !== null && (
        <PasswordRevealDialog
          password={revealed.password}
          notice={revealed.notice !== null ? t(revealed.notice) : null}
          onClose={handleRevealClose}
        />
      )}
    </section>
  );
}
