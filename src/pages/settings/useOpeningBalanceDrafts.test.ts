import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ActiveLeafClassification } from '@/hooks/useClassifications';
import type { OpeningBalanceRow } from '@/hooks/useFiscalSettings';
import {
  buildBalanceModels,
  editableAmount,
  useOpeningBalanceDrafts,
} from './useOpeningBalanceDrafts';

/**
 * Draft model of the sparse opening-balance editor (design study §7, U7–U17).
 *
 * These tests drive the hook directly instead of the screen: the guarantees are
 * about which rows exist, what a save would send, and what counts as dirty —
 * all of which the component only renders.
 */

const YEAR = 'fy-2025';
const WAREHOUSE = 'wh-1';
const OTHER_WAREHOUSE = 'wh-2';

function leaf(id: string, code: string, name: string): ActiveLeafClassification {
  return { id, code, name };
}

const CLASSIFICATIONS: readonly ActiveLeafClassification[] = [
  leaf('cls-1', 'CLS-001', 'حديد وصلب'),
  leaf('cls-2', 'CLS-002', 'أخشاب'),
  leaf('cls-10', 'CLS-1000', 'زيوت وشحوم'),
];

function balance(
  overrides: Partial<OpeningBalanceRow> & {
    classification?: OpeningBalanceRow['classification'];
  } = {},
): OpeningBalanceRow {
  const classificationId = overrides.classification_id ?? 'cls-1';
  const known =
    CLASSIFICATIONS.find((entry) => entry.id === classificationId) ?? CLASSIFICATIONS[0]!;
  return {
    id: `ob-${classificationId}`,
    fiscal_year_id: YEAR,
    warehouse_id: WAREHOUSE,
    classification_id: classificationId,
    amount: 100,
    created_at: '2025-07-01T00:00:00.000Z',
    updated_at: '2025-07-01T00:00:00.000Z',
    ...overrides,
    classification:
      overrides.classification === undefined
        ? { id: known.id, code: known.code, name: known.name, isLeaf: true, isActive: true }
        : overrides.classification,
  };
}

function setup(balances: readonly OpeningBalanceRow[] = []) {
  return renderHook(
    ({
      rows,
      classifications,
      year,
    }: {
      rows: readonly OpeningBalanceRow[];
      classifications: readonly ActiveLeafClassification[];
      year: string | null;
    }) => useOpeningBalanceDrafts(rows, classifications, year),
    {
      initialProps: {
        rows: balances,
        classifications: CLASSIFICATIONS,
        year: YEAR,
      },
    },
  );
}

describe('editableAmount', () => {
  it('renders numeric(18,2) without grouping, always with two decimals', () => {
    expect(editableAmount(125.5)).toBe('125.50');
    expect(editableAmount(0)).toBe('0.00');
    expect(editableAmount(1234567.8)).toBe('1234567.80');
    expect(editableAmount('125.50')).toBe('125.50');
  });

  it('keeps an unparseable value visible instead of blanking the field', () => {
    expect(editableAmount('abc')).toBe('abc');
  });
});

