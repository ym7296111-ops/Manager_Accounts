/**
 * APS Reconciliation capabilities and constants.
 */

export const APS_RECONCILIATION_PATH = '/workspaces/aps/reconciliation' as const;
export const APS_RECONCILIATION_MANAGE_CAPABILITY = 'aps.reconciliation:manage' as const;
export const APS_RECONCILIATION_CLOSE_CAPABILITY = 'aps.reconciliation:close_month' as const;
export const APS_RECONCILIATION_REOPEN_CAPABILITY = 'aps.reconciliation:reopen_month' as const;

/**
 * Format currency value for display.
 */
export function formatCurrency(value: number | string | null | undefined, locale: string): string {
  if (value === null || value === undefined) return '';
  const num = typeof value === 'string' ? parseFloat(value) : value;
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(num);
}
