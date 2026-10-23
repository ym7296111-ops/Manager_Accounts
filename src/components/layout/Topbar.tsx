import {
  LogOut,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  ShieldCheck,
  UserRound,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { ErrorBoundary } from '@/components/layout/ErrorBoundary';
import { LanguageToggle, ThemeToggle } from '@/components/layout/HeaderToggles';
import { NotificationBell } from '@/components/layout/NotificationBell';
import { NotificationsProvider } from '@/components/layout/NotificationsProvider';
import { useAuth } from '@/context/AuthContext';
import { useBranding } from '@/context/BrandingContext';
import { useI18n, type TranslationKey } from '@/i18n/I18nContext';
import { findNavLinkByPath, NAV_ITEMS } from '@/components/layout/nav-items';

/**
 * Titles for protected routes that are not sidebar leaves (`/profile` is a
 * self-service screen reachable from the account menu, not from the tree).
 */
const STANDALONE_TITLES: Record<string, TranslationKey> = {
  '/profile': 'profile.title',
  '/settings/my-profile': 'profile.title',
};

interface TopbarProps {
  /** Mobile drawer visibility (driven by DashboardLayout). */
  mobileOpen: boolean;
  onOpenMobileMenu: () => void;
  /** Desktop icons-only mode. */
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  /** Minimal account/sign-out header for dashboard-only executive accounts. */
  dashboardOnly?: boolean;
}

function initialsFrom(value: string): string {
  const parts = value
    .trim()
    .split(/[\s@._-]+/)
    .filter(Boolean);
  const first = parts[0] ?? '?';
  const second = parts[1];
  return ((first[0] ?? '') + (second?.[0] ?? '')).toUpperCase();
}

/**
 * Sticky top bar of the dashboard shell:
 * hamburger (mobile) · collapse toggle (desktop) · current page title ·
 * notifications bell · language switch · theme switch · account menu with
 * sign-out.
 */
export function Topbar({
  mobileOpen,
  onOpenMobileMenu,
  sidebarCollapsed,
  onToggleSidebar,
  dashboardOnly = false,
}: TopbarProps) {
  const { t, locale } = useI18n();
  const { session, signOut } = useAuth();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  const activeLink = findNavLinkByPath(NAV_ITEMS, location.pathname);
  const pageTitle = activeLink
    ? t(activeLink.labelKey)
    : t(STANDALONE_TITLES[location.pathname] ?? 'dashboard.title');
  const displayName =
    (typeof session?.user.user_metadata?.full_name === 'string'
      ? session.user.user_metadata.full_name
      : '') ||
    session?.user.email ||
    '—';
  const email = session?.user.email ?? '';

  /* Close the account menu on route change (render-phase adjustment) and on
     outside click / Escape while it is open. */
  const [seenPath, setSeenPath] = useState(location.pathname);
  if (seenPath !== location.pathname) {
    setSeenPath(location.pathname);
    if (menuOpen) {
      setMenuOpen(false);
    }
  }

  useEffect(() => {
    if (!menuOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
        menuButtonRef.current?.focus();
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [menuOpen]);

  const iconButtonClassName =
    'inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-ring';

  return (
    <header className="bg-background/85 sticky top-0 z-30 flex h-16 items-center gap-2 border-b px-3 backdrop-blur-md md:px-4">
      {!dashboardOnly && (
        <button
          type="button"
          onClick={onOpenMobileMenu}
          aria-label={t('topbar.openMenu')}
          aria-expanded={mobileOpen}
          className={`${iconButtonClassName} md:hidden`}
        >
          <Menu className="size-5" aria-hidden="true" />
        </button>
      )}

      {!dashboardOnly && (
        <button
          type="button"
          onClick={onToggleSidebar}
          aria-label={sidebarCollapsed ? t('topbar.expandSidebar') : t('topbar.collapseSidebar')}
          aria-pressed={sidebarCollapsed}
          className={`${iconButtonClassName} hidden md:inline-flex`}
        >
          {sidebarCollapsed ? (
            <PanelLeftOpen className="size-5" aria-hidden="true" />
          ) : (
            <PanelLeftClose className="size-5" aria-hidden="true" />
          )}
        </button>
      )}

      <div className="min-w-0 px-1">
        <p className="text-foreground truncate text-sm font-semibold md:text-base">{pageTitle}</p>
      </div>

      <div className="ms-auto flex items-center gap-1.5">
        {/* In-app notifications are available to EVERY signed-in account,
            including pending and dashboard-only ones, so the bell is not
            hidden in `dashboardOnly` mode.

            `NotificationsProvider` is mounted here so the bell and its
            dropdown share ONE feed hook — hence one Realtime subscription —
            instead of subscribing twice. The unit sits behind an
            ErrorBoundary on purpose: it owns the only always-on Realtime
            socket in the shell, and an uncaught error inside it would
            otherwise unmount the ENTIRE page (production incident: a second
            subscriber on `user-notifications-live` threw inside its
            effect). A dead bell is acceptable; a dead dashboard is not. */}
        <ErrorBoundary name="NotificationBell">
          <NotificationsProvider>
            <NotificationBell className={`${iconButtonClassName} relative`} />
          </NotificationsProvider>
        </ErrorBoundary>

        {!dashboardOnly && (
          <>
            <LanguageToggle className={iconButtonClassName} />
            <ThemeToggle className={iconButtonClassName} />
          </>
        )}

        <div className="relative" ref={menuRef}>
          <button
            ref={menuButtonRef}
            type="button"
            onClick={() => setMenuOpen((previous) => !previous)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={t('account.menu')}
            className="bg-primary text-primary-foreground ring-background ms-1 inline-flex size-9 items-center justify-center rounded-full text-xs font-semibold ring-2 transition-transform hover:scale-105"
          >
            {initialsFrom(displayName)}
          </button>

          {menuOpen && (
            <div
              role="menu"
              aria-label={t('account.menu')}
              className="animate-scale-in origin-top-end bg-popover text-popover-foreground absolute end-0 top-full z-50 mt-2 w-60 overflow-hidden rounded-xl border p-1 shadow-lg"
            >
              <div className="px-3 py-2.5">
                <p className="truncate text-sm font-semibold">{displayName}</p>
                <p className="text-muted-foreground truncate text-xs" dir="ltr">
                  {email}
                </p>
              </div>

              <div className="mx-2 my-1 border-t" />

              <div className="text-muted-foreground flex items-center justify-between px-3 py-2 text-xs">
                <span>{t('dashboard.status.language')}</span>
                <span className="text-foreground font-medium">{t(`language.${locale}`)}</span>
              </div>

              <div className="mx-2 my-1 border-t" />

              <Link
                to="/profile"
                role="menuitem"
                onClick={() => setMenuOpen(false)}
                className="hover:bg-accent hover:text-accent-foreground flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors"
              >
                <UserRound className="size-4" aria-hidden="true" />
                {t('account.profile')}
              </Link>

              <div className="mx-2 my-1 border-t" />

              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  void signOut();
                }}
                className="text-destructive hover:bg-destructive/10 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors"
              >
                <LogOut className="size-4" aria-hidden="true" />
                {t('account.signOut')}
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

/**
 * Brand block shared by the desktop sidebar and the mobile drawer.
 */
export function SidebarBrand({ compact = false }: { compact?: boolean }) {
  const { t } = useI18n();
  const { displayName, logoUrl } = useBranding();

  return (
    <Link
      to="/"
      className="border-sidebar-border flex h-16 shrink-0 items-center gap-3 border-b px-4 transition-opacity outline-none hover:opacity-80"
      aria-label={displayName}
      title={compact ? displayName : undefined}
    >
      {logoUrl !== null ? (
        <img src={logoUrl} alt="" className="size-9 shrink-0 rounded-lg object-contain" />
      ) : (
        <span className="bg-sidebar-primary text-sidebar-primary-foreground grid size-9 shrink-0 place-items-center rounded-lg">
          <ShieldCheck className="size-5" aria-hidden="true" />
        </span>
      )}
      {!compact && (
        <span className="min-w-0">
          <span className="text-sidebar-foreground block truncate text-sm font-semibold">
            {displayName}
          </span>
          <span className="text-sidebar-foreground/60 block truncate text-[11px]">
            {t('app.tagline')}
          </span>
        </span>
      )}
    </Link>
  );
}

interface MobileDrawerProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}

/**
 * Always-mounted off-canvas panel for phones and tablets.
 * Slide direction follows the active text direction via .drawer-panel CSS.
 */
export function MobileDrawer({ open, onClose, children }: MobileDrawerProps) {
  const { t } = useI18n();
  const panelRef = useRef<HTMLDivElement>(null);

  /* Move focus into the drawer when it opens; Escape closes it. */
  useEffect(() => {
    if (!open) {
      return;
    }
    /* Remember the opener (hamburger) so focus returns to it on close. */
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      if (previouslyFocused?.isConnected) {
        previouslyFocused.focus();
      }
    };
  }, [open, onClose]);

  return (
    <div className="md:hidden" aria-hidden={!open}>
      <div
        className="drawer-overlay animate-fade-in fixed inset-0 z-40 bg-black/50 backdrop-blur-[1px]"
        data-open={open}
        onClick={onClose}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('sidebar.label')}
        tabIndex={-1}
        inert={!open}
        data-open={open}
        className="drawer-panel border-sidebar-border bg-sidebar text-sidebar-foreground fixed inset-y-0 start-0 z-50 flex w-72 max-w-[85vw] flex-col border-e outline-none"
      >
        <div className="flex items-center justify-between pe-3">
          <SidebarBrand />
          <button
            type="button"
            onClick={onClose}
            aria-label={t('topbar.closeMenu')}
            className="text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground grid size-9 place-items-center rounded-lg transition-colors"
          >
            <X className="size-5" aria-hidden="true" />
          </button>
        </div>
        <div className="flex-1 scrollbar-thin overflow-y-auto px-3 py-4">{children}</div>
      </div>
    </div>
  );
}
