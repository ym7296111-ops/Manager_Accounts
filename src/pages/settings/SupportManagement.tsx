import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  Clock,
  LifeBuoy,
  Loader2,
  Lock,
  MessageSquare,
  Plus,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  SlidersHorizontal,
  User,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router';
import { EmptyState } from '@/components/ui/EmptyState';
import { useAuthCapabilities } from '@/hooks/useAuthCapabilities';
import {
  getStatusUpdateBlocker,
  SUPPORT_ERROR_KEYS,
  SUPPORT_MANAGE_CAPABILITY,
  useSupportManagement,
  validateCreateTicketInput,
  validateReplyBody,
  type SupportErrorCode,
  type SupportTicket,
  type SupportTicketReply,
  type TicketPriority,
  type TicketStatus,
} from '@/hooks/useSupportManagement';
import { useI18n, type TranslationKey } from '@/i18n/I18nContext';

/**
 * Support & Maintenance screen (renders inside SettingsPage for section `support`).
 *
 * * ONE DOM tree serves both layouts through container queries (`@container`):
 *   - Wide containers (`@4xl:` >= 896px): Master-Detail Split View with the
 *     active tickets list beside the live chronological conversation thread.
 *   - Narrow / mobile containers (`< 896px`): Alternating view where the user
 *     browses the tickets list and tapping any ticket opens the full-width
 *     conversation view with a back navigation control.
 * * Realtime invalidation signals keep both the ticket list and the open
 *   thread synchronized between the requester and support agents.
 * * Every mutation (`createTicket`, `addReply`, `updateTicketStatus`) executes
 *   through guarded `SECURITY DEFINER` RPCs and maps errors onto the bilingual
 *   dictionary.
 */

/* ----------------------------------------------------------------- consts */

const STATUS_KEYS: Record<TicketStatus, TranslationKey> = {
  opened: 'support.status.opened',
  in_progress: 'support.status.in_progress',
  resolved: 'support.status.resolved',
  closed: 'support.status.closed',
};

const STATUS_BADGE_CLASS: Record<TicketStatus, string> = {
  opened: 'border-primary/30 bg-primary/10 text-primary',
  in_progress: 'border-warning/30 bg-warning/10 text-warning',
  resolved: 'border-success/30 bg-success/10 text-success',
  closed: 'border-border bg-muted text-muted-foreground',
};

const STATUS_ICONS: Record<TicketStatus, LucideIcon> = {
  opened: MessageSquare,
  in_progress: Clock,
  resolved: CheckCircle2,
  closed: Lock,
};

const PRIORITY_KEYS: Record<TicketPriority, TranslationKey> = {
  low: 'support.priority.low',
  medium: 'support.priority.medium',
  high: 'support.priority.high',
};

const PRIORITY_BADGE_CLASS: Record<TicketPriority, string> = {
  low: 'border-border bg-muted/70 text-muted-foreground',
  medium: 'border-warning/30 bg-warning/10 text-warning',
  high: 'border-destructive/30 bg-destructive/10 text-destructive',
};

const ALL_STATUSES: readonly TicketStatus[] = ['opened', 'in_progress', 'resolved', 'closed'];
const ALL_PRIORITIES: readonly TicketPriority[] = ['low', 'medium', 'high'];

const RETRYABLE_CODES: ReadonlySet<SupportErrorCode> = new Set([
  'network',
  'unknown',
  'rate-limited',
]);

const PRIMARY_BUTTON_CLASS =
  'inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold transition-opacity hover:opacity-90 aria-disabled:cursor-not-allowed aria-disabled:opacity-60';

const SKELETON_TICKET_CARDS = 4;
const SKELETON_REPLY_ITEMS = 3;

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

function StatusBadge({ status }: { status: TicketStatus }) {
  const { t } = useI18n();
  const Icon = STATUS_ICONS[status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${STATUS_BADGE_CLASS[status]}`}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden="true" />
      {t(STATUS_KEYS[status])}
    </span>
  );
}

function PriorityBadge({ priority }: { priority: TicketPriority }) {
  const { t } = useI18n();
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${PRIORITY_BADGE_CLASS[priority]}`}
    >
      {t(PRIORITY_KEYS[priority])}
    </span>
  );
}

