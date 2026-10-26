import { useCallback, useMemo, useReducer } from 'react';
import type { ActiveLeafClassification } from '@/hooks/useClassifications';
import {
  openingBalanceReviewReason,
  type OpeningBalanceReviewReason,
  type OpeningBalanceRow,
  type OpeningBalanceWrite,
} from '@/hooks/useFiscalSettings';
import { amountToCents, normalizeAmountText } from './fiscalSettingsUtils';

/**
 * Draft state for the sparse opening-balance editor.
 *
 * The old screen held one big `Record<"year:warehouse:classification", string>`
 * and rendered an input for every active leaf in every warehouse, so a project
 * with 50 leaves and 20 warehouses mounted 1000 inputs and recomputed every
 * total on each keystroke. Here the unit of work is a **row the user actually
 * entered**: a saved balance, or one they added in this session.
 *
 * Two maps, keyed by `warehouseId:classificationId`:
 *
 * * `values` — the text exactly as typed. A row with no entry falls back to the
 *   saved amount, which keeps "untouched" and "edited to the same number"
 *   distinguishable without diffing strings on every render.
 * * `added` — rows created in this session and not yet saved. It changes what a
 *   delete means (discard locally vs. delete a persisted row) and what a save
 *   sends.
 *
 * The derived model is computed once per change for the whole year, in
 * O(rows) rather than O(warehouses × classifications).
 */

const SEPARATOR = ':';

function draftKey(warehouseId: string, classificationId: string): string {
  return `${warehouseId}${SEPARATOR}${classificationId}`;
}

