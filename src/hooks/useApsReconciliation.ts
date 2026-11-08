import { useInfiniteQuery, useQueries, useQuery } from '@tanstack/react-query';
import { useAuth } from '@/context/AuthContext';
import { getSupabase } from '@/lib/supabase';
import {
  parseReconciliationOptions,
  parseReconciliationScopes,
  parseReconciliationSettings,
  parseReconciliationState,
  RECONCILIATION_PAGE_SIZE,
  ReconciliationError,
  type RecordAmounts,
} from '@/lib/apsReconciliation';

async function rpc(name: string, args?: Record<string, unknown>): Promise<unknown> {
  const client = getSupabase();
  if (!client) throw new ReconciliationError('unavailable');
  try {
    const result = await client.rpc(name, args);
    if (result.error) throw new ReconciliationError(result.error.code || 'unknown');
    return result.data;
  } catch (e) {
    if (e instanceof ReconciliationError) throw e;
    throw new ReconciliationError('network');
  }
}
export function useReconciliationOptions() {
  const { session } = useAuth();
  return useQuery({
    queryKey: ['aps-reconciliation-options', session?.user.id],
    enabled: !!session?.user.id,
    queryFn: async () => parseReconciliationOptions(await rpc('aps_get_reconciliation_options')),
    retry: false,
    refetchOnWindowFocus: false,
  });
}
export function useReconciliationScopes() {
  const { session } = useAuth();
  return useQuery({
    queryKey: ['aps-reconciliation-scopes-v3', session?.user.id],
    enabled: !!session?.user.id,
    queryFn: async () => parseReconciliationScopes(await rpc('aps_get_reconciliation_scopes_v3')),
    retry: false,
    refetchOnWindowFocus: false,
  });
}
export function useReconciliationSettings(scopeId: string | null) {
  const { session } = useAuth();
  return useQuery({
    queryKey: ['aps-reconciliation-settings-v3', session?.user.id, scopeId],
    enabled: !!session?.user.id && !!scopeId,
    queryFn: async () =>
      parseReconciliationSettings(
        await rpc('aps_get_reconciliation_settings_v3', { p_scope_id: scopeId }),
        scopeId!,
      ),
    retry: false,
    refetchOnWindowFocus: false,
  });
}
export function useOtherReconciliationSettings(scopeIds: string[]) {
  const { session } = useAuth();
  return useQueries({
    queries: scopeIds.map((scopeId) => ({
      queryKey: ['aps-reconciliation-settings-v3', session?.user.id, scopeId],
      enabled: !!session?.user.id,
      queryFn: async () =>
        parseReconciliationSettings(
          await rpc('aps_get_reconciliation_settings_v3', { p_scope_id: scopeId }),
          scopeId,
        ),
      retry: false,
      refetchOnWindowFocus: false,
    })),
  });
}
export function useReconciliationState(monthId: string | null, scopeId: string | null) {
  const { session } = useAuth();
  return useInfiniteQuery({
    queryKey: ['aps-reconciliation-state-v3', session?.user.id, monthId, scopeId],
    enabled: !!session?.user.id && !!monthId && !!scopeId,
    initialPageParam: 0,
    queryFn: async ({ pageParam }) =>
      parseReconciliationState(
        await rpc('aps_get_reconciliation_state_v3', {
          p_month_id: monthId,
          p_scope_id: scopeId,
          p_offset: pageParam,
          p_limit: RECONCILIATION_PAGE_SIZE,
        }),
        monthId!,
        pageParam,
        scopeId!,
      ),
    getNextPageParam: (last) =>
      last.pagination.has_more ? last.pagination.offset + last.pagination.limit : undefined,
    retry: false,
    refetchOnWindowFocus: false,
  });
}
export const createReconciliationScope = (name: string) =>
  rpc('aps_create_reconciliation_scope_v3', { p_name: name });
export const renameReconciliationScope = (scope: string, name: string) =>
  rpc('aps_rename_reconciliation_scope_v3', { p_scope_id: scope, p_name: name });
export const archiveReconciliationScope = (scope: string) =>
  rpc('aps_archive_reconciliation_scope_v3', { p_scope_id: scope });
export const setReconciliationSettings = (
  scope: string,
  classifications: string[],
  revision: string | null,
) =>
  rpc('aps_set_reconciliation_settings_v3', {
    p_scope_id: scope,
    p_classifications: classifications,
    p_expected_revision: revision,
  });
export const openReconciliation = (month: string, scope: string) =>
  rpc('aps_open_reconciliation_v3', { p_month_id: month, p_scope_id: scope });
export const refreshReconciliation = (session: string, scope: string) =>
  rpc('aps_refresh_reconciliation_v3', { p_session_id: session, p_scope_id: scope });
export const syncReconciliation = (
  session: string,
  scope: string,
  snapshot: string,
  generation: string,
  revision: string | null,
) =>
  rpc('aps_sync_empty_reconciliation_v3', {
    p_session_id: session,
    p_scope_id: scope,
    p_expected_snapshot_version: snapshot,
    p_expected_generation: generation,
    p_expected_config_revision: revision,
  });
export const recordReconciliation = (
  session: string,
  scope: string,
  line: string,
  classification: string,
  generation: string,
  amounts: RecordAmounts,
  version: string,
) =>
  rpc('aps_record_reconciliation_v3', {
    p_session_id: session,
    p_scope_id: scope,
    p_line_id: line,
    p_classification_id: classification,
    p_expected_generation: generation,
    p_accountant_inbound: amounts.monthlyInbound,
    p_accountant_outbound: amounts.monthlyOutbound,
    p_accountant_ytd_inbound: amounts.ytdInbound,
    p_accountant_ytd_outbound: amounts.ytdOutbound,
    p_accountant_year_opening: amounts.opening,
    p_expected_version: version,
  });
export const closeReconciliation = (month: string, scope: string, reason: string) =>
  rpc('aps_close_reconciliation_month_v3', {
    p_month_id: month,
    p_scope_id: scope,
    p_reason: reason,
  });
export const reopenReconciliation = (month: string, scope: string, reason: string) =>
  rpc('aps_reopen_reconciliation_month_v3', {
    p_month_id: month,
    p_scope_id: scope,
    p_reason: reason,
  });
