import {
  Bell,
  DatabaseBackup,
  KeyRound,
  KeySquare,
  LifeBuoy,
  Loader2,
  Palette,
  Settings,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { Link, Navigate, useParams } from 'react-router';
import type { ComponentType } from 'react';
import NotificationSettings from '@/components/notifications/NotificationSettings';
import { RequireCapability } from '@/components/auth/RequireAuth';
import { EmptyState } from '@/components/ui/EmptyState';
import { NAV_ITEMS, findNavLinkByPath } from '@/components/layout/nav-items';
import { useNotificationAccess } from '@/hooks/useNotificationAccess';
import { useI18n, type TranslationKey } from '@/i18n/I18nContext';
import PasswordResetRequests from '@/pages/settings/PasswordResetRequests';
import RolesPermissions from '@/pages/settings/RolesPermissions';
import UsersManagement from '@/pages/settings/UsersManagement';
import BackupManagement from '@/pages/settings/BackupManagement';
import GeneralSettings from '@/pages/settings/GeneralSettings';
import LocalizationSettings from '@/pages/settings/LocalizationSettings';
import SupportManagement from '@/pages/settings/SupportManagement';

/**
 * Generic settings screen driven by the route.
 *
 * Eight routes (/settings/system/* and /settings/app/*) map onto this single
 * component so every sidebar leaf resolves to a real, prepared screen with
 * breadcrumb, title, description and an empty state ready for data.
 */

export type SettingsSectionId =
  | 'users'
  | 'roles'
  | 'password-resets'
  | 'backup'
  | 'support'
  | 'general'
  | 'appearance'
  | 'notifications';

type SettingsFamily = 'system' | 'app';

interface SectionConfig {
  id: SettingsSectionId;
  family: SettingsFamily;
  titleKey: TranslationKey;
  descriptionKey: TranslationKey;
  icon: LucideIcon;
  /**
   * Optional self-contained screen. Sections that ship their own layout (and their own
   * `@container` root) register here instead of falling through to the shared `EmptyState`.
   */
  component?: ComponentType;
}

const PRIMARY_BUTTON_CLASS =
  'inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold transition-opacity hover:opacity-90 aria-disabled:cursor-not-allowed aria-disabled:opacity-60 disabled:cursor-not-allowed disabled:opacity-60';

const SECTIONS: Record<SettingsSectionId, SectionConfig> = {
  users: {
    id: 'users',
    family: 'system',
    titleKey: 'nav.users',
    descriptionKey: 'settings.users.desc',
    icon: Users,
  },
  roles: {
    id: 'roles',
    family: 'system',
    titleKey: 'nav.roles',
    descriptionKey: 'settings.roles.desc',
    icon: KeyRound,
  },
  'password-resets': {
    id: 'password-resets',
    family: 'system',
    titleKey: 'nav.passwordResets',
    descriptionKey: 'settings.passwordResets.desc',
    icon: KeySquare,
  },
  backup: {
    id: 'backup',
    family: 'system',
    titleKey: 'nav.backup',
    descriptionKey: 'settings.backup.desc',
    icon: DatabaseBackup,
  },
  support: {
    id: 'support',
    family: 'system',
    titleKey: 'nav.support',
    descriptionKey: 'settings.support.desc',
    icon: LifeBuoy,
  },
  general: {
    id: 'general',
    family: 'app',
    titleKey: 'nav.general',
    descriptionKey: 'settings.general.desc',
    icon: Settings,
  },
  appearance: {
    id: 'appearance',
    family: 'app',
    titleKey: 'nav.appearance',
    descriptionKey: 'settings.appearance.desc',
    icon: Palette,
  },
  notifications: {
    id: 'notifications',
    family: 'app',
    titleKey: 'settings.notifications.title',
    descriptionKey: 'settings.notifications.description',
    icon: Bell,
    // Phase 3.3: the composite screen (transport + editor + live preview + Realtime signal).
    // Mounted through `NotificationsSection`, which resolves the capability first.
  },
};

const FAMILY_META: Record<
  SettingsFamily,
  { parentKey: TranslationKey; groupKey: TranslationKey; icon: LucideIcon }
> = {
  system: { parentKey: 'nav.settings', groupKey: 'nav.systemSettings', icon: ShieldCheck },
  app: { parentKey: 'nav.settings', groupKey: 'nav.appSettings', icon: SlidersHorizontal },
};

function isSectionId(value: string | undefined): value is SettingsSectionId {
  return value !== undefined && value in SECTIONS;
}

/**
 * Capability gate for the notifications screen.
 *
 * It was the only screen in the settings tree that mounted for every
 * authenticated caller: the fence was server-side (RLS + RPC gates) only, so a
 * caller without `notifications.manage` / `settings.manage` was left staring at
 * a fully rendered screen whose every call failed with `42501`. This resolves
 * the capability once — a single query, see `useNotificationAccess` — and shows
 * the same 403 panel as the General / Localization screens instead.
 *
 * The gate decides what to *render*; it is not the security boundary. Writes
 * and reads stay refused server-side for a caller without the capability.
 */
function NotificationsSection() {
  const { t } = useI18n();
  const { canManage, isAccessLoading, canManageTemplates, canManageTransport } =
    useNotificationAccess();

  if (isAccessLoading || canManage === null) {
    return (
      <p role="status" className="text-muted-foreground flex items-center gap-2 text-sm">
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        {t('common.loading')}
      </p>
    );
  }

  if (!canManage) {
    return (
      <div className="@container">
        <section className="border-destructive/30 bg-card mx-auto max-w-xl rounded-2xl border p-8 text-center">
          <ShieldAlert className="text-destructive mx-auto size-10" aria-hidden="true" />
          <p className="text-destructive mt-3 text-xs font-bold">
            {t('notifications.denied.code')}
          </p>
          <h2 className="mt-1 text-xl font-bold">{t('notifications.denied.title')}</h2>
          <p className="text-muted-foreground mt-2 text-sm">{t('notifications.denied.body')}</p>
          <Link
            to="/"
            className={`${PRIMARY_BUTTON_CLASS} bg-primary text-primary-foreground mt-5`}
          >
            {t('notifications.denied.back')}
          </Link>
        </section>
      </div>
    );
  }

  /* Per-card Smart Hiding: the SMTP card needs `settings.manage` (server:
     can_manage_email_transport), the template editor needs
     `notifications.manage` (server: can_manage_notification_templates). */
  return (
    <NotificationSettings
      canManageTemplates={canManageTemplates}
      canManageTransport={canManageTransport}
    />
  );
}

export default function SettingsPage() {
  const { t } = useI18n();
  const { family, section } = useParams();

  if ((family !== 'system' && family !== 'app') || !isSectionId(section)) {
    return <Navigate to="/" replace />;
  }

  const config = SECTIONS[section];
  const group = FAMILY_META[config.family];
  const Icon = config.icon;
  const SectionScreen = config.component ?? null;

  /* Route-level guard (Smart Hiding, route layer). The requirement is read from
     the sidebar tree — the single source of truth for each section's gate — so
     the link and the route can never disagree. Fail closed: a section without a
     nav entry is reachable by `*` holders only. */
  const requirement =
    findNavLinkByPath(NAV_ITEMS, `/settings/${family}/${section}`)?.capability ?? '*';

  return (
    <RequireCapability requirement={requirement}>
      <div className="space-y-6">
        <header className="space-y-3">
          {/* Breadcrumb: Settings / Group / Section */}
          <nav
            aria-label="Breadcrumb"
            className="text-muted-foreground flex items-center gap-1.5 text-xs"
          >
            <span>{t(group.parentKey)}</span>
            <span aria-hidden="true">/</span>
            <span>{t(group.groupKey)}</span>
            <span aria-hidden="true">/</span>
            <span className="text-foreground font-medium">{t(config.titleKey)}</span>
          </nav>

          <div className="flex items-center gap-3">
            <span className="bg-primary/10 text-primary grid size-10 place-items-center rounded-xl">
              <Icon className="size-5" aria-hidden="true" />
            </span>
            <div>
              <h1 className="text-foreground text-xl font-bold tracking-tight">
                {t(config.titleKey)}
              </h1>
              <p className="text-muted-foreground text-sm">{t(config.descriptionKey)}</p>
            </div>
          </div>
        </header>

        {config.id === 'users' ? (
          <UsersManagement />
        ) : config.id === 'roles' ? (
          <RolesPermissions />
        ) : config.id === 'password-resets' ? (
          <PasswordResetRequests />
        ) : config.id === 'backup' ? (
          <BackupManagement />
        ) : config.id === 'support' ? (
          <SupportManagement />
        ) : config.id === 'general' ? (
          <GeneralSettings />
        ) : config.id === 'appearance' ? (
          <LocalizationSettings />
        ) : config.id === 'notifications' ? (
          <NotificationsSection />
        ) : SectionScreen !== null ? (
          <SectionScreen />
        ) : (
          <EmptyState
            icon={Icon}
            title={t('settings.emptyTitle')}
            description={t('settings.emptyBody')}
          />
        )}
      </div>
    </RequireCapability>
  );
}
