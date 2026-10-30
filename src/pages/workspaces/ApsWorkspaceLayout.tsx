import { BookOpenText, Eye, FilePlus2, FolderOpen } from 'lucide-react';
import { Link, NavLink, Outlet, useLocation } from 'react-router';
import {
  requirementMet,
  useAuthCapabilities,
  type CapabilityRequirement,
} from '@/hooks/useAuthCapabilities';
import { useI18n } from '@/i18n/I18nContext';
import { APS_LETTER_CREATE_CAPABILITY, APS_LETTER_NEW_PATH } from '@/lib/apsLetterEntry';
import { APS_LETTERS_PATH, APS_LETTERS_READ_REQUIREMENT } from '@/lib/apsLetters';

export default function ApsWorkspaceLayout() {
  const { t } = useI18n();
  const capabilities = useAuthCapabilities();
  const location = useLocation();
  const canUse = (requirement: CapabilityRequirement) =>
    !capabilities.isAuthoritative ||
    requirementMet(requirement, (slug) => capabilities.hasCapability(slug));
  const creating = location.pathname === APS_LETTER_NEW_PATH;

  return (
    <div className="@container min-w-0 space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0 space-y-2">
          <div className="text-muted-foreground flex items-center gap-2 text-xs font-semibold tracking-wide">
            <FolderOpen className="text-primary size-4" aria-hidden="true" />
            {t('aps.workspace.eyebrow')}
          </div>
          <h1 className="text-foreground text-2xl font-bold tracking-tight sm:text-3xl">
            {t('aps.workspace.title')}
          </h1>
          <p className="text-muted-foreground text-sm leading-relaxed">
            {t('aps.workspace.description')}
          </p>
        </div>
        {!canUse(APS_LETTER_CREATE_CAPABILITY) && (
          <span className="border-border bg-card text-muted-foreground inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold">
            <Eye className="text-primary size-4" aria-hidden="true" />
            {t('aps.workspace.readOnly')}
          </span>
        )}
      </header>

      <nav
        aria-label={t('aps.workspace.navigation')}
        className="border-border flex flex-wrap gap-x-5 border-b"
      >
        {canUse(APS_LETTERS_READ_REQUIREMENT) && (
          <Link
            to={APS_LETTERS_PATH}
            aria-current={creating ? undefined : 'page'}
            className={`inline-flex min-h-12 items-center gap-2 border-b-2 px-1 text-sm font-semibold ${creating ? 'text-muted-foreground hover:text-foreground border-transparent' : 'text-primary border-primary'}`}
          >
            <BookOpenText className="size-4" aria-hidden="true" />
            {t('aps.letters.tab')}
          </Link>
        )}
        {canUse(APS_LETTER_CREATE_CAPABILITY) && (
          <NavLink
            to={APS_LETTER_NEW_PATH}
            end
            className={({ isActive }) =>
              `inline-flex min-h-12 items-center gap-2 border-b-2 px-1 text-sm font-semibold ${isActive ? 'text-primary border-primary' : 'text-muted-foreground hover:text-foreground border-transparent'}`
            }
          >
            <FilePlus2 className="size-4" aria-hidden="true" />
            {t('aps.entry.tab')}
          </NavLink>
        )}
      </nav>

      <Outlet />
    </div>
  );
}
