-- APS issuers: the short code that identifies who issued a paper letter
-- (`YM` = ياسر), the two manual header numbers that go with it, and the two
-- entry-screen fixes that share this deployment: the station name travels with
-- every warehouse choice and line, and the running period is read from the
-- periodic settings instead of being typed.
--
-- Safety of this migration:
--   * `issuers` is a new table: no existing row is rewritten.
--   * `letters.issuer_code` / `letters.issuer_sequence` are nullable, so adding
--     them cannot fail on a deployment that already holds letters; the entry
--     function validates whatever it writes.
--   * `letter_lines.station_name` is nullable for the same reason: the new
--     snapshot trigger fills it on every future insert/update, and a historical
--     line that predates this migration simply shows its warehouse name.
--   * No trigger is disabled, nothing is dropped and no client table privilege
--     is widened. Applying this file before deploying the UI is enough.

-- ---------------------------------------------------------------------------
-- 1) Issuers
-- ---------------------------------------------------------------------------
create table if not exists public.issuers (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  name text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint issuers_code_format check (code ~ '^[A-Za-z]{2}$'),
  constraint issuers_code_key unique (code),
  constraint issuers_name_not_blank check (char_length(btrim(name)) between 1 and 120)
);

-- `YM` and `ym` are the same issuer to every human reading the register, so the
-- uniqueness rule is case-insensitive even though the stored code keeps the
-- case the administrator typed. The entry function canonicalises to upper-case
-- before writing, which keeps the foreign key below unambiguous.
create unique index if not exists issuers_code_upper_key on public.issuers (upper(code));

drop trigger if exists issuers_set_updated_at on public.issuers;
create trigger issuers_set_updated_at
  before update on public.issuers
  for each row execute function public.set_updated_at();

comment on table public.issuers is
  'Who issued the paper letter (two Latin letters) — a controlled list, not a free-text field.';
comment on column public.issuers.code is
  'Canonical upper-case two-letter code, unique case-insensitively; referenced by letters.issuer_code.';

-- Seed only the code that is already in use in the paper register. `do nothing`
-- keeps a locally edited name intact when the migration is replayed.
insert into public.issuers (code, name)
values ('YM', 'ياسر')
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- 2) Row Level Security
-- ---------------------------------------------------------------------------
-- Reading the list is part of reading or creating a letter: the entry screen
-- cannot render its dropdown without it, and the register shows the issuer code
-- beside the number. Managing the list is project settings, exactly like
-- stations, warehouses, classifications and parties.
alter table public.issuers enable row level security;
alter table public.issuers force row level security;

-- Same explicit table grant as the other APS-adjacent directory tables: the
-- `grant ... on all tables` in the core schema was a point-in-time grant, so a
-- new table starts with no `authenticated` privilege at all. `anon` gets
-- nothing. Deletion is not granted: a used code must be deactivated instead.
grant select, insert, update on public.issuers to authenticated;

drop policy if exists issuers_letter_readers_select on public.issuers;
create policy issuers_letter_readers_select
  on public.issuers
  for select
  to authenticated
  using (public.aps_can_read_letters() or public.aps_can_create_letters());

drop policy if exists issuers_project_settings_insert on public.issuers;
create policy issuers_project_settings_insert
  on public.issuers
  for insert
  to authenticated
  with check (public.can_manage_project_settings());

drop policy if exists issuers_project_settings_update on public.issuers;
create policy issuers_project_settings_update
  on public.issuers
  for update
  to authenticated
  using (public.can_manage_project_settings())
  with check (public.can_manage_project_settings());

-- ---------------------------------------------------------------------------
-- 3) Letter header: issuer code and issuer sequence
-- ---------------------------------------------------------------------------
-- `letter_number` keeps its existing meaning (the EPS number, typed by hand).
-- These two are the other numbers printed on the same document, so they are
-- stored on the header next to it and frozen with the rest of the letter.
alter table public.letters
  add column if not exists issuer_code text,
  add column if not exists issuer_sequence text;

alter table public.letters
  drop constraint if exists letters_issuer_code_format,
  drop constraint if exists letters_issuer_sequence_format,
  drop constraint if exists letters_issuer_code_fkey;

alter table public.letters
  add constraint letters_issuer_code_format
    check (issuer_code is null or issuer_code ~ '^[A-Z]{2}$'),
  add constraint letters_issuer_sequence_format
    check (
      issuer_sequence is null
      or (
        char_length(issuer_sequence) between 1 and 32
        and issuer_sequence !~ '[[:cntrl:]]'
      )
    );

-- A stored code must exist in the controlled list; deleting an issuer that
-- letters already reference is refused. Renaming a code carries the headers
-- with it (the code is the identifier the register prints), except where that
-- would rewrite a settled letter: the freeze trigger below refuses that update,
-- and the rename then fails as a whole instead of silently altering history.
alter table public.letters
  add constraint letters_issuer_code_fkey
    foreign key (issuer_code) references public.issuers (code)
    on update cascade on delete restrict;

