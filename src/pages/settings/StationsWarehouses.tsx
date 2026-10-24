import { Ban, Building2, CheckCircle2, ChevronDown, Loader2, Plus, RefreshCw } from 'lucide-react';
import { useCallback, useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import {
  useStationsDirectory,
  type StationsDirectoryErrorCode,
  type StationWarehouse,
  type StationWithWarehouses,
} from '@/hooks/useStationsDirectory';
import { useI18n } from '@/i18n/I18nContext';

/**
 * Stations & Warehouses — read-only accordion (Phase 2).
 *
 * Renders the nested directory fetched by `useStationsDirectory()` as a list of
 * collapsed stations. Expanding a station reveals its warehouses. Both "add"
 * buttons are present but inert: the write path (create/edit RPCs or table
 * inserts plus their audit trail) is a later phase, and a control that silently
 * discards a click is worse than one that is visibly not yet available.
 *
 * The route already wraps this screen in `RequireCapability`, but the capability
 * snapshot can disagree with the live grant, so a `forbidden` query result is
 * surfaced explicitly instead of collapsing into the empty state.
 */

const ERROR_MESSAGE_KEY: Record<StationsDirectoryErrorCode, string> = {
  forbidden: 'settings.project.stations.error.forbidden',
  unavailable: 'settings.project.stations.error.unavailable',
  network: 'settings.project.stations.error.network',
  unknown: 'settings.project.stations.error.unknown',
};

function StatusIcon({ active, label }: { readonly active: boolean; readonly label: string }) {
  const Icon = active ? CheckCircle2 : Ban;
  return (
    <span className="inline-flex shrink-0 items-center gap-1">
      <Icon
        className={active ? 'text-success size-4' : 'text-destructive size-4'}
        aria-hidden="true"
      />
      <span className="sr-only">{label}</span>
    </span>
  );
}

function WarehouseRow({ warehouse }: { readonly warehouse: StationWarehouse }) {
  const { t } = useI18n();
  return (
    <li className="bg-background border-border flex items-center gap-3 rounded-lg border px-3 py-2">
      <span className="text-foreground min-w-0 flex-1 truncate text-sm">{warehouse.name}</span>
      <span className="text-muted-foreground/70 shrink-0 font-mono text-xs">{warehouse.code}</span>
      <StatusIcon
        active={warehouse.isActive}
        label={
          warehouse.isActive
            ? t('settings.project.stations.status.active')
            : t('settings.project.stations.status.inactive')
        }
      />
    </li>
  );
}

function StationAccordionItem({
  station,
  isOpen,
  onToggle,
}: {
  readonly station: StationWithWarehouses;
  readonly isOpen: boolean;
  readonly onToggle: () => void;
}) {
  const { t } = useI18n();
  const buttonId = `station-header-${station.id}`;
  const panelId = `station-panel-${station.id}`;
  const statusLabel = station.isActive
    ? t('settings.project.stations.status.active')
    : t('settings.project.stations.status.inactive');

  return (
    <div className="border-border bg-card overflow-hidden rounded-xl border">
      <button
        type="button"
        id={buttonId}
        aria-expanded={isOpen}
        aria-controls={panelId}
        onClick={onToggle}
        className="hover:bg-muted/40 focus-visible:ring-ring flex w-full items-center gap-3 px-4 py-3 text-start focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
      >
        <ChevronDown
          className={`text-muted-foreground size-4 shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`}
          aria-hidden="true"
        />

        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="text-foreground truncate text-sm font-medium">{station.name}</span>
          <span className="text-muted-foreground/70 shrink-0 font-mono text-xs">
            {station.code}
          </span>
        </span>

        <span className="text-muted-foreground hidden shrink-0 text-xs sm:inline">
          {t('settings.project.stations.warehouseCount', { count: station.warehouses.length })}
        </span>

        <StatusIcon active={station.isActive} label={statusLabel} />
      </button>

      {isOpen ? (
        <div
          id={panelId}
          role="region"
          aria-labelledby={buttonId}
          className="border-border space-y-3 border-t px-4 py-3"
        >
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
              {t('settings.project.stations.warehousesHeading')}
            </h3>
            {/* Inert by design — the warehouse write path is a later phase. */}
            <button
              type="button"
              disabled
              className="text-primary inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Plus className="size-3.5" aria-hidden="true" />
              {t('settings.project.stations.addWarehouse')}
            </button>
          </div>

          {station.warehouses.length === 0 ? (
            <p className="text-muted-foreground py-2 text-sm">
              {t('settings.project.stations.noWarehouses')}
            </p>
          ) : (
            <ul className="space-y-2">
              {station.warehouses.map((warehouse) => (
                <WarehouseRow key={warehouse.id} warehouse={warehouse} />
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

export default function StationsWarehouses() {
  const { t } = useI18n();
  const query = useStationsDirectory();
  const [openStations, setOpenStations] = useState<ReadonlySet<string>>(() => new Set());

  const toggleStation = useCallback((id: string) => {
    setOpenStations((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  if (query.isLoading) {
    return (
      <div className="text-muted-foreground flex items-center justify-center gap-2 py-12 text-sm">
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        {t('settings.project.stations.loading')}
      </div>
    );
  }

  if (query.isError) {
    const code =
      query.error instanceof Error && 'code' in query.error
        ? ((query.error as { code?: unknown }).code as StationsDirectoryErrorCode | undefined)
        : undefined;
    const messageKey =
      code !== undefined && code in ERROR_MESSAGE_KEY
        ? ERROR_MESSAGE_KEY[code]
        : ERROR_MESSAGE_KEY.unknown;

    return (
      <div className="space-y-4">
        <div
          role="alert"
          className="border-destructive/40 bg-destructive/5 text-destructive flex items-start gap-3 rounded-xl border px-4 py-3 text-sm"
        >
          <Ban className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{t(messageKey as never)}</span>
        </div>
        <button
          type="button"
          onClick={() => void query.refetch()}
          className="text-foreground border-border hover:bg-muted/40 inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-semibold transition-colors"
        >
          <RefreshCw className="size-3.5" aria-hidden="true" />
          {t('settings.project.stations.retry')}
        </button>
      </div>
    );
  }

  const stations = query.data ?? [];

  return (
    <div className="space-y-4">
      {/* Inert by design — the station write path is a later phase. */}
      <div className="flex items-center justify-end">
        <button
          type="button"
          disabled
          className="bg-primary text-primary-foreground inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-xs font-semibold transition-opacity disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Plus className="size-3.5" aria-hidden="true" />
          {t('settings.project.stations.add')}
        </button>
      </div>

      {stations.length === 0 ? (
        <EmptyState
          icon={Building2}
          title={t('settings.project.stations.empty.title')}
          description={t('settings.project.stations.empty.description')}
        />
      ) : (
        <div className="space-y-2">
          {stations.map((station) => (
            <StationAccordionItem
              key={station.id}
              station={station}
              isOpen={openStations.has(station.id)}
              onToggle={() => toggleStation(station.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
