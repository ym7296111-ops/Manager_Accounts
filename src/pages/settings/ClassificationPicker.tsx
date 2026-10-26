import { Check, Plus, Search, X } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ActiveLeafClassification } from '@/hooks/useClassifications';
import { useI18n } from '@/i18n/I18nContext';
import { searchClassifications } from '@/lib/arabicText';

/**
 * Inline combobox with multi-select chips.
 *
 * Deliberately not a modal: adding one line was four context switches (open,
 * search, pick, close), which is the same friction the old 50-input screen had,
 * only moved. Here the field opens under the button, the keyboard never leaves
 * the list, and several classifications are added in a single commit.
 *
 * The options are already loaded by `useActiveLeafClassifications` — one
 * request for the whole screen — so filtering is local and cannot lag behind
 * typing.
 *
 * Chips are *staged*: they become rows only when «إضافة (N)» is pressed. Escape
 * therefore discards them, which is safe because nothing has been written yet.
 */

const MAX_VISIBLE_OPTIONS = 50;

export interface ClassificationPickerProps {
  /** Active leaves, in display order. */
  readonly options: readonly ActiveLeafClassification[];
  /** Saved or already added in this warehouse — never offered twice. */
  readonly excludedIds: ReadonlySet<string>;
  readonly busy: boolean;
  readonly onAdd: (classificationIds: readonly string[]) => void;
  readonly onClose: () => void;
}

export function ClassificationPicker({
  options,
  excludedIds,
  busy,
  onAdd,
  onClose,
}: ClassificationPickerProps) {
  const { t } = useI18n();
  const listboxId = useId();
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [limit, setLimit] = useState(MAX_VISIBLE_OPTIONS);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const available = useMemo(
    () => options.filter((option) => !excludedIds.has(option.id)),
    [options, excludedIds],
  );

  const matches = useMemo(() => searchClassifications(available, query), [available, query]);
  const visible = matches.slice(0, limit);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const selectedEntries = useMemo(
    () =>
      selected
        .map((id) => options.find((option) => option.id === id))
        .filter((entry): entry is ActiveLeafClassification => entry !== undefined),
    [selected, options],
  );

  /* The highlight must never point past the rendered list after a filter. */
  const boundedIndex = Math.min(activeIndex, Math.max(visible.length - 1, 0));
  const activeOption = visible[boundedIndex];

  const toggle = (id: string) => {
    setSelected((current) =>
      current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id],
    );
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((current) => Math.min(current + 1, Math.max(visible.length - 1, 0)));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((current) => Math.max(current - 1, 0));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (activeOption !== undefined) {
        toggle(activeOption.id);
      }
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === 'Backspace' && query === '' && selected.length > 0) {
      event.preventDefault();
      setSelected((current) => current.slice(0, -1));
    }
  };

  const commit = () => {
    if (selected.length === 0 || busy) {
      return;
    }
    onAdd(selected);
    setSelected([]);
    setQuery('');
  };

  const allAdded = available.length === 0;
  const noResults = !allAdded && matches.length === 0;

  return (
    <div
      className="border-border bg-background/60 mt-2 rounded-xl border p-3"
      data-testid="classification-picker"
    >
      <div className="flex min-w-0 items-start justify-between gap-2">
        <p className="text-foreground min-w-0 flex-1 text-sm font-semibold">
          {t('settings.project.fiscal.openingBalances.picker.title')}
        </p>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('settings.project.fiscal.openingBalances.picker.close')}
          className="text-muted-foreground hover:text-foreground shrink-0 rounded p-1"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>

      {selectedEntries.length > 0 ? (
        <ul
          className="mt-2 flex min-w-0 flex-wrap gap-1.5"
          aria-label={t('settings.project.fiscal.openingBalances.picker.selected', {
            count: selectedEntries.length,
          })}
        >
          {selectedEntries.map((entry) => (
            <li key={entry.id}>
              <button
                type="button"
                onClick={() => toggle(entry.id)}
                aria-label={t('settings.project.fiscal.openingBalances.picker.remove', {
                  name: entry.name,
                })}
                className="bg-primary/10 text-primary inline-flex max-w-full items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium"
              >
                <span className="truncate">{entry.name}</span>
                <X className="size-3 shrink-0" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="relative mt-2">
        <Search
          className="text-muted-foreground pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2"
          aria-hidden="true"
        />
        <input
          ref={inputRef}
          id={inputId}
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={
            activeOption === undefined ? undefined : `${listboxId}-option-${activeOption.id}`
          }
          autoComplete="off"
          value={query}
          placeholder={t('settings.project.fiscal.openingBalances.picker.search')}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(0);
            setLimit(MAX_VISIBLE_OPTIONS);
          }}
          onKeyDown={handleKeyDown}
          className="border-input bg-background text-foreground placeholder:text-muted-foreground focus:border-primary/60 focus:ring-primary/25 w-full rounded-lg border py-2 ps-9 pe-3 text-sm outline-none focus:ring-2"
        />
      </div>

      {allAdded ? (
        <p className="text-muted-foreground mt-2 text-xs">
          {t('settings.project.fiscal.openingBalances.picker.allAdded')}
        </p>
      ) : noResults ? (
        <p className="text-muted-foreground mt-2 text-xs">
          {t('settings.project.fiscal.openingBalances.picker.noResults')}
        </p>
      ) : (
        <>
          <ul
            id={listboxId}
            role="listbox"
            aria-labelledby={inputId}
            className="border-border mt-2 max-h-64 overflow-y-auto rounded-lg border"
          >
            {visible.map((option, index) => {
              const isSelected = selectedSet.has(option.id);
              return (
                /* The option is the click target — the combobox keeps focus and
                   drives the highlighted row through aria-activedescendant, so
                   the rows themselves are never focusable. */
                <li
                  key={option.id}
                  id={`${listboxId}-option-${option.id}`}
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => toggle(option.id)}
                  onMouseEnter={() => setActiveIndex(index)}
                  className={[
                    'flex w-full min-w-0 cursor-pointer items-center justify-between gap-2 px-3 py-2 text-start text-sm transition-colors',
                    index === boundedIndex ? 'bg-muted/60' : '',
                    isSelected ? 'text-primary' : 'text-foreground',
                  ].join(' ')}
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{option.name}</span>
                    <span className="text-muted-foreground block text-xs">{option.code}</span>
                  </span>
                  {isSelected ? (
                    <Check className="text-primary size-4 shrink-0" aria-hidden="true" />
                  ) : null}
                </li>
              );
            })}
          </ul>
          {matches.length > visible.length ? (
            <button
              type="button"
              onClick={() => setLimit((current) => current + MAX_VISIBLE_OPTIONS)}
              className="text-primary mt-2 text-xs font-semibold"
            >
              {t('settings.project.fiscal.openingBalances.picker.showMore', {
                remaining: matches.length - visible.length,
              })}
            </button>
          ) : null}
        </>
      )}

      <div className="mt-3 flex items-center justify-between gap-2">
        <span className="text-muted-foreground text-xs">
          {t('settings.project.fiscal.openingBalances.picker.selected', {
            count: selected.length,
          })}
        </span>
        <button
          type="button"
          onClick={commit}
          disabled={selected.length === 0 || busy}
          className="bg-primary text-primary-foreground inline-flex items-center justify-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-semibold transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Plus className="size-4" aria-hidden="true" />
          {t('settings.project.fiscal.openingBalances.picker.addSelected', {
            count: selected.length,
          })}
        </button>
      </div>
    </div>
  );
}
