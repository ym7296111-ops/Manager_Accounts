-- Financial-year and opening-balance foundations (database only).
-- Fiscal years are created explicitly by project settings; balances stay empty
-- until an authorized user adds them. Carry-forward, supplements and close-out
-- workflows are deliberately deferred.

-- Opening-balance edits use the existing audit trail's typed action column.
alter type public.audit_action
  add value if not exists 'opening_balance.updated';

-- ---------------------------------------------------------------------------
-- 1) Fiscal years
-- ---------------------------------------------------------------------------
create table public.fiscal_years (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  start_date date not null,
  end_date date not null,
  is_active boolean not null default false,
  is_closed boolean not null default false,
  supplements_open boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fiscal_years_valid_date_range check (start_date < end_date)
);

-- Keep the derived label in sync on every write, even when a client supplies a
-- different name. For example, 2026-07-01 through 2027-06-30 becomes 2026-2027.
create or replace function public.fiscal_years_before_write()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_excluded_id uuid;
begin
  new.name := extract(year from new.start_date)::integer::text
              || '-'
              || extract(year from new.end_date)::integer::text;
  v_excluded_id := case when tg_op = 'UPDATE' then old.id else new.id end;

  -- This BEFORE trigger runs before the partial unique index is checked, so a
  -- new active year can replace the previous one without a transient conflict.
  -- The nested updates enter this trigger with is_active=false and do not recurse.
  if new.is_active then
    update public.fiscal_years
       set is_active = false
     where is_active
       and id is distinct from v_excluded_id;
  end if;

  return new;
end;
$$;

revoke all on function public.fiscal_years_before_write()
  from public, anon, authenticated, service_role;

drop trigger if exists fiscal_years_before_write on public.fiscal_years;
create trigger fiscal_years_before_write
  before insert or update on public.fiscal_years
  for each row execute function public.fiscal_years_before_write();

-- The trigger switches the old year off; this index is the final invariant,
-- including for concurrent transactions or writes that bypass that trigger.
create unique index fiscal_years_one_active_idx
  on public.fiscal_years (is_active)
  where is_active;

create trigger fiscal_years_set_updated_at
  before update on public.fiscal_years
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 2) Fiscal months
-- ---------------------------------------------------------------------------
create table public.fiscal_months (
  id uuid primary key default gen_random_uuid(),
  fiscal_year_id uuid not null
    references public.fiscal_years (id) on delete cascade,
  month_number integer not null,
  name text not null,
  start_date date not null,
  end_date date not null,
  current_period integer not null default 1,
  is_closed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fiscal_months_year_month_key unique (fiscal_year_id, month_number),
  constraint fiscal_months_number_between_1_and_12 check (month_number between 1 and 12),
  constraint fiscal_months_current_period_positive check (current_period >= 1),
  constraint fiscal_months_valid_date_range check (start_date <= end_date)
);

create trigger fiscal_months_set_updated_at
  before update on public.fiscal_months
  for each row execute function public.set_updated_at();

-- Generate a full sequence of twelve fiscal months from the year's start date.
-- The fiscal year's end date caps ordinary month ends; the twelfth month reaches
-- the configured year end. This also keeps every generated period within the
-- fiscal-year bounds if a future short or extended fiscal year is configured.
create or replace function public.generate_fiscal_months()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_month_number integer;
  v_month_start date;
  v_month_end date;
  v_month_names constant text[] := array[
    'يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو',
    'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'
  ];
begin
  for v_month_number in 1..12 loop
    v_month_start := least(
      (new.start_date + ((v_month_number - 1) * interval '1 month'))::date,
      new.end_date
    );

    if v_month_number = 12 then
      v_month_end := new.end_date;
    else
      v_month_end := least(
        (new.start_date + (v_month_number * interval '1 month') - interval '1 day')::date,
        new.end_date
      );
      v_month_end := greatest(v_month_start, v_month_end);
    end if;

    insert into public.fiscal_months (
      fiscal_year_id,
      month_number,
      name,
      start_date,
      end_date
    )
    values (
      new.id,
      v_month_number,
      v_month_names[extract(month from v_month_start)::integer]
        || ' '
        || extract(year from v_month_start)::integer::text,
      v_month_start,
      v_month_end
    );
  end loop;

  return new;
end;
$$;

revoke all on function public.generate_fiscal_months()
  from public, anon, authenticated, service_role;

drop trigger if exists fiscal_years_generate_months on public.fiscal_years;
create trigger fiscal_years_generate_months
  after insert on public.fiscal_years
  for each row execute function public.generate_fiscal_months();

-- ---------------------------------------------------------------------------
-- 3) Opening balances
-- ---------------------------------------------------------------------------
create table public.opening_balances (
  id uuid primary key default gen_random_uuid(),
  fiscal_year_id uuid not null
    references public.fiscal_years (id) on delete restrict,
  warehouse_id uuid not null
    references public.warehouses (id) on delete restrict,
  classification_id uuid not null
    references public.classifications (id) on delete restrict,
  amount numeric(18,2) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint opening_balances_year_warehouse_classification_key
    unique (fiscal_year_id, warehouse_id, classification_id),
  constraint opening_balances_amount_non_negative check (amount >= 0)
);