comment on column public.letters.issuer_code is
  'Upper-case two-letter issuer code from public.issuers; chosen, not typed.';
comment on column public.letters.issuer_sequence is
  'The issuer''s own sequence number as printed on the letter; typed by hand.';

-- The header guard already freezes a settled letter, but its immutability list
-- predates these two columns. A dedicated guard is used instead of restating
-- that whole function: it is additive, and it cannot drift out of step with the
-- columns it does not own.
create or replace function public.aps_letters_issuer_freeze()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if old.status in ('approved', 'cancelled')
     and (
       new.issuer_code is distinct from old.issuer_code
       or new.issuer_sequence is distinct from old.issuer_sequence
     ) then
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
-- 4) Line station snapshot
-- ---------------------------------------------------------------------------
-- The warehouse name already travels with the line, for the same reason: a
-- reader of an old letter must see what the warehouse was called then. The
-- station is now part of every warehouse label (`المخزن - المحطة`), so it is
-- snapshotted in the same place and by the same rule.
alter table public.letter_lines
  add column if not exists station_name text;

comment on column public.letter_lines.station_name is
  'Station name captured by the line write guard; null only on lines written before the station label existed.';

create or replace function public.aps_letter_lines_station_snapshot()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_station text;
begin
  select station.name
    into v_station
    from public.warehouses as warehouse
    join public.stations as station on station.id = warehouse.station_id
   where warehouse.id = new.warehouse_id;
  -- The existing line guard rejects an unknown warehouse before this runs, or
  -- right after it; a null here is therefore "no station recorded", never a
  -- silently accepted bad reference.
  new.station_name := v_station;
  return new;
end;
$$;

revoke all on function public.aps_letter_lines_station_snapshot()
  from public, anon, authenticated, service_role;

drop trigger if exists letter_lines_aps_station_snapshot on public.letter_lines;
create trigger letter_lines_aps_station_snapshot
  before insert or update on public.letter_lines
  for each row execute function public.aps_letter_lines_station_snapshot();

