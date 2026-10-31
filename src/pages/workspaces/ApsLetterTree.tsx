import { Check, ChevronDown, Plus, Trash2, TriangleAlert, X } from 'lucide-react';
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { ModalShell } from '@/components/ui/ModalShell';
import { MODAL_BUTTON_CLASS, useEscapeKey } from '@/components/ui/modalStyles';
import { SearchCombobox } from '@/components/ui/SearchCombobox';
import { useI18n } from '@/i18n/I18nContext';
import {
  centsToSignedAmount,
  groupEntryLines,
  newEntryLine,
  normalizeEntryAmount,
  signedAmountToCents,
  sumEntryAmounts,
  type EntryLine,
  type EntryOption,
  type EntryParty,
} from '@/lib/apsLetterEntry';
import { formatLetterAmount } from '@/lib/apsLetters';

/*
 * The counterparty tree as a box-free diagram: root (the letter type) ←
 * parties ← warehouses ← classification rows, drawn with the connector
 * lines in globals.css (.aps-tree). One component serves both counterparty
 * types; `type` only changes the root label, the party vocabulary and the
 * sign of the projected balance. The stored model stays the flat line
 * list — every interaction below rewrites lines and lets the grouping
 * re-derive, so the tree can never disagree with what will be saved.
 *
 * Affordances keep one meaning each: the chevron folds, the ghost row at
 * the end of a child list adds, the trash removes (groups ask first).
 */

const CONTROL =
  'border-input bg-card text-foreground focus:border-primary/60 focus:ring-primary/25 min-h-11 w-full min-w-0 rounded-xl border px-3 text-sm outline-none focus:ring-2 disabled:opacity-60';
const GHOST_BUTTON =
  'text-primary hover:bg-primary/5 focus-visible:ring-ring inline-flex min-h-11 items-center gap-2 rounded-lg px-2 text-sm font-semibold focus-visible:ring-2 focus-visible:outline-none disabled:opacity-50';
const ICON_BUTTON =
  'text-muted-foreground hover:text-destructive focus-visible:ring-ring grid size-11 shrink-0 place-items-center rounded-lg focus-visible:ring-2 focus-visible:outline-none disabled:opacity-30';
const CHEVRON_BUTTON =
  'text-muted-foreground hover:text-foreground focus-visible:ring-ring grid size-11 shrink-0 place-items-center rounded-lg focus-visible:ring-2 focus-visible:outline-none';

interface WarehouseComboboxOption {
  readonly value: string;
  readonly label: string;
  readonly keywords: string;
}

export interface ApsLetterTreeProps {
  readonly type: 'inbound' | 'outbound';
  /** Active parties of this type's branch, in entry-options order. */
  readonly parties: readonly EntryParty[];
  readonly warehouseOptions: readonly WarehouseComboboxOption[];
  readonly classifications: readonly EntryOption[];
  readonly lines: readonly EntryLine[];
  /** Physical balances keyed `warehouseId:classificationId`; null hides badges. */
  readonly balances: ReadonlyMap<string, string> | null;
  readonly maxLines: number;
  /**
   * Lines the page's validation blames. A changed set opens their
   * ancestors, scrolls to the first one and paints the rows.
   */
  readonly highlightedKeys?: ReadonlySet<string>;
  readonly onLinesChange: (lines: EntryLine[]) => void;
}

function PartySelect({
  value,
  parties,
  placeholder,
  onChange,
}: {
  readonly value: string;
  readonly parties: readonly EntryParty[];
  readonly placeholder: string;
  readonly onChange: (partyId: string) => void;
}) {
  const { t } = useI18n();
  const missing = value !== '' && !parties.some((party) => party.id === value);
  return (
    <select
      className={CONTROL}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      aria-label={placeholder}
    >
      <option value="">{placeholder}</option>
      {missing && <option value={value}>{t('aps.entry.unavailableOption')}</option>}
      {parties.map((party) => (
        <option key={party.id} value={party.id}>
          {party.name} — {party.code}
        </option>
      ))}
    </select>
  );
}

/**
 * ✓ / ⚠ / ✗ for the projected physical balance. Static by design — no
 * animation, no blinking (WCAG 2.2.2); the numbers are one tap or focus away.
 */
