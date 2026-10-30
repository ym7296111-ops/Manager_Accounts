import {
  Bell,
  BookOpenText,
  FilePlus2,
  DatabaseBackup,
  KeyRound,
  KeySquare,
  LayoutDashboard,
  LayoutGrid,
  LifeBuoy,
  Palette,
  Settings,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Users,
  type LucideIcon,
} from 'lucide-react';
import type { CapabilityRequirement } from '@/hooks/useAuthCapabilities';
import type { TranslationKey } from '@/i18n/locales/ar';
import { APS_LETTER_CREATE_CAPABILITY, APS_LETTER_NEW_PATH } from '@/lib/apsLetterEntry';
import { APS_LETTERS_PATH, APS_LETTERS_READ_REQUIREMENT } from '@/lib/apsLetters';
import { WORKSPACES } from '@/lib/workspaces';

export const PROJECT_SETTINGS_CAPABILITY = 'project.settings:manage';

/*
 * Capability map for protected settings routes:
 *
 *   users → '*' OR users.approve (full user management vs approval queue)
 *   roles → '*'              (admin_set_user_roles / role permissions use is_admin())
 *   password-resets → '*' OR password_reset.manage (safe view + service RPC checks)
 *   backup       → '*'       (kept super_admin-only; the page links to Supabase Dashboard)
 *   support              → support.manage  (is_support_agent: is_admin OR support.manage)
 *   general, appearance  → settings.manage (can_manage_appearance / identity gate
 *                                           accept is_admin OR settings.manage;
 *                                           `appearance.manage` is seeded but unused)
 *   notifications        → notifications.manage OR settings.manage (templates vs SMTP)
 *   project              → project.settings:manage (dedicated project identity RPCs)
 *
 * `'*'` is implicit in every requirement, so it is not repeated here.
 */

/**
 * Sidebar navigation tree.
 *
 * The structure mirrors the product spec exactly:
 *   Dashboard · APS / Workshops / Reports (empty, collapsible) · Settings & Control
 *     ├── System & Users   (users, roles, password-resets, backup, support)
 *     ├── App Settings     (general, appearance, notifications)
 *     └── Project Settings (last direct child, dedicated capability)
 *
 * Labels are translation keys, so the same tree renders in Arabic or English.
 */

/** A leaf item that navigates to a route. */
export interface NavLinkNode {
  kind: 'link';
  /** Stable identifier (also used as the DOM id prefix for accordion state). */
  id: string;
  /** Absolute route path. */
  to: string;
  labelKey: TranslationKey;
  icon: LucideIcon;
  /** Exact match for the index route ("/"). */
  end?: boolean;
  /** The same navigation item remains active on its nested detail routes. */
  matchDescendants?: boolean;
  /**
   * Capability requirement to see this leaf (Phase 2 capability channel).
   * Undefined = always visible. A string is one slug; an array means ANY of
   * the slugs. The wildcard capability (`*`) passes every requirement — the UI
   * learns capabilities, never role names.
   *
   * The values mirror the SERVER gate of each screen (see the capability map
   * at the top of this file), not the seeded permission names: a permission
   * that no RPC checks must never reveal a link the server will refuse.
   */
  capability?: CapabilityRequirement;
}

/** A collapsible branch. May optionally navigate itself (workspaces). */
export interface NavGroupNode {
  kind: 'group';
  id: string;
  labelKey: TranslationKey;
  icon: LucideIcon;
  /** Optional route opened when the group header label is clicked. */
  to?: string;
  children: NavNode[];
  /** Optional capability requirement (children drive visibility when set). */
  capability?: CapabilityRequirement;
}

export type NavNode = NavLinkNode | NavGroupNode;

const WILDCARD_SLUG = '*';

