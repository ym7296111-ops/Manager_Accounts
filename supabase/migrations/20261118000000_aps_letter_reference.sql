-- APS letter header, step 2: one manual letter code instead of two fields, and
-- a letter date the database records itself.
--
-- The entry screen used to ask for the issuer code (`YM`, chosen from a list),
-- the issuer's own sequence number (`63`, typed by hand) and the letter date.
-- All three are the same document detail, so the two number fields become one
-- `issuer_reference` (`YM:63`) whose format the database enforces, and the
-- date stops being a question: a draft is dated the day it is written.
--
-- Safety of this migration:
--   * `issuer_reference` is added before anything is dropped, so a deployment
--     that already holds letters keeps its data: the two old columns are
--     concatenated into the new one first.
--   * A row whose stored pair cannot form `XX:NN` is left with a null
--     reference. Nothing is guessed and no number is invented.
--   * `letter_date` keeps its NOT NULL contract; it simply gains a default, and
--     every existing row keeps the date it already had.
--   * The columns are dropped last, after the freeze trigger and the draft
--     function no longer mention them.
--   * One function is replaced (the draft save) and one trigger function is
--     replaced (the issuer freeze); no table, policy or grant is widened, and
--     approval/cancellation/reconciliation are untouched.

-- ---------------------------------------------------------------------------
-- 1) One letter code per header
-- ---------------------------------------------------------------------------
alter table public.letters
  add column if not exists issuer_reference text;

comment on column public.letters.issuer_reference is
  'Manual letter code printed on the paper document, `XX:NN` (two Latin letters, a colon, digits); chosen and typed by the entry clerk.';

-- Backfill from the pair that the previous screen wrote. The regex is the same
-- one the CHECK below installs, so nothing that cannot satisfy it is copied.
update public.letters
   set issuer_reference = upper(issuer_code) || ':' || issuer_sequence
 where issuer_reference is null
   and issuer_code is not null
   and issuer_sequence is not null
   and (upper(issuer_code) || ':' || issuer_sequence) ~ '^[A-Z]{2}:[0-9]+$';

alter table public.letters
  drop constraint if exists letters_issuer_reference_format,
  add constraint letters_issuer_reference_format
    check (issuer_reference is null or issuer_reference ~ '^[A-Z]{2}:[0-9]+$');

-- One issuance series per fiscal year, exactly like `letters_year_number_key`:
-- the same code may appear again in a later year, never twice in one. Nulls do
-- not collide, so an unfinished draft without a code is still storable.
alter table public.letters
  drop constraint if exists letters_year_issuer_reference_key,
  add constraint letters_year_issuer_reference_key
    unique (fiscal_year_id, issuer_reference);

-- The unique key covers `(fiscal_year_id, issuer_reference)`; this index serves
-- the direct lookup by code alone (register search, duplicate diagnosis).
create index if not exists letters_issuer_reference_idx
  on public.letters (issuer_reference)
  where issuer_reference is not null;

-- The old pair is now redundant. The freeze trigger and the draft function are
-- rewritten below *before* this runs, so no live code still reads these names.
alter table public.letters
  drop constraint if exists letters_issuer_code_fkey,
  drop constraint if exists letters_issuer_code_format,
  drop constraint if exists letters_issuer_sequence_format,
  drop column if exists issuer_code,
  drop column if exists issuer_sequence;

-- ---------------------------------------------------------------------------
-- 2) The date is recorded, not asked for
-- ---------------------------------------------------------------------------
-- `letter_date` stays the accounting date and the filter axis; the entry screen
-- no longer supplies it, so the column defaults to the day the draft is saved.
-- The fiscal-year window check in `aps_letters_before_write` still applies.
alter table public.letters
  alter column letter_date set default current_date;

comment on column public.letters.letter_date is
  'The accounting date. Defaults to the day the draft is saved; the entry screen does not ask for it. Always inside the fiscal year (checked by aps_letters_before_write).';

-- ---------------------------------------------------------------------------
-- 3) Settled letters keep their code
-- ---------------------------------------------------------------------------
create or replace function public.aps_letters_issuer_freeze()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if old.status in ('approved', 'cancelled')
     and new.issuer_reference is distinct from old.issuer_reference then
    raise exception 'aps letters: the issuer of a % letter is immutable', old.status
      using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function public.aps_letters_issuer_freeze()
  from public, anon, authenticated, service_role;

drop trigger if exists letters_aps_issuer_freeze on public.letters;
create trigger letters_aps_issuer_freeze
  before update on public.letters
  for each row execute function public.aps_letters_issuer_freeze();

-- ---------------------------------------------------------------------------
-- 4) Draft save: one validated letter code, and the date recorded by the server
-- ---------------------------------------------------------------------------
-- The previous signature is dropped rather than overloaded: a caller must not
-- keep a path that writes a header with the retired columns. `p_letter_date`
-- moves to the end with a default, so the entry screen can omit it and the
-- database records today; a caller that needs an explicit accounting date (the
-- audit fixtures, a future back-office import) can still pass one.
drop function if exists public.aps_save_letter_draft(
  uuid, timestamptz, uuid, text, text, date, uuid, uuid, text, text, jsonb, text, text
);

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
    end if;
  end loop;

  v_reason := nullif(btrim(coalesce(p_reclassification_reason, '')), '');
  if v_has_reclassification and (v_reason is null or char_length(v_reason) < 3) then
    raise exception 'aps entry: reclassification requires a reason' using errcode = '22023';
  end if;
  if not v_has_reclassification then v_reason := null; end if;

  if p_expected_updated_at is null then
    insert into public.letters (
      id, fiscal_year_id, letter_type, letter_number, letter_date,
      party_id, sister_company_id, has_reclassification, reclassification_reason,
      issuer_reference
    ) values (
      p_letter_id, p_fiscal_year_id, p_letter_type, p_letter_number, v_letter_date,
      p_party_id, p_sister_company_id, v_has_reclassification, v_reason,
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
           party_id = p_party_id,
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
      insert into public.letter_lines (letter_id, direction, warehouse_id, classification_id, amount)
      values (p_letter_id, v_direction, (v_line->>'warehouse_id')::uuid,
              (v_line->>'classification_id')::uuid, v_amount);
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
-- 5) Preconditions
-- ---------------------------------------------------------------------------
do $verify_aps_letter_reference$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'letters'
       and column_name in ('issuer_code', 'issuer_sequence')
  ) then
    raise exception 'the retired issuer_code / issuer_sequence columns still exist';
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'letters'
       and column_name = 'issuer_reference'
  ) then
    raise exception 'letters.issuer_reference is missing';
  end if;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.letters'::regclass
       and conname = 'letters_year_issuer_reference_key'
  ) then
    raise exception 'the per-year letter code key is missing';
  end if;

  if not exists (
    select 1 from pg_proc
     where oid = 'public.aps_save_letter_draft(uuid,timestamptz,uuid,text,text,uuid,uuid,text,text,jsonb,text,date)'::regprocedure
  ) then
    raise exception 'aps_save_letter_draft() was not replaced';
  end if;
end;
$verify_aps_letter_reference$;

notify pgrst, 'reload schema';
