import { Check, ChevronDown, Plus, Trash2, TriangleAlert, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
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
 * The counterparty tree: root (the letter type) ← parties ← warehouses ←
 * classification rows. One component serves both counterparty types; `type`
 * only changes the root label, the party vocabulary and the sign of the
 * projected balance. The stored model stays the flat line list — every
 * interaction below rewrites lines and lets the grouping re-derive, so the
 * tree can never disagree with what will be saved.
 */

const CONTROL =
  'border-input bg-card text-foreground focus:border-primary/60 focus:ring-primary/25 min-h-11 w-full min-w-0 rounded-xl border px-3 text-sm outline-none focus:ring-2 disabled:opacity-60';
const ADD_BUTTON =
  'border-primary/25 text-primary hover:bg-primary/5 inline-flex min-h-10 items-center gap-2 rounded-xl border px-3 text-sm font-semibold disabled:opacity-50';
const ICON_BUTTON =
  'text-muted-foreground hover:text-destructive grid size-10 shrink-0 place-items-center rounded-lg disabled:opacity-30';

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
        className={`${chip} focus-visible:ring-ring grid size-9 place-items-center rounded-lg focus-visible:ring-2 focus-visible:outline-none`}
      >
        <Icon className="size-4" aria-hidden="true" />
      </button>
      {open && (
        <span
          role="status"
          className="border-border bg-card text-foreground absolute start-0 top-full z-10 mt-1 w-60 space-y-1 rounded-xl border p-3 text-xs shadow-lg"
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

export function ApsLetterTree({
  type,
  parties,
  warehouseOptions,
  classifications,
  lines,
  balances,
  maxLines,
  onLinesChange,
}: ApsLetterTreeProps) {
  const { t, locale, dir } = useI18n();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const groups = useMemo(() => groupEntryLines(lines), [lines]);
  const kindLabel = t(type === 'inbound' ? 'aps.entry.partyInbound' : 'aps.entry.partyOutbound');
  const atCapacity = lines.length >= maxLines;
  const sign = type === 'inbound' ? 1n : -1n;

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

  function balanceFor(line: EntryLine): { current: string; projected: string } | null {
    if (balances === null || line.warehouseId === '' || line.classificationId === '') return null;
    const key = `${line.warehouseId}:${line.classificationId}`;
    const current = balances.get(key) ?? '0.00';
    let projected = signedAmountToCents(current) ?? 0n;
    for (const other of lines) {
      if (
        other.warehouseId !== line.warehouseId ||
        other.classificationId !== line.classificationId
      )
        continue;
      const amount = normalizeEntryAmount(other.amount);
      if (amount !== null) projected += sign * BigInt(amount.replace('.', ''));
    }
    return { current, projected: centsToSignedAmount(projected) };
  }

  function updateLine(key: string, next: Partial<EntryLine>) {
    onLinesChange(lines.map((line) => (line.key === key ? { ...line, ...next } : line)));
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
  }
  function addPartyGroup() {
    if (atCapacity) return;
    const used = new Set(groups.map((group) => group.partyId));
    const candidate = parties.find((party) => !used.has(party.id));
    onLinesChange([...lines, newEntryLine(candidate?.id ?? '')]);
  }
  function toggleCollapsed(partyId: string) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(partyId)) next.delete(partyId);
      else next.add(partyId);
      return next;
    });
  }

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
    <div className="min-w-0 space-y-3">
      {/* The fixed root: the letter type itself. */}
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <p className="text-foreground inline-flex items-center gap-2 text-sm font-bold">
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
        </p>
        <button type="button" className={ADD_BUTTON} disabled={atCapacity} onClick={addPartyGroup}>
          <Plus className="size-4" aria-hidden="true" />
          {t('aps.entry.tree.addParty', { kind: kindLabel })}
        </button>
      </div>

      {groups.map((group) => {
        const party = parties.find((item) => item.id === group.partyId);
        const partyChoices = parties.filter(
          (item) => item.id === group.partyId || !groups.some((other) => other.partyId === item.id),
        );
        const isCollapsed = collapsed.has(group.partyId);
        const partyTotal = sumEntryAmounts(group.lines);
        return (
          <div
            key={group.partyId || 'unassigned'}
            className="border-border bg-card min-w-0 rounded-2xl border p-3 shadow-[0_2px_12px_rgb(15_23_42/0.035)] sm:p-4"
          >
            <div className="flex min-w-0 items-start gap-2">
              <button
                type="button"
                aria-label={t(isCollapsed ? 'aps.entry.tree.expand' : 'aps.entry.tree.collapse')}
                aria-expanded={!isCollapsed}
                onClick={() => toggleCollapsed(group.partyId)}
                className="text-muted-foreground hover:text-foreground grid size-11 shrink-0 place-items-center rounded-lg"
              >
                <ChevronDown
                  className={`size-4 transition-transform ${
                    isCollapsed ? (dir === 'rtl' ? 'rotate-90' : '-rotate-90') : ''
                  }`}
                  aria-hidden="true"
                />
              </button>
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
              <span className="text-muted-foreground shrink-0 pt-2.5 text-xs">
                {t('aps.entry.tree.subtotal')}:{' '}
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
                onClick={() => removeLines((line) => line.partyId === group.partyId)}
                className={ICON_BUTTON}
              >
                <Trash2 className="size-4" aria-hidden="true" />
              </button>
            </div>

            {!isCollapsed && (
              <div className="border-border ms-5 mt-3 space-y-3 border-s ps-3 sm:ms-6 sm:ps-4">
                {group.warehouses.map((warehouseGroup) => {
                  const warehouseTotal = sumEntryAmounts(warehouseGroup.lines);
                  return (
                    <div key={warehouseGroup.warehouseId || 'unassigned'} className="min-w-0">
                      <div className="flex min-w-0 items-start gap-2">
                        <div className="min-w-0 flex-1">
                          <SearchCombobox
                            label={t('aps.letters.warehouse')}
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
                        <span className="text-muted-foreground shrink-0 pt-2.5 text-xs">
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
                            removeLines(
                              (line) =>
                                line.partyId === group.partyId &&
                                line.warehouseId === warehouseGroup.warehouseId,
                            )
                          }
                          className={ICON_BUTTON}
                        >
                          <Trash2 className="size-4" aria-hidden="true" />
                        </button>
                      </div>

                      <div className="mt-2 space-y-2">
                        {warehouseGroup.lines.map((line) => {
                          const balance = balanceFor(line);
                          const pairKey = `${line.warehouseId}:${line.classificationId}`;
                          return (
                            <div
                              key={line.key}
                              className="bg-muted/35 grid min-w-0 items-end gap-2 rounded-xl p-2.5 @3xl:grid-cols-[1fr_12rem_auto_auto]"
                            >
                              <label className="block min-w-0 space-y-1.5 text-sm font-semibold">
                                <span>{t('aps.letters.classification')}</span>
                                <select
                                  className={CONTROL}
                                  value={line.classificationId}
                                  onChange={(event) =>
                                    updateLine(line.key, { classificationId: event.target.value })
                                  }
                                >
                                  <option value="">{t('aps.entry.chooseClassification')}</option>
                                  {line.classificationId !== '' &&
                                    !classifications.some(
                                      (item) => item.id === line.classificationId,
                                    ) && (
                                      <option value={line.classificationId}>
                                        {t('aps.entry.unavailableOption')}
                                      </option>
                                    )}
                                  {classifications.map((item) => (
                                    <option key={item.id} value={item.id}>
                                      {item.name} — {item.code}
                                    </option>
                                  ))}
                                </select>
                              </label>
                              <label className="block min-w-0 space-y-1.5 text-sm font-semibold">
                                <span>{t('aps.letters.amount')}</span>
                                <input
                                  className={CONTROL}
                                  dir="ltr"
                                  inputMode="decimal"
                                  placeholder={t('aps.entry.amountPlaceholder')}
                                  value={line.amount}
                                  onChange={(event) =>
                                    updateLine(line.key, { amount: event.target.value })
                                  }
                                />
                              </label>
                              <span className="flex min-h-11 items-center">
                                {balance !== null && (
                                  <BalanceBadge
                                    current={balance.current}
                                    projected={balance.projected}
                                    repeated={(pairParties.get(pairKey)?.size ?? 0) > 1}
                                  />
                                )}
                              </span>
                              <button
                                type="button"
                                aria-label={t('aps.entry.tree.removeClassification')}
                                onClick={() => removeLines((item) => item.key === line.key)}
                                className={ICON_BUTTON}
                              >
                                <Trash2 className="size-4" aria-hidden="true" />
                              </button>
                            </div>
                          );
                        })}
                      </div>

                      <button
                        type="button"
                        className={`${ADD_BUTTON} mt-2`}
                        disabled={atCapacity}
                        onClick={() => addLine(group.partyId, warehouseGroup.warehouseId)}
                      >
                        <Plus className="size-4" aria-hidden="true" />
                        {t('aps.entry.tree.addClassification')}
                      </button>
                    </div>
                  );
                })}

                <button
                  type="button"
                  className={ADD_BUTTON}
                  disabled={atCapacity}
                  onClick={() => addLine(group.partyId, '')}
                >
                  <Plus className="size-4" aria-hidden="true" />
                  {t('aps.entry.tree.addWarehouse')}
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
