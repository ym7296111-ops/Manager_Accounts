import { AlertTriangle, ChevronDown, ChevronRight, Plus, Save } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ActiveLeafClassification } from '@/hooks/useClassifications';
import type { StationWarehouse } from '@/hooks/useStationsDirectory';
import { useI18n, type TranslationKey } from '@/i18n/I18nContext';
import { ClassificationPicker } from './ClassificationPicker';
import type { DeleteOpeningBalanceTarget } from './DeleteOpeningBalanceDialog';
import { DeleteOpeningBalanceDialog } from './DeleteOpeningBalanceDialog';
import { OpeningBalanceReviewRowView, OpeningBalanceRowView } from './OpeningBalanceRow';
import type { OpeningBalanceReviewReason } from '@/hooks/useFiscalSettings';
import { amountToCents, formatCents } from './fiscalSettingsUtils';
import type { WarehouseBalanceModel } from './useOpeningBalanceDrafts';

const OUTLINE_BUTTON_CLASS =
  'border-border text-foreground hover:bg-muted/50 inline-flex items-center justify-center gap-2 rounded-lg border px-3.5 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60';

const REVIEW_REASON_KEYS: Record<OpeningBalanceReviewReason, TranslationKey> = {
  not_leaf: 'settings.project.fiscal.openingBalances.review.notLeaf',
  inactive: 'settings.project.fiscal.openingBalances.review.inactive',
  unavailable: 'settings.project.fiscal.openingBalances.review.unavailable',
};

export interface OpeningBalancesWarehouseProps {
  readonly warehouse: StationWarehouse;
  readonly model: WarehouseBalanceModel;
  /** Active leaves in the project — the denominator of the counter. */
  readonly eligibleCount: number;
  readonly options: readonly ActiveLeafClassification[];
  readonly open: boolean;
  /**
   * The year's opening balances are frozen: inputs, the add-picker, delete and
   * save are all disabled. The reason lives above, in the screen banner — this
   * component only refuses the interactions.
   */
  readonly locked: boolean;
  readonly onToggle: () => void;
  readonly saving: boolean;
  readonly deleting: boolean;
  readonly onAdd: (classificationIds: readonly string[]) => void;
  readonly onChangeAmount: (classificationId: string, text: string) => void;
  readonly onDiscardAdded: (classificationId: string) => void;
  readonly onSave: () => void;
  readonly onDelete: (target: DeleteOpeningBalanceTarget) => Promise<void>;
}

/**
 * One warehouse panel of the sparse editor.
 *
 * Owns only what is local to a warehouse: whether the add-picker is open, which
 * saved row is pending deletion, the live-region announcement and the focus
 * hand-off to the first new amount field. Everything that survives a collapse —
 * the drafts and their dirty state — lives above, in `useOpeningBalanceDrafts`.
 *
 * When the year is frozen (`locked`), every control that would write is
 * disabled and the picker is closed — the disabled state mirrors an RLS policy,
 * it does not replace it.
 *
 * The body is not rendered while the panel is collapsed. That is the difference
 * between "hidden" and "cheap": previously every warehouse kept its inputs
 * mounted, so the page carried `warehouses × classifications` fields whether or
 * not anyone had expanded a station.
 */