function BalanceBadge({
  current,
  projected,
  repeated,
}: {
  readonly current: string;
  readonly projected: string;
  readonly repeated: boolean;
}) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const cents = signedAmountToCents(projected) ?? 0n;
  const state = cents > 0n ? 'positive' : cents === 0n ? 'zero' : 'negative';
  const chip =
    state === 'positive'
      ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
      : state === 'zero'
        ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
        : 'bg-destructive/10 text-destructive';
  const Icon = state === 'positive' ? Check : state === 'zero' ? TriangleAlert : X;
  return (
    <span
      className="relative inline-flex shrink-0"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <button
        type="button"
        aria-label={`${t('aps.entry.balance.show')} — ${t(`aps.entry.balance.${state}`)}`}
        aria-expanded={open}
        title={`${t('aps.entry.balance.current')} ${formatLetterAmount(current, locale)}`}
        onClick={() => setOpen((value) => !value)}
        className={`${chip} focus-visible:ring-ring grid size-10 place-items-center rounded-lg focus-visible:ring-2 focus-visible:outline-none`}
      >
        <Icon className="size-4" aria-hidden="true" />
      </button>
      {open && (
        <span
          role="status"
          className="border-border bg-card text-foreground absolute start-0 top-full z-20 mt-1 w-60 space-y-1 rounded-xl border p-3 text-xs shadow-lg"
        >
          <span className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">{t('aps.entry.balance.current')}</span>
            <bdi dir="ltr" className="font-bold">
              {formatLetterAmount(current, locale)}
            </bdi>
          </span>
          <span className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">{t('aps.entry.balance.after')}</span>
            <bdi dir="ltr" className="font-bold">
              {formatLetterAmount(projected, locale)}
            </bdi>
          </span>
          {repeated && (
            <span className="text-muted-foreground block pt-1 leading-relaxed">
              {t('aps.entry.balance.physicalNote')}
            </span>
          )}
        </span>
      )}
    </span>
  );
}

function CollapseButton({
  collapsed,
  onToggle,
}: {
  readonly collapsed: boolean;
  readonly onToggle: () => void;
}) {
  const { t, dir } = useI18n();
  return (
    <button
      type="button"
      aria-label={t(collapsed ? 'aps.entry.tree.expand' : 'aps.entry.tree.collapse')}
      aria-expanded={!collapsed}
      onClick={onToggle}
      className={CHEVRON_BUTTON}
    >
      <ChevronDown
        className={`size-4 transition-transform ${
          collapsed ? (dir === 'rtl' ? 'rotate-90' : '-rotate-90') : ''
        }`}
        aria-hidden="true"
      />
    </button>
  );
}

type PendingDelete =
  | {
      readonly kind: 'party';
      readonly partyId: string;
      readonly name: string;
      readonly warehouses: number;
      readonly lines: number;
      readonly total: string | null;
    }
  | {
      readonly kind: 'warehouse';
      readonly partyId: string;
      readonly warehouseId: string;
      readonly name: string;
      readonly lines: number;
      readonly total: string | null;
    };

/**
 * Group deletion asks first — in the system's one modal shell, with the
 * descendant counts and the value on the table, because a whole party is
 * one mis-tap away from its warehouses and classifications.
 */