describe('buildBalanceModels', () => {
  it('creates a model only for warehouses that have rows', () => {
    const models = buildBalanceModels([balance()], CLASSIFICATIONS, {
      values: {},
      added: new Set(),
    });
    expect([...models.keys()]).toEqual([WAREHOUSE]);
  });

  it('sorts persisted rows by code numerically, not by string', () => {
    const models = buildBalanceModels(
      [
        balance({ classification_id: 'cls-10', id: 'ob-10' }),
        balance({ classification_id: 'cls-2', id: 'ob-2' }),
      ],
      CLASSIFICATIONS,
      { values: {}, added: new Set() },
    );
    expect(models.get(WAREHOUSE)?.rows.map((row) => row.code)).toEqual(['CLS-002', 'CLS-1000']);
  });

  it('keeps a review row inside the total and out of the editable rows', () => {
    const models = buildBalanceModels(
      [
        balance({ amount: 100 }),
        balance({
          classification_id: 'cls-2',
          id: 'ob-2',
          amount: 50,
          classification: {
            id: 'cls-2',
            code: 'CLS-002',
            name: 'أخشاب',
            isLeaf: false,
            isActive: true,
          },
        }),
      ],
      CLASSIFICATIONS,
      { values: {}, added: new Set() },
    );
    const model = models.get(WAREHOUSE);
    expect(model?.rows).toHaveLength(1);
    expect(model?.reviewRows).toHaveLength(1);
    expect(model?.reviewRows[0]?.reason).toBe('not_leaf');
    expect(model?.totalCents).toBe(15000n);
    expect(model?.entered).toBe(1);
    expect(model?.review).toBe(1);
  });

  it('sorts review rows with an unreadable classification last', () => {
    const models = buildBalanceModels(
      [
        balance({ classification_id: 'cls-9', id: 'ob-9', classification: null }),
        balance({
          classification_id: 'cls-2',
          id: 'ob-2',
          classification: {
            id: 'cls-2',
            code: 'CLS-002',
            name: 'أخشاب',
            isLeaf: false,
            isActive: true,
          },
        }),
      ],
      CLASSIFICATIONS,
      { values: {}, added: new Set() },
    );
    expect(models.get(WAREHOUSE)?.reviewRows.map((row) => row.code)).toEqual(['CLS-002', null]);
  });

  it('drops an added row whose classification is no longer eligible', () => {
    const models = buildBalanceModels([], CLASSIFICATIONS, {
      values: {},
      added: new Set([`${WAREHOUSE}:cls-missing`]),
    });
    expect(models.size, 'a warehouse with no renderable row has no model at all').toBe(0);
  });
});

