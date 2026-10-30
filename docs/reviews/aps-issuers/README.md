# APS issuers, station labels and the running-period bar — review pack

Review pack for the third APS batch, re-captured **before** the pull request is
opened. Everything here is **fictional sample data** rendered by the local
review harness (`npm run preview:aps`). The harness replaces Supabase,
authentication and capabilities with in-memory fixtures: it proves layout,
labels, filtering and state handling, **not** PostgREST, RLS or PostgreSQL
behaviour. The database rules are covered by the offline audit instead.

## The letter-type header lives in the sticky top bar

There is **one** header: the shell's sticky top bar. The entry screen no longer
draws a band of its own — that band duplicated the title and pushed the form
down. Instead the screen publishes a header override while it is mounted, and
the top bar renders it:

| Type                | Header text      | Colour | Icon            |
| ------------------- | ---------------- | ------ | --------------- |
| `inbound`           | خطاب وارد جديد   | green  | arrow down-left |
| `outbound`          | خطاب منصرف جديد  | orange | arrow up-right  |
| `internal_transfer` | تحويل داخلي جديد | violet | swap            |
| `external_transfer` | تحويل خارجي جديد | blue   | arrow out       |

The colour is carried by the text, a tinted icon chip and a short bar under the
title, so the type is never colour-only. Editing a draft reads
«إكمال مسودة واردة / منصرفة / …». The bar is `sticky top-0` in the shell, so it
stays visible while the form scrolls, and it returns to the navigation label as
soon as the screen unmounts.

## Screens

| File                               | Shows                                                                         |
| ---------------------------------- | ----------------------------------------------------------------------------- |
| `01-entry-inbound-desktop-ar.png`  | Inbound: green header in the top bar, period bar, EPS / issuer / sequence     |
| `02-entry-outbound-header-ar.png`  | Outbound: the same bar turns orange with its own arrow and title              |
| `03-entry-internal-desktop-ar.png` | Internal transfer: violet, paired source → destination, stations              |
| `04-entry-external-desktop-ar.png` | External transfer: blue, sister company and direction                         |
| `05-entry-sticky-scrolled-ar.png`  | Scrolled 900 px: the header is still pinned and still says «تحويل داخلي جديد» |
| `06-entry-mobile-ar.png`           | 390 px: the title is not truncated, the icon chip yields its space            |
| `07-entry-desktop-en.png`          | English, left-to-right                                                        |

## What changed on the entry screen

1. **Type is a button group.** The four large cards became one row of four
   buttons inside a single control, with their hints as accessible titles.
2. **The header is the shell's, not the page's.** No band, no repeated title, no
   wasted space: the sticky top bar states the type in colour, icon and words.
3. **The running period is read, not typed.** The bar above the form reads the
   fiscal months from the periodic settings and shows
   «أنت تدخل خطاباً في: [شهر] [سنة] — الفترة [رقم]»; a date outside every
   configured month says so instead of guessing, and a closed month is flagged.
   The unsaved-changes note sits at the end of that same bar.
4. **The three numbers are named as on the paper form.** `رقم النظام (EPS)` is
   the manually typed `letter_number`; `كود المُصدر` is a searchable list of the
   two-letter issuers (`YM — ياسر`); `رقم المُصدر` is the issuer's own sequence,
   typed by hand.
5. **Warehouse and station are one label.** Every warehouse choice and every
   line reads `[المخزن] - [المحطة]`, and the search matches the warehouse name,
   the station name and the code.
6. **A real shell bug is fixed on the way.** The desktop sidebar-collapse button
   was visible on phones: `iconButtonClassName` contains `inline-flex`, which
   cancelled the `hidden` utility at equal specificity. It is now
   `hidden max-md:hidden md:inline-flex`, which gives the header title the width
   it needs to stay whole at 360 px.

## Behaviour that only the database proves

`supabase/migrations/20261117000000_aps_issuers.sql` adds:

- `public.issuers` (two Latin letters, unique case-insensitively, `is_active`),
  seeded with `YM — ياسر`. Reading is allowed to anyone holding
  `aps.letters:read` **or** `aps.letters:create`; adding and editing is
  `project.settings:manage`. Deletion is not granted: a used code is deactivated.
- `letters.issuer_code` (validated against the list, `on update cascade`) and
  `letters.issuer_sequence`, both nullable so the migration is safe on a
  deployment that already holds letters, and frozen once the letter is settled.
- `letter_lines.station_name`, filled by a new snapshot trigger exactly like the
  warehouse and classification names; nullable, because a line written before
  this migration simply has no station recorded.
- Updated `aps_letter_entry_options()` (issuers, fiscal months and the station
  beside each warehouse) and `aps_save_letter_draft(...)` with the two issuer
  fields in the same atomic transaction. Approval still goes only through
  `aps_approve_letter`.

The offline PostgreSQL audit covers the RLS split, the code format and
case-insensitive uniqueness, the frozen issuer on a settled letter, the station
snapshot, and the creator-only options payload. These screenshots do not.

Not included, by scope: a settings screen for maintainers to add or rename
issuer codes (the table and its policies exist; the seed carries the current
codes), reconciliations, editing approved letters, and any changes to approval
or cancellation. There is no letters report screen in the application yet, so
the shared `warehouseLabel()` helper — used by the entry screen and the letter
detail — is the single place a future report will use too.