create trigger opening_balances_set_updated_at
  before update on public.opening_balances
  for each row execute function public.set_updated_at();

-- Audit writes must be atomic with the balance change. SECURITY DEFINER is
-- required because API roles intentionally have no direct INSERT grant on
-- audit_logs; actor identity still comes from the caller's JWT via auth.uid().
create or replace function public.audit_opening_balance_write()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_old_amount numeric(18,2);
begin
  if tg_op = 'UPDATE' then
    v_old_amount := old.amount;
  else
    v_old_amount := null;
  end if;

  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
  values (
    auth.uid(),
    'opening_balance.updated'::public.audit_action,
    'opening_balances',
    new.id::text,
    jsonb_build_object(
      'fiscal_year_id', new.fiscal_year_id,
      'warehouse_id', new.warehouse_id,
      'classification_id', new.classification_id,
      'old_amount', v_old_amount,
      'new_amount', new.amount
    )
  );

  return new;
end;
$$;

revoke all on function public.audit_opening_balance_write()
  from public, anon, authenticated, service_role;

create trigger opening_balances_audit_write
  after insert or update on public.opening_balances
  for each row execute function public.audit_opening_balance_write();

-- ---------------------------------------------------------------------------
-- 4) RLS and explicit API grants
-- ---------------------------------------------------------------------------
alter table public.fiscal_years enable row level security;
alter table public.fiscal_years force row level security;
alter table public.fiscal_months enable row level security;
alter table public.fiscal_months force row level security;
alter table public.opening_balances enable row level security;
alter table public.opening_balances force row level security;

grant select, insert, update, delete on public.fiscal_years to authenticated;
grant select, insert, update, delete on public.fiscal_months to authenticated;
grant select, insert, update, delete on public.opening_balances to authenticated;

drop policy if exists fiscal_years_project_settings_select on public.fiscal_years;
create policy fiscal_years_project_settings_select
  on public.fiscal_years
  for select
  to authenticated
  using (public.can_manage_project_settings());

drop policy if exists fiscal_years_project_settings_insert on public.fiscal_years;
create policy fiscal_years_project_settings_insert
  on public.fiscal_years
  for insert
  to authenticated
  with check (public.can_manage_project_settings());

drop policy if exists fiscal_years_project_settings_update on public.fiscal_years;
create policy fiscal_years_project_settings_update
  on public.fiscal_years
  for update
  to authenticated
  using (public.can_manage_project_settings())
  with check (public.can_manage_project_settings());

drop policy if exists fiscal_years_project_settings_delete on public.fiscal_years;
create policy fiscal_years_project_settings_delete
  on public.fiscal_years
  for delete
  to authenticated
  using (public.can_manage_project_settings());

drop policy if exists fiscal_months_project_settings_select on public.fiscal_months;
create policy fiscal_months_project_settings_select
  on public.fiscal_months
  for select
  to authenticated
  using (public.can_manage_project_settings());

drop policy if exists fiscal_months_project_settings_insert on public.fiscal_months;
create policy fiscal_months_project_settings_insert
  on public.fiscal_months
  for insert
  to authenticated
  with check (public.can_manage_project_settings());

drop policy if exists fiscal_months_project_settings_update on public.fiscal_months;
create policy fiscal_months_project_settings_update
  on public.fiscal_months
  for update
  to authenticated
  using (public.can_manage_project_settings())
  with check (public.can_manage_project_settings());

drop policy if exists fiscal_months_project_settings_delete on public.fiscal_months;
create policy fiscal_months_project_settings_delete
  on public.fiscal_months
  for delete
  to authenticated
  using (public.can_manage_project_settings());

drop policy if exists opening_balances_project_settings_select on public.opening_balances;
create policy opening_balances_project_settings_select
  on public.opening_balances
  for select
  to authenticated
  using (public.can_manage_project_settings());

drop policy if exists opening_balances_project_settings_insert on public.opening_balances;
create policy opening_balances_project_settings_insert
  on public.opening_balances
  for insert
  to authenticated
  with check (public.can_manage_project_settings());

drop policy if exists opening_balances_project_settings_update on public.opening_balances;
create policy opening_balances_project_settings_update
  on public.opening_balances
  for update
  to authenticated
  using (public.can_manage_project_settings())
  with check (public.can_manage_project_settings());

drop policy if exists opening_balances_project_settings_delete on public.opening_balances;
create policy opening_balances_project_settings_delete
  on public.opening_balances
  for delete
  to authenticated
  using (public.can_manage_project_settings());

-- ---------------------------------------------------------------------------
-- 5) Migration preconditions
-- ---------------------------------------------------------------------------
do $verify_fiscal_years_and_balances$
begin
  if not exists (
    select 1 from public.permissions where slug = 'project.settings:manage'
  ) then
    raise exception 'Project settings permission is missing';
  end if;

  if to_regprocedure('public.can_manage_project_settings()') is null then
    raise exception 'can_manage_project_settings() is missing';
  end if;

  if to_regprocedure('public.set_updated_at()') is null then
    raise exception 'set_updated_at() is missing';
  end if;
end
$verify_fiscal_years_and_balances$;

notify pgrst, 'reload schema';
