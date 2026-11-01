-- APS internal transfers: two independent lists, settled as one letter.
--
-- Until now an internal transfer was stored as pairs: each `in` line pointed
-- at the equal `out` line it settled (`paired_line_id`), and a pair that
-- crossed classifications had to be flagged on the header and justified with
-- a mandatory reason (`has_reclassification` / `reclassification_reason`).
-- One source feeding two destinations — the ordinary shape of a real move —
-- could only be written by splitting it into pairs by hand.
--
-- The transfer now stores what the entry screen shows: two independent lists
-- of free lines, each naming its own direction. Pairing is retired, and the
-- only settlement rule is at letter level: `sum(out) = sum(in)`, proven at
-- approval by `aps_assert_letter_consistent()` (and backstopped for approved
-- letters by `letters_internal_balance_check` over the trigger-maintained
-- totals). Inbound stays all-`in` and outbound all-`out`, exactly as before.
-- The justified-reason machinery is replaced by one optional statement on the
-- header, `letters.reclassification_note`: movement between classifications
-- needs no flag and no per-line reason any more.
--
-- Data premise (verified against production before this migration was
-- written): there are no internal transfers yet. Section 0 re-proves the part
-- that would lose information and aborts instead of dropping pairings that
-- exist; any stray statement text is carried into the new note column before
-- the old one is dropped, so nothing readable is discarded either way.
--
-- `aps_letter_balances()` is deliberately untouched: it already sums lines by
-- direction and never reads a pair.

-- ---------------------------------------------------------------------------
-- 0) Precondition: no pairings exist to lose
-- ---------------------------------------------------------------------------
do $guard_aps_free_transfer_lines$
begin
  if exists (select 1 from public.letter_lines as line where line.paired_line_id is not null) then
    raise exception 'aps free transfer lines: paired lines exist; this migration defines no backfill for them';
  end if;
end
$guard_aps_free_transfer_lines$;

-- ---------------------------------------------------------------------------
-- 1) Columns: the note replaces the flag + reason; pairing is retired
-- ---------------------------------------------------------------------------
alter table public.letters add column if not exists reclassification_note text;

update public.letters as letter
   set reclassification_note = letter.reclassification_reason
 where letter.reclassification_reason is not null
   and letter.reclassification_note is null;

alter table public.letters drop constraint if exists letters_reclassification_check;
alter table public.letters drop column if exists reclassification_reason;
alter table public.letters drop column if exists has_reclassification;
alter table public.letters
  add constraint letters_reclassification_note_check check (
    reclassification_note is null
    or (
      letter_type = 'internal_transfer'
      and char_length(btrim(reclassification_note)) >= 1
    )
  );

comment on column public.letters.reclassification_note is
  'Internal transfers only: the optional free-text statement for the move (for example why stock changed classification). Replaces the retired has_reclassification flag and its mandatory reason; never required, never per-line.';

-- Dropping the column takes its foreign key, the self-pair CHECK and the
-- partial unique index with it; the index and CHECK are dropped explicitly
-- first so the intent is reviewable in the migration itself.
drop index if exists public.letter_lines_pair_unique;
alter table public.letter_lines drop constraint if exists letter_lines_no_self_pair;
alter table public.letter_lines drop column if exists paired_line_id;

-- ---------------------------------------------------------------------------
-- 2) The header guard: the frozen-column list names the note, and the note is
--    normalised like every other statement on the header (body otherwise
--    identical to 20261114000000)
-- ---------------------------------------------------------------------------
create or replace function public.aps_letters_before_write()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_party record;
  v_sister record;
  v_year record;
  v_typed text;
  v_expected_branch text;
  v_session public.aps_reconciliation_sessions%rowtype;
