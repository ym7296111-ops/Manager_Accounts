import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import {
  RedirectDashboardOnly,
  RequireAuth,
  RequireCapability,
} from '@/components/auth/RequireAuth';
import { DocumentTitle } from '@/components/layout/DocumentTitle';
import { AuthProvider } from '@/context/AuthContext';
import { BrandingProvider } from '@/context/BrandingContext';
import { LocalizationProvider, useLocalization } from '@/context/LocalizationProvider';
import { ThemeProvider } from '@/context/ThemeContext';
import { AuthCapabilitiesProvider } from '@/hooks/useAuthCapabilities';
import { I18nProvider } from '@/i18n/I18nContext';
import DashboardLayout from '@/layouts/DashboardLayout';
import DashboardPage from '@/pages/DashboardPage';
import Login from '@/pages/Login';
import NotFoundPage from '@/pages/NotFoundPage';
import ProfilePage from '@/pages/ProfilePage';
import ProjectSettings from '@/pages/settings/ProjectSettings';
import ResetPasswordPage from '@/pages/ResetPasswordPage';
import SettingsPage from '@/pages/SettingsPage';
import ApsLetterDetailPage from '@/pages/workspaces/ApsLetterDetailPage';
import ApsLetterEntryPage from '@/pages/workspaces/ApsLetterEntryPage';
import ApsLettersPage from '@/pages/workspaces/ApsLettersPage';
import ApsWorkspaceLayout from '@/pages/workspaces/ApsWorkspaceLayout';
import WorkspacePage from '@/pages/workspaces/WorkspacePage';
import { APS_LETTER_CREATE_CAPABILITY } from '@/lib/apsLetterEntry';
import { APS_LETTERS_READ_REQUIREMENT } from '@/lib/apsLetters';
import { WORKSPACES } from '@/lib/workspaces';

/**
 * Shared TanStack Query cache for the app shell (users management today,
 * every data screen tomorrow). Per-query options live with their hooks.
 */
const queryClient = new QueryClient();

/**
 * Route map.
 *
 *   /login                                → standalone auth screen
 *   /reset-password                       → standalone recovery screen (emailed link)
 *   /                                     → protected shell + dashboard
 *   /workspaces/1|2|3                     → legacy redirects to canonical slugs
 *   /workspaces/aps|workshops-10th|reports → prepared, isolated workspace shells
 *   /profile                              → self-service profile + change password
 *   /settings/project                     → project identity (dedicated capability)
 *   /settings/system/:section             → 5 system & users screens
 *   /settings/app/:section                → 3 app settings screens
 *   *                                     → standalone 404
 *
 * The protected branch renders DashboardLayout (sidebar + topbar + drawer)
 * behind RequireAuth; every other route lives completely outside the shell.
 */
function AppRoutes() {
  return (
    <RedirectDashboardOnly>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />

        <Route
          path="/"
          element={
            <RequireAuth>
              <DashboardLayout />
            </RequireAuth>
          }
        >
          <Route index element={<DashboardPage />} />
          <Route path="dashboard" element={<DashboardPage />} />
          {WORKSPACES.map((workspace) => (
            <Route
              key={workspace.slug}
              path={workspace.legacyPath.slice(1)}
              element={<Navigate to={workspace.path} replace />}
            />
          ))}
          <Route path="workspaces/aps" element={<ApsWorkspaceLayout />}>
            <Route index element={<Navigate to="letters" replace />} />
            <Route
              path="letters"
              element={
                <RequireCapability requirement={APS_LETTERS_READ_REQUIREMENT}>
                  <ApsLettersPage />
                </RequireCapability>
              }
            />
            <Route
              path="letters/new"
              element={
                <RequireCapability requirement={APS_LETTER_CREATE_CAPABILITY}>
                  <ApsLetterEntryPage />
                </RequireCapability>
              }
            />
            <Route
              path="letters/:letterId"
              element={
                <RequireCapability requirement={APS_LETTERS_READ_REQUIREMENT}>
                  <ApsLetterDetailPage />
                </RequireCapability>
              }
            />
          </Route>
          <Route path="workspaces/:workspaceSlug" element={<WorkspacePage />} />
          <Route path="profile" element={<ProfilePage />} />
          <Route path="settings/my-profile" element={<ProfilePage />} />
          <Route path="settings/project" element={<ProjectSettings />} />
          <Route path="settings/:family/:section" element={<SettingsPage />} />
        </Route>

        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </RedirectDashboardOnly>
  );
}

/**
 * Resolution-cascade composition: the LocalizationProvider owns the system
 * defaults (fetched once, anon-readable) and injects them into the theme and
 * i18n providers. Explicit per-browser choices always win inside those two.
 */
function LocalizedShell() {
  const { settings } = useLocalization();
  return (
    <ThemeProvider defaultTheme={settings.defaultTheme}>
      <I18nProvider defaultLocale={settings.defaultLocale}>
        <AuthProvider>
          {/* Phase 2 capability channel: resolved once per actor, shared by the
              navigation and every screen gate (capabilities, never roles). */}
          <AuthCapabilitiesProvider>
            <BrandingProvider>
              <BrowserRouter>
                <DocumentTitle />
                <AppRoutes />
              </BrowserRouter>
            </BrandingProvider>
          </AuthCapabilitiesProvider>
        </AuthProvider>
      </I18nProvider>
    </ThemeProvider>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <LocalizationProvider>
        <LocalizedShell />
      </LocalizationProvider>
    </QueryClientProvider>
  );
}
