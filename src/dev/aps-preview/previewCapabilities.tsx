import type { CapabilityRequirement, DashboardOnlyInput } from '@/hooks/useAuthCapabilities';

/**
 * Synthetic reviewer with the APS read/create capabilities plus project
 * settings, so one review harness can add an issuer code and watch it arrive in
 * the entry dropdown. It does not model RLS.
 */
const CAPABILITIES = ['aps.letters:read', 'aps.letters:create', 'project.settings:manage'] as const;

export function useAuthCapabilities() {
  return {
    capabilities: [...CAPABILITIES],
    isAuthoritative: true,
    isLoading: false,
    configured: true,
    hasCapability: (capability: string) => CAPABILITIES.some((slug) => slug === capability),
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
