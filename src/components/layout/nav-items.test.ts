import { describe, expect, it } from 'vitest';
import { requirementMet } from '@/hooks/useAuthCapabilities';
import { NAV_ITEMS, filterNavByCapability, type NavNode } from './nav-items';

/**
 * Sidebar Smart Hiding: the tree is filtered by the caller's capability set.
 * Each leaf mirrors the server gate of its screen (see nav-items.ts header).
 */

function visibleLeafIds(capabilities: readonly string[]): string[] {
  const hasCapability = (slug: string) => capabilities.includes('*') || capabilities.includes(slug);
  const filtered = filterNavByCapability(NAV_ITEMS, (requirement) =>
    requirement === undefined ? true : requirementMet(requirement, hasCapability),
  );
  const ids: string[] = [];
  const walk = (nodes: NavNode[]) => {
    for (const node of nodes) {
      if (node.kind === 'link') {
        ids.push(node.id);
      } else {
        ids.push(node.id);
        walk(node.children);
      }
    }
  };
  walk(filtered);
  return ids;
}

const SYSTEM_LEAVES = ['settings-users', 'settings-roles', 'settings-backup', 'settings-support'];
const APP_LEAVES = ['settings-general', 'settings-appearance', 'settings-notifications'];

describe('sidebar capability filter', () => {
  it('shows the whole tree to the wildcard holder', () => {
    const ids = visibleLeafIds(['*']);
    for (const id of [...SYSTEM_LEAVES, ...APP_LEAVES]) {
      expect(ids).toContain(id);
    }
  });

  it('hides a branch entirely when none of its children survive', () => {
    const ids = visibleLeafIds([]);
    expect(ids).toContain('dashboard');
    expect(ids).not.toContain('settings');
    expect(ids).not.toContain('settings-system');
    expect(ids).not.toContain('settings-app');
  });

  it('keeps only the system leaves the caller can use (support.manage)', () => {
    const ids = visibleLeafIds(['support.manage']);
    expect(ids).toContain('settings-support');
    for (const id of ['settings-users', 'settings-roles', 'settings-backup']) {
      expect(ids).not.toContain(id);
    }
    expect(ids).toContain('settings-system');
    expect(ids).not.toContain('settings-app');
  });

  it('keeps users, roles and the informational backup route gated by the wildcard', () => {
    /* A seeded `admin` role holds users.manage / roles.manage / backup.manage
       but NOT `*`; the backup route intentionally remains super_admin-only. */
    const ids = visibleLeafIds(['users.manage', 'roles.manage', 'backup.manage']);
    for (const id of ['settings-users', 'settings-roles', 'settings-backup']) {
      expect(ids).not.toContain(id);
    }
  });

  it('opens the app branch to settings.manage (general, appearance, and SMTP-backed notifications)', () => {
    const ids = visibleLeafIds(['settings.manage']);
    for (const id of APP_LEAVES) {
      expect(ids).toContain(id);
    }
    expect(ids).not.toContain('settings-system');
  });

  it('shows notifications to a notifications.manage holder without settings.manage', () => {
    const ids = visibleLeafIds(['notifications.manage']);
    expect(ids).toContain('settings-notifications');
    expect(ids).not.toContain('settings-general');
    expect(ids).not.toContain('settings-appearance');
  });

  it('does not treat the unused appearance.manage slug as a reason to show appearance', () => {
    const ids = visibleLeafIds(['appearance.manage']);
    expect(ids).not.toContain('settings-appearance');
    expect(ids).not.toContain('settings-app');
  });
});
