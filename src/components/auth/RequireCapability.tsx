import { Loader2, ShieldAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router';
import {
  requirementMet,
  useAuthCapabilities,
  type CapabilityRequirement,
} from '@/hooks/useAuthCapabilities';
import { useI18n } from '@/i18n/I18nContext';

export interface RequireCapabilityProps {
  /** Any-of requirement; the wildcard passes everything. */
  requirement: CapabilityRequirement;
  children: ReactNode;
}

/**
 * Capability-only guard (no session redirect). Use it where the session is
 * already enforced by an outer `RequireAuth` — e.g. inside SettingsPage, which
 * is mounted under the dashboard shell.
 */
export function RequireCapability({ requirement, children }: RequireCapabilityProps) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const capabilities = useAuthCapabilities();

  if (capabilities.isLoading) {
    return (
      <div className="grid min-h-40 place-items-center" aria-busy="true">
        <Loader2 className="text-primary size-6 animate-spin" aria-hidden="true" />
      </div>
    );
  }

  if (
    capabilities.isAuthoritative &&
    !requirementMet(requirement, (slug) => capabilities.hasCapability(slug))
  ) {
    return (
      <div className="@container">
        <section
          role="alert"
          className="border-destructive/30 bg-card mx-auto max-w-xl rounded-2xl border p-8 text-center"
        >
          <ShieldAlert className="text-destructive mx-auto size-10" aria-hidden="true" />
          <p className="text-destructive mt-3 text-xs font-bold">{t('access.denied.code')}</p>
          <h2 className="mt-1 text-xl font-bold">{t('access.denied.title')}</h2>
          <p className="text-muted-foreground mt-2 text-sm">{t('access.denied.body')}</p>
          <button
            type="button"
            onClick={() => void navigate('/', { replace: true })}
            className="bg-primary text-primary-foreground mt-5 inline-flex cursor-pointer items-center justify-center rounded-lg px-4 py-2 text-sm font-semibold transition-opacity hover:opacity-90"
          >
            {t('access.denied.back')}
          </button>
        </section>
      </div>
    );
  }

  return children;
}

export default RequireCapability;
