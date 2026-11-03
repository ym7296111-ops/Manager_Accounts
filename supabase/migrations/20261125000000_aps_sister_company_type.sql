-- A.6: sister-company type (sister / non_sister) for the merged tab.
--
-- Adds `company_type` to `sister_companies` so the "Sister & Non-Sister
-- Companies" tab can render one unified list and distinguish the two kinds
-- visually. The default is `sister` so every existing row keeps its meaning
-- without a data migration, and a CHECK restricts the vocabulary to exactly
-- the two allowed values.
--
-- A change of `company_type` is audited to `audit_logs` with action
-- `sister_company.type_changed`, so the history of which companies were
-- reclassified is preserved.

alter table public.sister_companies
  add column if not exists company_type text not null default 'sister';

alter table public.sister_companies
  add constraint sister_companies_company_type_check
  check (company_type in ('sister', 'non_sister'));

-- Audit a type change so it is visible in the register and in reports.
create or replace function public.audit_sister_company_type_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.company_type is distinct from old.company_type then
    insert into public.audit_logs(
      actor_id, action, entity, entity_id, metadata
    ) values (
      auth.uid(),
      'sister_company.type_changed',
      'sister_companies',
      new.id::text,
      jsonb_build_object(
        'name', new.name,
        'code', new.code,
        'from', old.company_type,
        'to', new.company_type
      )
    );
  end if;
  return new;
end;
$$;

drop trigger if exists audit_sister_company_type_change on public.sister_companies;
create trigger audit_sister_company_type_change
  before update on public.sister_companies
  for each row
  when (old.company_type is distinct from new.company_type)
  execute function public.audit_sister_company_type_change();

revoke all on function public.audit_sister_company_type_change()
  from public, anon, authenticated, service_role;

comment on column public.sister_companies.company_type is
  'sister (intercompany) or non_sister (external); defaults to sister on create.';

-- Carry the type into the entry options payload so the entry screen can
-- render an icon next to each sister company in the external-transfer list.
create or replace function public.aps_letter_entry_options()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_today date;
begin
  if auth.uid() is null or not public.aps_can_create_letters() then
    raise exception 'aps entry: aps.letters:create is required' using errcode = '42501';
  end if;

  v_today := public.aps_project_today();

  return jsonb_build_object(
    'active_period', public.aps_active_period(),
    'fiscal_years', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', year.id, 'name', year.name, 'start_date', year.start_date,
        'end_date', year.end_date, 'is_closed', year.is_closed, 'supplements_open', year.supplements_open,
        'active', year.is_active
      ) order by year.start_date desc, year.id)
      from public.fiscal_years as year
    ), '[]'::jsonb),
    'fiscal_months', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', month.id, 'fiscal_year_id', month.fiscal_year_id, 'month_number', month.month_number,
        'name', month.name, 'start_date', month.start_date, 'end_date', month.end_date,
        'current_period', month.current_period, 'is_closed', month.is_closed,
        'contains_today', v_today between month.start_date and month.end_date
      ) order by month.start_date, month.month_number)
      from public.fiscal_months as month
    ), '[]'::jsonb),
    'warehouses', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', warehouse.id, 'name', warehouse.name, 'code', warehouse.code,
        'station_name', station.name, 'station_code', station.code
      ) order by station.name, warehouse.name)
      from public.warehouses as warehouse
      left join public.stations as station on station.id = warehouse.station_id
    ), '[]'::jsonb),
    'classifications', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', classification.id, 'name', classification.name, 'code', classification.code
      ) order by classification.code)
      from public.classifications as classification
    ), '[]'::jsonb),
    'parties', coalesce((
      select jsonb_agg(jsonb_build_object('id', party.id, 'name', party.name, 'code', party.code, 'branch', party.branch)
        order by party.name, party.code)
      from public.parties as party
      where party.is_active
    ), '[]'::jsonb),
    'sister_companies', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', company.id, 'name', company.name, 'code', company.code,
        'company_type', company.company_type
      ) order by company.name, company.code)
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
  'Everything the entry screen needs in one payload: the active posting period, the calendar with a contains_today suggestion, warehouse/classification/party/issuer list, and sister companies with their type.';

-- ---------------------------------------------------------------------------
-- Verification
-- ---------------------------------------------------------------------------
do $verify_sister_company_type$
declare
  v_type text;
  v_constraint_count integer;
begin
  select pg_typeof(company_type) into v_type
    from public.sister_companies
   limit 1;

  if v_type <> 'text' then
    raise exception 'sister_companies.company_type is not text';
  end if;

  select count(*) into v_constraint_count
    from pg_constraint
   where conname = 'sister_companies_company_type_check'
     and conrelid = 'public.sister_companies'::regclass;

  if v_constraint_count = 0 then
    raise exception 'sister_companies_company_type_check is missing';
  end if;

  if to_regprocedure('public.audit_sister_company_type_change()') is null then
    raise exception 'audit_sister_company_type_change() is missing';
  end if;
end
$verify_sister_company_type$;
