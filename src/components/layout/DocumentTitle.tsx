import { useEffect } from 'react';
import { useLocation } from 'react-router';
import { useBranding } from '@/context/BrandingContext';
import { useI18n } from '@/i18n/I18nContext';
import { getWorkspaceByPath } from '@/lib/workspaces';

/**
 * Keeps the browser title synchronized with both the live project identity and
 * the active route. Workspace titles use their translated display names while
 * URLs remain stable English slugs.
 */
export function DocumentTitle() {
  const { displayName } = useBranding();
  const { t } = useI18n();
  const { pathname } = useLocation();
  const workspace = getWorkspaceByPath(pathname);
  const workspaceTitle = workspace === null ? null : t(workspace.labelKey);

  useEffect(() => {
    document.title = workspaceTitle === null ? displayName : `${workspaceTitle} | ${displayName}`;
  }, [displayName, workspaceTitle]);

  return null;
}
