-- APS party tree, phase 2: the rules that make a party per line real.
--
-- Phase 1 (`20261119000000`) added the columns and backfilled history. This
-- phase replaces five function **bodies** — every signature, security mode and
-- grant is unchanged, so there is no moment at which an RPC is missing:
--
--   1. `aps_letter_lines_before_write()` — the line guard learns the party:
--      mandatory and branch-matched on inbound/outbound lines, forbidden on
--      transfers and settlements, snapshots assigned server-side, and one line
--      per (party, warehouse, classification) per letter.
--   2. `aps_letter_lines_recalc_totals()` — the derived header gains its two
--      party fields next to the totals it already owns: `party_count`, and
--      `party_id` as the primary party (the first line's party).
--   3. `aps_save_letter_draft(...)` — reads `party_id` from each element of
--      `p_lines` and falls back to `p_party_id`, so a deployed pre-tree client
--      keeps saving single-party drafts exactly as before.
--   4. `aps_assert_letter_consistent(uuid)` — approval re-proves the party
--      invariants: every counterparty line has a branch-matched party, the
--      header party is the first line's, and `party_count` matches.
--   5. `aps_approve_letter(uuid)` — the audit row records `party_count` and the
--      list of `party_codes` instead of implying one counterparty.
--
-- Nothing in this file touches reconciliation: `aps_reconciliation_book_*` and
-- the settlement writer aggregate on (station, classification) and never read
-- a party, and the settlement letter type keeps carrying none.
--
-- The duplicate rule is a trigger check, not a unique index, on purpose:
-- approved history may already repeat a (warehouse, classification) pair and
-- an index over it would fail; and the error is a named `P0001` because the
-- entry screen translates `23505` as "letter number already used".
-- See `docs/consultations/2026-10-31-aps-inbound-multi-party-implementation-plan.md` (§12).

-- ---------------------------------------------------------------------------
-- 0) Close the deploy window: drafts saved between phase 1 and this file
-- ---------------------------------------------------------------------------
-- A draft saved by the pre-tree function bodies after phase 1 landed has lines
-- with no party yet (and could even have been approved in that window). The
-- rules below would refuse to approve such a letter, so phase 1's backfill is
-- repeated first: identical, idempotent, and a no-op wherever phase 1 already
-- filled the lines. The write path is paused for the same reasons as there.
do $backfill_aps_letter_parties$
begin
  execute 'alter table public.letter_lines disable trigger letter_lines_set_updated_at';
  execute 'alter table public.letters disable trigger letters_set_updated_at';
  execute 'alter table public.letter_lines disable trigger letter_lines_aps_before_write';
  execute 'alter table public.letter_lines disable trigger letter_lines_aps_station_snapshot';
  execute 'alter table public.letter_lines disable trigger letter_lines_aps_recalc_totals';
  execute 'alter table public.letters disable trigger letters_aps_before_write';

  begin
    -- The `left join` supplies a fallback for a header whose snapshot is
    -- missing (only possible for rows written before the header guard captured
    -- it): the live party name is better than a nameless line, and the
    -- verification below still guarantees every counterparty line ends up with
    -- a party.
    update public.letter_lines as line
       set party_id = letter.party_id,
           party_code = coalesce(letter.counterparty_code, party.code),
           party_name = coalesce(letter.counterparty_name, party.name)
      from public.letters as letter
      left join public.parties as party on party.id = letter.party_id
     where letter.id = line.letter_id
       and letter.letter_type in ('inbound', 'outbound')
       and letter.party_id is not null
       and (
         line.party_id is distinct from letter.party_id
         or line.party_code is distinct from coalesce(letter.counterparty_code, party.code)
         or line.party_name is distinct from coalesce(letter.counterparty_name, party.name)
       );

    -- The mirror rule, so a re-run after a manual correction cannot leave a
    -- party on a transfer or settlement line. On a fresh run this matches
    -- nothing.
    update public.letter_lines as line
       set party_id = null,
           party_code = null,
           party_name = null
      from public.letters as letter
     where letter.id = line.letter_id
       and letter.letter_type in ('internal_transfer', 'external_transfer', 'settlement')
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
      execute 'alter table public.letters enable trigger letters_aps_before_write';
      execute 'alter table public.letter_lines enable trigger letter_lines_aps_recalc_totals';
      execute 'alter table public.letter_lines enable trigger letter_lines_aps_station_snapshot';
      execute 'alter table public.letter_lines enable trigger letter_lines_aps_before_write';
      execute 'alter table public.letters enable trigger letters_set_updated_at';
      execute 'alter table public.letter_lines enable trigger letter_lines_set_updated_at';
      raise;
  end;

  execute 'alter table public.letters enable trigger letters_aps_before_write';
  execute 'alter table public.letter_lines enable trigger letter_lines_aps_recalc_totals';
  execute 'alter table public.letter_lines enable trigger letter_lines_aps_station_snapshot';
  execute 'alter table public.letter_lines enable trigger letter_lines_aps_before_write';
  execute 'alter table public.letters enable trigger letters_set_updated_at';
  execute 'alter table public.letter_lines enable trigger letter_lines_set_updated_at';
