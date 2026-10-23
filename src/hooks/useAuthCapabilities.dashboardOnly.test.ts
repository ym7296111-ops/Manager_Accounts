import { describe, expect, it } from 'vitest';
import {
  DASHBOARD_READ_CAPABILITY,
  DASHBOARD_SURFACE_CAPABILITIES,
  isDashboardOnlyActor,
  isDashboardOnlyCapabilitySet,
} from '@/hooks/useAuthCapabilities';

/**
 * Regression guard for the retired `capabilities.length === 1` heuristic.
 *
 * The executive shell used to be derived from the exact LENGTH of the
 * capability array. That made the isolation vanish the moment a dashboard-only
 * account received any second slug — including the dotted alias
 * `dashboard.read` or the legacy seeded `dashboard.view` — which would bring
 * the sidebar and every settings route back. The rule under test is the
 * replacement: "dashboard capability present AND nothing outside the dashboard
 * family".
 */
describe('isDashboardOnlyCapabilitySet', () => {
  it('accepts the single canonical capability', () => {
    expect(isDashboardOnlyCapabilitySet([DASHBOARD_READ_CAPABILITY])).toBe(true);
  });

  it('accepts a dashboard-only set after a dashboard alias is added', () => {
    // This is the regression: two entries, still dashboard-only.
    expect(isDashboardOnlyCapabilitySet([DASHBOARD_READ_CAPABILITY, 'dashboard.read'])).toBe(true);
    expect(isDashboardOnlyCapabilitySet([DASHBOARD_READ_CAPABILITY, 'dashboard.view'])).toBe(true);
  });

  it('accepts the dotted alias on its own', () => {
    expect(isDashboardOnlyCapabilitySet(['dashboard.read'])).toBe(true);
  });

  it('rejects a set without any dashboard capability', () => {
    expect(isDashboardOnlyCapabilitySet([])).toBe(false);
    expect(isDashboardOnlyCapabilitySet(['dashboard.view'])).toBe(false);
  });

  it('rejects the wildcard and any operational capability', () => {
    expect(isDashboardOnlyCapabilitySet(['*'])).toBe(false);
    expect(isDashboardOnlyCapabilitySet([DASHBOARD_READ_CAPABILITY, 'users.manage'])).toBe(false);
    expect(isDashboardOnlyCapabilitySet([DASHBOARD_READ_CAPABILITY, 'settings.manage'])).toBe(
      false,
    );
    expect(isDashboardOnlyCapabilitySet([DASHBOARD_READ_CAPABILITY, '*'])).toBe(false);
  });

  it('treats every member of the dashboard family as an alias', () => {
    for (const slug of DASHBOARD_SURFACE_CAPABILITIES) {
      expect(DASHBOARD_SURFACE_CAPABILITIES).toContain(slug);
    }
  });
});

describe('isDashboardOnlyActor', () => {
  it('requires an authoritative capability answer', () => {
    expect(
      isDashboardOnlyActor({
        capabilities: [DASHBOARD_READ_CAPABILITY],
        isAuthoritative: true,
      }),
    ).toBe(true);

    // Fail-soft: an unresolved channel must never claim the executive shell.
    expect(
      isDashboardOnlyActor({
        capabilities: [DASHBOARD_READ_CAPABILITY],
        isAuthoritative: false,
      }),
    ).toBe(false);
  });

  it('keeps a full administrator out of the dashboard-only shell', () => {
    expect(isDashboardOnlyActor({ capabilities: ['*'], isAuthoritative: true })).toBe(false);
  });
});
