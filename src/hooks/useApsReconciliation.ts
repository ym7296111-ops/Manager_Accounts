import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useAuth } from '@/context/AuthContext';
import { getSupabase } from '@/lib/supabase';
import {
  parseReconciliationOptions,
  parseReconciliationState,
  RECONCILIATION_PAGE_SIZE,
  ReconciliationError,
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
export function useReconciliationState(monthId: string | null, stationId: string | null) {
  const { session } = useAuth();
  return useInfiniteQuery({
    queryKey: ['aps-reconciliation-state', session?.user.id, monthId, stationId],
    enabled: !!session?.user.id && !!monthId && !!stationId,
    initialPageParam: 0,
    queryFn: async ({ pageParam }) =>
      parseReconciliationState(
        await rpc('aps_get_reconciliation_state', {
          p_month_id: monthId,
          p_station_id: stationId,
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
export const openReconciliation = (month: string, station: string) =>
  rpc('aps_open_reconciliation', { p_month_id: month, p_station_id: station });
export const recordReconciliation = (session: string, classification: string, amount: string) =>
  rpc('aps_record_reconciliation', {
    p_session_id: session,
    p_classification_id: classification,
    p_accountant_amount: amount,
  });
export const closeReconciliation = (month: string, reason: string) =>
  rpc('aps_close_reconciliation_month', { p_month_id: month, p_reason: reason });
export const reopenReconciliation = (month: string, reason: string) =>
  rpc('aps_reopen_reconciliation_month', { p_month_id: month, p_reason: reason });