export const NAV_ITEMS: NavNode[] = [
  {
    kind: 'link',
    id: 'dashboard',
    to: '/',
    labelKey: 'nav.dashboard',
    icon: LayoutDashboard,
    end: true,
  },
  ...WORKSPACES.map((workspace): NavGroupNode => ({
    kind: 'group',
    id: `workspace-${workspace.slug}`,
    to: workspace.path,
    labelKey: workspace.labelKey,
    icon: workspace.icon,
    children:
      workspace.slug === 'aps'
        ? [
            {
              kind: 'link',
              id: 'aps-letter-entry',
              to: APS_LETTER_NEW_PATH,
              labelKey: 'aps.entry.tab',
              icon: FilePlus2,
              capability: APS_LETTER_CREATE_CAPABILITY,
              end: true,
            },
            {
              kind: 'link',
              id: 'aps-letters',
              to: APS_LETTERS_PATH,
              labelKey: 'aps.letters.tab',
              icon: BookOpenText,
              capability: APS_LETTERS_READ_REQUIREMENT,
              matchDescendants: true,
            },
          ]
        : [],
  })),
  {
    kind: 'group',
    id: 'settings',
    labelKey: 'nav.settings',
    icon: SlidersHorizontal,
    children: [
      {
        kind: 'group',
        id: 'settings-system',
        labelKey: 'nav.systemSettings',
        icon: ShieldCheck,
        children: [
          {
            kind: 'link',
            id: 'settings-users',
            to: '/settings/system/users',
            labelKey: 'nav.users',
            icon: Users,
            capability: [WILDCARD_SLUG, 'users.approve'],
          },
          {
            kind: 'link',
            id: 'settings-roles',
            to: '/settings/system/roles',
            labelKey: 'nav.roles',
            icon: KeyRound,
            capability: WILDCARD_SLUG,
          },
          {
            kind: 'link',
            id: 'settings-password-resets',
            to: '/settings/system/password-resets',
            labelKey: 'nav.passwordResets',
            icon: KeySquare,
            capability: [WILDCARD_SLUG, 'password_reset.manage'],
          },
          {
            kind: 'link',
            id: 'settings-backup',
            to: '/settings/system/backup',
            labelKey: 'nav.backup',
            icon: DatabaseBackup,
            capability: WILDCARD_SLUG,
          },
          {
            kind: 'link',
            id: 'settings-support',
            to: '/settings/system/support',
            labelKey: 'nav.support',
            icon: LifeBuoy,
            capability: 'support.manage',
          },
        ],
      },
      {
        kind: 'group',
        id: 'settings-app',
        labelKey: 'nav.appSettings',
        icon: LayoutGrid,
        children: [
          {
            kind: 'link',
            id: 'settings-general',
            to: '/settings/app/general',
            labelKey: 'nav.general',
            icon: Settings,
            capability: 'settings.manage',
          },
          {
            kind: 'link',
            id: 'settings-appearance',
            to: '/settings/app/appearance',
            labelKey: 'nav.appearance',
            icon: Palette,
            capability: 'settings.manage',
          },
          {
            kind: 'link',
            id: 'settings-notifications',
            to: '/settings/app/notifications',
            labelKey: 'nav.notifications',
            icon: Bell,
            capability: ['notifications.manage', 'settings.manage'],
          },
        ],
      },
      {
        kind: 'link',
        id: 'settings-project',
        to: '/settings/project',
        labelKey: 'nav.projectSettings',
        icon: Settings2,
        capability: PROJECT_SETTINGS_CAPABILITY,
      },
    ],
  },
];

/** Find the leaf link matching this route, including explicitly enabled descendants. */
export function findNavLinkByPath(nodes: NavNode[], pathname: string): NavLinkNode | null {
  for (const node of nodes) {
    if (node.kind === 'link') {
      if (
        node.to === pathname ||
        (node.matchDescendants === true && pathname.startsWith(`${node.to}/`))
      ) {
        return node;
      }
    } else {
      const nested = findNavLinkByPath(node.children, pathname);
      if (nested) {
        return nested;
      }
    }
  }
  return null;
}

/**
 * Ids of every group on the branch leading to the active link.
 * Used to auto-expand the accordion chain for the current route.
 */
export function getGroupChainForPath(nodes: NavNode[], pathname: string): string[] {
  for (const node of nodes) {
    if (node.kind !== 'group') {
      continue;
    }
    if (findNavLinkByPath([node], pathname)) {
      return [node.id, ...getGroupChainForPath(node.children, pathname)];
    }
  }
  return [];
}

function nodeVisible(
  node: NavNode,
  canUse: (capability: CapabilityRequirement | undefined) => boolean,
): boolean {
  if (!canUse(node.capability)) {
    return false;
  }
  if (node.kind === 'group' && node.children.length > 0) {
    return node.children.some((child) => nodeVisible(child, canUse));
  }
  return true;
}

/**
 * Capability filter for the navigation tree (Phase 2 capability channel).
 *
 * `canUse(undefined)` must answer "visible" while capabilities are unknown —
 * the sidebar is display-only (every screen keeps its own gate and the server
 * is the security boundary), so an unresolved channel shows the full tree
 * exactly as before. A group survives whenever one child survives.
 */
export function filterNavByCapability(
  nodes: NavNode[],
  canUse: (capability: CapabilityRequirement | undefined) => boolean,
): NavNode[] {
  const visible: NavNode[] = [];
  for (const node of nodes) {
    if (!nodeVisible(node, canUse)) {
      continue;
    }
    if (node.kind === 'group' && node.children.length > 0) {
      visible.push({ ...node, children: filterNavByCapability(node.children, canUse) });
    } else {
      visible.push(node);
    }
  }
  return visible;
}