function DeleteGroupDialog({
  target,
  kindLabel,
  onConfirm,
  onClose,
}: {
  readonly target: PendingDelete | null;
  readonly kindLabel: string;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const titleId = useId();

  useEscapeKey(onClose, target !== null);

  if (target === null) {
    return null;
  }

  const total =
    target.total === null ? t('aps.entry.waitingAmount') : formatLetterAmount(target.total, locale);

  return (
    <ModalShell
      titleId={titleId}
      title={
        target.kind === 'party'
          ? t('aps.entry.tree.deletePartyTitle', { name: target.name })
          : t('aps.entry.tree.deleteWarehouseTitle')
      }
      closeLabel={t('aps.entry.tree.deleteClose')}
      onClose={onClose}
      busy={false}
    >
      <p className="text-muted-foreground mt-3 text-sm leading-relaxed">
        {target.kind === 'party'
          ? t('aps.entry.tree.deletePartyBody', {
              kind: kindLabel,
              name: target.name,
              warehouses: target.warehouses,
              lines: target.lines,
              total,
            })
          : t('aps.entry.tree.deleteWarehouseBody', {
              name: target.name,
              lines: target.lines,
              total,
            })}
      </p>
      <div className="mt-5 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className={`${MODAL_BUTTON_CLASS} border-border text-foreground border`}
        >
          {t('aps.entry.tree.deleteCancel')}
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className={`${MODAL_BUTTON_CLASS} bg-destructive text-destructive-foreground`}
        >
          {t('aps.entry.tree.deleteConfirm')}
        </button>
      </div>
    </ModalShell>
  );
}

interface ClassificationRowProps {
  readonly line: EntryLine;
  readonly classifications: readonly EntryOption[];
  readonly balanceCurrent: string | null;
  readonly balanceProjected: string | null;
  readonly repeated: boolean;
  readonly highlighted: boolean;
  readonly onUpdate: (key: string, next: Partial<EntryLine>) => void;
  readonly onRemove: (key: string) => void;
}

/**
 * One live editor row. Memoized on primitive props (and stable callbacks)
 * so typing in one amount does not repaint the other 499 rows; the labels
 * stay as accessible names, visually hidden — the tree position already
 * says what each field is.
 */
const ClassificationRow = memo(function ClassificationRow({
  line,
  classifications,
  balanceCurrent,
  balanceProjected,
  repeated,
  highlighted,
  onUpdate,
  onRemove,
}: ClassificationRowProps) {
  const { t } = useI18n();
  const missingClass =
    line.classificationId !== '' &&
    !classifications.some((item) => item.id === line.classificationId);
  return (
    <div
      data-line-key={line.key}
      className={`aps-tree-node flex min-w-0 flex-wrap items-center gap-2 rounded-lg pt-2 pb-1 ${
        highlighted ? 'bg-destructive/5 ring-destructive/70 ring-2 ring-inset' : ''
      }`}
    >
      <label className="min-w-[10rem] flex-1">
        <span className="sr-only">{t('aps.letters.classification')}</span>
        <select
          className={CONTROL}
          value={line.classificationId}
          onChange={(event) => onUpdate(line.key, { classificationId: event.target.value })}
        >
          <option value="">{t('aps.entry.chooseClassification')}</option>
          {missingClass && (
            <option value={line.classificationId}>{t('aps.entry.unavailableOption')}</option>
          )}
          {classifications.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name} — {item.code}
            </option>
          ))}
        </select>
      </label>
      <label className="w-36 shrink-0">
        <span className="sr-only">{t('aps.letters.amount')}</span>
        <input
          className={CONTROL}
          dir="ltr"
          inputMode="decimal"
          placeholder={t('aps.entry.amountPlaceholder')}
          value={line.amount}
          onChange={(event) => onUpdate(line.key, { amount: event.target.value })}
        />
      </label>
      <span className="flex min-h-11 items-center">
        {balanceCurrent !== null && balanceProjected !== null && (
          <BalanceBadge current={balanceCurrent} projected={balanceProjected} repeated={repeated} />
        )}
      </span>
      <button
        type="button"
        aria-label={t('aps.entry.tree.removeClassification')}
        onClick={() => onRemove(line.key)}
        className={ICON_BUTTON}
      >
        <Trash2 className="size-4" aria-hidden="true" />
      </button>
    </div>
  );
});

