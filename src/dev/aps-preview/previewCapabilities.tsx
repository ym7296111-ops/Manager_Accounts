import type { CapabilityRequirement, DashboardOnlyInput } from '@/hooks/useAuthCapabilities';

/** Synthetic reviewer with read + create capabilities; it does not model RLS. */
export function useAuthCapabilities() {
  return {
    capabilities: ['aps.letters:read', 'aps.letters:create'],
    isAuthoritative: true,
    isLoading: false,
    configured: true,
    hasCapability: (capability: string) =>
      capability === 'aps.letters:read' || capability === 'aps.letters:create',
    refetch: () => Promise.resolve(),
  };
}

export function requirementMet(
  requirement: CapabilityRequirement,
  hasCapability: (capability: string) => boolean,
) {
  const slugs = typeof requirement === 'string' ? [requirement] : requirement;
  return slugs.some(hasCapability);
}

export function isDashboardOnlyActor(_channel: DashboardOnlyInput) {
  return false;
}