function SkeletonScreen() {
  const { t } = useI18n();
  return (
    <div className="@container" aria-busy="true">
      <div role="status" className="sr-only">
        {t('support.loading')}
      </div>
      <div className="grid grid-cols-1 gap-4 @4xl:grid-cols-[minmax(0,21rem)_minmax(0,1fr)] @4xl:items-start">
        <div className="flex flex-col gap-2.5">
          {Array.from({ length: SKELETON_TICKET_CARDS }, (_, index) => (
            <div
              key={index}
              className="border-border bg-card h-24 animate-pulse rounded-2xl border p-4 motion-reduce:animate-none"
            />
          ))}
        </div>
        <div className="border-border bg-card space-y-4 rounded-2xl border p-5">
          <div className="bg-muted h-6 w-1/2 animate-pulse rounded motion-reduce:animate-none" />
          <div className="bg-muted h-20 w-full animate-pulse rounded-xl motion-reduce:animate-none" />
          <div className="space-y-3 pt-2">
            {Array.from({ length: SKELETON_REPLY_ITEMS }, (_, index) => (
              <div
                key={index}
                className="bg-muted/70 h-16 w-4/5 animate-pulse rounded-2xl motion-reduce:animate-none"
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function RepliesSkeleton() {
  const { t } = useI18n();
  return (
    <div className="space-y-3 py-2" aria-busy="true">
      <div role="status" className="sr-only">
        {t('support.thread.loadingReplies')}
      </div>
      {Array.from({ length: SKELETON_REPLY_ITEMS }, (_, index) => (
        <div
          key={index}
          className={`border-border bg-muted/40 h-20 animate-pulse rounded-2xl border p-4 motion-reduce:animate-none ${
            index % 2 === 1 ? 'ms-auto w-5/6' : 'me-auto w-5/6'
          }`}
        />
      ))}
    </div>
  );
}

interface ReplyBubbleProps {
  reply: SupportTicketReply;
  actorId: string | null;
  formatDateTime: (value: string | number) => string;
}

function ReplyBubble({ reply, actorId, formatDateTime }: ReplyBubbleProps) {
  const { t, locale } = useI18n();
  const isSelf = actorId !== null && reply.senderId === actorId;
  const senderName =
    reply.sender?.fullName ??
    (reply.sender?.email ? reply.sender.email : null) ??
    (reply.isSupportReply ? t('support.reply.supportBadge') : t('support.reply.userBadge'));

  return (
    <article
      className={`rounded-2xl border p-4 transition-colors ${
        reply.isSupportReply
          ? 'border-primary/30 bg-primary/5 ms-0 @lg:ms-6'
          : 'border-border bg-card me-0 @lg:me-6'
      }`}
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${
              reply.isSupportReply
                ? 'border-primary/40 bg-primary/15 text-primary'
                : 'border-border bg-muted text-muted-foreground'
            }`}
          >
            {reply.isSupportReply ? (
              <ShieldCheck className="size-3.5 shrink-0" aria-hidden="true" />
            ) : (
              <User className="size-3.5 shrink-0" aria-hidden="true" />
            )}
            {reply.isSupportReply ? t('support.reply.supportBadge') : t('support.reply.userBadge')}
          </span>

          <span className="text-foreground text-xs font-semibold">
            <bdi dir="auto">{senderName}</bdi>
          </span>

          {isSelf && (
            <span className="bg-secondary text-secondary-foreground rounded-full px-2 py-0.5 text-[11px] font-medium">
              {t('support.reply.you')}
            </span>
          )}

          {reply.sender?.roles.map((role) => (
            <span
              key={role.slug}
              className="border-border bg-background text-muted-foreground rounded-full border px-2 py-0.5 text-[11px]"
            >
              {locale === 'ar' ? role.nameAr : role.nameEn}
            </span>
          ))}
        </div>

        <time dateTime={reply.createdAt} className="text-muted-foreground text-xs tabular-nums">
          {formatDateTime(reply.createdAt)}
        </time>
      </header>

      <p className="text-foreground mt-2.5 text-sm leading-relaxed whitespace-pre-wrap">
        <bdi dir="auto">{reply.body}</bdi>
      </p>
    </article>
  );
}

interface NewTicketDialogProps {
  busy: boolean;
  error: SupportErrorCode | null;
  onSubmit: (input: { subject: string; description: string; priority: TicketPriority }) => void;
  onCancel: () => void;
}

/** Accessible modal dialog to create a new support ticket. */
function NewTicketDialog({ busy, error, onSubmit, onCancel }: NewTicketDialogProps) {
  const { t } = useI18n();
  const panelRef = useRef<HTMLDivElement>(null);
  const subjectInputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const subtitleId = useId();
  const subjectId = useId();
  const priorityId = useId();
  const descriptionId = useId();
  const errorId = useId();

  const [subject, setSubject] = useState('');
  const [priority, setPriority] = useState<TicketPriority>('medium');
  const [description, setDescription] = useState('');
  const [localError, setLocalError] = useState<SupportErrorCode | null>(null);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    subjectInputRef.current?.focus();
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

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) {
      return;
    }
    const validation = validateCreateTicketInput({ subject, description, priority });
    if (validation !== null) {
      setLocalError(validation);
      return;
    }
    setLocalError(null);
    onSubmit({ subject, description, priority });
  };

  const displayedError = error ?? localError;

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
        aria-describedby={subtitleId}
        onKeyDown={handleKeyDown}
        className="bg-card text-card-foreground animate-scale-in border-border w-full max-w-lg rounded-2xl border p-5 shadow-xl motion-reduce:animate-none"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id={titleId} className="text-card-foreground text-base font-semibold">
              {t('support.newTicket.title')}
            </h2>
            <p id={subtitleId} className="text-muted-foreground mt-1 text-xs leading-relaxed">
              {t('support.newTicket.subtitle')}
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            aria-disabled={busy}
            aria-label={t('support.newTicket.cancel')}
            className="text-muted-foreground hover:text-foreground grid size-8 place-items-center rounded-lg transition-colors"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          <div>
            <label htmlFor={subjectId} className="text-foreground mb-1.5 block text-xs font-medium">
              {t('support.newTicket.subject')}
            </label>
            <input
              ref={subjectInputRef}
              id={subjectId}
              type="text"
              required
              minLength={5}
              maxLength={200}
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
              placeholder={t('support.newTicket.subjectPlaceholder')}
              className="border-input bg-background text-foreground focus-visible:outline-ring h-10 w-full rounded-lg border px-3 text-sm focus-visible:outline-2"
            />
          </div>

          <div>
            <label
              htmlFor={priorityId}
              className="text-foreground mb-1.5 block text-xs font-medium"
            >
              {t('support.newTicket.priority')}
            </label>
            <select
              id={priorityId}
              value={priority}
              onChange={(event) => setPriority(event.target.value as TicketPriority)}
              className="border-input bg-background text-foreground focus-visible:outline-ring h-10 w-full rounded-lg border px-3 text-sm focus-visible:outline-2"
            >
              {ALL_PRIORITIES.map((level) => (
                <option key={level} value={level}>
                  {t(PRIORITY_KEYS[level])}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label
              htmlFor={descriptionId}
              className="text-foreground mb-1.5 block text-xs font-medium"
            >
              {t('support.newTicket.description')}
            </label>
            <textarea
              id={descriptionId}
              required
              rows={4}
              minLength={10}
              maxLength={5000}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder={t('support.newTicket.descriptionPlaceholder')}
              className="border-input bg-background text-foreground focus-visible:outline-ring w-full rounded-lg border p-3 text-sm leading-relaxed focus-visible:outline-2"
            />
          </div>

          {displayedError !== null && (
            <div
              id={errorId}
              role="alert"
              className="border-destructive/40 bg-destructive/10 text-destructive flex items-center gap-2.5 rounded-xl border px-4 py-3 text-sm"
            >
              <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
              <span>{t(SUPPORT_ERROR_KEYS[displayedError])}</span>
            </div>
          )}

          <div className="flex flex-col-reverse gap-2.5 pt-2 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={onCancel}
              aria-disabled={busy}
              className="border-border bg-background text-foreground hover:bg-accent inline-flex items-center justify-center gap-2 rounded-lg border px-4 py-2.5 text-sm font-semibold transition-colors aria-disabled:cursor-not-allowed aria-disabled:opacity-60"
            >
              {t('support.newTicket.cancel')}
            </button>
            <button
              type="submit"
              aria-disabled={busy}
              className={`${PRIMARY_BUTTON_CLASS} bg-primary text-primary-foreground`}
            >
              {busy ? (
                <Loader2
                  className="size-4 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
              ) : (
                <Plus className="size-4" aria-hidden="true" />
              )}
              {t('support.newTicket.submit')}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}

/* ----------------------------------------------------------------- page */

export default function SupportManagement() {
  const { t, dir } = useI18n();
  const formatDateTime = useDateTimeFormatter();
  const {
    tickets,
    replies,
    selectedTicket,
    selectTicket,
    actorId,
    actorIsActive,
    actorIsSupportAgent,
    isInitialLoading,
    isRefreshing,
    isLoadingReplies,
    fetchError,
    repliesError,
    lastSyncedAt,
    realtimeState,
    isCreatingTicket,
    isSendingReply,
    isUpdatingStatus,
    refresh,
    createTicket,
    addReply,
    updateTicketStatus,
  } = useSupportManagement();

  /* Phase 3A — capability gate for the agent toolbox: `hasCapability('support
     .manage')` through the server-resolved capability channel, never a role
     name. While the channel is silent the hook's resolved flag keeps the
     exact same surface (the `useNotificationAccess` fallback pattern). */
  const capabilities = useAuthCapabilities();
  const canAdministerTickets = capabilities.isAuthoritative
    ? capabilities.hasCapability(SUPPORT_MANAGE_CAPABILITY)
    : actorIsSupportAgent;

  /* Mobile/narrow-container pane state (`@4xl:` always shows both panes). */
  const [mobilePane, setMobilePane] = useState<'list' | 'thread'>('list');
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | TicketStatus>('all');
  const [priorityFilter, setPriorityFilter] = useState<'all' | TicketPriority>('all');

  /* New ticket modal state */
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [createError, setCreateError] = useState<SupportErrorCode | null>(null);

  /* Thread composer & admin status controls state */
  const [replyDraft, setReplyDraft] = useState('');
  const [statusDraft, setStatusDraft] = useState<TicketStatus | null>(null);
  const [priorityDraft, setPriorityDraft] = useState<TicketPriority | null>(null);
  const [opError, setOpError] = useState<SupportErrorCode | null>(null);
  const [successBanner, setSuccessBanner] = useState<string | null>(null);

  const searchInputId = useId();
  const statusFilterId = useId();
  const priorityFilterId = useId();
  const adminStatusSelectId = useId();
  const adminPrioritySelectId = useId();
  const replyInputId = useId();
  const closedNoticeId = useId();
  const threadEndRef = useRef<HTMLDivElement>(null);

  const effectiveStatusDraft = statusDraft ?? selectedTicket?.status ?? 'opened';
  const effectivePriorityDraft = priorityDraft ?? selectedTicket?.priority ?? 'medium';

  /* Filter tickets by search query, status, and priority. */
  const filteredTickets = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return tickets.filter((ticket) => {
      if (statusFilter !== 'all' && ticket.status !== statusFilter) {
        return false;
      }
      if (priorityFilter !== 'all' && ticket.priority !== priorityFilter) {
        return false;
      }
      if (query !== '') {
        const matchesNumber =
          String(ticket.ticketNumber).includes(query) || `#${ticket.ticketNumber}`.includes(query);
        const matchesSubject = ticket.subject.toLowerCase().includes(query);
        const matchesRequester =
          (ticket.requester?.fullName?.toLowerCase().includes(query) ?? false) ||
          (ticket.requester?.email.toLowerCase().includes(query) ?? false);
        if (!matchesNumber && !matchesSubject && !matchesRequester) {
          return false;
        }
      }
      return true;
    });
  }, [tickets, searchQuery, statusFilter, priorityFilter]);

  /* Scroll to the bottom of the thread when new replies arrive. */
  useEffect(() => {
    if (replies.length > 0 && typeof threadEndRef.current?.scrollIntoView === 'function') {
      threadEndRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [replies.length, selectedTicket?.id]);

  const handleSelectTicket = useCallback(
    (ticket: SupportTicket) => {
      selectTicket(ticket.id);
      setStatusDraft(null);
      setPriorityDraft(null);
      setOpError(null);
      setMobilePane('thread');
    },
    [selectTicket],
  );

  const handleCreateTicket = useCallback(
    async (input: { subject: string; description: string; priority: TicketPriority }) => {
      setCreateError(null);
      const result = await createTicket(input);
      if (result.ok) {
        setCreateDialogOpen(false);
        setSuccessBanner(
          t('support.success.ticketCreated', {
            number: result.ticketNumber,
          }),
        );
        setMobilePane('thread');
      } else {
        setCreateError(result.code);
      }
    },
    [createTicket, t],
  );

  const handleSendReply = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (selectedTicket === null || isSendingReply) {
        return;
      }
      setOpError(null);
      const blocker = validateReplyBody(selectedTicket, replyDraft);
      if (blocker !== null) {
        setOpError(blocker);
        return;
      }

      const result = await addReply(selectedTicket.id, replyDraft);
      if (result.ok) {
        setReplyDraft('');
        setSuccessBanner(t('support.success.replySent'));
      } else {
        setOpError(result.code);
      }
    },
    [selectedTicket, isSendingReply, replyDraft, addReply, t],
  );

  const handleUpdateStatus = useCallback(async () => {
    if (selectedTicket === null || isUpdatingStatus) {
      return;
    }
    setOpError(null);
    const result = await updateTicketStatus(
      selectedTicket.id,
      effectiveStatusDraft,
      effectivePriorityDraft,
    );
    if (result.ok) {
      setStatusDraft(null);
      setPriorityDraft(null);
      setSuccessBanner(
        t('support.success.statusUpdated', {
          number: selectedTicket.ticketNumber,
        }),
      );
    } else {
      setOpError(result.code);
    }
  }, [
    selectedTicket,
    isUpdatingStatus,
    updateTicketStatus,
    effectiveStatusDraft,
    effectivePriorityDraft,
    t,
  ]);

  const statusUpdateBlocker = useMemo(
    () =>
      getStatusUpdateBlocker({
        ticket: selectedTicket,
        actorIsSupportAgent: canAdministerTickets,
        nextStatus: effectiveStatusDraft,
        nextPriority: effectivePriorityDraft,
      }),
    [selectedTicket, canAdministerTickets, effectiveStatusDraft, effectivePriorityDraft],
  );

  const realtimeLabel =
    realtimeState === 'live'
      ? t('support.realtime.live')
      : realtimeState === 'connecting'
        ? t('support.realtime.connecting')
        : t('support.realtime.offline');
  const realtimeDotClass =
    realtimeState === 'live'
      ? 'bg-success'
      : realtimeState === 'connecting'
        ? 'bg-warning'
        : 'bg-muted-foreground';

  const BackArrowIcon = dir === 'rtl' ? ArrowRight : ArrowLeft;

  /* Content state machine: loading → error → inactive/denied → empty → split view. */
  let content: ReactNode;
  if (isInitialLoading) {
    content = <SkeletonScreen />;
  } else if (fetchError !== null && tickets.length === 0) {
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
            {t('support.error.title')}
          </h2>
          <p className="text-muted-foreground mx-auto max-w-md text-sm">
            {t(SUPPORT_ERROR_KEYS[fetchError])}
          </p>
        </div>
        {RETRYABLE_CODES.has(fetchError) && (
          <button
            type="button"
            onClick={refresh}
            className={`${PRIMARY_BUTTON_CLASS} bg-primary text-primary-foreground`}
          >
            <RefreshCw className="size-4" aria-hidden="true" />
            {t('support.retry')}
          </button>
        )}
      </div>
    );
  } else if (!actorIsActive) {
    content = (
      <div className="bg-card animate-fade-in flex flex-col items-center gap-4 rounded-2xl border border-dashed px-6 py-14 text-center">
        <span className="bg-destructive/10 text-destructive grid size-14 place-items-center rounded-2xl">
          <Lock className="size-6" aria-hidden="true" />
        </span>
        <div className="space-y-1.5">
          <p className="text-destructive text-xs font-semibold tracking-widest">
            {t('support.denied.code')}
          </p>
          <h2 className="text-card-foreground text-base font-semibold">
            {t('support.denied.title')}
          </h2>
          <p className="text-muted-foreground mx-auto max-w-md text-sm">
            {t('support.denied.body')}
          </p>
        </div>
        <Link to="/" className={`${PRIMARY_BUTTON_CLASS} bg-primary text-primary-foreground`}>
          {t('support.denied.back')}
        </Link>
      </div>
    );
  } else if (tickets.length === 0) {
    content = (
      <div className="@container">
        <div className="grid grid-cols-1 gap-4 @4xl:grid-cols-[minmax(0,21rem)_minmax(0,1fr)] @4xl:items-start">
          <div className="@4xl:col-span-2">
            <EmptyState
              icon={LifeBuoy}
              title={t('support.empty.title')}
              description={t('support.empty.body')}
            />
          </div>
        </div>
      </div>
    );
  } else {
    const isSelectedClosed = selectedTicket?.status === 'closed';

    content = (
      <div className="@container">
        {/* ONE DOM tree: 1 column on narrow containers, 2 columns (Master-Detail) at @4xl (>= 896px) */}
        <div className="grid grid-cols-1 gap-4 @4xl:grid-cols-[minmax(0,21rem)_minmax(0,1fr)] @4xl:items-start">
          {/* Master Column: Active Tickets List + Search & Filters */}
          <nav
            aria-label={t('support.list.label')}
            className={`${
              mobilePane === 'thread' ? 'hidden @4xl:block' : 'block'
            } space-y-3 @4xl:sticky @4xl:top-4`}
          >
            {/* Search and filter controls */}
            <div className="border-border bg-card space-y-2.5 rounded-2xl border p-3.5">
              <div className="relative">
                <label htmlFor={searchInputId} className="sr-only">
                  {t('support.search.label')}
                </label>
                <Search
                  className="text-muted-foreground pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2"
                  aria-hidden="true"
                />
                <input
                  id={searchInputId}
                  type="search"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder={t('support.search.placeholder')}
                  className="border-input bg-background text-foreground focus-visible:outline-ring h-9 w-full rounded-lg border ps-9 pe-3 text-xs focus-visible:outline-2"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label htmlFor={statusFilterId} className="sr-only">
                    {t('support.filter.status')}
                  </label>
                  <select
                    id={statusFilterId}
                    value={statusFilter}
                    onChange={(event) =>
                      setStatusFilter(event.target.value as 'all' | TicketStatus)
                    }
                    className="border-input bg-background text-foreground focus-visible:outline-ring h-8 w-full rounded-lg border px-2 text-xs focus-visible:outline-2"
                  >
                    <option value="all">{t('support.filter.allStatuses')}</option>
                    {ALL_STATUSES.map((status) => (
                      <option key={status} value={status}>
                        {t(STATUS_KEYS[status])}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label htmlFor={priorityFilterId} className="sr-only">
                    {t('support.filter.priority')}
                  </label>
                  <select
                    id={priorityFilterId}
                    value={priorityFilter}
                    onChange={(event) =>
                      setPriorityFilter(event.target.value as 'all' | TicketPriority)
                    }
                    className="border-input bg-background text-foreground focus-visible:outline-ring h-8 w-full rounded-lg border px-2 text-xs focus-visible:outline-2"
                  >
                    <option value="all">{t('support.filter.allPriorities')}</option>
                    {ALL_PRIORITIES.map((priority) => (
                      <option key={priority} value={priority}>
                        {t(PRIORITY_KEYS[priority])}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            {filteredTickets.length === 0 ? (
              <div className="border-border bg-card rounded-2xl border p-6 text-center">
                <p className="text-foreground text-sm font-semibold">
                  {t('support.empty.filteredTitle')}
                </p>
                <p className="text-muted-foreground mt-1 text-xs">
                  {t('support.empty.filteredBody')}
                </p>
              </div>
            ) : (
              <ul role="list" className="flex flex-col gap-2.5">
                {filteredTickets.map((ticket) => {
                  const isSelected = selectedTicket?.id === ticket.id;
                  const requesterLabel =
                    ticket.requester?.fullName ?? ticket.requester?.email ?? null;
                  return (
                    <li key={ticket.id}>
                      <button
                        type="button"
                        aria-current={isSelected ? 'true' : undefined}
                        onClick={() => handleSelectTicket(ticket)}
                        className={`border-border flex w-full flex-col items-start gap-2 rounded-2xl border p-3.5 text-start transition-colors ${
                          isSelected
                            ? 'bg-primary/10 border-primary/40 shadow-xs'
                            : 'bg-card hover:bg-accent'
                        }`}
                      >
                        <div className="flex w-full items-center justify-between gap-2">
                          <span className="text-muted-foreground font-mono text-xs font-semibold">
                            <bdi dir="ltr">#{ticket.ticketNumber}</bdi>
                          </span>
                          <PriorityBadge priority={ticket.priority} />
                        </div>

                        <p className="text-foreground line-clamp-2 w-full text-sm font-semibold">
                          <bdi dir="auto">{ticket.subject}</bdi>
                        </p>

                        <div className="flex w-full flex-wrap items-center justify-between gap-2 pt-0.5">
                          <StatusBadge status={ticket.status} />
                          <time
                            dateTime={ticket.lastActivityAt}
                            className="text-muted-foreground text-[11px] tabular-nums"
                          >
                            {formatDateTime(ticket.lastActivityAt)}
                          </time>
                        </div>

                        {requesterLabel !== null && (
                          <span className="text-muted-foreground flex w-full items-center gap-1.5 truncate text-xs">
                            <User className="size-3 shrink-0" aria-hidden="true" />
                            <bdi dir="auto" className="truncate">
                              {requesterLabel}
                            </bdi>
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </nav>

          {/* Detail Column: Conversation Thread & Status Controls */}
          <div className={`${mobilePane === 'list' ? 'hidden @4xl:flex' : 'flex'} flex-col gap-4`}>
            {/* Mobile back navigation bar (hidden on wide containers >= @4xl) */}
            <div className="@4xl:hidden">
              <button
                type="button"
                onClick={() => setMobilePane('list')}
                className="border-border bg-card text-foreground hover:bg-accent inline-flex items-center gap-2 rounded-xl border px-3.5 py-2 text-xs font-semibold transition-colors"
              >
                <BackArrowIcon className="size-4" aria-hidden="true" />
                {t('support.thread.backToList')}
              </button>
            </div>

            {selectedTicket === null ? (
              <div className="border-border bg-card flex flex-col items-center justify-center gap-3 rounded-2xl border p-12 text-center">
                <MessageSquare className="text-muted-foreground size-8" aria-hidden="true" />
                <h2 className="text-foreground text-base font-semibold">
                  {t('support.thread.emptySelectionTitle')}
                </h2>
                <p className="text-muted-foreground max-w-sm text-sm">
                  {t('support.thread.emptySelectionBody')}
                </p>
              </div>
            ) : (
              <div className="border-border bg-card flex flex-col overflow-hidden rounded-2xl border shadow-xs">
                {/* Ticket Header & Metadata */}
                <header className="border-border space-y-3 border-b p-4 sm:p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="bg-primary/10 text-primary rounded-lg px-2 py-0.5 font-mono text-xs font-bold">
                          <bdi dir="ltr">#{selectedTicket.ticketNumber}</bdi>
                        </span>
                        <StatusBadge status={selectedTicket.status} />
                        <PriorityBadge priority={selectedTicket.priority} />
                      </div>
                      <h2 className="text-foreground pt-1 text-base font-bold sm:text-lg">
                        <bdi dir="auto">{selectedTicket.subject}</bdi>
                      </h2>
                    </div>
                  </div>

                  <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
                    {selectedTicket.requester !== null && (
                      <span className="inline-flex items-center gap-1.5">
                        <User className="size-3.5 shrink-0" aria-hidden="true" />
                        <span>{t('support.thread.requester')}:</span>
                        <strong className="text-foreground font-medium">
                          <bdi dir="auto">
                            {selectedTicket.requester.fullName ?? selectedTicket.requester.email}
                          </bdi>
                        </strong>
                      </span>
                    )}
                    <time dateTime={selectedTicket.createdAt} className="tabular-nums">
                      {t('support.thread.createdAt', {
                        time: formatDateTime(selectedTicket.createdAt),
                      })}
                    </time>
                    <time dateTime={selectedTicket.lastActivityAt} className="tabular-nums">
                      {t('support.thread.lastActivity', {
                        time: formatDateTime(selectedTicket.lastActivityAt),
                      })}
                    </time>
                    {selectedTicket.resolvedAt !== null && (
                      <time
                        dateTime={selectedTicket.resolvedAt}
                        className="text-success tabular-nums"
                      >
                        {t('support.thread.resolvedAt', {
                          time: formatDateTime(selectedTicket.resolvedAt),
                        })}
                      </time>
                    )}
                    {selectedTicket.closedAt !== null && (
                      <time dateTime={selectedTicket.closedAt} className="tabular-nums">
                        {t('support.thread.closedAt', {
                          time: formatDateTime(selectedTicket.closedAt),
                        })}
                      </time>
                    )}
                  </div>

                  {/* Administrative controls — capability `support.manage` (or `*`) */}
                  {canAdministerTickets && (
                    <div className="border-border bg-muted/40 mt-3 rounded-xl border p-3">
                      <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold">
                        <SlidersHorizontal className="text-primary size-3.5" aria-hidden="true" />
                        <span>{t('support.admin.controlsTitle')}</span>
                      </div>
                      <div className="grid grid-cols-1 gap-2.5 @lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] @lg:items-end">
                        <div>
                          <label
                            htmlFor={adminStatusSelectId}
                            className="text-muted-foreground mb-1 block text-xs font-medium"
                          >
                            {t('support.admin.statusLabel')}
                          </label>
                          <select
                            id={adminStatusSelectId}
                            value={effectiveStatusDraft}
                            onChange={(event) => setStatusDraft(event.target.value as TicketStatus)}
                            className="border-input bg-background text-foreground focus-visible:outline-ring h-9 w-full rounded-lg border px-2.5 text-xs focus-visible:outline-2"
                          >
                            {ALL_STATUSES.map((status) => (
                              <option key={status} value={status}>
                                {t(STATUS_KEYS[status])}
                              </option>
                            ))}
                          </select>
                        </div>

                        <div>
                          <label
                            htmlFor={adminPrioritySelectId}
                            className="text-muted-foreground mb-1 block text-xs font-medium"
                          >
                            {t('support.admin.priorityLabel')}
                          </label>
                          <select
                            id={adminPrioritySelectId}
                            value={effectivePriorityDraft}
                            onChange={(event) =>
                              setPriorityDraft(event.target.value as TicketPriority)
                            }
                            className="border-input bg-background text-foreground focus-visible:outline-ring h-9 w-full rounded-lg border px-2.5 text-xs focus-visible:outline-2"
                          >
                            {ALL_PRIORITIES.map((priority) => (
                              <option key={priority} value={priority}>
                                {t(PRIORITY_KEYS[priority])}
                              </option>
                            ))}
                          </select>
                        </div>

                        <button
                          type="button"
                          onClick={() => void handleUpdateStatus()}
                          aria-disabled={statusUpdateBlocker !== null || isUpdatingStatus}
                          className="bg-primary text-primary-foreground inline-flex h-9 items-center justify-center gap-2 rounded-lg px-4 text-xs font-semibold transition-opacity hover:opacity-90 aria-disabled:cursor-not-allowed aria-disabled:opacity-60"
                        >
                          {isUpdatingStatus ? (
                            <Loader2
                              className="size-3.5 animate-spin motion-reduce:animate-none"
                              aria-hidden="true"
                            />
                          ) : (
                            <Check className="size-3.5" aria-hidden="true" />
                          )}
                          {isUpdatingStatus
                            ? t('support.admin.updating')
                            : t('support.admin.updateAction')}
                        </button>
                      </div>
                    </div>
                  )}
                </header>

                {/* Pinned Original Ticket Description */}
                <div className="border-border bg-muted/25 border-b p-4 sm:px-5">
                  <p className="text-muted-foreground text-xs font-semibold">
                    {t('support.thread.originalDescription')}
                  </p>
                  <p className="text-foreground mt-1.5 text-sm leading-relaxed whitespace-pre-wrap">
                    <bdi dir="auto">{selectedTicket.description}</bdi>
                  </p>
                </div>

                {/* Live Conversation Thread Log */}
                <div
                  role="log"
                  aria-live="polite"
                  aria-relevant="additions"
                  aria-label={t('support.thread.label')}
                  className="max-h-[28rem] space-y-3 overflow-y-auto p-4 sm:p-5"
                >
                  {isLoadingReplies ? (
                    <RepliesSkeleton />
                  ) : repliesError !== null ? (
                    <div
                      role="alert"
                      className="border-destructive/40 bg-destructive/10 text-destructive flex items-center gap-2.5 rounded-xl border px-4 py-3 text-sm"
                    >
                      <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
                      <span>{t(SUPPORT_ERROR_KEYS[repliesError])}</span>
                    </div>
                  ) : replies.length === 0 ? (
                    <p className="text-muted-foreground py-8 text-center text-sm">
                      {t('support.thread.noReplies')}
                    </p>
                  ) : (
                    replies.map((reply) => (
                      <ReplyBubble
                        key={reply.id}
                        reply={reply}
                        actorId={actorId}
                        formatDateTime={formatDateTime}
                      />
                    ))
                  )}
                  <div ref={threadEndRef} />
                </div>

                {/* Operation Error Alert inside Thread */}
                {opError !== null && (
                  <div className="px-4 pb-2 sm:px-5">
                    <div
                      role="alert"
                      className="border-destructive/40 bg-destructive/10 text-destructive flex items-center gap-2.5 rounded-xl border px-4 py-3 text-sm"
                    >
                      <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
                      <span className="flex-1">{t(SUPPORT_ERROR_KEYS[opError])}</span>
                      <button
                        type="button"
                        onClick={() => setOpError(null)}
                        aria-label={t('support.newTicket.cancel')}
                        className="text-destructive/80 hover:text-destructive grid size-6 place-items-center rounded"
                      >
                        <X className="size-3.5" aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                )}

                {/* Reply Composer Footer */}
                <form
                  onSubmit={(event) => void handleSendReply(event)}
                  className="border-border bg-background/60 space-y-2.5 border-t p-4 sm:px-5"
                >
                  {isSelectedClosed && (
                    <p
                      id={closedNoticeId}
                      className="border-warning/30 bg-warning/10 text-warning flex items-center gap-2 rounded-xl border px-3 py-2 text-xs font-medium"
                    >
                      <Lock className="size-3.5 shrink-0" aria-hidden="true" />
                      <span>{t('support.reply.closedNotice')}</span>
                    </p>
                  )}

                  <label htmlFor={replyInputId} className="sr-only">
                    {t('support.reply.label')}
                  </label>
                  <div className="flex flex-col gap-2.5 @md:flex-row @md:items-end">
                    <textarea
                      id={replyInputId}
                      rows={2}
                      value={replyDraft}
                      aria-disabled={isSelectedClosed || isSendingReply}
                      aria-describedby={isSelectedClosed ? closedNoticeId : undefined}
                      onChange={(event) => {
                        if (isSelectedClosed) {
                          return;
                        }
                        setReplyDraft(event.target.value);
                      }}
                      placeholder={t('support.reply.placeholder')}
                      className="border-input bg-background text-foreground focus-visible:outline-ring min-h-11 flex-1 rounded-xl border p-3 text-sm leading-relaxed focus-visible:outline-2 aria-disabled:cursor-not-allowed aria-disabled:opacity-60"
                    />
                    <button
                      type="submit"
                      aria-disabled={
                        isSelectedClosed || isSendingReply || replyDraft.trim().length === 0
                      }
                      aria-describedby={isSelectedClosed ? closedNoticeId : undefined}
                      className={`${PRIMARY_BUTTON_CLASS} bg-primary text-primary-foreground shrink-0`}
                    >
                      {isSendingReply ? (
                        <Loader2
                          className="size-4 animate-spin motion-reduce:animate-none"
                          aria-hidden="true"
                        />
                      ) : (
                        <Send className="size-4" aria-hidden="true" />
                      )}
                      {isSendingReply ? t('support.reply.sending') : t('support.reply.send')}
                    </button>
                  </div>
                </form>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <section className="space-y-4">
      {/* Polite operation notice */}
      {successBanner !== null && (
        <div
          role="status"
          className="border-success/40 bg-success/10 text-success flex items-center gap-2.5 rounded-xl border px-4 py-3 text-sm"
        >
          <Check className="size-4 shrink-0" aria-hidden="true" />
          <span className="flex-1">{successBanner}</span>
          <button
            type="button"
            aria-label={t('support.newTicket.cancel')}
            onClick={() => setSuccessBanner(null)}
            className="text-success/80 hover:text-success grid size-7 place-items-center rounded-lg transition-colors"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>
      )}

      {/* Top Toolbar: Ticket count · Realtime health · Sync indicator · New Ticket · Refresh */}
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="text-muted-foreground inline-flex items-center gap-1.5 text-sm">
          <LifeBuoy className="size-4" aria-hidden="true" />
          {t('support.count', { count: tickets.length })}
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
            {t('support.syncing')}
          </span>
        ) : (
          lastSyncedAt !== null && (
            <span className="text-muted-foreground text-xs">
              {t('support.lastSynced', { time: formatDateTime(lastSyncedAt) })}
            </span>
          )
        )}

        <div className="ms-auto flex flex-wrap items-center gap-2">
          {actorIsActive && (
            <button
              type="button"
              onClick={() => {
                setCreateError(null);
                setCreateDialogOpen(true);
              }}
              className="bg-primary text-primary-foreground inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-semibold transition-opacity hover:opacity-90"
            >
              <Plus className="size-4" aria-hidden="true" />
              {t('support.newTicket.open')}
            </button>
          )}

          <button
            type="button"
            onClick={refresh}
            aria-disabled={isRefreshing}
            className="border-border bg-card text-foreground hover:bg-accent inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-colors aria-disabled:cursor-not-allowed aria-disabled:opacity-60"
          >
            <RefreshCw
              className={`size-4 ${isRefreshing ? 'animate-spin motion-reduce:animate-none' : ''}`}
              aria-hidden="true"
            />
            {t('support.refresh')}
          </button>
        </div>
      </div>

      {/* Live region for screen readers during background sync */}
      <p role="status" className="sr-only">
        {isRefreshing ? t('support.syncing') : ''}
      </p>

      {/* Non-blocking error banner if refresh fails over cached tickets */}
      {fetchError !== null && tickets.length > 0 && !isInitialLoading && (
        <div
          role="alert"
          className="border-destructive/40 bg-destructive/10 text-destructive flex items-center gap-2.5 rounded-xl border px-4 py-3 text-sm"
        >
          <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
          <span className="flex-1">{t(SUPPORT_ERROR_KEYS[fetchError])}</span>
          {RETRYABLE_CODES.has(fetchError) && (
            <button
              type="button"
              onClick={refresh}
              className="text-destructive underline-offset-2 hover:underline"
            >
              {t('support.retry')}
            </button>
          )}
        </div>
      )}

      {content}

      {createDialogOpen && (
        <NewTicketDialog
          busy={isCreatingTicket}
          error={createError}
          onSubmit={(input) => void handleCreateTicket(input)}
          onCancel={() => {
            setCreateDialogOpen(false);
            setCreateError(null);
          }}
        />
      )}
    </section>
  );
}
