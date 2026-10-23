import { AlertCircle, Ban, Check, Clock, Inbox, Info, Loader2, RefreshCw, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { EmptyState } from '@/components/ui/EmptyState';
import { PasswordRevealDialog } from '@/components/ui/PasswordRevealDialog';
import {
  PASSWORD_RESET_ERROR_KEYS,
  usePasswordResetRequests,
  type PasswordResetErrorCode,
  type PasswordResetRequestRow,
  type PasswordResetRequestStatus,
} from '@/hooks/usePasswordResetRequests';
import { useI18n, type TranslationKey } from '@/i18n/I18nContext';

/**
 * Password Reset Requests screen (renders inside SettingsPage for section
 * `password-resets`) — the admin half of the manual approval recovery flow.
 *
 * Visitors submit only an email. Owners/super_admin and `password_reset.manage`
 * delegates review the safe view here. On approval, the Edge Function generates
 * a one-time password, sends it directly to GoTrue, and returns it once for
 * `PasswordRevealDialog`; it is never selected from or stored in the database.
 *
 * The route and safe view are both capability-gated, and service-only RPCs
 * re-check the executor. The screen exposes only id, email, created_at and
 * status from the queue.
 */

/* ----------------------------------------------------------------- consts */

/**
 * Shared grid template for the header, the data rows and the skeletons, so
 * columns can never drift apart. `minmax(0, …)` lets text truncate instead
 * of overflowing.
 */
const ROW_GRID_COLS =
  'grid-cols-1 gap-2 @2xl:grid-cols-[minmax(0,2.4fr)_minmax(0,9rem)_minmax(0,11rem)_minmax(0,11rem)] @2xl:items-center @2xl:gap-4';

const STATUS_KEYS: Record<PasswordResetRequestStatus, TranslationKey> = {
  awaiting_password: 'passwordResets.status.awaitingPassword',
  pending_approval: 'passwordResets.status.pending',
  approved: 'passwordResets.status.approved',
  rejected: 'passwordResets.status.rejected',
};

const STATUS_ICONS: Record<PasswordResetRequestStatus, LucideIcon> = {
  awaiting_password: Loader2,
  pending_approval: Clock,
  approved: Check,
  rejected: Ban,
};

const STATUS_BADGE_CLASS: Record<PasswordResetRequestStatus, string> = {
  awaiting_password: 'border-warning/30 bg-warning/10 text-warning',
  pending_approval: 'border-warning/30 bg-warning/10 text-warning',
  approved: 'border-success/30 bg-success/10 text-success',
  rejected: 'border-destructive/30 bg-destructive/10 text-destructive',
};

const ACTION_BUTTON_CLASS =
  'inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60';

const PRIMARY_BUTTON_CLASS =
  'inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold transition-opacity hover:opacity-90 aria-disabled:cursor-not-allowed aria-disabled:opacity-60 disabled:cursor-not-allowed disabled:opacity-60';

/** Failures worth offering a retry for (never for permission classes). */
const RETRYABLE_CODES: ReadonlySet<PasswordResetErrorCode> = new Set([
  'network',
  'unknown',
  'rate-limited',
  'update-failed',
]);

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

function StatusBadge({ status }: { status: PasswordResetRequestStatus }) {
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

interface RequestRowProps {
  row: PasswordResetRequestRow;
  busy: boolean;
  onProcess: (row: PasswordResetRequestRow, action: 'approve' | 'reject') => void;
}

function RequestRow({ row, busy, onProcess }: RequestRowProps) {
  const { t } = useI18n();
  const formatDateTime = useDateTimeFormatter();

  return (
    <div
      role="row"
      className={`grid ${ROW_GRID_COLS} border-border bg-card rounded-xl border p-4 @2xl:rounded-none @2xl:border-x-0 @2xl:border-t-0 @2xl:p-3.5 @2xl:last:border-b-0`}
    >
      <Field label={t('passwordResets.col.email')} rowHeader>
        <p className="text-foreground truncate text-sm font-semibold">
          <bdi dir="ltr">{row.email}</bdi>
        </p>
      </Field>

      <Field label={t('passwordResets.col.status')}>
        <StatusBadge status={row.status} />
      </Field>

      <Field label={t('passwordResets.col.created')}>
        <time dateTime={row.createdAt} className="text-muted-foreground text-sm tabular-nums">
          {formatDateTime(row.createdAt)}
        </time>
      </Field>

      <div role="cell" className="flex flex-col items-start gap-1.5 @2xl:items-start">
        <span className="text-muted-foreground text-xs font-medium @2xl:hidden">
          {t('passwordResets.col.action')}
        </span>
        {row.status === 'pending_approval' ? (
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => onProcess(row, 'approve')}
              className={`${ACTION_BUTTON_CLASS} bg-primary text-primary-foreground`}
            >
              <Check className="size-4" aria-hidden="true" />
              {t('passwordResets.approve')}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => onProcess(row, 'reject')}
              className={`${ACTION_BUTTON_CLASS} bg-destructive text-destructive-foreground`}
            >
              <Ban className="size-4" aria-hidden="true" />
              {t('passwordResets.reject')}
            </button>
          </div>
        ) : (
          <span className="text-muted-foreground text-xs">—</span>
        )}
      </div>
    </div>
  );
}