begin
  -- Apply the same whitespace normalization to RPC and direct writes so the
  -- length constraint cannot be satisfied with surrounding whitespace alone.
  if new.settlement_reason is not null then
    new.settlement_reason := public.aps_trim_settlement_reason(new.settlement_reason);
  end if;

  -- The transfer note is a statement, not a flag: blank is no note at all.
  if new.reclassification_note is not null then
    new.reclassification_note := nullif(btrim(new.reclassification_note), '');
  end if;

  -- Normalise first: the unique key must see the canonical value, and the raw
  -- text is only kept when the caller actually supplied something new.
  v_typed := new.letter_number;
  new.letter_number := public.aps_normalize_letter_number(new.letter_number);
  if tg_op = 'INSERT' or new.letter_number is distinct from old.letter_number then
    new.letter_number_raw := coalesce(nullif(btrim(coalesce(v_typed, '')), ''), new.letter_number);
  end if;
  new.letter_number_raw := coalesce(new.letter_number_raw, new.letter_number);

  if new.letter_number is null or new.letter_number = '' then
    raise exception 'aps letters: a letter number is required' using errcode = '23514';
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'aps letters: letters are created as drafts; use aps_approve_letter()'
        using errcode = '23514';
    end if;
    new.created_by := coalesce(new.created_by, auth.uid());
    if new.created_by is null then
      raise exception 'aps letters: created_by is required' using errcode = '23514';
    end if;
    new.approved_at := null;
    new.approved_by := null;
    new.cancelled_at := null;
    new.cancelled_by := null;
    new.cancel_reason := null;
  else
    if new.created_by is distinct from old.created_by then
      raise exception 'aps letters: the author of a letter cannot change'
        using errcode = '23514';
    end if;
    -- A settlement must not be converted into an ordinary draft to evade the
    -- settlement-specific approval capability or discard its audit context.
    if old.letter_type = 'settlement' and new.letter_type <> 'settlement' then
      raise exception 'aps letters: a settlement cannot change its letter type'
        using errcode = '23514';
    end if;

    -- A settled letter is frozen. The only permitted change is the one-way
    -- trip from `approved` to `cancelled`, and even that may not touch a
    -- single content column.
    if old.status in ('approved', 'cancelled') then
      if new.status is distinct from old.status
         and not (old.status = 'approved' and new.status = 'cancelled') then
        raise exception 'aps letters: % letters cannot change status to %', old.status, new.status
          using errcode = '23514';
      end if;
      if new.letter_number is distinct from old.letter_number
         or new.letter_number_raw is distinct from old.letter_number_raw
         or new.letter_date is distinct from old.letter_date
         or new.letter_type is distinct from old.letter_type
         or new.fiscal_year_id is distinct from old.fiscal_year_id
         or new.party_id is distinct from old.party_id
         or new.sister_company_id is distinct from old.sister_company_id
         or new.counterparty_code is distinct from old.counterparty_code
         or new.counterparty_name is distinct from old.counterparty_name
         or new.source_total is distinct from old.source_total
         or new.destination_total is distinct from old.destination_total
         or new.reclassification_note is distinct from old.reclassification_note
         or new.reconciliation_session_id is distinct from old.reconciliation_session_id
         or new.settlement_reason is distinct from old.settlement_reason
      then
        raise exception 'aps letters: a % letter is immutable', old.status
          using errcode = '23514';
      end if;
    end if;

    if new.status = 'approved' and old.status = 'draft' then
      if new.approved_at is null or new.approved_by is null then
        raise exception 'aps letters: approval must record the approver'
          using errcode = '23514';
      end if;
      -- aps_approve_letter() retains its normal author/settings-manager check
      -- and requires create for every letter. Settlement approval additionally
      -- needs the dedicated capability, even on any other write path.
      if new.letter_type = 'settlement'
         and (
           auth.uid() is null
           or not public.aps_can_create_letters()
           or not coalesce(public.has_permission('aps.letters:approve'), false)
         )
      then
        raise exception 'aps letters: settlement approval requires aps.letters:create and aps.letters:approve'
          using errcode = '42501';
      end if;
    end if;
  end if;

  -- Counterparty: exclusive per type, snapshotted, branch-matched.
  if new.letter_type in ('inbound', 'outbound') then
    if new.party_id is null or new.sister_company_id is not null then
      raise exception 'aps letters: a % letter needs exactly one party and no sister company',
        new.letter_type using errcode = '23514';
    end if;
    select party.branch, party.code, party.name
      into v_party
      from public.parties as party
     where party.id = new.party_id;
    if not found then
      raise exception 'aps letters: unknown party %', new.party_id using errcode = '23503';
    end if;
    v_expected_branch := case when new.letter_type = 'inbound' then 'inbound' else 'outbound' end;
    if v_party.branch <> v_expected_branch then
      raise exception 'aps letters: a % letter needs a % party, % is %',
        new.letter_type, v_expected_branch, v_party.code, v_party.branch
        using errcode = '23514';
    end if;
    new.counterparty_code := v_party.code;
    new.counterparty_name := v_party.name;
  elsif new.letter_type = 'external_transfer' then
    if new.sister_company_id is null or new.party_id is not null then
      raise exception 'aps letters: an external transfer needs exactly one sister company'
        using errcode = '23514';
    end if;
    select company.code, company.name
      into v_sister
      from public.sister_companies as company
     where company.id = new.sister_company_id;
    if not found then
      raise exception 'aps letters: unknown sister company %', new.sister_company_id
        using errcode = '23503';
    end if;
    new.counterparty_code := v_sister.code;
    new.counterparty_name := v_sister.name;
  elsif new.letter_type = 'settlement' then
    -- A caller with only letter-creation rights must not bypass the settlement
    -- RPC by inserting a settlement directly or converting another draft.
    -- Trusted maintenance without an authenticated actor remains unchanged.
    if auth.uid() is not null
       and (tg_op = 'INSERT' or old.letter_type is distinct from 'settlement')
       and not public.aps_can_manage_reconciliation()
    then
      raise exception 'aps letters: creating a settlement requires aps.reconciliation:manage'
        using errcode = '42501';
    end if;
    if new.party_id is not null or new.sister_company_id is not null then
      raise exception 'aps letters: a settlement has no counterparty' using errcode = '23514';
    end if;
    new.counterparty_code := null;
    new.counterparty_name := null;

    if new.reconciliation_session_id is null then
      raise exception 'aps letters: a settlement must belong to a reconciliation session'
        using errcode = '23514';
    end if;
    select * into v_session
      from public.aps_reconciliation_sessions as session
     where session.id = new.reconciliation_session_id;
    if not found then
      raise exception 'aps letters: unknown reconciliation session %',
        new.reconciliation_session_id using errcode = '23503';
    end if;
    if v_session.status <> 'open' then
      raise exception 'aps letters: reconciliation session is % and no longer accepts a settlement',
        v_session.status using errcode = '23514';
    end if;
    if v_session.fiscal_year_id <> new.fiscal_year_id then
      raise exception 'aps letters: the settlement must stay in the session fiscal year'
        using errcode = '23514';
    end if;
  else
    if new.party_id is not null or new.sister_company_id is not null then
      raise exception 'aps letters: an internal transfer has no counterparty'
        using errcode = '23514';
    end if;
    new.counterparty_code := null;
    new.counterparty_name := null;
  end if;

  if new.letter_type <> 'settlement' and new.reconciliation_session_id is not null then
    raise exception 'aps letters: only a settlement points at a reconciliation session'
      using errcode = '23514';
  end if;

  -- The accounting date must belong to the letter's own fiscal year; otherwise
  -- every monthly total silently lands in the wrong bucket.
  select year.start_date, year.end_date
    into v_year
    from public.fiscal_years as year
   where year.id = new.fiscal_year_id;
  if not found then
    raise exception 'aps letters: unknown fiscal year %', new.fiscal_year_id
      using errcode = '23503';
  end if;
  if new.letter_date < v_year.start_date or new.letter_date > v_year.end_date then
    raise exception 'aps letters: % is outside the fiscal year (% to %)',
      new.letter_date, v_year.start_date, v_year.end_date
      using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function public.aps_letters_before_write()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3) The line guard: the pair shape check goes away (body otherwise identical
--    to 20261119010000, party rules included)
-- ---------------------------------------------------------------------------
create or replace function public.aps_letter_lines_before_write()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_letter record;
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

  return new;
