-- APS inbound tree, phase 1: the party moves onto the line (columns + backfill).
--
-- This migration is intentionally **additive**: it changes no behaviour, calls no
-- trigger and replaces no function. A deployed client that knows nothing about
-- per-line parties keeps working exactly as before — it still writes one party
-- on the header, and the header keeps its party. See
-- `docs/consultations/2026-10-31-aps-inbound-multi-party-implementation-plan.md`.
--
-- Why the columns live on `letter_lines` and not in a new table:
--
--   * A letter line is already the row that carries the warehouse, the
--     classification, the amount and the names as they were printed. The party
--     belongs to that same sentence: "3 tons of steel into warehouse A, from
--     supplier X".
--   * `aps_reconciliation_book_amounts()` aggregates on (station,
--     classification) and never looks at a party, so the balance layer is
--     untouched by this column.
--   * No read path is added, so no RLS policy is added: a line is exactly as
--     visible as its letter, and the party travels with the same row.
--
-- Why `letters.party_id` is **kept**:
--
--   * It stays the *primary* party (the party of the lowest `line_number`), so
--     `letters_counterparty_matches_type`, the header snapshots, the register
--     filter and every existing reader stay true without modification.
--   * Consequently this migration does **not** weaken any CHECK, which the
--     earlier study had proposed and the implementation plan withdrew.
--
-- Why the snapshots are copied from the **header** and not from `parties`:
--
--   * The header already holds the name that was printed on the paper
--     (`counterparty_code` / `counterparty_name`, captured by the header guard).
--     `parties.name` may have been renamed since; copying the live name would
--     invent a name the document never carried.
--
-- Everything here is re-runnable: every column is `if not exists`, every
-- constraint is dropped before being added, and the two backfills are guarded by
-- a `distinct from` predicate so a second run updates no row.

-- ---------------------------------------------------------------------------
-- 1) The party on the line, with its printed snapshots
-- ---------------------------------------------------------------------------
-- `party_id` is nullable on purpose: only an inbound letter has one. Making it
-- mandatory per type is the line guard's job (phase 2), not a column CHECK,
-- because a CHECK cannot see the letter type.
alter table public.letter_lines
  add column if not exists party_id uuid;

alter table public.letter_lines
  add column if not exists party_code text;

alter table public.letter_lines
  add column if not exists party_name text;

comment on column public.letter_lines.party_id is
  'Inbound letters only: the party (supplier / local purchase) this line was received from. Null on every other letter type.';

comment on column public.letter_lines.party_code is
  'Party code captured when the draft was last saved; never rewritten by a later rename.';

comment on column public.letter_lines.party_name is
  'Party name captured when the draft was last saved; never rewritten by a later rename.';

-- `on delete restrict` mirrors what `warehouse_id` and `classification_id`
-- already do: a party that a historical letter was written against cannot be
-- deleted out from under that history, only deactivated.
alter table public.letter_lines
  drop constraint if exists letter_lines_party_fkey;
alter table public.letter_lines
  add constraint letter_lines_party_fkey
    foreign key (party_id) references public.parties (id) on delete restrict;

-- A snapshot is a pair or it is nothing: a code without a name (or the reverse)
-- would render as a half-named party on the detail screen.
alter table public.letter_lines
  drop constraint if exists letter_lines_party_snapshot_check;
alter table public.letter_lines
  add constraint letter_lines_party_snapshot_check check (
    num_nonnulls(party_code, party_name) in (0, 2)
  );

-- Reading a letter's lines is already served by `letter_lines_letter_idx`;
-- this one serves the grouped read ("lines of this letter, by party") and the
-- duplicate check the line guard will run in phase 2.
create index if not exists letter_lines_letter_party_idx
  on public.letter_lines (letter_id, party_id);

-- ---------------------------------------------------------------------------
-- 2) How many parties the letter actually carries
-- ---------------------------------------------------------------------------
-- Derived data, like `source_total` / `destination_total`: written by the line
-- totals trigger (phase 2), never accepted from a client. It exists so the
-- register can print «شركة النيل +2» without a sub-query per row.
--
-- The default is a constant, so this ALTER does not rewrite the table.
alter table public.letters
  add column if not exists party_count integer not null default 1;

comment on column public.letters.party_count is
  'Derived: number of distinct parties among the letter lines (0 when the letter has no party, e.g. an internal transfer or a settlement). Maintained by aps_letter_lines_recalc_totals().';

