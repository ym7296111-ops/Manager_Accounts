import { useCallback, useEffect, useId, useState } from 'react';
import { Outlet, useLocation } from 'react-router';
import { SidebarNav } from '@/components/layout/SidebarNav';
import { NAV_ITEMS } from '@/components/layout/nav-items';
import { MobileDrawer, SidebarBrand, Topbar } from '@/components/layout/Topbar';
import { PageHeaderProvider } from '@/context/PageHeaderContext';
import { useI18n } from '@/i18n/I18nContext';
import { isDashboardOnlyActor, useAuthCapabilities } from '@/hooks/useAuthCapabilities';

/**
 * Responsive dashboard shell.
 *
 * Desktop (md and up)
 *   * Sticky sidebar, collapsible between icons-only (4.5rem) and expanded
 *     (18rem). The choice is persisted under `admin-system:sidebar-collapsed`.
 *   * Collapsing hides every label and accordion; tapping a collapsed group
 *     re-expands the sidebar (workspaces navigate directly instead).
 *
 * Mobile (below md)
 *   * The sidebar disappears entirely and is replaced by an off-canvas
 *     drawer opened from the hamburger button in the top bar.
 *   * The drawer closes on route change, overlay click, Escape, the
 *     dedicated close button, or when the viewport grows to desktop width.
 *   * While open it locks page scroll and marks the rest of the shell
 *     `inert`, so keyboard and screen-reader focus stay inside the drawer.
 */

const SIDEBAR_STATE_KEY = 'admin-system:sidebar-collapsed';

/** Must match Tailwind's `md` breakpoint used by `md:hidden` / `md:flex`. */
const DESKTOP_MEDIA_QUERY = '(min-width: 768px)';

function readIsDesktop(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia(DESKTOP_MEDIA_QUERY).matches;
}

function readStoredCollapsed(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  try {
    return window.localStorage.getItem(SIDEBAR_STATE_KEY) === '1';
  } catch {
    return false;
  }
}

export default function DashboardLayout() {
  const { t } = useI18n();
  const capabilities = useAuthCapabilities();
  const dashboardOnly = isDashboardOnlyActor(capabilities);
  const location = useLocation();
  const [collapsed, setCollapsed] = useState<boolean>(readStoredCollapsed);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [isDesktop, setIsDesktop] = useState<boolean>(readIsDesktop);
  const desktopNavId = useId();
  const mobileNavId = useId();

  /* The drawer only exists below `md`; on desktop it is never considered open. */
  const drawerOpen = mobileOpen && !isDesktop;

  const openMobileMenu = useCallback(() => setMobileOpen(true), []);
  const closeMobileMenu = useCallback(() => setMobileOpen(false), []);

  /* Track the breakpoint: growing to desktop closes the drawer, which in turn
     releases the scroll lock and the inert shell. */
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }
    const media = window.matchMedia(DESKTOP_MEDIA_QUERY);
    const handleChange = (event: MediaQueryListEvent) => {
      setIsDesktop(event.matches);
      if (event.matches) {
        setMobileOpen(false);
      }
    };
    media.addEventListener('change', handleChange);
    return () => media.removeEventListener('change', handleChange);
  }, []);

  /* Persist the desktop sidebar state. */
  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_STATE_KEY, collapsed ? '1' : '0');
    } catch {
      // Storage blocked: the layout still collapses for this session.
    }
  }, [collapsed]);

  /* Navigating always closes the mobile drawer (render-phase adjustment:
     https://react.dev/learn/you-might-not-need-an-effect). */
  const [seenPathname, setSeenPathname] = useState(location.pathname);
  if (seenPathname !== location.pathname) {
    setSeenPathname(location.pathname);
    if (mobileOpen) {
      setMobileOpen(false);
    }
  }

  /* Lock background scroll only while the drawer is actually open. The
     cleanup runs on close, on breakpoint change and on unmount, so the body
     can never stay frozen. */
  useEffect(() => {
    if (!drawerOpen) {
      return;
    }
    const { body } = document;
    const previousOverflow = body.style.overflow;
    body.style.overflow = 'hidden';
    return () => {
      body.style.overflow = previousOverflow;
    };
  }, [drawerOpen]);

  return (
    <PageHeaderProvider>
      <div className="bg-background flex min-h-dvh">
        {/* ---------------------------------------------------- desktop sidebar */}
        {!dashboardOnly && (
          <aside
            inert={drawerOpen}
            className={`border-sidebar-border bg-sidebar text-sidebar-foreground sticky top-0 hidden h-dvh shrink-0 flex-col border-e transition-[width] duration-300 ease-out md:flex ${
              collapsed ? 'w-[4.5rem]' : 'w-72'
            }`}
          >
            <SidebarBrand compact={collapsed} />

            <nav
              aria-label={t('sidebar.label')}
              className="flex-1 scrollbar-thin overflow-x-hidden overflow-y-auto px-3 py-4"
            >
              <SidebarNav
                idPrefix={desktopNavId}
                nodes={NAV_ITEMS}
                collapsed={collapsed}
                onRequestExpand={() => setCollapsed(false)}
              />
            </nav>

            <div className="border-sidebar-border text-sidebar-foreground/50 border-t px-4 py-3 text-[11px]">
              {collapsed ? 'v0.1' : 'v0.1.0 · Cloud-Only'}
            </div>
          </aside>
        )}

        {/* ------------------------------------------------------------ content */}
        <div inert={drawerOpen} className="flex min-w-0 flex-1 flex-col">
          <Topbar
            mobileOpen={drawerOpen}
            onOpenMobileMenu={openMobileMenu}
            sidebarCollapsed={collapsed}
            onToggleSidebar={() => setCollapsed((previous) => !previous)}
            dashboardOnly={dashboardOnly}
          />

          <main className="w-full max-w-full min-w-0 flex-1 px-4 py-6 md:px-6 md:py-8">
            <div className="mx-auto w-full max-w-7xl min-w-0">
              <Outlet />
            </div>
          </main>
        </div>

        {/* --------------------------------------------------------- mobile drawer */}
        {!dashboardOnly && (
          <MobileDrawer open={drawerOpen} onClose={closeMobileMenu}>
            <SidebarNav
              idPrefix={mobileNavId}
              nodes={NAV_ITEMS}
              collapsed={false}
              onNavigate={closeMobileMenu}
            />
          </MobileDrawer>
        )}
      </div>
    </PageHeaderProvider>
  );
}
