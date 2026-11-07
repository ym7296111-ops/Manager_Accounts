// Preview-only capability channel: the review harness has no AuthProvider.
// Keep the existing project-settings preview limited to the six original tabs.
export * from '../../hooks/useAuthCapabilities';
import type { AuthCapabilitiesApi } from '../../hooks/useAuthCapabilities';

export function useAuthCapabilities(): AuthCapabilitiesApi {
  return {
    capabilities: ['project.settings:manage'],
    isLoading: false,
    isAuthoritative: true,
    configured: true,
    hasCapability: (slug) => slug === 'project.settings:manage',
    refetch: () => Promise.resolve(),
  };
}