describe('useOpeningBalanceDrafts', () => {
  it('falls back to a shared empty model for a warehouse with no rows', () => {
    const { result } = setup();
    const model = result.current.modelFor('wh-empty');
    expect(model.rows).toEqual([]);
    expect(model.totalCents).toBe(0n);
    expect(model.dirtyRows).toEqual([]);
  });

  it('returns nothing at all while there is no active year', () => {
    const { result } = setup([balance()]);
    act(() => result.current.setAmount(WAREHOUSE, 'cls-1', '200'));
    const withYear = result.current.modelFor(WAREHOUSE);
    expect(withYear.dirtyRows[0]?.fiscal_year_id).toBe(YEAR);

    act(() => result.current.reset());
    expect(result.current.modelFor(WAREHOUSE).dirtyRows).toEqual([]);
  });

  it('marks an edited persisted row dirty and sends the formatted amount', () => {
    const { result } = setup([balance({ amount: 100 })]);
    act(() => result.current.setAmount(WAREHOUSE, 'cls-1', '125.5'));

    const model = result.current.modelFor(WAREHOUSE);
    expect(model.rows[0]?.dirty).toBe(true);
    expect(model.totalCents).toBe(12550n);
    expect(model.dirtyRows).toEqual([
      {
        fiscal_year_id: YEAR,
        warehouse_id: WAREHOUSE,
        classification_id: 'cls-1',
        amount: '125.50',
      },
    ]);
    expect(result.current.isDirty).toBe(true);
  });

  it('treats "edited back to the saved value" as clean', () => {
    const { result } = setup([balance({ amount: 100 })]);
    act(() => result.current.setAmount(WAREHOUSE, 'cls-1', '100.00'));
    expect(result.current.modelFor(WAREHOUSE).dirtyRows).toEqual([]);
    expect(result.current.isDirty).toBe(false);
  });

  it('flags an invalid amount and never puts it in the payload', () => {
    const { result } = setup([balance({ amount: 100 })]);
    act(() => result.current.setAmount(WAREHOUSE, 'cls-1', '-5'));

    const model = result.current.modelFor(WAREHOUSE);
    expect(model.invalid).toBe(true);
    expect(model.rows[0]?.invalid).toBe(true);
    expect(model.dirtyRows).toEqual([]);
    expect(model.totalCents, 'an invalid draft keeps the saved amount in the total').toBe(10000n);
  });

  it('adds rows in one commit and keeps an empty added row out of the payload', () => {
    const { result } = setup();
    act(() => result.current.addRows(WAREHOUSE, ['cls-1', 'cls-2']));

    let model = result.current.modelFor(WAREHOUSE);
    expect(model.rows).toHaveLength(2);
    expect(model.dirtyRows, 'empty added rows are not unsaved data').toEqual([]);
    expect(result.current.isDirty).toBe(false);

    act(() => result.current.setAmount(WAREHOUSE, 'cls-1', '7'));
    model = result.current.modelFor(WAREHOUSE);
    expect(model.dirtyRows).toEqual([
      { fiscal_year_id: YEAR, warehouse_id: WAREHOUSE, classification_id: 'cls-1', amount: '7.00' },
    ]);
    expect(result.current.isDirty).toBe(true);
  });

  it('discards a session-added row together with its text', () => {
    const { result } = setup();
    act(() => result.current.addRows(WAREHOUSE, ['cls-1']));
    act(() => result.current.setAmount(WAREHOUSE, 'cls-1', '7'));
    act(() => result.current.discardAdded(WAREHOUSE, 'cls-1'));

    expect(result.current.modelFor(WAREHOUSE).rows).toEqual([]);
    expect(result.current.isDirty).toBe(false);
  });

  it('clears only the rows the server confirmed', () => {
    const { result } = setup();
    act(() => result.current.addRows(WAREHOUSE, ['cls-1', 'cls-2']));
    act(() => result.current.setAmount(WAREHOUSE, 'cls-1', '10'));
    act(() => result.current.setAmount(WAREHOUSE, 'cls-2', '20'));

    const sent = result.current
      .modelFor(WAREHOUSE)
      .dirtyRows.filter((row) => row.amount === '10.00');
    act(() => result.current.clearSaved(sent));

    const model = result.current.modelFor(WAREHOUSE);
    expect(model.rows.map((row) => [row.classificationId, row.kind])).toEqual([['cls-2', 'added']]);
    expect(result.current.isDirty, 'the row added during the request still counts').toBe(true);
  });

  it('restores the saved amounts after a reset', () => {
    const { result } = setup([balance({ amount: 100 })]);
    act(() => result.current.setAmount(WAREHOUSE, 'cls-1', '5'));
    expect(result.current.modelFor(WAREHOUSE).totalCents).toBe(500n);

    act(() => result.current.reset());
    const model = result.current.modelFor(WAREHOUSE);
    expect(model.rows[0]?.amountText).toBe('100.00');
    expect(model.totalCents).toBe(10000n);
    expect(model.dirtyRows).toEqual([]);
  });

  it('keeps each warehouse independent', () => {
    const { result } = setup([balance({ warehouse_id: OTHER_WAREHOUSE, amount: 40 })]);
    act(() => result.current.addRows(WAREHOUSE, ['cls-1']));
    act(() => result.current.setAmount(WAREHOUSE, 'cls-1', '5'));

    expect(result.current.modelFor(WAREHOUSE).totalCents).toBe(500n);
    expect(result.current.modelFor(OTHER_WAREHOUSE).totalCents).toBe(4000n);
    expect(result.current.modelFor(OTHER_WAREHOUSE).dirtyRows).toEqual([]);
  });

  it('clears the dirty flag when the last draft is reset', () => {
    const { result } = setup();
    act(() => result.current.addRows(WAREHOUSE, ['cls-1']));
    act(() => result.current.setAmount(WAREHOUSE, 'cls-1', '3'));
    expect(result.current.isDirty).toBe(true);

    act(() => result.current.reset());
    expect(result.current.isDirty).toBe(false);
    expect(result.current.modelFor(WAREHOUSE).rows).toEqual([]);
  });
});