/** `numeric(18,2)` formatted without thousands separators, as the input shows it. */
export function editableAmount(value: string | number): string {
  const cents = amountToCents(value);
  if (cents === null) {
    return String(value);
  }
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`;
}

export interface OpeningBalanceDraftRow {
  readonly classificationId: string;
  readonly code: string;
  readonly name: string;
  readonly kind: 'persisted' | 'added';
  /** Present for a persisted row only; the delete action needs it. */
  readonly balanceId: string | null;
  readonly amountText: string;
  readonly dirty: boolean;
  readonly invalid: boolean;
}

export interface OpeningBalanceReviewRow {
  readonly balanceId: string;
  readonly classificationId: string;
  readonly code: string | null;
  readonly name: string | null;
  readonly amount: number;
  readonly reason: OpeningBalanceReviewReason;
}

export interface WarehouseBalanceModel {
  readonly rows: readonly OpeningBalanceDraftRow[];
  readonly reviewRows: readonly OpeningBalanceReviewRow[];
  /** Saved + drafts + review rows: money never leaves the total. */
  readonly totalCents: bigint;
  readonly entered: number;
  readonly review: number;
  readonly invalid: boolean;
  readonly dirtyRows: readonly OpeningBalanceWrite[];
}

interface DraftState {
  readonly values: Readonly<Record<string, string>>;
  readonly added: ReadonlySet<string>;
}

type DraftAction =
  | { readonly type: 'setAmount'; readonly key: string; readonly value: string }
  | { readonly type: 'addRows'; readonly keys: readonly string[] }
  | { readonly type: 'discardAdded'; readonly key: string }
  | { readonly type: 'clearSaved'; readonly keys: readonly string[] }
  | { readonly type: 'reset' };

const EMPTY_STATE: DraftState = { values: {}, added: new Set() };

function reducer(state: DraftState, action: DraftAction): DraftState {
  switch (action.type) {
    case 'setAmount': {
      if (state.values[action.key] === action.value) {
        return state;
      }
      return { ...state, values: { ...state.values, [action.key]: action.value } };
    }
    case 'addRows': {
      const fresh = action.keys.filter((key) => !state.added.has(key));
      if (fresh.length === 0) {
        return state;
      }
      const added = new Set(state.added);
      for (const key of fresh) {
        added.add(key);
      }
      return { ...state, added };
    }
    case 'discardAdded': {
      if (!state.added.has(action.key)) {
        return state;
      }
      const added = new Set(state.added);
      added.delete(action.key);
      const values = { ...state.values };
      delete values[action.key];
      return { values, added };
    }
    case 'clearSaved': {
      /* Only the rows that reached the server are forgotten. Anything added
         while the request was in flight must survive — it is unsaved work. */
      if (action.keys.length === 0) {
        return state;
      }
      const values = { ...state.values };
      const added = new Set(state.added);
      for (const key of action.keys) {
        delete values[key];
        added.delete(key);
      }
      return { values, added };
    }
    case 'reset':
      return EMPTY_STATE;
    default:
      return state;
  }
}

export interface UseOpeningBalanceDrafts {
  readonly isDirty: boolean;
  readonly modelFor: (warehouseId: string) => WarehouseBalanceModel;
  readonly setAmount: (warehouseId: string, classificationId: string, text: string) => void;
  readonly addRows: (warehouseId: string, classificationIds: readonly string[]) => void;
  readonly discardAdded: (warehouseId: string, classificationId: string) => void;
  /** Forget rows the server confirmed. Accepts the payload that was sent. */
  readonly clearSaved: (rows: readonly OpeningBalanceWrite[]) => void;
  readonly reset: () => void;
}

const EMPTY_MODEL: WarehouseBalanceModel = {
  rows: [],
  reviewRows: [],
  totalCents: 0n,
  entered: 0,
  review: 0,
  invalid: false,
  dirtyRows: [],
};

/** Codes are zero-padded but grow past 999: `CLS-1000` must follow `CLS-999`. */
const CODE_COLLATOR = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** Rows without a readable code (review-only) sort last, by name. */
function byCode(
  a: { readonly code: string | null; readonly name?: string | null },
  b: { readonly code: string | null; readonly name?: string | null },
): number {
  if (a.code === null || b.code === null) {
    if (a.code === b.code) {
      return (a.name ?? '').localeCompare(b.name ?? '', 'ar');
    }
    return a.code === null ? 1 : -1;
  }
  return CODE_COLLATOR.compare(a.code, b.code);
}

/**
 * Build the render model for every warehouse that has at least one saved or
 * added row. Warehouses with nothing entered are absent, and the caller falls
 * back to `EMPTY_MODEL` — that is the whole point of the sparse editor.
 */
export function buildBalanceModels(
  balances: readonly OpeningBalanceRow[],
  classifications: readonly ActiveLeafClassification[],
  state: Pick<DraftState, 'values' | 'added'>,
): ReadonlyMap<string, WarehouseBalanceModel> {
  const eligible = new Map(classifications.map((entry) => [entry.id, entry]));
  const perWarehouse = new Map<
    string,
    {
      rows: OpeningBalanceDraftRow[];
      reviewRows: OpeningBalanceReviewRow[];
      totalCents: bigint;
      invalid: boolean;
      dirtyRows: OpeningBalanceWrite[];
    }
  >();

  const bucketFor = (warehouseId: string) => {
    let bucket = perWarehouse.get(warehouseId);
    if (bucket === undefined) {
      bucket = { rows: [], reviewRows: [], totalCents: 0n, invalid: false, dirtyRows: [] };
      perWarehouse.set(warehouseId, bucket);
    }
    return bucket;
  };

  for (const balance of balances) {
    const key = draftKey(balance.warehouse_id, balance.classification_id);
    const reason = openingBalanceReviewReason(balance);
    const savedCents = amountToCents(balance.amount) ?? 0n;
    /** An added row for the same classification shadows the saved one. */
    const draft = state.added.has(key) ? undefined : state.values[key];

    const effectiveCents =
      draft === undefined
        ? savedCents
        : draft.trim() === ''
          ? 0n
          : (amountToCents(draft) ?? savedCents);

    if (reason !== null) {
      bucketFor(balance.warehouse_id).reviewRows.push({
        balanceId: balance.id,
        classificationId: balance.classification_id,
        code: balance.classification?.code ?? null,
        name: balance.classification?.name ?? null,
        amount: balance.amount,
        reason,
      });
      bucketFor(balance.warehouse_id).totalCents += savedCents;
      continue;
    }

    const amountText = draft ?? editableAmount(balance.amount);
    const dirty = draft !== undefined && (amountToCents(draft) ?? null) !== savedCents;
    const invalid =
      draft !== undefined && draft.trim() !== '' && normalizeAmountText(draft) === null;
    const bucket = bucketFor(balance.warehouse_id);

    bucket.rows.push({
      classificationId: balance.classification_id,
      code: balance.classification?.code ?? '',
      name: balance.classification?.name ?? '',
      kind: 'persisted',
      balanceId: balance.id,
      amountText,
      dirty,
      invalid,
    });
    bucket.totalCents += effectiveCents;
    if (invalid) {
      bucket.invalid = true;
    }
    if (dirty) {
      const normalized = draft === undefined ? null : normalizeAmountText(draft);
      if (normalized === null) {
        bucket.invalid = true;
      } else {
        bucket.dirtyRows.push({
          fiscal_year_id: balance.fiscal_year_id,
          warehouse_id: balance.warehouse_id,
          classification_id: balance.classification_id,
          amount: normalized,
        });
      }
    }
  }

  for (const key of state.added) {
    const separator = key.indexOf(SEPARATOR);
    const warehouseId = key.slice(0, separator);
    const classificationId = key.slice(separator + 1);
    /* An added row whose classification stopped being eligible is dropped from
       the editor rather than rendered without a label. */
    const classification = eligible.get(classificationId);
    if (classification === undefined) {
      continue;
    }
    const draft = state.values[key] ?? '';
    const normalized = draft.trim() === '' ? null : normalizeAmountText(draft);
    const invalid = draft.trim() !== '' && normalized === null;
    const bucket = bucketFor(warehouseId);

    bucket.rows.push({
      classificationId,
      code: classification.code,
      name: classification.name,
      kind: 'added',
      balanceId: null,
      amountText: draft,
      dirty: true,
      invalid,
    });
    if (invalid) {
      bucket.invalid = true;
    }
    if (normalized !== null) {
      bucket.dirtyRows.push({
        fiscal_year_id: '',
        warehouse_id: warehouseId,
        classification_id: classificationId,
        amount: normalized,
      });
    }
    /* A row added in this session is money the user just entered; the total
       must move as they type, not only after a successful save. */
    bucket.totalCents += amountToCents(draft) ?? 0n;
  }

  const models = new Map<string, WarehouseBalanceModel>();
  for (const [warehouseId, bucket] of perWarehouse) {
    models.set(warehouseId, {
      rows: bucket.rows.slice().sort(byCode),
      reviewRows: bucket.reviewRows.slice().sort(byCode),
      totalCents: bucket.totalCents,
      entered: bucket.rows.length,
      review: bucket.reviewRows.length,
      invalid: bucket.invalid,
      dirtyRows: bucket.dirtyRows,
    });
  }
  return models;
}

/**
 * `fiscalYearId` is threaded in at save time instead of being stored on every
 * draft row: the state survives a year switch only until `reset()` runs, and a
 * draft must never claim a year it was not typed in.
 */
export function useOpeningBalanceDrafts(
  balances: readonly OpeningBalanceRow[],
  classifications: readonly ActiveLeafClassification[],
  fiscalYearId: string | null,
): UseOpeningBalanceDrafts {
  const [state, dispatch] = useReducer(reducer, EMPTY_STATE);

  const models = useMemo(
    () => buildBalanceModels(balances, classifications, state),
    [balances, classifications, state],
  );

  const setAmount = useCallback((warehouseId: string, classificationId: string, text: string) => {
    dispatch({ type: 'setAmount', key: draftKey(warehouseId, classificationId), value: text });
  }, []);

  const addRows = useCallback((warehouseId: string, classificationIds: readonly string[]) => {
    dispatch({
      type: 'addRows',
      keys: classificationIds.map((classificationId) => draftKey(warehouseId, classificationId)),
    });
  }, []);

  const discardAdded = useCallback((warehouseId: string, classificationId: string) => {
    dispatch({ type: 'discardAdded', key: draftKey(warehouseId, classificationId) });
  }, []);

  const clearSaved = useCallback((rows: readonly OpeningBalanceWrite[]) => {
    dispatch({
      type: 'clearSaved',
      keys: rows.map((row) => draftKey(row.warehouse_id, row.classification_id)),
    });
  }, []);

  const reset = useCallback(() => dispatch({ type: 'reset' }), []);

  const modelFor = useCallback(
    (warehouseId: string): WarehouseBalanceModel => {
      const model = models.get(warehouseId) ?? EMPTY_MODEL;
      if (fiscalYearId === null) {
        return EMPTY_MODEL;
      }
      return {
        ...model,
        dirtyRows: model.dirtyRows.map((row) => ({ ...row, fiscal_year_id: fiscalYearId })),
      };
    },
    [models, fiscalYearId],
  );

  const isDirty = useMemo(() => {
    for (const model of models.values()) {
      if (model.dirtyRows.length > 0) {
        return true;
      }
    }
    for (const key of state.added) {
      /* An empty added row is not unsaved data; nothing would be lost. */
      if ((state.values[key] ?? '').trim() !== '') {
        return true;
      }
    }
    return false;
  }, [models, state.added, state.values]);

  return { isDirty, modelFor, setAmount, addRows, discardAdded, clearSaved, reset };
}
