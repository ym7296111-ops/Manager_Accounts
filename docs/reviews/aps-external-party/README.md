# External transfer party — review pack

Hotfix review pack, captured **before** the pull request is opened. Everything
here is **fictional sample data** rendered by the local review harness
(`npm run preview:aps`). The harness replaces Supabase, authentication and
capabilities with in-memory fixtures: it proves layout, labels, icons and
filtering, **not** PostgREST, RLS or PostgreSQL behaviour.

## Why the field was renamed

The external-transfer register now holds **sister and non-sister companies**
alike (`sister_companies.company_type`, migration `20261125000000`). Calling
the field «الشركة الشقيقة» / “Sister company” was therefore inaccurate. It is
now:

- Arabic: **جهة التحويل الخارجية**
- English: **External Transfer Party**

The placeholder, clear label, counterparty hint, type tooltip and validation
message were renamed with it. Nothing in the stored letter changed: the choice
is still written to `sister_company_id`.

## What the picker shows

- Every company carries its type glyph — **Handshake** (🤝) for a sister
  company, **Globe** (🌐) for a non-sister one — the same glyphs the settings
  tree uses. The hover tooltip is the native `title` attribute naming the type
  («شركة شقيقة» / «شركة غير شقيقة»); headless screenshots cannot draw native
  tooltips, so the review suite asserts the attribute instead.
- A chosen company keeps its glyph in the closed field, in place of the
  magnifier.
- A three-way filter sits above the field: **الكل** (default), **شقيقة فقط**,
  **غير شقيقة فقط**. It is presentation only — never part of the letter — and
  a chosen company that the new filter would hide is cleared with it, so the
  field never keeps a value its own list cannot show.

## Screens

| File                               | Shows                                                            |
| ---------------------------------- | ---------------------------------------------------------------- |
| `01-entry-external-field-ar.png`   | The renamed field, closed, with the filter row above it          |
| `02-dropdown-all-types-ar.png`     | «الكل»: four companies, Handshake beside the two sister ones     |
| `03-filter-sister-only-ar.png`     | «شقيقة فقط»: only the two sister companies remain                |
| `04-filter-non-sister-only-ar.png` | «غير شقيقة فقط»: only the two non-sister companies remain        |
| `05-selected-non-sister-ar.png`    | A chosen non-sister company keeps its Globe in the closed field  |
| `06-entry-external-en.png`         | English, left to right: “External Transfer Party” and the filter |
| `07-entry-external-mobile-ar.png`  | 390 px: the filter row and the open list fit without overflow    |

Re-capture with the harness running on port 4174:

```sh
CHROME_PATH=/path/to/chromium node scripts/preview/external-party.mjs
```

## Tests

- `src/pages/workspaces/ApsLetterEntryPage.test.tsx`: the renamed label, the
  per-type icon and tooltip, the three-way filter (including clearing a hidden
  selection), and a save that writes a non-sister `sisterId`.
- `src/dev/aps-preview/review.spec.ts`: the same walk in a real browser, plus
  the English labels. Five specs in this file had drifted from the tree UI on
  `main` (native `selectOption` on what is now a combobox, and page-wide
  `/وارد/` locators that also match the tree's buttons); they were repaired
  here without changing what they assert.
