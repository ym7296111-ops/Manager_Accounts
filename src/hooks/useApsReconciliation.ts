import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useAuth } from '@/context/AuthContext';
import { getSupabase } from '@/lib/supabase';
import {
  parseReconciliationOptions,
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
export function useReconciliationSettings() {
  const { session } = useAuth();
  return useQuery({
    queryKey: ['aps-reconciliation-settings-v2', session?.user.id],
    enabled: !!session?.user.id,
    queryFn: async () =>
      parseReconciliationSettings(await rpc('aps_get_reconciliation_settings_v2')),
    retry: false,
    refetchOnWindowFocus: false,
  });
}
export function useReconciliationState(monthId: string | null) {
  const { session } = useAuth();
  return useInfiniteQuery({
    queryKey: ['aps-reconciliation-state-v2', session?.user.id, monthId],
    enabled: !!session?.user.id && !!monthId,
    initialPageParam: 0,
    queryFn: async ({ pageParam }) =>
      parseReconciliationState(
        await rpc('aps_get_reconciliation_state_v2', {
          p_month_id: monthId,
          p_offset: pageParam,
          p_limit: RECONCILIATION_PAGE_SIZE,
        }),
        monthId!,
        pageParam,
      ),
    getNextPageParam: (last) =>
      last.pagination.has_more ? last.pagination.offset + last.pagination.limit : undefined,
    retry: false,
    refetchOnWindowFocus: false,
  });
}
export const setReconciliationSettings = (classifications: string[]) =>
  rpc('aps_set_reconciliation_settings_v2', { p_classifications: classifications });
export const openReconciliation = (month: string) =>
  rpc('aps_open_reconciliation_v2', { p_month_id: month });
export const refreshReconciliation = (session: string) =>
  rpc('aps_refresh_reconciliation_v2', { p_session_id: session });
export const recordReconciliation = (
  session: string,
  classification: string,
  amounts: RecordAmounts,
  version: string,
) =>
  rpc('aps_record_reconciliation_v2', {
    p_session_id: session,
    p_classification_id: classification,
    p_accountant_inbound: amounts.monthlyInbound,
    p_accountant_outbound: amounts.monthlyOutbound,
    p_accountant_ytd_inbound: amounts.ytdInbound,
    p_accountant_ytd_outbound: amounts.ytdOutbound,
    p_accountant_year_opening: amounts.opening,
    p_expected_version: version,
  });
export const closeReconciliation = (month: string, reason: string) =>
  rpc('aps_close_reconciliation_month_v2', { p_month_id: month, p_reason: reason });
export const reopenReconciliation = (month: string, reason: string) =>
  rpc('aps_reopen_reconciliation_month_v2', { p_month_id: month, p_reason: reason });
