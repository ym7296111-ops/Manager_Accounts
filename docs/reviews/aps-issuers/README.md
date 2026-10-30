# APS issuers, station labels and the period bar — review pack

Review pack for the third APS batch, captured **before** the pull request is
opened. Everything here is **fictional sample data** rendered by the local
review harness (`npm run preview:aps`). The harness replaces Supabase,
authentication and capabilities with in-memory fixtures: it proves layout,
labels, filtering and state handling, **not** PostgREST, RLS or PostgreSQL
behaviour. The database rules are covered by the offline audit instead.

## Screens

| File                                | Shows                                                                        |
| ----------------------------------- | ---------------------------------------------------------------------------- |
| `01-entry-inbound-desktop-ar.png`   | Inbound header band (green), period bar, EPS / issuer code / issuer number   |
| `02-entry-issuer-search-ar.png`     | Issuer code combobox filtered by name (`ياسر` → `YM — ياسر`)                 |
| `03-entry-warehouse-station-ar.png` | Warehouse combobox showing `المخزن - المحطة` for every choice                |
| `04-entry-internal-desktop-ar.png`  | Internal transfer: violet header band, paired source → destination, stations |
| `05-entry-mobile-ar.png`            | 390 px: header band, period bar and the four type buttons on one row         |
| `06-detail-station-ar.png`          | Letter detail: EPS, issuer code, issuer number, and `مخزن - محطة` per line   |
| `07-entry-desktop-en.png`           | English, left-to-right                                                       |

## What changed on the entry screen

1. **Type is a button group.** The four large cards became one row of four
   buttons inside a single control. The type no longer costs a quarter of the
   screen, and the selected type is a state, not a page.
2. **The header states the type.** Inbound = green with a down-left arrow,
   outbound = orange with an up-right arrow, internal transfer = violet with the
   exchange icon, external transfer = blue with an outgoing arrow. Each band
   carries its own title (`خطاب وارد جديد`, …) plus the short hint, so the type
   is never colour-only.
3. **The running period is read, not typed.** The bar above the form reads the
   fiscal months from the periodic settings and shows
   «أنت تدخل خطاباً في: [شهر] [سنة] — الفترة [رقم]». A date outside every
   configured month says so instead of guessing a period, and a closed month is
   flagged.
4. **The three numbers are named as on the paper form.** `رقم النظام (EPS)` is
   the manually typed `letter_number`; `كود المُصدر` is a searchable list of the
   two-letter issuers (`YM — ياسر`); `رقم المُصدر` is the issuer's own sequence,
   typed by hand.
5. **Warehouse and station are one label.** Every warehouse choice and every
   line reads `[المخزن] - [المحطة]`, and the search matches the warehouse name,
   the station name and the code.

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

The offline PostgreSQL audit (93 checks) covers the RLS split, the code format
and case-insensitive uniqueness, the frozen issuer on a settled letter, the
station snapshot, and the creator-only options payload. These screenshots do
not.

Not included, by scope: a settings screen for maintainers to add or rename
issuer codes (the table and its policies exist; the seed carries the current
codes), reconciliations, editing approved letters, and any changes to approval
or cancellation. There is no letters report screen in the application yet, so
the shared `warehouseLabel()` helper — used by the entry screen and the letter
detail — is the single place a future report will use too.