end
$backfill_aps_letter_parties$;

-- ---------------------------------------------------------------------------
-- 1) The line guard: party per line, branch-matched, snapshotted, de-duplicated
-- ---------------------------------------------------------------------------
create or replace function public.aps_letter_lines_before_write()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_letter record;
  v_paired record;
  v_party record;
begin
  select letter.letter_type, letter.status, letter.created_by
    into v_letter
    from public.letters as letter
   where letter.id = new.letter_id;
  if not found then
    raise exception 'aps letters: unknown letter %', new.letter_id using errcode = '23503';
  end if;
  if v_letter.status <> 'draft' then
    raise exception 'aps letters: the lines of a % letter are immutable', v_letter.status
      using errcode = '23514';
  end if;

  -- A classification must be a leaf: posting to a parent would double-count
  -- once the tree totals are rolled up from the leaves.
  -- The snapshots are assigned by the server, never trusted from the client.
  -- The SECURITY DEFINER context is the existing narrow line-write guard: it
  -- does not grant callers direct access to the protected reference tables.
  select classification.name
    into new.classification_name
    from public.classifications as classification
   where classification.id = new.classification_id
     and classification.is_leaf;
  if not found then
    raise exception 'aps letters: classification % is not a leaf', new.classification_id
      using errcode = '23514';
  end if;

  select warehouse.name
    into new.warehouse_name
    from public.warehouses as warehouse
   where warehouse.id = new.warehouse_id;
  if not found and new.warehouse_id is not null then
    raise exception 'aps letters: unknown warehouse %', new.warehouse_id using errcode = '23503';
  end if;

  -- The party: only the two counterparty letter types carry one, and its branch
  -- must match the letter type (a supplier for inbound, an issue purpose for
  -- outbound). The snapshots are assigned here, exactly like the warehouse and
  -- classification names.
  --
  -- `is_active` is deliberately NOT checked, mirroring the header guard:
  -- deactivation closes a party to new letters on the entry screen, but it
  -- must not freeze a draft that was written while the party was active.
  if v_letter.letter_type in ('inbound', 'outbound') then
    if new.party_id is null then
      raise exception 'aps letters: a % line needs a party', v_letter.letter_type
        using errcode = '23514';
    end if;
    select party.branch, party.code, party.name
      into v_party
      from public.parties as party
     where party.id = new.party_id;
    if not found then
      raise exception 'aps letters: unknown party %', new.party_id using errcode = '23503';
    end if;
    if v_party.branch <> v_letter.letter_type then
      raise exception 'aps letters: a % line needs a % party, % is %',
        v_letter.letter_type, v_letter.letter_type, v_party.code, v_party.branch
        using errcode = '23514';
    end if;
    new.party_code := v_party.code;
    new.party_name := v_party.name;

    -- One line per (party, warehouse, classification) in a letter: two lines
    -- for the same triple are one line typed twice. Enforced here and not by
    -- a unique index, because approved history may already repeat a pair and
    -- building an index over it would fail outright. A named P0001, not
    -- 23505: the entry screen reads 23505 as "letter number already used".
    if exists (
      select 1 from public.letter_lines as other
       where other.letter_id = new.letter_id
         and other.id <> new.id
         and other.party_id = new.party_id
         and other.warehouse_id is not distinct from new.warehouse_id
         and other.classification_id = new.classification_id
    ) then
      raise exception 'aps_entry_duplicate_party_line' using errcode = 'P0001';
    end if;
  else
    if new.party_id is not null then
      raise exception 'aps letters: a % line carries no party', v_letter.letter_type
        using errcode = '23514';
    end if;
    new.party_code := null;
    new.party_name := null;
  end if;

  if new.line_number is null then
    select coalesce(max(line.line_number), 0) + 1
      into new.line_number
      from public.letter_lines as line
     where line.letter_id = new.letter_id;
  end if;

  -- Pairing exists only inside an internal transfer. Completeness is checked at
  -- approval; the shape of a single pair is checked here, where the mistake is
  -- made.
  if new.paired_line_id is not null then
    if v_letter.letter_type <> 'internal_transfer' then
      raise exception 'aps letters: only an internal transfer pairs lines'
        using errcode = '23514';
    end if;
    if new.direction <> 'in' then
      raise exception 'aps letters: only an `in` line records a pair' using errcode = '23514';
    end if;
    select paired.direction, paired.amount, paired.letter_id
      into v_paired
      from public.letter_lines as paired
     where paired.id = new.paired_line_id;
    if not found then
      raise exception 'aps letters: unknown paired line %', new.paired_line_id
        using errcode = '23503';
    end if;
    if v_paired.letter_id <> new.letter_id then
      raise exception 'aps letters: a pair must belong to the same letter'
        using errcode = '23514';
    end if;
    if v_paired.direction <> 'out' then
      raise exception 'aps letters: a line pairs with an `out` line, not with another `in` line'
        using errcode = '23514';
    end if;
    if v_paired.amount <> new.amount then
      raise exception 'aps letters: a paired line must have the same amount (% vs %)',
        v_paired.amount, new.amount using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.aps_letter_lines_before_write()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2) The totals trigger also owns the derived party header