-- ---------------------------------------------------------------------------
-- 3) Backfill: every inbound line takes its letter's party and snapshots
-- ---------------------------------------------------------------------------
-- A letter written before this change has exactly one party, on its header, so
-- every one of its lines belongs to that party. Giving the party to the first
-- line only would produce a document where the remaining lines have no supplier
-- at all — a state the approval step (phase 2) refuses.
--
-- `updated_at` is NOT touched by this migration, and that is deliberate.
--
-- `letters.updated_at` is the optimistic-concurrency token of the draft save
-- (`aps_save_letter_draft` compares it with `p_expected_updated_at`). The
-- backfill below sets a derived counter, not user content, so bumping the
-- token would make a draft that somebody has open in a browser tab fail its
-- next save with «the draft changed elsewhere» — a false conflict caused by a
-- migration. The `set_updated_at` triggers are therefore disabled for the two
-- statements, with a hard guarantee that they are re-enabled even on failure
-- (the `exception` branch re-enables and re-raises; and the whole block is one
-- transaction, so a rollback restores the trigger regardless).
--
-- The line snapshots are written the same way: they are captured values the
-- clerk never sees as an edit.
do $backfill_aps_letter_parties$
begin
  execute 'alter table public.letter_lines disable trigger letter_lines_set_updated_at';
  execute 'alter table public.letters disable trigger letters_set_updated_at';

  begin
    -- The `left join` supplies a fallback for a header whose snapshot is
    -- missing (only possible for rows written before the header guard captured
    -- it): the live party name is better than a nameless line, and the
    -- verification below still guarantees every inbound line ends up with a
    -- party.
    update public.letter_lines as line
       set party_id = letter.party_id,
           party_code = coalesce(letter.counterparty_code, party.code),
           party_name = coalesce(letter.counterparty_name, party.name)
      from public.letters as letter
      left join public.parties as party on party.id = letter.party_id
     where letter.id = line.letter_id
       and letter.letter_type = 'inbound'
       and letter.party_id is not null
       and (
         line.party_id is distinct from letter.party_id
         or line.party_code is distinct from coalesce(letter.counterparty_code, party.code)
         or line.party_name is distinct from coalesce(letter.counterparty_name, party.name)
       );

    -- The mirror rule, so a re-run after a manual correction cannot leave a
    -- party on an outbound or transfer line. On a fresh run this matches
    -- nothing.
    update public.letter_lines as line
       set party_id = null,
           party_code = null,
           party_name = null
      from public.letters as letter
     where letter.id = line.letter_id
       and letter.letter_type <> 'inbound'
       and (
         line.party_id is not null
         or line.party_code is not null
         or line.party_name is not null
       );

    -- The counter is defined exactly as the trigger will maintain it: the
    -- number of distinct parties present on the letter's lines. That makes the
    -- migration and the trigger agree from the first second, and the
    -- verification below can compare the two definitions.
    update public.letters as letter
       set party_count = coalesce(
             (
               select count(distinct line.party_id)
                 from public.letter_lines as line
                where line.letter_id = letter.id
                  and line.party_id is not null
             ),
             0
           )
     where letter.party_count is distinct from coalesce(
             (
               select count(distinct line.party_id)
                 from public.letter_lines as line
                where line.letter_id = letter.id
                  and line.party_id is not null
             ),
             0
           );
  exception
    when others then
      execute 'alter table public.letters enable trigger letters_set_updated_at';
      execute 'alter table public.letter_lines enable trigger letter_lines_set_updated_at';
      raise;
  end;

  execute 'alter table public.letters enable trigger letters_set_updated_at';
  execute 'alter table public.letter_lines enable trigger letter_lines_set_updated_at';
end
$backfill_aps_letter_parties$;

-- ---------------------------------------------------------------------------
-- 4) Verification: fail the migration loudly rather than ship a half-filled tree
-- ---------------------------------------------------------------------------
-- The first three are invariants. The fourth is a no-op assertion that the
-- backfill above touched no money: the header totals are recomputed from the
-- lines and compared with the stored value, and a mismatch is reported as a
-- notice rather than an exception, because a legacy drift between the two is
-- possible and is not something this migration introduced or may "fix".
do $verify_aps_letter_parties$
declare
  v_lines integer;
  v_letters integer;
  v_missing integer;
  v_stray integer;
  v_counter integer;
  v_inbound_draft integer;
  v_drift integer;
begin
  select count(*) into v_lines from public.letter_lines;
  select count(*) into v_letters from public.letters;

  select count(*)
    into v_missing
    from public.letter_lines as line
    join public.letters as letter on letter.id = line.letter_id
   where letter.letter_type = 'inbound'
     and (line.party_id is null or line.party_code is null or line.party_name is null);

  select count(*)
    into v_stray
    from public.letter_lines as line
    join public.letters as letter on letter.id = line.letter_id
   where letter.letter_type <> 'inbound'
     and (line.party_id is not null or line.party_code is not null or line.party_name is not null);

  select count(*)
    into v_counter
    from public.letters as letter
   where letter.party_count is distinct from coalesce(
           (
             select count(distinct line.party_id)
               from public.letter_lines as line
              where line.letter_id = letter.id
                and line.party_id is not null
           ),
           0
         );

  select count(*)
    into v_inbound_draft
    from public.letters as letter
   where letter.letter_type = 'inbound'
     and letter.status = 'draft';

  if v_missing > 0 then
    raise exception 'aps letter parties: % inbound line(s) still have no party', v_missing;
  end if;

  if v_stray > 0 then
    raise exception 'aps letter parties: % non-inbound line(s) still carry a party', v_stray;
  end if;

  if v_counter > 0 then
    raise exception 'aps letter parties: % letter(s) have a party_count that does not match their lines',
      v_counter;
  end if;

  -- Read-only sanity check on the money. `letters` totals are trigger-maintained
  -- from the lines, so a difference here already existed before this migration.
  select count(*)
    into v_drift
    from public.letters as letter
   where letter.destination_total is distinct from coalesce(
           (select sum(line.amount) from public.letter_lines as line
             where line.letter_id = letter.id and line.direction = 'in'),
           0
         )
      or letter.source_total is distinct from coalesce(
           (select sum(line.amount) from public.letter_lines as line
             where line.letter_id = letter.id and line.direction = 'out'),
           0
         );

  raise notice 'aps letter parties: % letter(s), % line(s) inspected; % inbound draft(s) ready to open in the tree; pre-existing total drift on % letter(s)',
    v_letters, v_lines, v_inbound_draft, v_drift;
end
$verify_aps_letter_parties$;

notify pgrst, 'reload schema';
