import { BarChart3, Factory, FileText, type LucideIcon } from 'lucide-react';
import type { TranslationKey } from '@/i18n/locales/ar';

/**
 * Canonical workspace catalogue.
 *
 * APS and the 10th-of-Ramadan workshops are independent data entities. The
 * reports workspace is reserved for a future read-only aggregation layer over
 * both; it must never become a shared write path. Their internal modules and
 * optional future cross-entity references are intentionally outside this
 * restructuring milestone.
 */
export interface WorkspaceDefinition {
  readonly slug: 'aps' | 'workshops-10th' | 'reports';
  readonly path: `/workspaces/${WorkspaceDefinition['slug']}`;
  readonly legacyPath: `/workspaces/${1 | 2 | 3}`;
  readonly labelKey: TranslationKey;
  readonly descriptionKey: TranslationKey;
  readonly icon: LucideIcon;
  readonly nature: 'paper-entry' | 'independent-entity' | 'read-aggregation';
}

export const WORKSPACES = [
  {
    slug: 'aps',
    path: '/workspaces/aps',
    legacyPath: '/workspaces/1',
    labelKey: 'nav.workspaceAps',
    descriptionKey: 'workspace.aps.description',
    icon: FileText,
    nature: 'paper-entry',
  },
  {
    slug: 'workshops-10th',
    path: '/workspaces/workshops-10th',
    legacyPath: '/workspaces/2',
    labelKey: 'nav.workspaceWorkshops10th',
    descriptionKey: 'workspace.workshops10th.description',
    icon: Factory,
    nature: 'independent-entity',
  },
  {
    slug: 'reports',
    path: '/workspaces/reports',
    legacyPath: '/workspaces/3',
    labelKey: 'nav.workspaceReports',
    descriptionKey: 'workspace.reports.description',
    icon: BarChart3,
    nature: 'read-aggregation',
  },
] as const satisfies readonly WorkspaceDefinition[];

export type WorkspaceSlug = (typeof WORKSPACES)[number]['slug'];
export type Workspace = (typeof WORKSPACES)[number];

export function getWorkspaceBySlug(slug: string | undefined): Workspace | null {
  return WORKSPACES.find((workspace) => workspace.slug === slug) ?? null;
}

/** Resolve only canonical workspace URLs; legacy URLs are redirected by the router. */
export function getWorkspaceByPath(pathname: string): Workspace | null {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return WORKSPACES.find((workspace) => workspace.path === normalized) ?? null;
}
