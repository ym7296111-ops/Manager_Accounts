import { ChevronDown } from 'lucide-react';
import { useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router';
import {
  requirementMet,
  useAuthCapabilities,
  type CapabilityRequirement,
} from '@/hooks/useAuthCapabilities';
import { useI18n } from '@/i18n/I18nContext';
import { filterNavByCapability, getGroupChainForPath, type NavNode } from './nav-items';

interface SidebarNavProps {
  nodes: NavNode[];
  /** Icons-only mode (desktop, collapsed): children are hidden behind a tap. */
  collapsed: boolean;
  /** Called after a leaf/group navigates — used to close the mobile drawer. */
  onNavigate?: () => void;
  /** Collapsed group tapped: expand the sidebar and reveal its children. */
  onRequestExpand?: () => void;
  /**
   * Unique prefix (from `useId()`) for generated DOM ids. The desktop sidebar
   * and the mobile drawer mount this tree at the same time, so without it
   * `aria-controls` would point at duplicated ids.
   */
  idPrefix: string;
}

interface NavRowProps extends Omit<SidebarNavProps, 'nodes'> {
  node: NavNode;
}

function activeLinkClass(isActive: boolean): string {
  return [
    'flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors outline-none',
    isActive
      ? 'bg-sidebar-accent font-semibold text-sidebar-accent-foreground shadow-sm'
      : 'text-sidebar-foreground/80 hover:bg-sidebar-accent/70 hover:text-sidebar-accent-foreground focus-visible:bg-sidebar-accent/70',
  ].join(' ');
}

function NavRow({ node, collapsed, onNavigate, onRequestExpand, idPrefix }: NavRowProps) {
  const { t } = useI18n();
  const location = useLocation();
  const label = t(node.labelKey);
  const Icon = node.icon;
  const panelId = `${idPrefix}-nav-panel-${node.id}`;
  const isCurrentLeaf = node.kind === 'link' && location.pathname === node.to;
  const onActiveBranch =
    node.kind === 'group' && getGroupChainForPath([node], location.pathname).length > 0;

  /* Deep links mount already expanded; navigation into this branch expands
     it during render (the React-approved alternative to setState effects). */
  const [open, setOpen] = useState(onActiveBranch);
  const [seenPath, setSeenPath] = useState(location.pathname);
  if (seenPath !== location.pathname) {
    setSeenPath(location.pathname);
    if (node.kind === 'group' && getGroupChainForPath([node], location.pathname).length > 0) {
      setOpen(true);
    }
  }

  /* ------------------------------------------------------------- leaf */
  if (node.kind === 'link') {
    return (
      <li>
        <NavLink
          to={node.to}
          end={node.end ?? false}
          onClick={onNavigate}
          title={collapsed ? label : undefined}
          aria-label={collapsed ? label : undefined}
          className={({ isActive }) =>
            activeLinkClass(
              isActive &&
                !(node.id === 'aps-letters' && location.pathname === '/workspaces/aps/letters/new'),
            )
          }
        >
          <Icon className="size-[18px] shrink-0" aria-hidden="true" />
          {!collapsed && <span className="truncate">{label}</span>}
        </NavLink>
      </li>
    );
  }

  /* ----------------------------------------------------- collapsed group */
  if (collapsed) {
    const iconClass = 'size-[18px] shrink-0';

    if (node.to !== undefined) {
      // Workspaces: primary intent in icons-only mode is opening the screen.
      return (
        <li>
          <Link
            to={node.to}
            onClick={onNavigate}
            title={label}
            aria-label={label}
            className={activeLinkClass(isCurrentLeaf)}
          >
            <Icon className={iconClass} aria-hidden="true" />
          </Link>
        </li>
      );
    }

    // Settings branches have no route of their own: reveal the tree instead.
    return (
      <li>
        <button
          type="button"
          onClick={() => onRequestExpand?.()}
          title={label}
          aria-label={label}
          className={activeLinkClass(false)}
        >
          <Icon className={iconClass} aria-hidden="true" />
        </button>
      </li>
    );
  }

  /* ----------------------------------------------------- expanded group */
  const hasChildren = node.children.length > 0;
  const toggleLabel = open ? t('nav.collapse', { name: label }) : t('nav.expand', { name: label });

  const headerIcon = <Icon className="size-[18px] shrink-0" aria-hidden="true" />;
  const headerChevron = (
    <button
      type="button"
      onClick={() => setOpen((previous) => !previous)}
      aria-expanded={open}
      aria-controls={panelId}
      aria-label={toggleLabel}
      title={toggleLabel}
      className="text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground ms-auto grid size-6 shrink-0 place-items-center rounded-md transition-colors"
    >
      <ChevronDown
        className={`size-4 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
        aria-hidden="true"
      />
    </button>
  );

  const labelSpan = <span className="truncate">{label}</span>;

  return (
    <li>
      <div className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors">
        {node.to !== undefined ? (
          <NavLink
            to={node.to}
            onClick={onNavigate}
            className={({ isActive }) =>
              [
                'flex min-w-0 flex-1 items-center gap-3 outline-none',
                isActive
                  ? 'text-sidebar-accent-foreground font-semibold'
                  : 'text-sidebar-foreground/80 hover:text-sidebar-accent-foreground',
              ].join(' ')
            }
          >
            {headerIcon}
            {labelSpan}
          </NavLink>
        ) : (
          <button
            type="button"
            onClick={() => setOpen((previous) => !previous)}
            aria-expanded={open}
            aria-controls={panelId}
            className="text-sidebar-foreground/80 hover:text-sidebar-accent-foreground flex min-w-0 flex-1 items-center gap-3 text-start transition-colors outline-none"
          >
            {headerIcon}
            {labelSpan}
          </button>
        )}
        {headerChevron}
      </div>

      <div id={panelId} className="accordion-panel" data-open={open}>
        <div>
          <ul className="border-sidebar-border ms-4 space-y-1 border-s ps-3">
            {hasChildren ? (
              node.children.map((child) => (
                <NavRow
                  key={child.id}
                  node={child}
                  collapsed={false}
                  onNavigate={onNavigate}
                  onRequestExpand={onRequestExpand}
                  idPrefix={idPrefix}
                />
              ))
            ) : (
              <li className="text-sidebar-foreground/50 rounded-lg px-3 py-2 text-xs">
                {t('nav.emptyGroup')}
              </li>
            )}
          </ul>
        </div>
      </div>
    </li>
  );
}

/**
 * Recursive accordion navigation shared by the desktop sidebar and the
 * mobile drawer. Keeps the open/close state per row and auto-expands the
 * chain that leads to the active route.
 *
 * Phase 2 (capability channel): leaves carry `capability` slugs and are
 * filtered through `useAuthCapabilities()` — the sidebar reads capabilities,
 * never role names (`capabilities.includes('*')` shows everything). While the
 * channel is unresolved (loading, unconfigured, refused) the full tree stays
 * visible: this is display-only, every screen keeps its own gate and the
 * database remains the security boundary.
 */
export function SidebarNav(props: SidebarNavProps) {
  const capabilities = useAuthCapabilities();
  const canUse = (requirement: CapabilityRequirement | undefined): boolean =>
    !capabilities.isAuthoritative ||
    requirement === undefined ||
    requirementMet(requirement, (slug) => capabilities.hasCapability(slug));
  const nodes = filterNavByCapability(props.nodes, canUse);

  return (
    <ul className="space-y-1">
      {nodes.map((node) => (
        <NavRow
          key={node.id}
          node={node}
          collapsed={props.collapsed}
          onNavigate={props.onNavigate}
          onRequestExpand={props.onRequestExpand}
          idPrefix={props.idPrefix}
        />
      ))}
    </ul>
  );
}
