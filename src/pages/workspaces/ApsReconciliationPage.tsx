import {
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  LoaderCircle,
  Plus,
  Search,
  X,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useAuth } from '@/context/AuthContext';
import { useI18n } from '@/i18n/I18nContext';
import { useSupabase } from '@/lib/supabase';
import type { Database } from '@/lib/database.types';

type ReconciliationSession =
  Database['public']['Tables']['aps_reconciliation_screen_sessions']['Row'];
type ReconciliationLine = Database['public']['Tables']['aps_reconciliation_screen_lines']['Row'];
type FiscalMonth = Database['public']['Tables']['fiscal_months']['Row'];
type Station = Database['public']['Tables']['stations']['Row'];

const CARD = 'bg-card border-border rounded-2xl border p-4 shadow-[0_2px_12px_rgb(15_23_42/0.035)]';
const BUTTON_CLASS =
  'border-border hover:bg-muted/50 inline-flex items-center justify-center gap-2 rounded-lg border px-4 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60';
const BUTTON_PRIMARY =
  'bg-primary text-primary-foreground hover:opacity-90 inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold';

export default function ApsReconciliationPage() {
  const { t, locale } = useI18n();
  const { session } = useAuth();
  const supabase = useSupabase();
  const navigate = useNavigate();

  const [sessions, setSessions] = useState<ReconciliationSession[]>([]);
  const [fiscalMonths, setFiscalMonths] = useState<FiscalMonth[]>([]);
  const [stations, setStations] = useState<Station[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null);
  const [selectedStation, setSelectedStation] = useState<string | null>(null);
  const [showNewSessionDialog, setShowNewSessionDialog] = useState(false);

  // Fetch data
  const fetchData = async () => {
    setLoading(true);
    setError(null);

    try {
      // Fetch sessions with related data
      const { data: sessionsData, error: sessionsError } = await supabase
        .from('aps_reconciliation_screen_sessions')
        .select(
          'id, fiscal_month_id, station_id, status, created_at, closed_at, closed_by, close_reason, fiscal_months(name, start_date, end_date), stations(name, code)',
        )
        .order('created_at', { ascending: false });

      if (sessionsError) throw sessionsError;
      setSessions(sessionsData || []);

      // Fetch fiscal months
      const { data: monthsData, error: monthsError } = await supabase
        .from('fiscal_months')
        .select('id, name, start_date, end_date')
        .order('start_date', { ascending: false });

      if (monthsError) throw monthsError;
      setFiscalMonths(monthsData || []);

      // Fetch stations
      const { data: stationsData, error: stationsError } = await supabase
        .from('stations')
        .select('id, name, code')
        .order('name');

      if (stationsError) throw stationsError;
      setStations(stationsData || []);

      // Set default selections
      if (monthsData && monthsData.length > 0) {
        setSelectedMonth(monthsData[0].id);
      }
      if (stationsData && stationsData.length > 0) {
        setSelectedStation(stationsData[0].id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load data');
    } finally {
      setLoading(false);
    }
  };

  useMemo(() => {
    fetchData();
  }, [session]);

  const handleCreateSession = async () => {
    if (!selectedMonth || !selectedStation) return;

    try {
      const { data, error } = await supabase.rpc('aps_open_reconciliation', {
        p_fiscal_month_id: selectedMonth,
        p_station_id: selectedStation,
      });

      if (error) throw error;

      // Refresh data
      await fetchData();
      setShowNewSessionDialog(false);

      // Navigate to the new session
      if (data && data.length > 0) {
        navigate(`/workspaces/aps/reconciliation/${data[0].id}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create session');
    }
  };

  const filteredSessions = sessions.filter((session) => {
    const monthName = session.fiscal_months?.name || '';
    const stationName = session.stations?.name || '';
    const query = searchQuery.toLowerCase();
    return (
      monthName.toLowerCase().includes(query) ||
      stationName.toLowerCase().includes(query) ||
      session.status.toLowerCase().includes(query)
    );
  });

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

  const getStatusText = (status: string) => {
    return status === 'open'
      ? t('aps.reconciliation.status.open')
      : t('aps.reconciliation.status.closed');
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

  return (
    <div className="min-w-0 space-y-6 pb-8">
      {/* Header */}
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-foreground text-xl font-bold">{t('aps.reconciliation.title')}</h1>
          <p className="text-muted-foreground mt-1 text-sm">{t('aps.reconciliation.subtitle')}</p>
        </div>
        <button onClick={() => setShowNewSessionDialog(true)} className={BUTTON_PRIMARY}>
          <Plus className="size-4" />
          {t('aps.reconciliation.newSession')}
        </button>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="text-muted-foreground absolute top-1/2 left-3 size-4 -translate-y-1/2" />
        <input
          type="text"
          placeholder={t('aps.reconciliation.searchPlaceholder')}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="border-input bg-background text-foreground placeholder:text-muted-foreground focus:ring-primary/25 focus:border-primary/60 w-full rounded-xl border py-2 pr-4 pl-10 text-sm outline-none focus:ring-2"
        />
      </div>

      {/* Sessions List */}
      {filteredSessions.length === 0 ? (
        <div className={CARD}>
          <div className="text-muted-foreground flex flex-col items-center justify-center py-12 text-center">
            <CalendarDays className="text-muted-foreground/50 mb-4 size-12" />
            <p className="text-sm">{t('aps.reconciliation.noSessions')}</p>
            <button
              onClick={() => setShowNewSessionDialog(true)}
              className={BUTTON_PRIMARY + ' mt-4'}
            >
              <Plus className="size-4" />
              {t('aps.reconciliation.createFirstSession')}
            </button>
          </div>
        </div>
      ) : (
        <div className="grid min-w-0 gap-4">
          {filteredSessions.map((session) => (
            <Link
              key={session.id}
              to={`/workspaces/aps/reconciliation/${session.id}`}
              className={CARD + ' hover:bg-muted/50 transition-colors'}
            >
              <div className="flex min-w-0 items-center justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-foreground font-semibold">
                      {session.fiscal_months?.name || t('aps.reconciliation.unknownMonth')}
                    </span>
                    <span className="text-muted-foreground">-</span>
                    <span className="text-foreground font-semibold">
                      {session.stations?.name || t('aps.reconciliation.unknownStation')}
                    </span>
                  </div>
                  <div className="text-muted-foreground mt-1 text-xs">
                    {formatDate(session.created_at)}
                    {session.closed_at && (
                      <>
                        {' - '}
                        {t('aps.reconciliation.closedOn', {
                          date: formatDate(session.closed_at),
                        })}
                      </>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-semibold ${getStatusColor(session.status)}`}
                  >
                    {session.status === 'closed' && <CheckCircle2 className="size-3" />}
                    {session.status === 'open' && <Clock className="size-3" />}
                    {getStatusText(session.status)}
                  </span>
                  <ChevronLeft className="text-muted-foreground size-4" />
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}

      {/* New Session Dialog */}
      {showNewSessionDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-card border-border w-full max-w-md rounded-2xl border p-6 shadow-xl">
            <div className="flex items-center justify-between">
              <h2 className="text-foreground text-lg font-bold">
                {t('aps.reconciliation.newSessionDialog.title')}
              </h2>
              <button
                onClick={() => setShowNewSessionDialog(false)}
                className="text-muted-foreground hover:text-foreground rounded-lg p-1"
              >
                <X className="size-5" />
              </button>
            </div>
            <p className="text-muted-foreground mt-2 text-sm">
              {t('aps.reconciliation.newSessionDialog.subtitle')}
            </p>

            <div className="mt-6 space-y-4">
              <div>
                <label className="text-foreground text-sm font-medium">
                  {t('aps.reconciliation.fiscalMonth')}
                </label>
                <select
                  value={selectedMonth || ''}
                  onChange={(e) => setSelectedMonth(e.target.value)}
                  className="border-input bg-background text-foreground focus:ring-primary/25 focus:border-primary/60 mt-1 w-full rounded-lg border px-3 py-2 text-sm outline-none focus:ring-2"
                >
                  {fiscalMonths.map((month) => (
                    <option key={month.id} value={month.id}>
                      {month.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="text-foreground text-sm font-medium">
                  {t('aps.reconciliation.station')}
                </label>
                <select
                  value={selectedStation || ''}
                  onChange={(e) => setSelectedStation(e.target.value)}
                  className="border-input bg-background text-foreground focus:ring-primary/25 focus:border-primary/60 mt-1 w-full rounded-lg border px-3 py-2 text-sm outline-none focus:ring-2"
                >
                  {stations.map((station) => (
                    <option key={station.id} value={station.id}>
                      {station.name} ({station.code})
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="mt-6 flex justify-end gap-3">
              <button onClick={() => setShowNewSessionDialog(false)} className={BUTTON_CLASS}>
                {t('aps.reconciliation.cancel')}
              </button>
              <button
                onClick={handleCreateSession}
                disabled={!selectedMonth || !selectedStation}
                className={BUTTON_PRIMARY}
              >
                <Plus className="size-4" />
                {t('aps.reconciliation.createSession')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
