import {
  ArrowLeft,
  CheckCircle2,
  Clock,
  LoaderCircle,
  MoreVertical,
  Save,
  Undo2,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useAuth } from '@/context/AuthContext';
import { useI18n } from '@/i18n/I18nContext';
import { useSupabase } from '@/lib/supabase';
import { formatCurrency } from '@/lib/apsReconciliation';
import type { Database } from '@/lib/database.types';

type ReconciliationSession =
  Database['public']['Tables']['aps_reconciliation_screen_sessions']['Row'];
type ReconciliationLine = Database['public']['Tables']['aps_reconciliation_screen_lines']['Row'];
type Classification = Database['public']['Tables']['classifications']['Row'];

const CARD = 'bg-card border-border rounded-2xl border p-4 shadow-[0_2px_12px_rgb(15_23_42/0.035)]';
const BUTTON_CLASS =
  'border-border hover:bg-muted/50 inline-flex items-center justify-center gap-2 rounded-lg border px-4 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60';
const BUTTON_PRIMARY =
  'bg-primary text-primary-foreground hover:opacity-90 inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold';
const BUTTON_DANGER =
  'bg-destructive text-destructive-foreground hover:opacity-90 inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold';

export default function ApsReconciliationSessionPage() {
  const { t, locale } = useI18n();
  const { session } = useAuth();
  const supabase = useSupabase();
  const navigate = useNavigate();
  const { sessionId } = useParams<{ sessionId: string }>();

  const [sessionData, setSessionData] = useState<ReconciliationSession | null>(null);
  const [lines, setLines] = useState<(ReconciliationLine & { classifications?: Classification })[]>(
    [],
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null); // 'saving', 'closing', 'reopening'
  const [closeReason, setCloseReason] = useState('');
  const [reopenReason, setReopenReason] = useState('');
  const [showCloseDialog, setShowCloseDialog] = useState(false);
  const [showReopenDialog, setShowReopenDialog] = useState(false);

  // Fetch session and lines data
  const fetchData = async () => {
    if (!sessionId) return;

    setLoading(true);
    setError(null);

    try {
      // Fetch session
      const { data: session, error: sessionError } = await supabase
        .from('aps_reconciliation_screen_sessions')
        .select(
          'id, fiscal_month_id, station_id, status, created_at, closed_at, closed_by, close_reason, fiscal_months(name, start_date, end_date), stations(name, code)',
        )
        .eq('id', sessionId)
        .single();

      if (sessionError) throw sessionError;
      setSessionData(session);

      // Fetch lines with classification data
      const { data: linesData, error: linesError } = await supabase
        .from('aps_reconciliation_screen_lines')
        .select(
          'id, session_id, classification_id, book_amount, accountant_amount, difference, classifications(name, code)',
        )
        .eq('session_id', sessionId)
        .order('classifications->>name', { ascending: true });

      if (linesError) throw linesError;
      setLines(linesData || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load session data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [sessionId, session]);

  // Calculate if all differences are zero
  const allDifferencesZero = useMemo(() => {
    return lines.every((line) => line.difference === 0 || line.difference === null);
  }, [lines]);

  // Calculate total difference
  const totalDifference = useMemo(() => {
    return lines.reduce((sum, line) => sum + (line.difference || 0), 0);
  }, [lines]);

  const handleUpdateAmount = async (lineId: string, amount: string) => {
    if (!sessionId) return;

    const numericAmount = amount === '' ? null : parseFloat(amount);

    try {
      const { error } = await supabase.rpc('aps_record_reconciliation', {
        p_session_id: sessionId,
        p_classification_id: lineId,
        p_accountant_amount: numericAmount,
      });

      if (error) throw error;

      // Refresh data to get updated values
      await fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update amount');
    }
  };

  const handleCloseSession = async () => {
    if (!sessionData || !sessionData.fiscal_month_id) return;

    try {
      setSaving('closing');
      const { error } = await supabase.rpc('aps_close_reconciliation_month', {
        p_fiscal_month_id: sessionData.fiscal_month_id,
        p_reason: closeReason,
      });

      if (error) throw error;

      await fetchData();
      setShowCloseDialog(false);
      setCloseReason('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to close session');
    } finally {
      setSaving(null);
    }
  };

  const handleReopenSession = async () => {
    if (!sessionData || !sessionData.fiscal_month_id) return;

    try {
      setSaving('reopening');
      const { error } = await supabase.rpc('aps_reopen_reconciliation_month', {
        p_fiscal_month_id: sessionData.fiscal_month_id,
        p_reason: reopenReason,
      });

      if (error) throw error;

      await fetchData();
      setShowReopenDialog(false);
      setReopenReason('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reopen session');
    } finally {
      setSaving(null);
    }
  };

  const formatDate = (dateString: string | null) => {
    if (!dateString) return '';
    return new Date(dateString).toLocaleDateString(locale, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'open':
        return 'bg-amber-500/10 text-amber-700 dark:text-amber-300';
      case 'closed':
        return 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
      default:
        return 'bg-gray-500/10 text-gray-700';
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-full items-center justify-center">
        <div className="text-muted-foreground flex items-center gap-2">
          <LoaderCircle className="size-5 animate-spin" />
          <span>{t('aps.reconciliation.loading')}</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-destructive/5 border-destructive/25 text-destructive rounded-xl border p-4 text-sm">
        {error}
        <button onClick={fetchData} className="text-primary ms-4 font-semibold">
          {t('aps.reconciliation.retry')}
        </button>
      </div>
    );
  }

  if (!sessionData) {
    return (
      <div className="bg-warning/5 border-warning/25 text-warning rounded-xl border p-4 text-sm">
        {t('aps.reconciliation.sessionNotFound')}
        <Link to="/workspaces/aps/reconciliation" className="text-primary ms-4 font-semibold">
          {t('aps.reconciliation.backToList')}
        </Link>
      </div>
    );
  }

  return (
    <div className="min-w-0 space-y-6 pb-8">
      {/* Header */}
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-4">
          <Link
            to="/workspaces/aps/reconciliation"
            className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-sm"
          >
            <ArrowLeft className="size-4" />
            {t('aps.reconciliation.backToList')}
          </Link>
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-foreground text-xl font-bold">
            {t('aps.reconciliation.sessionTitle')}
          </h1>
          <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-2 text-sm">
            <span>{sessionData.fiscal_months?.name || t('aps.reconciliation.unknownMonth')}</span>
            <span className="text-muted-foreground">-</span>
            <span>{sessionData.stations?.name || t('aps.reconciliation.unknownStation')}</span>
            <span
              className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-semibold ${getStatusColor(sessionData.status)}`}
            >
              {sessionData.status === 'closed' && <CheckCircle2 className="size-3" />}
              {sessionData.status === 'open' && <Clock className="size-3" />}
              {sessionData.status === 'open'
                ? t('aps.reconciliation.status.open')
                : t('aps.reconciliation.status.closed')}
            </span>
          </div>
        </div>
      </div>

      {/* Session Info */}
      <div className={CARD}>
        <div className="grid min-w-0 grid-cols-2 gap-4 @md:grid-cols-4">
          <div>
            <p className="text-muted-foreground text-xs">{t('aps.reconciliation.createdAt')}</p>
            <p className="text-foreground mt-1 text-sm font-medium">
              {formatDate(sessionData.created_at)}
            </p>
          </div>
          {sessionData.closed_at && (
            <div>
              <p className="text-muted-foreground text-xs">{t('aps.reconciliation.closedAt')}</p>
              <p className="text-foreground mt-1 text-sm font-medium">
                {formatDate(sessionData.closed_at)}
              </p>
            </div>
          )}
          <div>
            <p className="text-muted-foreground text-xs">{t('aps.reconciliation.totalItems')}</p>
            <p className="text-foreground mt-1 text-sm font-medium">{lines.length}</p>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">
              {t('aps.reconciliation.totalDifference')}
            </p>
            <p
              className={`text-foreground mt-1 text-sm font-medium ${
                totalDifference === 0 ? 'text-emerald-600' : 'text-destructive'
              }`}
            >
              {formatCurrency(totalDifference, locale)}
            </p>
          </div>
        </div>
      </div>

      {/* Lines Table */}
      <div className={CARD}>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-border border-b">
                <th className="text-muted-foreground px-4 py-3 text-left font-semibold">
                  {t('aps.reconciliation.classification')}
                </th>
                <th className="text-muted-foreground px-4 py-3 text-right font-semibold">
                  {t('aps.reconciliation.bookAmount')}
                </th>
                <th className="text-muted-foreground px-4 py-3 text-right font-semibold">
                  {t('aps.reconciliation.accountantAmount')}
                </th>
                <th className="text-muted-foreground px-4 py-3 text-right font-semibold">
                  {t('aps.reconciliation.difference')}
                </th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => {
                const isZero = line.difference === 0 || line.difference === null;
                return (
                  <tr key={line.id} className="border-border border-b last:border-0">
                    <td className="text-foreground px-4 py-3 text-left">
                      <div className="font-medium">
                        {line.classifications?.name ||
                          t('aps.reconciliation.unknownClassification')}
                      </div>
                      {line.classifications?.code && (
                        <div className="text-muted-foreground text-xs">
                          {line.classifications.code}
                        </div>
                      )}
                    </td>
                    <td className="text-foreground px-4 py-3 text-right tabular-nums">
                      {formatCurrency(line.book_amount, locale)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {sessionData.status === 'open' ? (
                        <input
                          type="text"
                          dir="ltr"
                          inputMode="decimal"
                          value={
                            line.accountant_amount !== null && line.accountant_amount !== undefined
                              ? line.accountant_amount
                              : ''
                          }
                          onChange={(e) =>
                            handleUpdateAmount(line.classification_id, e.target.value)
                          }
                          className="border-input bg-background text-foreground focus:ring-primary/25 focus:border-primary/60 w-full rounded-lg border px-3 py-2 text-right text-sm outline-none focus:ring-2"
                        />
                      ) : (
                        <span className="text-foreground tabular-nums">
                          {formatCurrency(line.accountant_amount, locale)}
                        </span>
                      )}
                    </td>
                    <td
                      className={`text-foreground px-4 py-3 text-right font-semibold tabular-nums ${
                        isZero ? 'text-emerald-600' : 'text-destructive'
                      }`}
                    >
                      {formatCurrency(line.difference, locale)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Summary */}
        <div className="border-border mt-4 border-t pt-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <p className="text-muted-foreground text-sm">
              {allDifferencesZero ? (
                <span className="font-medium text-emerald-600">
                  {t('aps.reconciliation.allDifferencesZero')}
                </span>
              ) : (
                <span className="text-destructive font-medium">
                  {t('aps.reconciliation.differencesExist')}
                </span>
              )}
            </p>
            <div className="flex items-center gap-2">
              {sessionData.status === 'open' && (
                <button
                  onClick={() => setShowCloseDialog(true)}
                  disabled={!allDifferencesZero || saving !== null}
                  className={
                    BUTTON_PRIMARY +
                    (!allDifferencesZero || saving !== null ? ' cursor-not-allowed opacity-60' : '')
                  }
                >
                  <CheckCircle2 className="size-4" />
                  {t('aps.reconciliation.closeMonth')}
                </button>
              )}
              {sessionData.status === 'closed' && (
                <button
                  onClick={() => setShowReopenDialog(true)}
                  disabled={saving !== null}
                  className={
                    BUTTON_DANGER + (saving !== null ? ' cursor-not-allowed opacity-60' : '')
                  }
                >
                  <Undo2 className="size-4" />
                  {t('aps.reconciliation.reopenMonth')}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Close Dialog */}
      {showCloseDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-card border-border w-full max-w-md rounded-2xl border p-6 shadow-xl">
            <div className="flex items-center justify-between">
              <h2 className="text-foreground text-lg font-bold">
                {t('aps.reconciliation.closeDialog.title')}
              </h2>
              <button
                onClick={() => {
                  setShowCloseDialog(false);
                  setCloseReason('');
                }}
                className="text-muted-foreground hover:text-foreground rounded-lg p-1"
              >
                <X className="size-5" />
              </button>
            </div>
            <p className="text-muted-foreground mt-2 text-sm">
              {t('aps.reconciliation.closeDialog.subtitle')}
            </p>
            <p className="text-muted-foreground mt-2 text-sm">
              {t('aps.reconciliation.closeDialog.warning')}
            </p>

            <div className="mt-4">
              <label className="text-foreground text-sm font-medium">
                {t('aps.reconciliation.closeReason')}
              </label>
              <textarea
                value={closeReason}
                onChange={(e) => setCloseReason(e.target.value)}
                placeholder={t('aps.reconciliation.closeReasonPlaceholder')}
                className="border-input bg-background text-foreground focus:ring-primary/25 focus:border-primary/60 mt-1 w-full rounded-lg border px-3 py-2 text-sm outline-none focus:ring-2"
                rows={3}
              />
            </div>

            <div className="mt-6 flex justify-end gap-3">
              <button
                onClick={() => {
                  setShowCloseDialog(false);
                  setCloseReason('');
                }}
                className={BUTTON_CLASS}
              >
                {t('aps.reconciliation.cancel')}
              </button>
              <button
                onClick={handleCloseSession}
                disabled={!closeReason || saving === 'closing'}
                className={BUTTON_PRIMARY + (!closeReason ? ' cursor-not-allowed opacity-60' : '')}
              >
                {saving === 'closing' ? (
                  <>
                    <LoaderCircle className="size-4 animate-spin" />
                    {t('aps.reconciliation.closing')}
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="size-4" />
                    {t('aps.reconciliation.closeMonth')}
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reopen Dialog */}
      {showReopenDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-card border-border w-full max-w-md rounded-2xl border p-6 shadow-xl">
            <div className="flex items-center justify-between">
              <h2 className="text-foreground text-lg font-bold">
                {t('aps.reconciliation.reopenDialog.title')}
              </h2>
              <button
                onClick={() => {
                  setShowReopenDialog(false);
                  setReopenReason('');
                }}
                className="text-muted-foreground hover:text-foreground rounded-lg p-1"
              >
                <X className="size-5" />
              </button>
            </div>
            <p className="text-muted-foreground mt-2 text-sm">
              {t('aps.reconciliation.reopenDialog.subtitle')}
            </p>

            <div className="mt-4">
              <label className="text-foreground text-sm font-medium">
                {t('aps.reconciliation.reopenReason')}
              </label>
              <textarea
                value={reopenReason}
                onChange={(e) => setReopenReason(e.target.value)}
                placeholder={t('aps.reconciliation.reopenReasonPlaceholder')}
                className="border-input bg-background text-foreground focus:ring-primary/25 focus:border-primary/60 mt-1 w-full rounded-lg border px-3 py-2 text-sm outline-none focus:ring-2"
                rows={3}
              />
            </div>

            <div className="mt-6 flex justify-end gap-3">
              <button
                onClick={() => {
                  setShowReopenDialog(false);
                  setReopenReason('');
                }}
                className={BUTTON_CLASS}
              >
                {t('aps.reconciliation.cancel')}
              </button>
              <button
                onClick={handleReopenSession}
                disabled={!reopenReason || saving === 'reopening'}
                className={BUTTON_DANGER + (!reopenReason ? ' cursor-not-allowed opacity-60' : '')}
              >
                {saving === 'reopening' ? (
                  <>
                    <LoaderCircle className="size-4 animate-spin" />
                    {t('aps.reconciliation.reopening')}
                  </>
                ) : (
                  <>
                    <Undo2 className="size-4" />
                    {t('aps.reconciliation.reopenMonth')}
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