end;
$$;

revoke all on function public.aps_letter_lines_before_write()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4) The draft save: free lines, and a statement instead of a mandatory reason
-- ---------------------------------------------------------------------------
-- The parameter changes name with the column it writes
-- (`p_reclassification_reason` -> `p_reclassification_note`). CREATE OR
-- REPLACE cannot rename a parameter, so the old function is dropped first;
-- the rest of the signature — types, order, security invoker, grants — is
-- unchanged, and the body is 20261119010000 with the transfer path rewritten:
-- each element of `p_lines` is now one stored line carrying its own
-- `direction`, and the 250-pair cap becomes the plain 500-line cap every
-- other letter type already has.
drop function public.aps_save_letter_draft(uuid,timestamptz,uuid,text,text,uuid,uuid,text,text,jsonb,text,date);

create function public.aps_save_letter_draft(
  p_letter_id uuid,
  p_expected_updated_at timestamptz,
  p_fiscal_year_id uuid,
  p_letter_type text,
  p_letter_number text,
  p_party_id uuid,
  p_sister_company_id uuid,
  p_direction text,
  p_reclassification_note text,
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
  v_note text;
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
     or jsonb_array_length(p_lines) > 500 then
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
      -- The two sides are independent lists: every stored line names its own
      -- direction, and nothing here pairs it with another line. Whether the
      -- sides settle is a letter-level question, answered at approval by
      -- aps_assert_letter_consistent() — a half-typed transfer stays a
      -- saveable draft until then.
      if v_line->>'warehouse_id' is null or v_line->>'classification_id' is null
         or coalesce(v_line->>'direction', '') not in ('in', 'out') then
        raise exception 'aps entry: each transfer line needs a direction, a warehouse and a classification' using errcode = '22023';
      end if;
    elsif v_line->>'warehouse_id' is null or v_line->>'classification_id' is null then
      raise exception 'aps entry: each line needs a warehouse and classification' using errcode = '22023';
    elsif p_letter_type in ('inbound', 'outbound')
       and coalesce((v_line->>'party_id')::uuid, p_party_id) is null then
      raise exception 'aps entry: each line needs a party' using errcode = '22023';
    end if;
  end loop;

  -- The note is the transfer's optional statement on the header, never a
  -- per-line obligation. Off a transfer it means nothing and is stored null.
  v_note := case
    when p_letter_type = 'internal_transfer'
      then nullif(btrim(coalesce(p_reclassification_note, '')), '')
  end;

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
      party_id, sister_company_id, reclassification_note,
      issuer_reference
    ) values (
      p_letter_id, p_fiscal_year_id, p_letter_type, p_letter_number, v_letter_date,
      v_primary_party, p_sister_company_id, v_note,
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

    delete from public.letter_lines where letter_id = p_letter_id;
    update public.letters
       set fiscal_year_id = p_fiscal_year_id,
           letter_type = p_letter_type,
           letter_number = p_letter_number,
           letter_date = v_letter_date,
           party_id = v_primary_party,
           sister_company_id = p_sister_company_id,
           reclassification_note = v_note,
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
      values (p_letter_id, v_line->>'direction', (v_line->>'warehouse_id')::uuid,
              (v_line->>'classification_id')::uuid, v_amount);
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
-- 5) Approval consistency: the letter settles as a whole (body otherwise
--    identical to 20261119010000, party invariants included)
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
    return;
  end if;

  -- The whole letter settles, or it does not: one source may feed several
  -- destinations and several sources one destination, as long as the two
  -- independent sides add up to the same figure.
  if v_in_total <> v_out_total then
    raise exception 'aps letters: the transfer does not balance (% in vs % out)',
      v_in_total, v_out_total using errcode = '23514';
  end if;

  -- Nothing else is owed. The two sides are independent lists: lines are
  -- not paired, a destination need not name the source it settles, and
  -- movement between classifications demands no flag and no per-line reason
  -- — the header carries an optional statement (`reclassification_note`).
