# APS letter code and the two-line letter header — review pack

Review pack for the header simplification, re-captured **before** the pull request
is opened. Everything here is **fictional sample data** rendered by the local
review harness (`npm run preview:aps`). The harness replaces Supabase,
authentication and capabilities with in-memory fixtures: it proves layout,
labels, formatting and state handling, **not** PostgREST, RLS or PostgreSQL
behaviour. The database rules are covered by the offline audit instead.

## «بيانات الخطاب» is now two lines

| Line | What it says                                  | Source                                   |
| ---- | --------------------------------------------- | ---------------------------------------- |
| 1    | `فترة 4 — أكتوبر 2026 — عام مالي 2026/2027`   | the periodic settings (`fiscal_months`)  |
| 2    | `رقم النظام (EPS)` and `كود الخطاب` (`YM:63`) | typed by hand, unique in the fiscal year |

Line 1 is read-only. The date, the fiscal-year picker, the issuer picker and the
issuer-sequence field are gone from the screen, and so is the separate
period band that used to sit above the form: the running period is stated once,
inside the section it belongs to. A letter is dated by the database (today for a
new draft, the stored date when a draft is resumed), so nothing on this screen
asks for a date.

The counterparty is not header data any more. It moved to its own compact row
(`03`) that appears only for the types that need it — inbound party, outbound
purpose, or the sister company and direction of an external transfer. The lines
section is therefore `03` for a transfer and `04` otherwise, and the internal
transfer has no `03` at all.

## The letter code types itself

- Two Latin letters, automatically upper-cased: `ym` becomes `YM`.
- The colon is inserted after the second letter: `ym63` becomes `YM:63`.
- After the colon only digits are accepted; Arabic letters, spaces and symbols
  never reach the field, so a phone keyboard left on Arabic produces nothing
  instead of a quietly wrong code.
- `dir="ltr"`, `lang="en"`, `inputMode="text"`, `autoCapitalize="characters"`,
  `autoComplete="off"` and `spellCheck={false}` — the hints a mobile keyboard
  needs to switch to Latin.
- Invalid input says so immediately under the field, and the save is refused
  before any request: the shape must be `XX:NN`, and `XX` must be a registered,
  active issuer.
- `رقم النظام (EPS)` is a numeric field: digits only.

## Screens

| File                                | Shows                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------ |
| `01-entry-inbound-desktop-ar.png`   | Inbound: two-line header, period line, `9001` and `YM:63`                |
| `02-entry-outbound-header-ar.png`   | Outbound: the sticky header turns orange, the header stays two lines     |
| `03-entry-internal-desktop-ar.png`  | Internal transfer: violet header, no counterparty row, pairs from `03`   |
| `04-entry-external-desktop-ar.png`  | External transfer: blue header, sister company and direction in `03`     |
| `05-entry-sticky-scrolled-ar.png`   | Scrolled: the top bar is still pinned and still says the type            |
| `06-entry-mobile-ar.png`            | 390 px: the period line and the two fields stack without clipping        |
| `07-entry-desktop-en.png`           | English, left-to-right (the month name is stored data, so it stays عربي) |
| `08-entry-letter-code-error-ar.png` | A half-typed code: the inline error names the required shape             |
| `09-detail-letter-code-ar.png`      | The detail page reads one `كود الخطاب` where it used to show two fields  |

## Behaviour that only the database proves

`supabase/migrations/20261118000000_aps_letter_reference.sql`:

- adds `letters.issuer_reference` and backfills it from the old pair
  (`issuer_code` + `:` + `issuer_sequence`) wherever that forms a valid code,
  then drops both old columns — after the freeze trigger and the draft function
  stopped naming them;
- `CHECK (issuer_reference ~ '^[A-Z]{2}:[0-9]+$')`, unique on
  `(fiscal_year_id, issuer_reference)`, plus an index on the code itself;
- `letters.letter_date` keeps its NOT NULL contract and gains
  `default current_date`; the draft function also keeps a resumed draft's date;
- the freeze trigger now protects `issuer_reference` on approved and cancelled
  letters;
- `aps_save_letter_draft(...)` is replaced with a 12-argument signature
  (`p_issuer_reference`, and `p_letter_date` last with a default). The letter
  code is validated against the shape and against the active issuer, and a
  duplicate reports `aps_entry_duplicate_letter_code` so the screen can say
  «كود الخطاب مستخدم بالفعل» instead of blaming the EPS number.
- Approval, cancellation, reconciliation and the entry options payload are
  untouched.

The offline PostgreSQL audit covers the backfill target shape, the CHECK, the
per-year key, the index, the date default, the frozen code, and the duplicate
error. These screenshots do not.

The letter detail now prints `كود الخطاب` (`YM:2458`) once, next to the EPS
number, instead of the retired `كود المُصدر` and `رقم المُصدر` pair.

Not included, by scope: a settings screen for issuer codes, a reports screen, and
editing approved letters. The separately requested three-part SQL hand-over of
earlier drafts is still outstanding and unrelated to this screen.