export function OpeningBalancesWarehouse({
  warehouse,
  model,
  eligibleCount,
  options,
  open,
  locked,
  onToggle,
  saving,
  deleting,
  onAdd,
  onChangeAmount,
  onDiscardAdded,
  onSave,
  onDelete,
}: OpeningBalancesWarehouseProps) {
  const { t, locale } = useI18n();
  const toggleId = `opening-warehouse-toggle-${warehouse.id}`;
  const panelId = `opening-warehouse-panel-${warehouse.id}`;
  const pickerId = `opening-warehouse-picker-${warehouse.id}`;

  const [pickerOpen, setPickerOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DeleteOpeningBalanceTarget | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const pendingFocus = useRef<string | null>(null);
  const inputs = useRef(new Map<string, HTMLInputElement>());

  /* Focus moves after the row exists, never during the click that creates it.
     A ref carries the target so the effect only touches the DOM. */
  useEffect(() => {
    const target = pendingFocus.current;
    if (target === null) {
      return;
    }
    const element = inputs.current.get(target);
    if (element !== undefined) {
      element.focus();
      pendingFocus.current = null;
    }
  }, [model.rows]);

  const excluded = useMemo(
    () =>
      new Set([
        ...model.rows.filter((row) => row.kind === 'persisted').map((row) => row.classificationId),
        ...model.rows.filter((row) => row.kind === 'added').map((row) => row.classificationId),
      ]),
    [model.rows],
  );

  const handleAdd = (classificationIds: readonly string[]) => {
    onAdd(classificationIds);
    setPickerOpen(false);
    setAnnouncement(
      t('settings.project.fiscal.openingBalances.success.addedRows', {
        count: classificationIds.length,
      }),
    );
    pendingFocus.current = classificationIds[0] ?? null;
  };

  const confirmDelete = () => {
    if (deleteTarget === null) {
      return;
    }
    const target = deleteTarget;
    void onDelete(target).finally(() => setDeleteTarget(null));
  };

  const hasEligible = options.length > 0;

  return (
    <section className="bg-background border-border w-full max-w-full min-w-0 rounded-xl border">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 p-2.5 sm:p-3">
        <button
          type="button"
          id={toggleId}
          aria-expanded={open}
          aria-controls={panelId}
          aria-label={t('settings.project.fiscal.openingBalances.toggleWarehouse', {
            name: warehouse.name,
          })}
          onClick={onToggle}
          className="focus-visible:ring-ring flex max-w-full min-w-0 flex-1 basis-full items-center justify-between gap-3 rounded-lg px-1.5 py-1 text-start focus-visible:ring-2 focus-visible:outline-none sm:basis-auto"
        >
          <span className="flex min-w-0 flex-1 items-center gap-2.5">
            {open ? (
              <ChevronDown className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
            ) : (
              <ChevronRight className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
            )}
            <span className="min-w-0">
              <span className="text-foreground block text-sm font-semibold break-words">
                {warehouse.name}
              </span>
              <span className="text-muted-foreground block text-xs">
                {warehouse.code}
                {warehouse.isActive ? null : (
                  <span className="bg-muted text-muted-foreground ms-2 rounded-full px-1.5 py-0.5 text-[10px] font-semibold">
                    {t('settings.project.fiscal.openingBalances.inactiveWarehouse')}
                  </span>
                )}
              </span>
            </span>
          </span>
          <span className="text-muted-foreground shrink-0 text-xs">
            {t('settings.project.fiscal.openingBalances.warehouseTotal')}{' '}
            <strong className="text-foreground tabular-nums">
              {formatCents(model.totalCents, locale)}
            </strong>
          </span>
        </button>
      </div>

      <div
        id={panelId}
        role="region"
        aria-labelledby={toggleId}
        hidden={!open}
        className="border-border border-t px-3 py-3 sm:px-4"
      >
        {open ? (
          <div className="space-y-3">
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
              <p className="text-muted-foreground min-w-0 text-xs">
                {t('settings.project.fiscal.openingBalances.counter', {
                  entered: model.entered,
                  eligible: eligibleCount,
                })}
              </p>
              {model.review > 0 ? (
                <span className="bg-warning/10 text-warning inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold">
                  <AlertTriangle className="size-3.5" aria-hidden="true" />
                  {t('settings.project.fiscal.openingBalances.review.badge', {
                    count: model.review,
                  })}
                </span>
              ) : null}
            </div>

            {model.rows.length > 0 ? (
              <div className="space-y-0">
                {model.rows.map((row) => (
                  <OpeningBalanceRowView
                    key={row.classificationId}
                    classificationId={row.classificationId}
                    code={row.code}
                    name={row.name}
                    amountText={row.amountText}
                    invalid={row.invalid}
                    added={row.kind === 'added'}
                    disabled={saving || deleting || locked}
                    inputRef={(element) => {
                      if (element === null) {
                        inputs.current.delete(row.classificationId);
                      } else {
                        inputs.current.set(row.classificationId, element);
                      }
                    }}
                    onChange={(text) => onChangeAmount(row.classificationId, text)}
                    onRemove={() => {
                      if (row.kind === 'added') {
                        onDiscardAdded(row.classificationId);
                        return;
                      }
                      setDeleteTarget({
                        balanceId: row.balanceId ?? '',
                        classification: row.name,
                        code: row.code,
                        amountText: row.amountText,
                        warehouse: warehouse.name,
                      });
                    }}
                  />
                ))}
              </div>
            ) : (
              <p className="text-muted-foreground py-2 text-sm">
                {t('settings.project.fiscal.openingBalances.emptyWarehouse')}
              </p>
            )}

            {model.reviewRows.length > 0 ? (
              <section
                aria-labelledby={`opening-review-heading-${warehouse.id}`}
                className="border-warning/30 bg-warning/5 rounded-lg border p-2.5"
              >
                <h4
                  id={`opening-review-heading-${warehouse.id}`}
                  className="text-warning flex min-w-0 items-center gap-1.5 text-xs font-semibold"
                >
                  <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
                  {t('settings.project.fiscal.openingBalances.review.title', {
                    count: model.reviewRows.length,
                  })}
                </h4>
                <div className="mt-1">
                  {model.reviewRows.map((row) => (
                    <OpeningBalanceReviewRowView
                      key={row.balanceId}
                      balanceId={row.balanceId}
                      code={row.code}
                      name={row.name}
                      amountText={formatCents(amountToCents(row.amount) ?? 0n, locale)}
                      reasonLabel={t(REVIEW_REASON_KEYS[row.reason])}
                      deleting={deleting || locked}
                      onDelete={() =>
                        setDeleteTarget({
                          balanceId: row.balanceId,
                          classification:
                            row.name ??
                            t('settings.project.fiscal.openingBalances.review.unavailable'),
                          code: row.code,
                          amountText: formatCents(amountToCents(row.amount) ?? 0n, locale),
                          warehouse: warehouse.name,
                        })
                      }
                    />
                  ))}
                </div>
                <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
                  {t('settings.project.fiscal.openingBalances.review.hint')}
                </p>
              </section>
            ) : null}

            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-t pt-3">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setPickerOpen((current) => !current)}
                  aria-expanded={pickerOpen}
                  aria-controls={pickerId}
                  disabled={!hasEligible || saving || locked}
                  className={OUTLINE_BUTTON_CLASS}
                >
                  <Plus className="size-4" aria-hidden="true" />
                  {t('settings.project.fiscal.openingBalances.addClassification')}
                </button>
                {!hasEligible ? (
                  <p className="text-muted-foreground min-w-0 flex-1 basis-52 text-xs">
                    {t('settings.project.fiscal.openingBalances.noClassifications')}
                  </p>
                ) : null}
              </div>
              {model.rows.length > 0 ? (
                <button
                  type="button"
                  onClick={onSave}
                  disabled={saving || model.dirtyRows.length === 0 || model.invalid || locked}
                  aria-label={t('settings.project.fiscal.openingBalances.saveWarehouse', {
                    name: warehouse.name,
                  })}
                  className={OUTLINE_BUTTON_CLASS}
                >
                  <Save className="size-4" aria-hidden="true" />
                  {saving
                    ? t('settings.project.fiscal.openingBalances.saving')
                    : t('settings.project.fiscal.openingBalances.save')}
                </button>
              ) : null}
            </div>

            <div id={pickerId} hidden={!pickerOpen || locked}>
              {pickerOpen && !locked ? (
                <ClassificationPicker
                  options={options}
                  excludedIds={excluded}
                  busy={saving}
                  onAdd={handleAdd}
                  onClose={() => setPickerOpen(false)}
                />
              ) : null}
            </div>

            <p role="status" aria-live="polite" className="sr-only">
              {announcement}
            </p>
          </div>
        ) : null}
      </div>

      <DeleteOpeningBalanceDialog
        target={deleteTarget}
        busy={deleting}
        onConfirm={confirmDelete}
        onClose={() => setDeleteTarget(null)}
      />
    </section>
  );
}