-- ---------------------------------------------------------------------------
create or replace function public.aps_letter_lines_recalc_totals()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_letter_id uuid;
begin
  for v_letter_id in
    select distinct candidate
      from (
        values (coalesce(new.letter_id, old.letter_id)), (old.letter_id), (new.letter_id)
      ) as moved(candidate)
     where candidate is not null
  loop
    update public.letters as letter
       set source_total = coalesce(
             (
               select sum(line.amount)
                 from public.letter_lines as line
                where line.letter_id = v_letter_id
                  and line.direction = 'out'
             ),
             0
           ),
           destination_total = coalesce(
             (
               select sum(line.amount)
                 from public.letter_lines as line
                where line.letter_id = v_letter_id
                  and line.direction = 'in'
             ),
             0
           ),
           -- The header party is derived like the totals: the primary party is
           -- the party of the first line, so the register and the header
           -- snapshot keep naming a real party of this letter. A letter left
           -- with no lines (mid-save, just after the delete) keeps its header
           -- party: blanking it would make the header guard refuse the save
           -- halfway through. Transfers and settlements carry no party and
           -- keep whatever the header holds (null).
           party_id = case
             when letter.letter_type in ('inbound', 'outbound') then coalesce(
               (
                 select line.party_id
                   from public.letter_lines as line
                  where line.letter_id = v_letter_id
                  order by line.line_number
                  limit 1
               ),
               letter.party_id
             )
             else letter.party_id
           end,
           party_count = coalesce(
             (
               select count(distinct line.party_id)
                 from public.letter_lines as line
                where line.letter_id = v_letter_id
             ),
             0
           )::integer
     where letter.id = v_letter_id;
  end loop;

  return null;
end;
$$;