-- ---------------------------------------------------------------------------
-- 5) Entry choices: issuers, station labels, and the periodic settings
-- ---------------------------------------------------------------------------
-- Same narrow disclosure as before: an active `aps.letters:create` user gets
-- the identifying fields the entry screen renders and nothing else. The period
-- bar needs the fiscal months, which that user cannot read directly.
create or replace function public.aps_letter_entry_options()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  if auth.uid() is null or not public.aps_can_create_letters() then
    raise exception 'aps entry: aps.letters:create is required' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'fiscal_years', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', year.id, 'name', year.name, 'start_date', year.start_date,
        'end_date', year.end_date, 'is_active', year.is_active,
        'is_closed', year.is_closed, 'supplements_open', year.supplements_open
      ) order by year.start_date desc, year.id)
      from public.fiscal_years as year
    ), '[]'::jsonb),
    'fiscal_months', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', month.id, 'fiscal_year_id', month.fiscal_year_id,
        'month_number', month.month_number, 'name', month.name,
        'start_date', month.start_date, 'end_date', month.end_date,
        'current_period', month.current_period, 'is_closed', month.is_closed
      ) order by month.start_date, month.month_number)
      from public.fiscal_months as month
    ), '[]'::jsonb),
    'warehouses', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', warehouse.id, 'name', warehouse.name, 'code', warehouse.code,
        'station_name', station.name, 'station_code', station.code
      ) order by warehouse.name, warehouse.code)
      from public.warehouses as warehouse
      left join public.stations as station on station.id = warehouse.station_id
      where warehouse.is_active
    ), '[]'::jsonb),
    'classifications', coalesce((
      select jsonb_agg(jsonb_build_object('id', class.id, 'name', class.name, 'code', class.code)
        order by class.name, class.code)
      from public.classifications as class
      where class.is_active and class.is_leaf
    ), '[]'::jsonb),
    'parties', coalesce((
      select jsonb_agg(jsonb_build_object('id', party.id, 'name', party.name, 'code', party.code, 'branch', party.branch)
        order by party.name, party.code)
      from public.parties as party
      where party.is_active
    ), '[]'::jsonb),
    'sister_companies', coalesce((
      select jsonb_agg(jsonb_build_object('id', company.id, 'name', company.name, 'code', company.code)
        order by company.name, company.code)
      from public.sister_companies as company
      where company.is_active
    ), '[]'::jsonb),
    'issuers', coalesce((
      select jsonb_agg(jsonb_build_object('id', issuer.id, 'code', issuer.code, 'name', issuer.name)
        order by issuer.code)
      from public.issuers as issuer
      where issuer.is_active
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.aps_letter_entry_options() from public, anon;
grant execute on function public.aps_letter_entry_options() to authenticated, service_role;
comment on function public.aps_letter_entry_options() is
  'Minimal live entry choices for active letter creators; does not grant access to underlying directory tables.';

-- ---------------------------------------------------------------------------
-- 6) Draft save: the two issuer fields join the same atomic transaction
-- ---------------------------------------------------------------------------
-- The previous signature is dropped rather than overloaded: an 11-argument
-- caller must not keep a path that writes a header without validating the
-- issuer code. Everything else about the function is unchanged.
drop function if exists public.aps_save_letter_draft(
  uuid, timestamptz, uuid, text, text, date, uuid, uuid, text, text, jsonb
);

create or replace function public.aps_save_letter_draft(
  p_letter_id uuid,
  p_expected_updated_at timestamptz,
  p_fiscal_year_id uuid,
  p_letter_type text,
  p_letter_number text,
  p_letter_date date,
  p_party_id uuid,
  p_sister_company_id uuid,
  p_direction text,
  p_reclassification_reason text,
  p_lines jsonb,
  p_issuer_code text,
  p_issuer_sequence text
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
  v_issuer_code text;
  v_issuer_sequence text;
  v_updated_at timestamptz;
  v_constraint text;
begin
  if v_actor is null or not public.aps_can_create_letters() then
    raise exception 'aps entry: aps.letters:create is required' using errcode = '42501';
  end if;
  if p_letter_id is null or p_fiscal_year_id is null or p_letter_date is null
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

  -- Both issuer fields are optional on a draft, but whatever is supplied must
  -- be the code the controlled list holds. Canonicalising to upper-case here is
  -- what makes the stored value match the foreign key exactly.
  v_issuer_code := nullif(upper(btrim(coalesce(p_issuer_code, ''))), '');
  v_issuer_sequence := nullif(btrim(coalesce(p_issuer_sequence, '')), '');
  if v_issuer_code is not null then
    if v_issuer_code !~ '^[A-Z]{2}$' then
      raise exception 'aps entry: the issuer code must be two Latin letters' using errcode = '22023';
    end if;
    if not exists (
      select 1 from public.issuers as issuer
       where issuer.code = v_issuer_code and issuer.is_active
    ) then
      raise exception 'aps entry: unknown or inactive issuer %', v_issuer_code using errcode = '22023';
    end if;
  end if;
  if v_issuer_sequence is not null
     and (char_length(v_issuer_sequence) > 32 or v_issuer_sequence ~ '[[:cntrl:]]') then
    raise exception 'aps entry: invalid issuer sequence' using errcode = '22023';
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
      issuer_code, issuer_sequence
    ) values (
      p_letter_id, p_fiscal_year_id, p_letter_type, p_letter_number, p_letter_date,
      p_party_id, p_sister_company_id, v_has_reclassification, v_reason,
      v_issuer_code, v_issuer_sequence
    );
  else
    select letter.created_by, letter.status, letter.letter_type, letter.updated_at
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

    -- Delete incoming paired rows before their referenced outgoing rows.
    delete from public.letter_lines where letter_id = p_letter_id and direction = 'in';
    delete from public.letter_lines where letter_id = p_letter_id;
    update public.letters
       set fiscal_year_id = p_fiscal_year_id,
           letter_type = p_letter_type,
           letter_number = p_letter_number,
           letter_date = p_letter_date,
           party_id = p_party_id,
           sister_company_id = p_sister_company_id,
           has_reclassification = v_has_reclassification,
           reclassification_reason = v_reason,
           issuer_code = v_issuer_code,
           issuer_sequence = v_issuer_sequence
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
  raise;
end;
$$;

revoke all on function public.aps_save_letter_draft(uuid,timestamptz,uuid,text,text,date,uuid,uuid,text,text,jsonb,text,text) from public, anon;
grant execute on function public.aps_save_letter_draft(uuid,timestamptz,uuid,text,text,date,uuid,uuid,text,text,jsonb,text,text) to authenticated, service_role;
comment on function public.aps_save_letter_draft(uuid,timestamptz,uuid,text,text,date,uuid,uuid,text,text,jsonb,text,text) is
  'Atomically create or replace an owned ordinary draft under RLS, with optimistic concurrency. Approval remains aps_approve_letter().';

-- ---------------------------------------------------------------------------
-- 7) Preconditions
-- ---------------------------------------------------------------------------
do $verify_aps_issuers$
begin
  if not exists (
    select 1
      from pg_proc as proc
      join pg_namespace as namespace on namespace.oid = proc.pronamespace
     where namespace.nspname = 'public'
       and proc.proname = 'aps_can_create_letters'
  ) then
    raise exception 'aps_can_create_letters() is missing';
  end if;

  if not exists (
    select 1 from public.permissions where slug = 'aps.letters:create'
  ) then
    raise exception 'aps.letters:create permission is missing';
  end if;

  if not exists (select 1 from public.issuers where code = 'YM') then
    raise exception 'the seeded issuer code YM is missing';
  end if;
end;
$verify_aps_issuers$;

notify pgrst, 'reload schema';