end;
$$;

revoke all on function public.aps_assert_letter_consistent(uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6) Verification: retired storage is gone, new bodies landed
-- ---------------------------------------------------------------------------
do $verify_aps_free_transfer_lines$
declare
  v_count integer;
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and (table_name, column_name) in (
         ('letter_lines', 'paired_line_id'),
         ('letters', 'has_reclassification'),
         ('letters', 'reclassification_reason')
       )
  ) then
    raise exception 'aps free transfer lines: a retired column survived';
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'letters'
       and column_name = 'reclassification_note'
  ) then
    raise exception 'aps free transfer lines: letters.reclassification_note is missing';
  end if;

  if to_regclass('public.letter_lines_pair_unique') is not null then
    raise exception 'aps free transfer lines: the pair unique index survived';
  end if;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.letters'::regclass
       and conname = 'letters_reclassification_note_check'
  ) then
    raise exception 'aps free transfer lines: the note check is missing';
  end if;

  if exists (
    select 1 from pg_proc as proc
     where proc.oid in (
       'public.aps_letters_before_write()'::regprocedure,
       'public.aps_letter_lines_before_write()'::regprocedure,
       'public.aps_save_letter_draft(uuid,timestamptz,uuid,text,text,uuid,uuid,text,text,jsonb,text,date)'::regprocedure,
       'public.aps_assert_letter_consistent(uuid)'::regprocedure
     )
       and (
         proc.prosrc like '%paired_line_id%'
         or proc.prosrc like '%reclassification_reason%'
         or proc.prosrc like '%has_reclassification%'
       )
  ) then
    raise exception 'aps free transfer lines: a live function body still reads retired storage';
  end if;

  if not exists (
    select 1 from pg_proc as proc
     where proc.oid = 'public.aps_save_letter_draft(uuid,timestamptz,uuid,text,text,uuid,uuid,text,text,jsonb,text,date)'::regprocedure
       and not proc.prosecdef
       and 'p_reclassification_note' = any (proc.proargnames)
       and proc.prosrc like '%v_note%'
  ) then
    raise exception 'aps free transfer lines: aps_save_letter_draft was not replaced as expected';
  end if;

  if not exists (
    select 1 from pg_proc as proc
     where proc.oid = 'public.aps_assert_letter_consistent(uuid)'::regprocedure
       and proc.prosecdef
       and proc.prosrc like '%does not balance%'
  ) then
    raise exception 'aps free transfer lines: aps_assert_letter_consistent was not replaced as expected';
  end if;

  select count(*) into v_count
    from pg_proc as proc
   where proc.oid in (
     'public.aps_letters_before_write()'::regprocedure,
     'public.aps_letter_lines_before_write()'::regprocedure
   )
     and proc.prosecdef;
  if v_count <> 2 then
    raise exception 'aps free transfer lines: expected 2 security definer guards, found %', v_count;
  end if;

  raise notice 'aps free transfer lines: pairing retired, note installed, four bodies replaced';
end
$verify_aps_free_transfer_lines$;

notify pgrst, 'reload schema';
