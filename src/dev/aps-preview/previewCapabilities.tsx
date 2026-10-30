import type { CapabilityRequirement, DashboardOnlyInput } from '@/hooks/useAuthCapabilities';

/** The preview is always a synthetic read-only reviewer; it does not model RLS. */
export function useAuthCapabilities() {
  return {
    capabilities: ['aps.letters:read'],
    isAuthoritative: true,
    isLoading: false,
    configured: true,
    hasCapability: (capability: string) => capability === 'aps.letters:read',
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
