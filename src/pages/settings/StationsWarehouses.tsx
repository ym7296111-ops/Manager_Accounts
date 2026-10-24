import {
  Ban,
  Building2,
  CheckCircle2,
  ChevronDown,
  Loader2,
  Pencil,
  Plus,
  Power,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react';
import { useCallback, useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import {
  useStationsDirectory,
  type StationsDirectoryErrorCode,
  type StationWarehouse,
  type StationWithWarehouses,
} from '@/hooks/useStationsDirectory';
import {
  classifyStationWriteError,
  useCreateStation,
  useCreateWarehouse,
  useDeleteStation,
  useDeleteWarehouse,
  useUpdateStation,
  useUpdateWarehouse,
  type StationWriteErrorCode,
} from '@/hooks/useStationsMutations';
import { useI18n, type TranslationKey } from '@/i18n/I18nContext';
import { ConfirmDeleteDialog, StationFormDialog, type StationFormKind } from './StationDialogs';

/**
 * Stations & Warehouses — read plus the full write path (Phase 3).
 *
 * The directory is one nested read; every mutation invalidates it so the
 * accordion re-renders from the database rather than from optimistic local
 * state. Codes are never sent: both tables default to sequence-backed
 * SECURITY DEFINER generators.
 *
 * Authorization is the database's. `RequireCapability` on the route reads the
 * capability snapshot, which can disagree with a live revoked or delegated
 * grant, so both the read (`forbidden`) and every write are classified and
 * surfaced as an explicit alert instead of a silent no-op or an empty list.
 *
 * Deleting a station is offered only when it has no warehouses, but the real
 * guard is `warehouses_station_id_fkey ... ON DELETE RESTRICT`: a concurrent
 * insert still produces SQLSTATE 23503, which is classified as `conflict` and
 * shown as a readable message.
 */

const READ_ERROR_KEY: Record<StationsDirectoryErrorCode, TranslationKey> = {
  forbidden: 'settings.project.stations.error.forbidden',
  unavailable: 'settings.project.stations.error.unavailable',
  network: 'settings.project.stations.error.network',
  unknown: 'settings.project.stations.error.unknown',
};

const WRITE_ERROR_KEY: Record<StationWriteErrorCode, TranslationKey> = {
  forbidden: 'settings.project.stations.writeError.forbidden',
  unavailable: 'settings.project.stations.writeError.unavailable',
  network: 'settings.project.stations.writeError.network',
  validation: 'settings.project.stations.writeError.validation',
  conflict: 'settings.project.stations.writeError.conflict',
  unknown: 'settings.project.stations.writeError.unknown',
};

interface FormTarget {
  readonly kind: StationFormKind;
  readonly mode: 'create' | 'edit';
  readonly stationId?: string;
  readonly rowId?: string;
  readonly initialName?: string;
  readonly code?: string;
}

interface DeleteTarget {
  readonly kind: StationFormKind;
  readonly id: string;
  readonly name: string;
}

interface Banner {
  readonly tone: 'error' | 'success';
  readonly key: TranslationKey;
}

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

const ACTION_CLASS =
  'text-muted-foreground hover:text-foreground hover:bg-muted/60 focus-visible:ring-ring inline-grid size-8 shrink-0 place-items-center rounded-lg transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60';

function RowActions({
  entityLabel,
  isActive,
  canDelete,
  busy,
  onEdit,
  onToggleActive,
  onDelete,
}: {
  readonly entityLabel: string;
  readonly isActive: boolean;
  readonly canDelete: boolean;
  readonly busy: boolean;
  readonly onEdit: () => void;
  readonly onToggleActive: () => void;
  readonly onDelete: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex shrink-0 items-center gap-1">
      <button
        type="button"
        onClick={onEdit}
        disabled={busy}
        aria-label={`${t('settings.project.stations.action.edit')} ${entityLabel}`}
        className={ACTION_CLASS}
      >
        <Pencil className="size-3.5" aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={onToggleActive}
        disabled={busy}
        aria-label={`${
          isActive
            ? t('settings.project.stations.action.deactivate')
            : t('settings.project.stations.action.activate')
        } ${entityLabel}`}
        className={ACTION_CLASS}
      >
        <Power className="size-3.5" aria-hidden="true" />
      </button>
      {canDelete ? (
        <button
          type="button"
          onClick={onDelete}
          disabled={busy}
          aria-label={`${t('settings.project.stations.action.delete')} ${entityLabel}`}
          className={`${ACTION_CLASS} hover:text-destructive`}
        >
          <Trash2 className="size-3.5" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

export default function StationsWarehouses() {
  const { t } = useI18n();
  const query = useStationsDirectory();

  const createStation = useCreateStation();
  const updateStation = useUpdateStation();
  const deleteStation = useDeleteStation();
  const createWarehouse = useCreateWarehouse();
  const updateWarehouse = useUpdateWarehouse();
  const deleteWarehouse = useDeleteWarehouse();

  const [openStations, setOpenStations] = useState<ReadonlySet<string>>(() => new Set());
  const [form, setForm] = useState<FormTarget | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [banner, setBanner] = useState<Banner | null>(null);

  const busy =
    createStation.isPending ||
    updateStation.isPending ||
    deleteStation.isPending ||
    createWarehouse.isPending ||
    updateWarehouse.isPending ||
    deleteWarehouse.isPending;

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

  /**
   * Write failure. The form dialog deliberately stays open so the user keeps
   * what they typed and can retry; a delete confirmation is dismissed instead,
   * because a refused delete means the row is no longer deletable and there is
   * nothing to resubmit unchanged.
   */
  const failWith = useCallback((error: unknown) => {
    setBanner({ tone: 'error', key: WRITE_ERROR_KEY[classifyStationWriteError(error)] });
  }, []);

  const failDeleteWith = useCallback(
    (error: unknown) => {
      setDeleteTarget(null);
      failWith(error);
    },
    [failWith],
  );

  const succeedWith = useCallback((key: TranslationKey) => {
    setForm(null);
    setDeleteTarget(null);
    setBanner({ tone: 'success', key });
  }, []);

  function submitForm(name: string) {
    if (form === null) {
      return;
    }
    setBanner(null);

    if (form.kind === 'station') {
      if (form.mode === 'create') {
        createStation.mutate(
          { name },
          {
            onSuccess: () => succeedWith('settings.project.stations.success.saved'),
            onError: failWith,
          },
        );
        return;
      }
      updateStation.mutate(
        { id: form.rowId as string, name },
        {
          onSuccess: () => succeedWith('settings.project.stations.success.saved'),
          onError: failWith,
        },
      );
      return;
    }

    if (form.mode === 'create') {
      createWarehouse.mutate(
        { stationId: form.stationId as string, name },
        {
          onSuccess: () => succeedWith('settings.project.stations.success.saved'),
          onError: failWith,
        },
      );
      return;
    }
    updateWarehouse.mutate(
      { id: form.rowId as string, name },
      {
        onSuccess: () => succeedWith('settings.project.stations.success.saved'),
        onError: failWith,
      },
    );
  }

  function confirmDelete() {
    if (deleteTarget === null) {
      return;
    }
    setBanner(null);
    const mutation = deleteTarget.kind === 'station' ? deleteStation : deleteWarehouse;
    mutation.mutate(
      { id: deleteTarget.id },
      {
        onSuccess: () => succeedWith('settings.project.stations.success.deleted'),
        onError: failDeleteWith,
      },
    );
  }

  function toggleStationActive(station: StationWithWarehouses) {
    setBanner(null);
    updateStation.mutate({ id: station.id, isActive: !station.isActive }, { onError: failWith });
  }

  function toggleWarehouseActive(warehouse: StationWarehouse) {
    setBanner(null);
    updateWarehouse.mutate(
      { id: warehouse.id, isActive: !warehouse.isActive },
      { onError: failWith },
    );
  }

  if (query.isLoading) {
    return (
      <div className="text-muted-foreground flex items-center justify-center gap-2 py-12 text-sm">
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        {t('settings.project.stations.loading')}
      </div>
    );
  }

  const readErrorKey =
    query.isError && query.error instanceof Error && 'code' in query.error
      ? (READ_ERROR_KEY[(query.error as { code?: StationsDirectoryErrorCode }).code ?? 'unknown'] ??
        READ_ERROR_KEY.unknown)
      : null;

  const stations = query.data ?? [];

  return (
    <div className="space-y-4">
      {banner !== null ? (
        <div
          role="alert"
          className={
            banner.tone === 'error'
              ? 'border-destructive/40 bg-destructive/5 text-destructive flex items-start gap-3 rounded-xl border px-4 py-3 text-sm'
              : 'border-success/40 bg-success/5 text-success flex items-start gap-3 rounded-xl border px-4 py-3 text-sm'
          }
        >
          {banner.tone === 'error' ? (
            <Ban className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          ) : (
            <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          )}
          <span className="flex-1">{t(banner.key)}</span>
          <button
            type="button"
            onClick={() => setBanner(null)}
            aria-label={t('settings.project.stations.dismiss')}
            className="shrink-0 opacity-70 hover:opacity-100"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>
      ) : null}

      {readErrorKey !== null ? (
        <div className="space-y-4">
          <div
            role="alert"
            className="border-destructive/40 bg-destructive/5 text-destructive flex items-start gap-3 rounded-xl border px-4 py-3 text-sm"
          >
            <Ban className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>{t(readErrorKey)}</span>
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
      ) : (
        <>
          <div className="flex items-center justify-end">
            <button
              type="button"
              onClick={() => {
                setBanner(null);
                setForm({ kind: 'station', mode: 'create' });
              }}
              disabled={busy}
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
              {stations.map((station) => {
                const isOpen = openStations.has(station.id);
                const buttonId = `station-header-${station.id}`;
                const panelId = `station-panel-${station.id}`;
                const statusLabel = station.isActive
                  ? t('settings.project.stations.status.active')
                  : t('settings.project.stations.status.inactive');

                return (
                  <div
                    key={station.id}
                    className="border-border bg-card overflow-hidden rounded-xl border"
                  >
                    <div className="hover:bg-muted/30 flex items-center gap-2 px-4 py-3">
                      <button
                        type="button"
                        id={buttonId}
                        aria-expanded={isOpen}
                        aria-controls={panelId}
                        onClick={() => toggleStation(station.id)}
                        className="focus-visible:ring-ring flex min-w-0 flex-1 items-center gap-3 rounded-lg text-start focus-visible:ring-2 focus-visible:outline-none"
                      >
                        <ChevronDown
                          className={`text-muted-foreground size-4 shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`}
                          aria-hidden="true"
                        />
                        <span className="flex min-w-0 flex-1 items-baseline gap-2">
                          <span className="text-foreground truncate text-sm font-medium">
                            {station.name}
                          </span>
                          <span className="text-muted-foreground/70 shrink-0 font-mono text-xs">
                            {station.code}
                          </span>
                        </span>
                        <span className="text-muted-foreground hidden shrink-0 text-xs sm:inline">
                          {t('settings.project.stations.warehouseCount', {
                            count: station.warehouses.length,
                          })}
                        </span>
                        <StatusIcon active={station.isActive} label={statusLabel} />
                      </button>

                      <RowActions
                        entityLabel={station.name}
                        isActive={station.isActive}
                        /* Offered only for an empty station; the constraint is
                           still the real guard against a concurrent insert. */
                        canDelete={station.warehouses.length === 0}
                        busy={busy}
                        onEdit={() => {
                          setBanner(null);
                          setForm({
                            kind: 'station',
                            mode: 'edit',
                            rowId: station.id,
                            initialName: station.name,
                            code: station.code,
                          });
                        }}
                        onToggleActive={() => toggleStationActive(station)}
                        onDelete={() => {
                          setBanner(null);
                          setDeleteTarget({
                            kind: 'station',
                            id: station.id,
                            name: station.name,
                          });
                        }}
                      />
                    </div>

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
                          <button
                            type="button"
                            onClick={() => {
                              setBanner(null);
                              setForm({
                                kind: 'warehouse',
                                mode: 'create',
                                stationId: station.id,
                              });
                            }}
                            disabled={busy}
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
                              <li
                                key={warehouse.id}
                                className="bg-background border-border flex items-center gap-3 rounded-lg border px-3 py-2"
                              >
                                <span className="text-foreground min-w-0 flex-1 truncate text-sm">
                                  {warehouse.name}
                                </span>
                                <span className="text-muted-foreground/70 shrink-0 font-mono text-xs">
                                  {warehouse.code}
                                </span>
                                <StatusIcon
                                  active={warehouse.isActive}
                                  label={
                                    warehouse.isActive
                                      ? t('settings.project.stations.status.active')
                                      : t('settings.project.stations.status.inactive')
                                  }
                                />
                                <RowActions
                                  entityLabel={warehouse.name}
                                  isActive={warehouse.isActive}
                                  canDelete
                                  busy={busy}
                                  onEdit={() => {
                                    setBanner(null);
                                    setForm({
                                      kind: 'warehouse',
                                      mode: 'edit',
                                      rowId: warehouse.id,
                                      initialName: warehouse.name,
                                      code: warehouse.code,
                                    });
                                  }}
                                  onToggleActive={() => toggleWarehouseActive(warehouse)}
                                  onDelete={() => {
                                    setBanner(null);
                                    setDeleteTarget({
                                      kind: 'warehouse',
                                      id: warehouse.id,
                                      name: warehouse.name,
                                    });
                                  }}
                                />
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {form !== null ? (
        <StationFormDialog
          kind={form.kind}
          mode={form.mode}
          initialName={form.initialName}
          code={form.code}
          busy={busy}
          onSubmit={submitForm}
          onClose={() => setForm(null)}
        />
      ) : null}

      {deleteTarget !== null ? (
        <ConfirmDeleteDialog
          kind={deleteTarget.kind}
          name={deleteTarget.name}
          busy={busy}
          onConfirm={confirmDelete}
          onClose={() => setDeleteTarget(null)}
        />
      ) : null}
    </div>
  );
}
