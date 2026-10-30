-- APS letter entry: narrow choice lists and atomic ordinary-draft saves.
-- No directory table grants or RLS policies are changed. The lookup discloses
-- only the identifying fields needed by an active aps.letters:create user;
-- the write function runs as the caller and remains subject to existing RLS,
-- triggers, foreign keys and approval rules. Apply before deploying the UI.

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
    'warehouses', coalesce((
      select jsonb_agg(jsonb_build_object('id', warehouse.id, 'name', warehouse.name, 'code', warehouse.code)
        order by warehouse.name, warehouse.code)
      from public.warehouses as warehouse
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
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.aps_letter_entry_options() from public, anon;
grant execute on function public.aps_letter_entry_options() to authenticated, service_role;
comment on function public.aps_letter_entry_options() is
  'Minimal live entry choices for active letter creators; does not grant access to underlying directory tables.';

-- One call = one transaction, including both sides of every internal pair.
-- p_letter_id is generated once by the client: retrying after an uncertain
-- response cannot create a second document. Existing drafts require the last
-- observed updated_at, so stale or uncertain saves never overwrite silently.
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
  p_lines jsonb
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
      party_id, sister_company_id, has_reclassification, reclassification_reason
    ) values (
      p_letter_id, p_fiscal_year_id, p_letter_type, p_letter_number, p_letter_date,
      p_party_id, p_sister_company_id, v_has_reclassification, v_reason
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
           reclassification_reason = v_reason
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

revoke all on function public.aps_save_letter_draft(uuid,timestamptz,uuid,text,text,date,uuid,uuid,text,text,jsonb) from public, anon;
grant execute on function public.aps_save_letter_draft(uuid,timestamptz,uuid,text,text,date,uuid,uuid,text,text,jsonb) to authenticated, service_role;
comment on function public.aps_save_letter_draft(uuid,timestamptz,uuid,text,text,date,uuid,uuid,text,text,jsonb) is
  'Atomically create or replace an owned ordinary draft under RLS, with optimistic concurrency. Approval remains aps_approve_letter().';
