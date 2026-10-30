# APS letter entry — review pack

Review before a pull request is opened. Everything here is **fictional sample
data** rendered by the local review harness (`npm run preview:aps`). The
harness replaces Supabase, authentication and capabilities with in-memory
fixtures: it proves layout, validation, state handling and navigation, **not**
PostgREST, RLS or PostgreSQL behaviour.

## Screens

| File                               | Shows                                                                 |
| ---------------------------------- | --------------------------------------------------------------------- |
| `01-entry-inbound-desktop-ar.png`  | Inbound letter, two lines, live total, draft/approve actions (RTL)    |
| `02-entry-internal-desktop-ar.png` | Internal transfer pair, source → destination, reclassification reason |
| `03-entry-approved-desktop-ar.png` | The same transfer after a successful approval                         |
| `04-entry-mobile-ar.png`           | 390 px, internal pairs stacked, no horizontal overflow                |
| `05-entry-desktop-en.png`          | English, left-to-right                                                |

## What the screen does

- `/workspaces/aps/letters/new`, guarded by `aps.letters:create`. A draft is
  reopened with `?draft=<id>`; only the author's own ordinary draft is editable,
  and a settlement is never editable here.
- Four types only: inbound, outbound, internal transfer, external transfer.
  Each type renders its own fields: party branch, sister company plus direction,
  or source → destination pairs.
- Lines are money as text end to end (Arabic-Indic digits accepted, never
  `Number`), positive, at most two decimals. An internal pair is one source and
  one destination at the same value, so the transfer stays balanced; when a
  pair changes classification the reason is mandatory (3+ characters).
- Error states are explicit: field-level validation, duplicate number, stale or
  already-saved draft, refusal, and an _uncertain_ result that keeps the data
  and links to the draft instead of claiming success or failure.
- Capability, i18n, 390 px layout and keyboard/label semantics are shared with
  the browse tab.

## Behaviour that only the database proves

`supabase/migrations/20261116000000_aps_letter_entry.sql` adds a
creator-only choice RPC (fiscal years, active warehouses/leaf classifications,
parties by branch, sister companies) and `aps_save_letter_draft`, which writes
the header and every line atomically, refuses stale versions, enforces
`aps.letters:create` and remains subject to the existing RLS, triggers and
foreign keys. Approval still goes through `aps_approve_letter`. The local
PostgreSQL audit (91 checks) covers the server rules; the screenshots do not.

Not included, by scope: the reconciliations tab, editing approved letters,
attachment/scan upload, and client-side reference-directory reads.
