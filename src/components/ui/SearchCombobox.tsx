import { Check, ChevronDown, Search, X } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { matchesSearch } from '@/lib/arabicText';

/**
 * One searchable picker, used for the warehouse and the issuer code.
 *
 * A native `<select>` stops working when the list is a few hundred warehouses:
 * the user scrolls instead of typing, and Arabic spelling variants (أ/ا, ة/ه)
 * make the visible order useless. The options are already loaded with the rest
 * of the entry screen, so filtering is local and cannot lag behind typing.
 *
 * It is a single-select combobox: the input is the search field, the list opens
 * under it, and the keyboard never leaves the field. `Escape` closes without
 * changing the value.
 */

export interface SearchComboboxOption {
  /** Stored value: a warehouse id or an issuer code. */
  readonly value: string;
  /** The text the register prints, e.g. `احتياطي - غرب القاهرة` or `YM — ياسر`. */
  readonly label: string;
  /** Extra text that should match the search but is not displayed. */
  readonly keywords?: string;
}

export interface SearchComboboxProps {
  readonly label: string;
  readonly value: string;
  readonly options: readonly SearchComboboxOption[];
  /** Shown inside the closed field when nothing is chosen. */
  readonly placeholder: string;
  readonly searchPlaceholder: string;
  readonly noMatches: string;
  readonly clearLabel: string;
  /** Shown when a saved value is no longer in the active list. */
  readonly missingLabel?: string;
  /**
   * Keeps the label as the field's accessible name but hides it visually —
   * for dense repeated rows (the letter tree) where the same word above
   * every group is noise, not information.
   */
  readonly hideLabel?: boolean;
  readonly onChange: (value: string) => void;
}

export function SearchCombobox({
  label,
  value,
  options,
  placeholder,
  searchPlaceholder,
  noMatches,
  clearLabel,
  missingLabel,
  hideLabel = false,
  onChange,
}: SearchComboboxProps) {
  const inputId = useId();
  const listboxId = useId();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);

  const selected = options.find((option) => option.value === value);
  const missing = value !== '' && selected === undefined;

  const matches = useMemo(
    () =>
      options.filter((option) => matchesSearch(query, `${option.label} ${option.keywords ?? ''}`)),
    [options, query],
  );

  /* The highlight must never point past the rendered list after a filter. */
  const boundedIndex = Math.min(activeIndex, Math.max(matches.length - 1, 0));
  const activeOption = matches[boundedIndex];

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (
        event.target instanceof Node &&
        containerRef.current !== null &&
        !containerRef.current.contains(event.target)
      ) {
        setOpen(false);
        setQuery('');
      }
    }
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  /* Focus stays in the field because the option's mousedown is prevented, so
     there is deliberately no `focus()` here — that would reopen the list. */
  function choose(option: SearchComboboxOption) {
    onChange(option.value);
    setQuery('');
    setOpen(false);
  }

  function close() {
    setOpen(false);
    setQuery('');
  }

  const shown = open ? query : (selected?.label ?? (missing ? (missingLabel ?? '') : ''));

  return (
    /* Only the open combobox elevates. Closed roots stay at z-0 so a sticky
       group header (z-10) keeps its own open list above the closed fields
       below it, instead of the next field painting over the dropdown. */
    <div
      className={`relative block min-w-0 space-y-2 text-xs font-semibold ${open ? 'z-50' : 'z-0'}`}
      ref={containerRef}
    >
      <label htmlFor={inputId} className={hideLabel ? 'sr-only' : 'text-foreground block'}>
        {label}
      </label>
      <div className="relative min-w-0">
        <input
          id={inputId}
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={
            open && activeOption !== undefined ? `${listboxId}-${activeOption.value}` : undefined
          }
          autoComplete="off"
          className="border-input bg-card text-foreground focus:border-primary/60 focus:ring-primary/25 min-h-11 w-full min-w-0 rounded-xl border py-2 ps-9 pe-9 text-sm font-normal outline-none focus:ring-2"
          placeholder={open ? searchPlaceholder : placeholder}
          value={shown}
          onFocus={() => {
            setOpen(true);
            setQuery('');
            setActiveIndex(0);
          }}
          onChange={(event) => {
            setOpen(true);
            setQuery(event.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setOpen(true);
              setActiveIndex(Math.min(boundedIndex + 1, Math.max(matches.length - 1, 0)));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setActiveIndex(Math.max(boundedIndex - 1, 0));
            } else if (event.key === 'Enter') {
              if (open && activeOption !== undefined) {
                event.preventDefault();
                choose(activeOption);
              }
            } else if (event.key === 'Escape') {
              if (open) {
                event.preventDefault();
                close();
              }
            }
          }}
        />
        <Search
          className="text-muted-foreground pointer-events-none absolute inset-y-0 start-3 my-auto size-4"
          aria-hidden="true"
        />
        <span className="absolute inset-y-0 end-1 my-auto grid">
          {value !== '' && !open ? (
            <button
              type="button"
              aria-label={clearLabel}
              onClick={() => {
                onChange('');
                setQuery('');
                setOpen(false);
              }}
              className="text-muted-foreground hover:text-foreground grid size-9 place-items-center rounded-lg"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          ) : (
            <span className="text-muted-foreground grid size-9 place-items-center">
              <ChevronDown className="size-4" aria-hidden="true" />
            </span>
          )}
        </span>
        {open && (
          <ul
            id={listboxId}
            role="listbox"
            className="border-border bg-card absolute inset-x-0 top-full z-50 mt-1 max-h-64 overflow-y-auto rounded-xl border p-1 shadow-lg"
          >
            {matches.length === 0 ? (
              <li className="text-muted-foreground px-3 py-2 text-xs font-normal">{noMatches}</li>
            ) : (
              matches.map((option, index) => {
                const isSelected = option.value === value;
                return (
                  <li key={option.value}>
                    <button
                      type="button"
                      id={`${listboxId}-${option.value}`}
                      role="option"
                      aria-selected={isSelected}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => choose(option)}
                      className={`flex min-h-10 w-full items-center justify-between gap-2 rounded-lg px-3 text-start text-sm font-normal ${index === boundedIndex ? 'bg-muted' : ''} ${isSelected ? 'text-primary font-semibold' : 'text-foreground'}`}
                    >
                      <span className="min-w-0 break-words">{option.label}</span>
                      {isSelected && <Check className="size-4 shrink-0" aria-hidden="true" />}
                    </button>
                  </li>
                );
              })
            )}
          </ul>
        )}
      </div>
    </div>
  );
}