export function ApsLetterTree({
  type,
  parties,
  warehouseOptions,
  classifications,
  lines,
  balances,
  maxLines,
  highlightedKeys,
  onLinesChange,
}: ApsLetterTreeProps) {
  const { t, locale } = useI18n();
  const [collapsedParties, setCollapsedParties] = useState<ReadonlySet<string>>(new Set());
  const [collapsedWarehouses, setCollapsedWarehouses] = useState<ReadonlySet<string>>(new Set());
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [freshKey, setFreshKey] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // The memoized rows need callbacks that never change identity, so the
  // row handlers read the latest lines through refs instead of closing
  // over the prop (which is a fresh array on every keystroke).
  const linesRef = useRef(lines);
  const onLinesChangeRef = useRef(onLinesChange);
  useEffect(() => {
    linesRef.current = lines;
    onLinesChangeRef.current = onLinesChange;
  });

  const updateLine = useCallback((key: string, next: Partial<EntryLine>) => {
    onLinesChangeRef.current(
      linesRef.current.map((line) => (line.key === key ? { ...line, ...next } : line)),
    );
  }, []);
  const removeLine = useCallback((key: string) => {
    const kept = linesRef.current.filter((line) => line.key !== key);
    onLinesChangeRef.current(kept.length === 0 ? [newEntryLine()] : kept);
  }, []);
  const expandParty = useCallback((partyId: string) => {
    setCollapsedParties((current) => {
      if (!current.has(partyId)) return current;
      const next = new Set(current);
      next.delete(partyId);
      return next;
    });
  }, []);
  const expandWarehouse = useCallback((partyId: string, warehouseId: string) => {
    setCollapsedWarehouses((current) => {
      const key = `${partyId}:${warehouseId}`;
      if (!current.has(key)) return current;
      const next = new Set(current);
      next.delete(key);
      return next;
    });
  }, []);
  const revealLine = useCallback((key: string, line: EntryLine | undefined) => {
    const root = rootRef.current;
    if (!root) return;
    const row = root.querySelector<HTMLElement>(`[data-line-key="${key}"]`);
    if (!row) return;
    try {
      row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } catch {
      /* jsdom has no layout engine */
    }
    // A fresh line without a warehouse wants its warehouse combobox first;
    // everything else lands on the row's own first field.
    const scope =
      line !== undefined && line.warehouseId === ''
        ? (row.closest('[data-warehouse-block]') ?? row)
        : row;
    scope.querySelector<HTMLElement>('select, input')?.focus({ preventScroll: true });
  }, []);

  const groups = useMemo(() => groupEntryLines(lines), [lines]);
  const kindLabel = t(type === 'inbound' ? 'aps.entry.partyInbound' : 'aps.entry.partyOutbound');
  const atCapacity = lines.length >= maxLines;
  const sign = type === 'inbound' ? 1n : -1n;
  const letterTotal = sumEntryAmounts(lines);

  /** Pairs that appear under more than one party share one physical balance. */
  const pairParties = useMemo(() => {
    const seen = new Map<string, Set<string>>();
    for (const line of lines) {
      if (line.warehouseId === '' || line.classificationId === '') continue;
      const key = `${line.warehouseId}:${line.classificationId}`;
      const set = seen.get(key) ?? new Set<string>();
      set.add(line.partyId);
      seen.set(key, set);
    }
    return seen;
  }, [lines]);

  /** This draft's own sum per pair, once per line list — the badge is O(1). */
  const pairDraftSums = useMemo(() => {
    const sums = new Map<string, bigint>();
    for (const line of lines) {
      if (line.warehouseId === '' || line.classificationId === '') continue;
      const amount = normalizeEntryAmount(line.amount);
      if (amount === null) continue;
      const key = `${line.warehouseId}:${line.classificationId}`;
      sums.set(key, (sums.get(key) ?? 0n) + BigInt(amount.replace('.', '')));
    }
    return sums;
  }, [lines]);

  function balanceFor(line: EntryLine): { current: string; projected: string } | null {
    if (balances === null || line.warehouseId === '' || line.classificationId === '') return null;
    const key = `${line.warehouseId}:${line.classificationId}`;
    const current = balances.get(key) ?? '0.00';
    const projected = (signedAmountToCents(current) ?? 0n) + sign * (pairDraftSums.get(key) ?? 0n);
    return { current, projected: centsToSignedAmount(projected) };
  }

  function removeLines(predicate: (line: EntryLine) => boolean) {
    const kept = lines.filter((line) => !predicate(line));
    onLinesChange(kept.length === 0 ? [newEntryLine()] : kept);
  }
  function setGroupParty(fromPartyId: string, toPartyId: string) {
    onLinesChange(
      lines.map((line) => (line.partyId === fromPartyId ? { ...line, partyId: toPartyId } : line)),
    );
  }
  function setGroupWarehouse(partyId: string, fromWarehouseId: string, toWarehouseId: string) {
    onLinesChange(
      lines.map((line) =>
        line.partyId === partyId && line.warehouseId === fromWarehouseId
          ? { ...line, warehouseId: toWarehouseId }
          : line,
      ),
    );
  }
  function addLine(partyId: string, warehouseId: string) {
    if (atCapacity) return;
    // Keep the new row next to its group instead of appending it to the end of
    // the flat list, which also keeps the saved line order readable.
    const fresh = newEntryLine(partyId, warehouseId);
    const lastIndex = lines.findLastIndex(
      (line) => line.partyId === partyId && line.warehouseId === warehouseId,
    );
    const partyIndex = lines.findLastIndex((line) => line.partyId === partyId);
    const at = (lastIndex === -1 ? partyIndex : lastIndex) + 1;
    const next = [...lines];
    next.splice(at, 0, fresh);
    onLinesChange(next);
    expandParty(partyId);
    expandWarehouse(partyId, warehouseId);
    setFreshKey(fresh.key);
  }
  function addPartyGroup() {
    if (atCapacity) return;
    const used = new Set(groups.map((group) => group.partyId));
    const candidate = parties.find((party) => !used.has(party.id));
    const fresh = newEntryLine(candidate?.id ?? '');
    onLinesChange([...lines, fresh]);
    expandParty(fresh.partyId);
    setFreshKey(fresh.key);
  }
  function toggleParty(partyId: string) {
    setCollapsedParties((current) => {
      const next = new Set(current);
      if (next.has(partyId)) next.delete(partyId);
      else next.add(partyId);
      return next;
    });
  }
  function toggleWarehouse(partyId: string, warehouseId: string) {
    setCollapsedWarehouses((current) => {
      const key = `${partyId}:${warehouseId}`;
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }
  function confirmPendingDelete() {
    if (pendingDelete === null) return;
    if (pendingDelete.kind === 'party') {
      const { partyId } = pendingDelete;
      removeLines((line) => line.partyId === partyId);
      setCollapsedParties((current) => {
        if (!current.has(partyId)) return current;
        const next = new Set(current);
        next.delete(partyId);
        return next;
      });
    } else {
      const { partyId, warehouseId } = pendingDelete;
      removeLines((line) => line.partyId === partyId && line.warehouseId === warehouseId);
    }
    setPendingDelete(null);
  }

  // A just-added row is opened to and focused, ready to type into. The ref
  // remembers which fresh key was already revealed, so the effect is a
  // one-shot DOM sync per addition without resetting state.
  const revealedFreshRef = useRef<string | null>(null);
  useEffect(() => {
    if (freshKey === null || revealedFreshRef.current === freshKey) return;
    revealedFreshRef.current = freshKey;
    const line = linesRef.current.find((item) => item.key === freshKey);
    if (line) revealLine(freshKey, line);
  }, [freshKey, lines, revealLine]);

  // Blamed rows are unveiled: ancestors open, the first one scrolls in.
  useEffect(() => {
    if (!highlightedKeys || highlightedKeys.size === 0) return;
    let firstKey: string | null = null;
    let firstLine: EntryLine | undefined;
    for (const line of linesRef.current) {
      if (!highlightedKeys.has(line.key)) continue;
      expandParty(line.partyId);
      expandWarehouse(line.partyId, line.warehouseId);
      if (firstKey === null) {
        firstKey = line.key;
        firstLine = line;
      }
    }
    if (firstKey !== null) {
      const key = firstKey;
      const line = firstLine;
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => revealLine(key, line));
      } else {
        revealLine(key, line);
      }
    }
  }, [highlightedKeys, expandParty, expandWarehouse, revealLine]);

  if (parties.length === 0) {
    return (
      <div className="border-border bg-card min-w-0 space-y-3 rounded-2xl border p-4 sm:p-5">
        <p className="text-muted-foreground text-sm leading-relaxed">
          {t(
            type === 'inbound'
              ? 'aps.entry.tree.noPartiesInbound'
              : 'aps.entry.tree.noPartiesOutbound',
          )}
        </p>
        <Link
          to="/settings/project"
          className="border-primary/25 text-primary hover:bg-primary/5 inline-flex min-h-10 items-center gap-2 rounded-xl border px-3 text-sm font-semibold"
        >
          <Plus className="size-4" aria-hidden="true" />
          {t('aps.entry.tree.goAddParty', { kind: kindLabel })}
        </Link>
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      className="aps-tree border-border bg-card min-w-0 rounded-2xl border shadow-[0_2px_12px_rgb(15_23_42/0.035)]"
    >
      {/* The fixed root: the letter type, its line count and its total. */}
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-4 pt-3.5 pb-1">
        <span
          className={`inline-flex items-center rounded-md px-2 py-1 text-xs font-bold ${
            type === 'inbound'
              ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
              : 'bg-orange-500/10 text-orange-700 dark:text-orange-300'
          }`}
        >
          {t(`aps.letters.type.${type}`)}
        </span>
        <span className="text-muted-foreground text-xs font-semibold">
          {lines.length === 1
            ? t('aps.entry.summaryLineOne')
            : t('aps.entry.summaryLines', { count: lines.length })}
        </span>
        <span className="ms-auto shrink-0 text-xs">
          <span className="text-muted-foreground">
            {t(type === 'inbound' ? 'aps.letters.inTotal' : 'aps.letters.outTotal')}:{' '}
          </span>
          <bdi dir="ltr" className="text-foreground text-sm font-bold">
            {letterTotal === null
              ? t('aps.entry.waitingAmount')
              : formatLetterAmount(letterTotal, locale)}
          </bdi>
        </span>
      </div>

      <div className="aps-tree-children ms-2 px-4 pb-4">
        {groups.map((group) => {
          const party = parties.find((item) => item.id === group.partyId);
          const partyChoices = parties.filter(
            (item) =>
              item.id === group.partyId || !groups.some((other) => other.partyId === item.id),
          );
          const isPartyCollapsed = collapsedParties.has(group.partyId);
          const partyTotal = sumEntryAmounts(group.lines);
          return (
            <div key={group.partyId || 'unassigned'} className="aps-tree-node">
              {/* Sticky: while this party's warehouses scroll by, its name and
                  subtotal stay pinned under the shell's top bar (h-16). */}
              <div className="border-border/60 bg-card sticky top-16 z-10 flex min-w-0 items-start gap-2 border-b pt-2 pb-1">
                <CollapseButton
                  collapsed={isPartyCollapsed}
                  onToggle={() => toggleParty(group.partyId)}
                />
                <div className="min-w-0 flex-1">
                  <PartySelect
                    value={group.partyId}
                    parties={partyChoices}
                    placeholder={t(
                      type === 'inbound' ? 'aps.entry.chooseParty' : 'aps.entry.choosePurpose',
                    )}
                    onChange={(partyId) => setGroupParty(group.partyId, partyId)}
                  />
                </div>
                <span className="shrink-0 pt-3 text-xs">
                  <span className="text-muted-foreground hidden sm:inline">
                    {t('aps.entry.tree.subtotal')}:{' '}
                  </span>
                  <bdi dir="ltr" className="text-foreground font-bold">
                    {partyTotal === null
                      ? t('aps.entry.waitingAmount')
                      : formatLetterAmount(partyTotal, locale)}
                  </bdi>
                </span>
                <button
                  type="button"
                  aria-label={t('aps.entry.tree.removeParty', {
                    name: party?.name ?? kindLabel,
                  })}
                  onClick={() =>
                    setPendingDelete({
                      kind: 'party',
                      partyId: group.partyId,
                      name: party?.name ?? kindLabel,
                      warehouses: group.warehouses.length,
                      lines: group.lines.length,
                      total: partyTotal,
                    })
                  }
                  className={ICON_BUTTON}
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                </button>
              </div>

              {!isPartyCollapsed && (
                <div className="aps-tree-children">
                  {group.warehouses.map((warehouseGroup) => {
                    const warehouseKey = `${group.partyId}:${warehouseGroup.warehouseId}`;
                    const isWarehouseCollapsed = collapsedWarehouses.has(warehouseKey);
                    const warehouseTotal = sumEntryAmounts(warehouseGroup.lines);
                    const warehouseName =
                      warehouseOptions.find((item) => item.value === warehouseGroup.warehouseId)
                        ?.label ?? t('aps.letters.warehouse');
                    return (
                      <div
                        key={warehouseGroup.warehouseId || 'unassigned'}
                        className="aps-tree-node"
                        data-warehouse-block
                      >
                        <div className="flex min-w-0 items-start gap-2 pt-2 pb-1 max-sm:flex-wrap">
                          <CollapseButton
                            collapsed={isWarehouseCollapsed}
                            onToggle={() =>
                              toggleWarehouse(group.partyId, warehouseGroup.warehouseId)
                            }
                          />
                          {/* On phones the combobox drops to its own full-width
                              line under chevron/total/trash so the warehouse
                              name stays readable; the stub still lands on the
                              44px chevron line. */}
                          <div className="min-w-0 flex-1 max-sm:order-3 max-sm:basis-full">
                            <SearchCombobox
                              label={t('aps.letters.warehouse')}
                              hideLabel
                              value={warehouseGroup.warehouseId}
                              options={warehouseOptions}
                              placeholder={t('aps.entry.chooseWarehouse')}
                              searchPlaceholder={t('aps.entry.searchWarehouse')}
                              noMatches={t('aps.entry.noWarehouseMatches')}
                              clearLabel={t('aps.entry.clearWarehouse')}
                              missingLabel={t('aps.entry.unavailableOption')}
                              onChange={(warehouseId) =>
                                setGroupWarehouse(
                                  group.partyId,
                                  warehouseGroup.warehouseId,
                                  warehouseId,
                                )
                              }
                            />
                          </div>
                          <span className="shrink-0 pt-3 text-xs max-sm:ms-auto">
                            <bdi dir="ltr" className="text-foreground font-bold">
                              {warehouseTotal === null
                                ? t('aps.entry.waitingAmount')
                                : formatLetterAmount(warehouseTotal, locale)}
                            </bdi>
                          </span>
                          <button
                            type="button"
                            aria-label={t('aps.entry.tree.removeParty', {
                              name: t('aps.letters.warehouse'),
                            })}
                            onClick={() =>
                              setPendingDelete({
                                kind: 'warehouse',
                                partyId: group.partyId,
                                warehouseId: warehouseGroup.warehouseId,
                                name: warehouseName,
                                lines: warehouseGroup.lines.length,
                                total: warehouseTotal,
                              })
                            }
                            className={ICON_BUTTON}
                          >
                            <Trash2 className="size-4" aria-hidden="true" />
                          </button>
                        </div>

                        {!isWarehouseCollapsed && (
                          <div className="aps-tree-children">
                            {warehouseGroup.lines.map((line) => {
                              const balance = balanceFor(line);
                              const pairKey = `${line.warehouseId}:${line.classificationId}`;
                              return (
                                <ClassificationRow
                                  key={line.key}
                                  line={line}
                                  classifications={classifications}
                                  balanceCurrent={balance?.current ?? null}
                                  balanceProjected={balance?.projected ?? null}
                                  repeated={(pairParties.get(pairKey)?.size ?? 0) > 1}
                                  highlighted={highlightedKeys?.has(line.key) ?? false}
                                  onUpdate={updateLine}
                                  onRemove={removeLine}
                                />
                              );
                            })}
                            <div className="aps-tree-node">
                              <div className="pt-2">
                                <button
                                  type="button"
                                  className={GHOST_BUTTON}
                                  disabled={atCapacity}
                                  onClick={() => addLine(group.partyId, warehouseGroup.warehouseId)}
                                >
                                  <Plus className="size-4" aria-hidden="true" />
                                  {t('aps.entry.tree.addClassification')}
                                </button>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}

                  <div className="aps-tree-node">
                    <div className="pt-2">
                      <button
                        type="button"
                        className={GHOST_BUTTON}
                        disabled={atCapacity}
                        onClick={() => addLine(group.partyId, '')}
                      >
                        <Plus className="size-4" aria-hidden="true" />
                        {t('aps.entry.tree.addWarehouse')}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}

        <div className="aps-tree-node">
          <div className="pt-2">
            <button
              type="button"
              className={GHOST_BUTTON}
              disabled={atCapacity}
              onClick={addPartyGroup}
            >
              <Plus className="size-4" aria-hidden="true" />
              {t('aps.entry.tree.addParty', { kind: kindLabel })}
            </button>
          </div>
        </div>
      </div>

      <DeleteGroupDialog
        target={pendingDelete}
        kindLabel={kindLabel}
        onConfirm={confirmPendingDelete}
        onClose={() => setPendingDelete(null)}
      />
    </div>
  );
}