function SkeletonList() {
  const { t } = useI18n();
  return (
    <div className="@container">
      <div
        aria-busy="true"
        className="@2xl:border-border @2xl:bg-card @2xl:overflow-hidden @2xl:rounded-2xl @2xl:border"
      >
        <div role="status" className="sr-only">
          {t('passwordResets.loading')}
        </div>
        <div className={`hidden @2xl:grid ${ROW_GRID_COLS} border-border border-b px-4 py-3`}>
          {[2.4, 0.9, 1.1, 1.1].map((weight, index) => (
            <div
              key={`${index}-${weight}`}
              className="bg-muted h-3 animate-pulse rounded motion-reduce:animate-none"
              style={{ width: `${weight * 2.2}rem`, maxWidth: '100%' }}
            />
          ))}
        </div>
        <div className="flex flex-col gap-3 @2xl:gap-0">
          {Array.from({ length: SKELETON_ROWS }, (_, index) => (
            <div
              key={index}
              className={`grid ${ROW_GRID_COLS} border-border bg-card rounded-xl border p-4 @2xl:rounded-none @2xl:border-x-0 @2xl:border-t-0 @2xl:p-3.5 @2xl:last:border-b-0`}
            >
              {[65, 35, 55, 45].map((width, cellIndex) => (
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

interface ConfirmProcessDialogProps {
  row: PasswordResetRequestRow;
  action: 'approve' | 'reject';
  busy: boolean;
  /** Resolved message key of the last failed operation. */
  error: TranslationKey | null;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Accessible confirmation dialog: portal + focus trap + Escape. Approving
 * writes the visitor's chosen password onto the live account immediately, so
 * it always asks first; rejecting is confirmed through the same dialog.
 */
function ConfirmProcessDialog({
  row,
  action,
  busy,
  error,
  onConfirm,
  onCancel,
}: ConfirmProcessDialogProps) {
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
          {t('passwordResets.confirm.title')}
        </h2>
        <p id={bodyId} className="text-muted-foreground mt-2 text-sm leading-relaxed">
          {t(
            action === 'approve'
              ? 'passwordResets.confirm.approve_with_generation'
              : 'passwordResets.confirm.rejectBody',
            { email: row.email },
          )}
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
            {t('passwordResets.confirm.cancel')}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            aria-disabled={busy}
            className={`${PRIMARY_BUTTON_CLASS} ${
              action === 'approve'
                ? 'bg-primary text-primary-foreground'
                : 'bg-destructive text-destructive-foreground'
            }`}
          >
            {busy && (
              <Loader2
                className="size-4 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            )}
            {action === 'approve'
              ? t('passwordResets.confirm.approve')
              : t('passwordResets.confirm.reject')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* ----------------------------------------------------------------- page */

export default function PasswordResetRequests() {
  const { t } = useI18n();
  const formatDateTime = useDateTimeFormatter();
  const {
    requests,
    statusFilter,
    setStatusFilter,
    approveRequest,
    rejectRequest,
    pendingRequestId,
    isInitialLoading,
    isRefreshing,
    fetchError,
    lastSyncedAt,
    refresh,
  } = usePasswordResetRequests();

  const [dialog, setDialog] = useState<{
    row: PasswordResetRequestRow;
    action: 'approve' | 'reject';
  } | null>(null);
  const [opError, setOpError] = useState<TranslationKey | null>(null);
  const [success, setSuccess] = useState<{ key: TranslationKey; email: string } | null>(null);
  /* The one-time generated password: held only until the reveal dialog closes. */
  const [revealedPassword, setRevealedPassword] = useState<string | null>(null);

  const handleProcess = useCallback(
    (row: PasswordResetRequestRow, action: 'approve' | 'reject') => {
      setOpError(null);
      setSuccess(null);
      setDialog({ row, action });
    },
    [],
  );

  const handleConfirm = useCallback(async () => {
    if (dialog === null) {
      return;
    }
    setOpError(null);
    const result =
      dialog.action === 'approve'
        ? await approveRequest(dialog.row.id)
        : await rejectRequest(dialog.row.id);
    if (result.ok) {
      setSuccess({
        key:
          dialog.action === 'approve'
            ? 'passwordResets.success.approved_with_password'
            : 'passwordResets.success.rejected',
        email: dialog.row.email,
      });
      setDialog(null);
      if (dialog.action === 'approve' && result.tempPassword) {
        setRevealedPassword(result.tempPassword);
      }
    } else {
      setOpError(PASSWORD_RESET_ERROR_KEYS[result.code]);
    }
  }, [approveRequest, dialog, rejectRequest]);

  const handleCancel = useCallback(() => {
    setDialog(null);
    setOpError(null);
  }, []);

  const handleRevealClose = useCallback(() => {
    setRevealedPassword(null);
    refresh();
  }, [refresh]);

  /* Content-state machine: loading → error → empty → table.
     A failed refresh over existing rows never blanks the screen. */
  let content: ReactNode;
  if (isInitialLoading) {
    content = <SkeletonList />;
  } else if (fetchError !== null && requests.length === 0) {
    content = (
      <div
        role="alert"
        className="bg-card flex flex-col items-center gap-4 rounded-2xl border border-dashed px-6 py-14 text-center"
      >
        <span className="bg-destructive/10 text-destructive grid size-14 place-items-center rounded-2xl">
          <AlertCircle className="size-6" aria-hidden="true" />
        </span>
        <div className="space-y-1.5">
          <h2 className="text-card-foreground text-base font-semibold">
            {t('passwordResets.error.title')}
          </h2>
          <p className="text-muted-foreground mx-auto max-w-md text-sm">
            {t(PASSWORD_RESET_ERROR_KEYS[fetchError])}
          </p>
        </div>
        {RETRYABLE_CODES.has(fetchError) && (
          <button
            type="button"
            onClick={refresh}
            className={`${PRIMARY_BUTTON_CLASS} bg-primary text-primary-foreground`}
          >
            <RefreshCw className="size-4" aria-hidden="true" />
            {t('passwordResets.retry')}
          </button>
        )}
      </div>
    );
  } else if (requests.length === 0) {
    content = (
      <EmptyState
        icon={Inbox}
        title={
          statusFilter === 'pending'
            ? t('passwordResets.empty.pending.title')
            : t('passwordResets.empty.title')
        }
        description={
          statusFilter === 'pending'
            ? t('passwordResets.empty.pending.body')
            : t('passwordResets.empty.body')
        }
      />
    );
  } else {
    content = (
      <div className="@container">
        <div
          role="table"
          aria-label={t('passwordResets.table.label')}
          aria-busy={isRefreshing}
          className="@2xl:border-border @2xl:bg-card @2xl:overflow-hidden @2xl:rounded-2xl @2xl:border"
        >
          <div role="rowgroup" className="hidden @2xl:block">
            <div role="row" className={`grid ${ROW_GRID_COLS} border-border border-b px-4 py-3`}>
              {(
                [
                  'passwordResets.col.email',
                  'passwordResets.col.status',
                  'passwordResets.col.created',
                  'passwordResets.col.action',
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
            {requests.map((row) => (
              <RequestRow
                key={row.id}
                row={row}
                busy={pendingRequestId === row.id}
                onProcess={(target, action) => void handleProcess(target, action)}
              />
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <section className="space-y-4">
      {/* Security/transparency note: what approving actually does. */}
      <div className="border-border bg-card flex items-start gap-2.5 rounded-xl border px-4 py-3 text-sm">
        <Info className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <span className="text-muted-foreground text-xs leading-relaxed">
          {t('passwordResets.hint')}
        </span>
      </div>

      {/* Operation result (polite) — never steals focus. */}
      {success !== null && (
        <div
          role="status"
          className="border-success/40 bg-success/10 text-success flex items-center gap-2.5 rounded-xl border px-4 py-3 text-sm"
        >
          <Check className="size-4 shrink-0" aria-hidden="true" />
          <span className="flex-1">{t(success.key, { email: success.email })}</span>
          <button
            type="button"
            aria-label={t('passwordResets.confirm.cancel')}
            onClick={() => setSuccess(null)}
            className="text-success/80 hover:text-success grid size-7 place-items-center rounded-lg transition-colors"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>
      )}

      {opError !== null && dialog === null && (
        <p role="alert" className="text-destructive text-sm">
          {t(opError)}
        </p>
      )}

      <div className="flex gap-2" role="group" aria-label={t('passwordResets.filter')}>
        {(['pending', 'processed', 'all'] as const).map((filter) => (
          <button
            key={filter}
            type="button"
            aria-pressed={statusFilter === filter}
            onClick={() => setStatusFilter(filter)}
            className={`rounded-lg border px-3 py-1 text-sm ${statusFilter === filter ? 'bg-primary text-primary-foreground' : 'bg-card'}`}
          >
            {t(`passwordResets.filter.${filter}`)}
          </button>
        ))}
      </div>

      {/* Toolbar: count · sync state · manual refresh */}
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="text-muted-foreground inline-flex items-center gap-1.5 text-sm">
          <Inbox className="size-4" aria-hidden="true" />
          {t('passwordResets.count', { count: requests.length })}
        </span>

        {isRefreshing ? (
          <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
            <Loader2
              className="size-3.5 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
            {t('passwordResets.syncing')}
          </span>
        ) : (
          lastSyncedAt !== null && (
            <span className="text-muted-foreground text-xs">
              {t('passwordResets.lastSynced', { time: formatDateTime(lastSyncedAt) })}
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
          {t('passwordResets.refresh')}
        </button>
      </div>

      {/* Live region for screen readers while a refetch is running. */}
      <p role="status" className="sr-only">
        {isRefreshing ? t('passwordResets.syncing') : ''}
      </p>

      {/* Non-blocking banner: a failed refresh over data we can still show. */}
      {fetchError !== null && requests.length > 0 && !isInitialLoading && (
        <div
          role="alert"
          className="border-destructive/40 bg-destructive/10 text-destructive flex items-center gap-2.5 rounded-xl border px-4 py-3 text-sm"
        >
          <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
          <span className="flex-1">{t(PASSWORD_RESET_ERROR_KEYS[fetchError])}</span>
          {RETRYABLE_CODES.has(fetchError) && (
            <button
              type="button"
              onClick={refresh}
              className="text-destructive underline-offset-2 hover:underline"
            >
              {t('passwordResets.retry')}
            </button>
          )}
        </div>
      )}

      {content}

      {dialog !== null && (
        <ConfirmProcessDialog
          row={dialog.row}
          action={dialog.action}
          busy={pendingRequestId !== null}
          error={opError}
          onConfirm={() => void handleConfirm()}
          onCancel={handleCancel}
        />
      )}

      {/* One-time credential: shown once, dropped on close, then refetched. */}
      {revealedPassword !== null && (
        <PasswordRevealDialog password={revealedPassword} onClose={handleRevealClose} />
      )}
    </section>
  );
}