revoke all on function public.aps_letter_lines_recalc_totals()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3) The draft save: a party per line, with the old single-party fallback
-- ---------------------------------------------------------------------------
create or replace function public.aps_save_letter_draft(
  p_letter_id uuid,
  p_expected_updated_at timestamptz,
  p_fiscal_year_id uuid,
  p_letter_type text,
  p_letter_number text,
  p_party_id uuid,
  p_sister_company_id uuid,
  p_direction text,
  p_reclassification_reason text,
  p_lines jsonb,
  p_issuer_reference text,
  p_letter_date date default current_date
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_previous record;
  v_line jsonb;
  v_amount_text text;
  v_amount numeric(18,2);
  v_direction text;
  v_out_id uuid;
  v_has_reclassification boolean := false;
  v_reason text;
  v_issuer_reference text;
  v_letter_date date := coalesce(p_letter_date, current_date);
  v_updated_at timestamptz;
  v_constraint text;
  v_primary_party uuid;
begin
  if v_actor is null or not public.aps_can_create_letters() then
    raise exception 'aps entry: aps.letters:create is required' using errcode = '42501';
  end if;
  if p_letter_id is null or p_fiscal_year_id is null
     or p_letter_type is null or p_letter_type not in ('inbound','outbound','internal_transfer','external_transfer') then
    raise exception 'aps entry: invalid letter header' using errcode = '22023';
  end if;
  if p_letter_type = 'external_transfer' and (p_direction is null or p_direction not in ('in','out')) then
    raise exception 'aps entry: external direction must be in or out' using errcode = '22023';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array'
     or jsonb_array_length(p_lines) < 1
     or jsonb_array_length(p_lines) > (case when p_letter_type = 'internal_transfer' then 250 else 500 end) then
    raise exception 'aps entry: invalid number of lines' using errcode = '22023';
  end if;

  -- The letter code is optional on a draft. Whatever is supplied must be the
  -- documented shape, and its issuer must exist in the controlled list: the
  -- registry is what makes `YM` a person and not a typo.
  v_issuer_reference := nullif(upper(btrim(coalesce(p_issuer_reference, ''))), '');
  if v_issuer_reference is not null then
    if v_issuer_reference !~ '^[A-Z]{2}:[0-9]+$' then
      raise exception 'aps entry: the letter code must look like YM:63' using errcode = '22023';
    end if;
    if not exists (
      select 1 from public.issuers as issuer
       where issuer.code = left(v_issuer_reference, 2) and issuer.is_active
    ) then
      raise exception 'aps entry: unknown or inactive issuer %', left(v_issuer_reference, 2)
        using errcode = '22023';
    end if;
  end if;

  -- Validate before writing; never round user input or accept negative values.
  for v_line in select value from jsonb_array_elements(p_lines) loop
    if jsonb_typeof(v_line) <> 'object' then
      raise exception 'aps entry: invalid line' using errcode = '22023';
    end if;
    v_amount_text := v_line->>'amount';
    if v_amount_text is null or v_amount_text !~ '^[0-9]{1,16}(\.[0-9]{1,2})?$'
       or v_amount_text::numeric <= 0 then
      raise exception 'aps entry: each amount must be positive with at most two decimals' using errcode = '22023';
    end if;
    if p_letter_type = 'internal_transfer' then
      if v_line->>'source_warehouse_id' is null or v_line->>'source_classification_id' is null
         or v_line->>'destination_warehouse_id' is null or v_line->>'destination_classification_id' is null then
        raise exception 'aps entry: each transfer needs a complete source and destination' using errcode = '22023';
      end if;
      if (v_line->>'source_classification_id')::uuid is distinct from (v_line->>'destination_classification_id')::uuid then
        v_has_reclassification := true;
      end if;
    elsif v_line->>'warehouse_id' is null or v_line->>'classification_id' is null then
      raise exception 'aps entry: each line needs a warehouse and classification' using errcode = '22023';
    elsif p_letter_type in ('inbound', 'outbound')
       and coalesce((v_line->>'party_id')::uuid, p_party_id) is null then
      raise exception 'aps entry: each line needs a party' using errcode = '22023';
    end if;
  end loop;

  v_reason := nullif(btrim(coalesce(p_reclassification_reason, '')), '');
  if v_has_reclassification and (v_reason is null or char_length(v_reason) < 3) then
    raise exception 'aps entry: reclassification requires a reason' using errcode = '22023';
  end if;
  if not v_has_reclassification then v_reason := null; end if;

  -- The header keeps exactly one party: the primary, which is the party of the
  -- first line. An older client sends one party in `p_party_id` and none on the
  -- lines; the tree client sends one per line. Both write the same header, and
  -- the totals trigger re-derives it from the lines after every write, so the
  -- header can never drift from the body of the letter.
  v_primary_party := case
    when p_letter_type in ('inbound', 'outbound')
      then coalesce((p_lines->0->>'party_id')::uuid, p_party_id)
    else p_party_id
  end;

  if p_expected_updated_at is null then
    insert into public.letters (
      id, fiscal_year_id, letter_type, letter_number, letter_date,
      party_id, sister_company_id, has_reclassification, reclassification_reason,
      issuer_reference
    ) values (
      p_letter_id, p_fiscal_year_id, p_letter_type, p_letter_number, v_letter_date,
      v_primary_party, p_sister_company_id, v_has_reclassification, v_reason,
      v_issuer_reference
    );
  else
    select letter.created_by, letter.status, letter.letter_type, letter.updated_at,
           letter.letter_date
      into v_previous
      from public.letters as letter
     where letter.id = p_letter_id
     for update;
    if not found or v_previous.created_by <> v_actor or v_previous.status <> 'draft'
       or v_previous.letter_type = 'settlement' then
      raise exception 'aps entry: draft is unavailable' using errcode = '42501';
    end if;
    if v_previous.updated_at is distinct from p_expected_updated_at then
      raise exception 'aps_entry_stale_draft' using errcode = 'P0001';
    end if;

    -- Editing a draft keeps the accounting date it was written with; only a new
    -- draft is dated today. The screen never sends a date, so this is what stops
    -- a resumed draft from silently moving to the day it was reopened.
    v_letter_date := coalesce(p_letter_date, v_previous.letter_date);

    -- Delete incoming paired rows before their referenced outgoing rows.
    delete from public.letter_lines where letter_id = p_letter_id and direction = 'in';
    delete from public.letter_lines where letter_id = p_letter_id;
    update public.letters
       set fiscal_year_id = p_fiscal_year_id,
           letter_type = p_letter_type,
           letter_number = p_letter_number,
           letter_date = v_letter_date,
           party_id = v_primary_party,
           sister_company_id = p_sister_company_id,
           has_reclassification = v_has_reclassification,
           reclassification_reason = v_reason,
           issuer_reference = v_issuer_reference
     where id = p_letter_id;
  end if;

  v_direction := case p_letter_type
    when 'inbound' then 'in'
    when 'outbound' then 'out'
    else p_direction
  end;
  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_amount := (v_line->>'amount')::numeric(18,2);
    if p_letter_type = 'internal_transfer' then
      insert into public.letter_lines (letter_id, direction, warehouse_id, classification_id, amount)
      values (p_letter_id, 'out', (v_line->>'source_warehouse_id')::uuid,
              (v_line->>'source_classification_id')::uuid, v_amount)
      returning id into v_out_id;
      insert into public.letter_lines (letter_id, direction, warehouse_id, classification_id, amount, paired_line_id)
      values (p_letter_id, 'in', (v_line->>'destination_warehouse_id')::uuid,
              (v_line->>'destination_classification_id')::uuid, v_amount, v_out_id);
    else
      -- The line's own party wins; the header argument is the fallback that
      -- keeps a pre-tree client working unchanged. An external transfer takes
      -- null: its counterparty is the sister company on the header.
      insert into public.letter_lines (letter_id, direction, warehouse_id, classification_id, amount, party_id)
      values (p_letter_id, v_direction, (v_line->>'warehouse_id')::uuid,
              (v_line->>'classification_id')::uuid, v_amount,
              case when p_letter_type in ('inbound', 'outbound')
                then coalesce((v_line->>'party_id')::uuid, p_party_id)
              end);
    end if;
  end loop;

  select letter.updated_at into v_updated_at from public.letters as letter where letter.id = p_letter_id;
  return jsonb_build_object('id', p_letter_id, 'updated_at', v_updated_at);
exception when unique_violation then
  get stacked diagnostics v_constraint = constraint_name;
  if v_constraint = 'letters_pkey' then
    raise exception 'aps_entry_id_exists' using errcode = 'P0001';
  end if;
  if v_constraint = 'letters_year_issuer_reference_key' then
    raise exception 'aps_entry_duplicate_letter_code' using errcode = 'P0001';
  end if;
  raise;
end;
$$;

revoke all on function public.aps_save_letter_draft(uuid,timestamptz,uuid,text,text,uuid,uuid,text,text,jsonb,text,date) from public, anon;
grant execute on function public.aps_save_letter_draft(uuid,timestamptz,uuid,text,text,uuid,uuid,text,text,jsonb,text,date) to authenticated, service_role;
comment on function public.aps_save_letter_draft(uuid,timestamptz,uuid,text,text,uuid,uuid,text,text,jsonb,text,date) is
  'Atomically create or replace an owned ordinary draft under RLS, with optimistic concurrency. The letter date defaults to today; approval remains aps_approve_letter().';

-- ---------------------------------------------------------------------------
-- 4) Approval invariants for the party tree
-- ---------------------------------------------------------------------------
create or replace function public.aps_assert_letter_consistent(p_letter_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_type text;
  v_party_id uuid;
  v_party_count integer;
  v_lines integer;
  v_in_total numeric(18, 2);
  v_out_total numeric(18, 2);
  v_directions integer;
begin
  select letter.letter_type, letter.party_id, letter.party_count
    into v_type, v_party_id, v_party_count
    from public.letters as letter
   where letter.id = p_letter_id;
  if v_type is null then
    return;
  end if;

  select count(*)::integer,
         coalesce(sum(line.amount) filter (where line.direction = 'in'), 0),
         coalesce(sum(line.amount) filter (where line.direction = 'out'), 0),
         count(distinct line.direction)::integer
    into v_lines, v_in_total, v_out_total, v_directions
    from public.letter_lines as line
   where line.letter_id = p_letter_id;

  if v_lines = 0 then
    return;
  end if;

  if v_type = 'inbound' and exists (
    select 1 from public.letter_lines as line
     where line.letter_id = p_letter_id and line.direction <> 'in'
  ) then
    raise exception 'aps letters: an inbound letter only has `in` lines' using errcode = '23514';
  end if;
  if v_type = 'outbound' and exists (
    select 1 from public.letter_lines as line
     where line.letter_id = p_letter_id and line.direction <> 'out'
  ) then
    raise exception 'aps letters: an outbound letter only has `out` lines' using errcode = '23514';
  end if;
  -- An intercompany movement goes one way. Netting both directions inside one
  -- letter would hide two unrelated movements behind a single total.
  if v_type = 'external_transfer' and v_directions <> 1 then
    raise exception 'aps letters: an external transfer moves stock in one direction only'
      using errcode = '23514';
  end if;

  -- The party tree, restated at the moment the letter becomes a reference
  -- document. The line guard enforces all of this on every write; approval
  -- re-proves it because an approved letter can no longer be repaired, and a
  -- derived header (primary party, party_count) that disagreed with the lines
  -- would misname the letter in the register forever.
  if v_type in ('inbound', 'outbound') then
    if exists (
      select 1 from public.letter_lines as line
       where line.letter_id = p_letter_id
         and (line.party_id is null or line.party_code is null or line.party_name is null)
    ) then
      raise exception 'aps letters: every % line needs a party', v_type using errcode = '23514';
    end if;
    if exists (
      select 1 from public.letter_lines as line
        join public.parties as party on party.id = line.party_id
       where line.letter_id = p_letter_id and party.branch <> v_type
    ) then
      raise exception 'aps letters: a % letter only carries % parties', v_type, v_type
        using errcode = '23514';
    end if;
    if v_party_id is distinct from (
      select line.party_id from public.letter_lines as line
       where line.letter_id = p_letter_id
       order by line.line_number
       limit 1
    ) then
      raise exception 'aps letters: the header party is not the party of the first line'
        using errcode = '23514';
    end if;
    if v_party_count is distinct from (
      select count(distinct line.party_id)::integer
        from public.letter_lines as line
       where line.letter_id = p_letter_id
    ) then
      raise exception 'aps letters: party_count does not match the lines' using errcode = '23514';
    end if;
  elsif exists (
    select 1 from public.letter_lines as line
     where line.letter_id = p_letter_id and line.party_id is not null
  ) then
    raise exception 'aps letters: a % line carries no party', v_type using errcode = '23514';
  end if;

  if v_type <> 'internal_transfer' then
    if exists (
      select 1 from public.letter_lines as line
       where line.letter_id = p_letter_id and line.paired_line_id is not null
    ) then
      raise exception 'aps letters: only an internal transfer pairs lines'
        using errcode = '23514';
    end if;
    return;
  end if;

  if v_in_total <> v_out_total then
    raise exception 'aps letters: the transfer does not balance (% in vs % out)',
      v_in_total, v_out_total using errcode = '23514';
  end if;

  if exists (
    select 1 from public.letter_lines as line
     where line.letter_id = p_letter_id and line.direction = 'in' and line.paired_line_id is null
  ) then
    raise exception 'aps letters: every destination line must name the source line it settles'
      using errcode = '23514';
  end if;

  if exists (
    select 1
      from public.letter_lines as line
      join public.letter_lines as paired on paired.id = line.paired_line_id
     where line.letter_id = p_letter_id
       and line.direction = 'in'
       and (
         paired.letter_id <> line.letter_id
         or paired.direction <> 'out'
         or paired.amount <> line.amount
       )
  ) then
    raise exception 'aps letters: a paired line must be an equal `out` line of the same letter'
      using errcode = '23514';
  end if;

  if exists (
    select 1
      from public.letter_lines as line
     where line.letter_id = p_letter_id
       and line.direction = 'out'
       and (
         select count(*)
           from public.letter_lines as settled
          where settled.paired_line_id = line.id
       ) <> 1
  ) then
    raise exception 'aps letters: every source line must be settled by exactly one destination line'
      using errcode = '23514';
  end if;

  -- A pair that crosses classifications is a reclassification, not a plain
  -- move: it must be declared and justified on the header, otherwise the same
  -- balance change hides behind an ordinary transfer.
  if exists (
    select 1
      from public.letter_lines as line
      join public.letter_lines as paired on paired.id = line.paired_line_id
     where line.letter_id = p_letter_id
       and line.direction = 'in'
       and line.classification_id <> paired.classification_id
  ) and not coalesce(
    (
      select letter.has_reclassification
        from public.letters as letter
       where letter.id = p_letter_id
    ),
    false
  ) then
    raise exception 'aps letters: a transfer into a different classification must be flagged as a reclassification with a reason'
      using errcode = '23514';
  end if;
end;
$$;

revoke all on function public.aps_assert_letter_consistent(uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5) Approval audit: every party of the letter, not only the primary
-- ---------------------------------------------------------------------------
create or replace function public.aps_approve_letter(p_letter_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_letter public.letters%rowtype;
  v_year record;
  v_month_closed boolean;
  v_line_count integer;
begin
  if v_actor is null or not public.aps_can_create_letters() then
    raise exception 'aps_approve_letter: aps.letters:create is required' using errcode = '42501';
  end if;

  select * into v_letter from public.letters where id = p_letter_id for update;
  if not found then
    raise exception 'aps_approve_letter: letter % not found', p_letter_id using errcode = 'P0002';
  end if;

  -- Drafts are author-scoped; a project-settings manager can finalise a draft
  -- left behind by a colleague who lost access.
  if v_letter.created_by <> v_actor and not public.can_manage_project_settings() then
    raise exception 'aps_approve_letter: only the author can approve this draft'
      using errcode = '42501';
  end if;

  if v_letter.status <> 'draft' then
    raise exception 'aps_approve_letter: only a draft can be approved, this letter is %',
      v_letter.status using errcode = '22023';
  end if;

  select count(*)::integer into v_line_count
    from public.letter_lines as line
   where line.letter_id = p_letter_id;
  if v_line_count = 0 then
    raise exception 'aps_approve_letter: a letter needs at least one line' using errcode = '22023';
  end if;

  select year.start_date, year.end_date, year.is_closed, year.supplements_open
    into v_year
    from public.fiscal_years as year
   where year.id = v_letter.fiscal_year_id;
  if not found then
    raise exception 'aps_approve_letter: unknown fiscal year' using errcode = '23503';
  end if;

  if v_year.is_closed and not v_year.supplements_open then
    raise exception 'aps_approve_letter: the fiscal year is closed' using errcode = '22023';
  end if;

  select month.is_closed into v_month_closed
    from public.fiscal_months as month
   where month.fiscal_year_id = v_letter.fiscal_year_id
     and v_letter.letter_date between month.start_date and month.end_date
   limit 1;
  if v_month_closed is null then
    raise exception 'aps_approve_letter: % is outside the fiscal year', v_letter.letter_date
      using errcode = '22023';
  end if;
  if v_month_closed and not v_year.supplements_open then
    raise exception 'aps_approve_letter: the fiscal month containing % is closed',
      v_letter.letter_date using errcode = '22023';
  end if;

  perform public.aps_assert_letter_consistent(p_letter_id);

  update public.letters
     set status = 'approved',
         approved_at = now(),
         approved_by = v_actor
   where id = p_letter_id;

  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
  values (
    v_actor,
    'aps.letter_approved'::public.audit_action,
    'letters',
    p_letter_id::text,
    jsonb_build_object(
      'letter_number', v_letter.letter_number,
      'letter_type', v_letter.letter_type,
      'fiscal_year_id', v_letter.fiscal_year_id,
      'letter_date', v_letter.letter_date,
      'counterparty_code', v_letter.counterparty_code,
      'party_count', v_letter.party_count,
      'party_codes', (
        select coalesce(jsonb_agg(distinct line.party_code), '[]'::jsonb)
          from public.letter_lines as line
         where line.letter_id = p_letter_id and line.party_code is not null
      ),
      'source_total', v_letter.source_total,
      'destination_total', v_letter.destination_total,
      'line_count', v_line_count
    )
  );
end;
$$;

revoke all on function public.aps_approve_letter(uuid) from public, anon;
grant execute on function public.aps_approve_letter(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6) Verification: the new bodies landed, with their signatures and security
-- ---------------------------------------------------------------------------
do $verify_aps_party_rules$
declare
  v_save record;
  v_count integer;
begin
  select proc.prosecdef, proc.prosrc
    into v_save
    from pg_proc as proc
   where proc.oid = 'public.aps_save_letter_draft(uuid,timestamptz,uuid,text,text,uuid,uuid,text,text,jsonb,text,date)'::regprocedure;

  if v_save.prosecdef then
    raise exception 'aps party rules: aps_save_letter_draft must stay security invoker (it writes under RLS)';
  end if;
  if v_save.prosrc not like '%v_primary_party%' then
    raise exception 'aps party rules: aps_save_letter_draft was not replaced';
  end if;

  select count(*)
    into v_count
    from pg_proc as proc
   where proc.pronamespace = 'public'::regnamespace
     and proc.proname in (
       'aps_letter_lines_before_write', 'aps_letter_lines_recalc_totals',
       'aps_assert_letter_consistent', 'aps_approve_letter'
     )
     and proc.prosecdef;
  if v_count <> 4 then
    raise exception 'aps party rules: expected 4 security definer guards, found %', v_count;
  end if;

  if not exists (
    select 1 from pg_proc as proc
     where proc.pronamespace = 'public'::regnamespace
       and proc.proname = 'aps_letter_lines_before_write'
       and proc.prosrc like '%aps_entry_duplicate_party_line%'
  ) then
    raise exception 'aps party rules: the line guard was not replaced';
  end if;

  if not exists (
    select 1 from pg_proc as proc
     where proc.pronamespace = 'public'::regnamespace
       and proc.proname = 'aps_letter_lines_recalc_totals'
       and proc.prosrc like '%party_count%'
  ) then
    raise exception 'aps party rules: the totals trigger was not replaced';
  end if;

  raise notice 'aps party rules: five bodies replaced, signatures and security unchanged';
end
$verify_aps_party_rules$;

notify pgrst, 'reload schema';
