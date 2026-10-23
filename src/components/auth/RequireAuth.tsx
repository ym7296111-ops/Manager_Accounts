import { Loader2, LogOut, ShieldAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import {
  RequireCapability,
  type RequireCapabilityProps,
} from '@/components/auth/RequireCapability';
import { useAuth } from '@/context/AuthContext';
import {
  DASHBOARD_SURFACE_CAPABILITIES,
  isDashboardOnlyActor,
  requirementMet,
  useAuthCapabilities,
  type CapabilityRequirement,
} from '@/hooks/useAuthCapabilities';
import { useI18n } from '@/i18n/I18nContext';

export { RequireCapability, type RequireCapabilityProps };

/**
 * Route guard for the dashboard shell.
 *
 * * Shows a full-screen loader while the initial session lookup runs.
 * * Redirects anonymous visitors to /login.
 * * Blocks authenticated accounts with zero capabilities (`capabilities.length === 0`)
 *   or without dashboard access from entering `/dashboard` / `/`, showing an
 *   explicit "contact administrator" screen with a sign-out button.
 * * Optional `capability` (Smart Hiding — route layer): the screen is rendered
 *   only for callers holding the requirement (any-of, `*` passes everything).
 */
export interface RequireAuthProps {
  children: ReactNode;
  /** Any-of capability requirement for this route. Undefined = session + role gate. */
  capability?: CapabilityRequirement;
}

export function RequireAuth({ children, capability }: RequireAuthProps) {
  const { session, loading, approvalStatus, signOut } = useAuth();
  const capabilities = useAuthCapabilities();
  const { t, dir } = useI18n();
  const location = useLocation();

  if (loading || (session !== null && capability === undefined && capabilities.isLoading)) {
    return (
      <div className="bg-background text-muted-foreground grid min-h-dvh place-items-center">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="text-primary size-6 animate-spin" aria-hidden="true" />
          <p className="text-sm">{t('auth.checking')}</p>
        </div>
      </div>
    );
  }

  if (session === null || (approvalStatus !== undefined && approvalStatus !== 'approved')) {
    return <Navigate to="/login" replace />;
  }

  if (capability !== undefined) {
    return <RequireCapability requirement={capability}>{children}</RequireCapability>;
  }

  const isDashboardRoute = location.pathname === '/' || location.pathname === '/dashboard';
  const hasDashboardAccess = requirementMet(DASHBOARD_SURFACE_CAPABILITIES, (slug) =>
    capabilities.hasCapability(slug),
  );

  if (
    capabilities.isAuthoritative &&
    (capabilities.capabilities.length === 0 || (isDashboardRoute && !hasDashboardAccess))
  ) {
    return (
      <div
        dir={dir}
        data-testid="auth-no-role-screen"
        className="bg-background text-foreground grid min-h-dvh place-items-center p-4"
      >
        <section
          role="alert"
          className="border-border bg-card mx-auto w-full max-w-md rounded-2xl border p-8 text-center shadow-sm"
        >
          <ShieldAlert className="text-warning mx-auto size-10" aria-hidden="true" />
          <h1 className="mt-4 text-xl font-bold">{t('auth.no_role.title')}</h1>
          <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
            {t('auth.no_role.description')}
          </p>
          <button
            type="button"
            onClick={() => void signOut()}
            className="bg-primary text-primary-foreground mt-6 inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold transition-opacity hover:opacity-90"
          >
            <LogOut className="size-4" aria-hidden="true" />
            {t('auth.no_role.signout')}
          </button>
        </section>
      </div>
    );
  }

  return children;
}

/** Restricts an executive-only capability set to the dashboard route. */
export function RedirectDashboardOnly({ children }: { children: ReactNode }) {
  const capabilities = useAuthCapabilities();
  const location = useLocation();
  const dashboardOnly = isDashboardOnlyActor(capabilities);

  if (capabilities.isLoading) {
    return (
      <div className="bg-background grid min-h-dvh place-items-center" aria-busy="true">
        <Loader2 className="text-primary size-6 animate-spin" aria-hidden="true" />
      </div>
    );
  }

  if (dashboardOnly && location.pathname !== '/' && location.pathname !== '/dashboard') {
    return <Navigate to="/" replace />;
  }
  return children;
}
