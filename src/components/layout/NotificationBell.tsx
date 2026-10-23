import { Bell } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router';
import { NotificationDropdown } from '@/components/layout/NotificationDropdown';
import { useNotifications } from '@/components/layout/NotificationsProvider';
import { useI18n } from '@/i18n/I18nContext';

/** Cap the badge so a long queue cannot stretch the topbar. */
const BADGE_CAP = 99;

interface NotificationBellProps {
  /** Shared topbar icon-button styling, passed down from `Topbar`. */
  className?: string;
}

/**
 * Bell icon + unread badge + the notification dropdown.
 *
 * The open/close contract is copied verbatim from the account menu in
 * `Topbar` so both popovers behave identically:
 *   - an outside `pointerdown` closes it,
 *   - `Escape` closes it AND returns focus to the opener,
 *   - a route change closes it (render-phase adjustment, no extra effect).
 *
 * Visibility: the bell is shown to EVERY signed-in account. It is deliberately
 * not capability-gated — a pending or dashboard-only account has an empty
 * capability set yet is exactly who must see "your request was approved".
 */
export function NotificationBell({ className }: NotificationBellProps) {
  const { t } = useI18n();
  const location = useLocation();
  /* The feed (and its single Realtime subscription) belongs to
     `NotificationsProvider` in `Topbar`; the bell only renders its badge. */
  const { unreadCount } = useNotifications();
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  /* Close on route change, matching the account menu's render-phase pattern. */
  const [seenPath, setSeenPath] = useState(location.pathname);
  if (seenPath !== location.pathname) {
    setSeenPath(location.pathname);
    if (open) {
      setOpen(false);
    }
  }

  useEffect(() => {
    if (!open) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (!panelRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const count = unreadCount ?? 0;

  return (
    <div className="relative" ref={panelRef}>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((previous) => !previous)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t('notifications.bell.label', { count: String(count) })}
        className={className}
      >
        <Bell className="size-5" aria-hidden="true" />
        {count > 0 && (
          <span
            data-testid="notification-badge"
            className="bg-destructive text-destructive-foreground absolute -end-0.5 -top-0.5 inline-flex min-w-4 items-center justify-center rounded-full px-1 text-[10px] leading-4 font-semibold"
          >
            {count > BADGE_CAP ? `${BADGE_CAP}+` : count}
          </span>
        )}
      </button>

      {open && <NotificationDropdown onNavigate={() => setOpen(false)} />}
    </div>
  );
}
