-- A.6: balance badge cutoff defaults to the end of the active month.
--
-- `aps_letter_balances()` previously defaulted its `p_as_of_date` cutoff to
-- the start of the active posting month (`month.start_date`), which meant a
-- letter dated mid-month was not yet reflected in the balance badge. The
-- badge now defaults to the end of the active month (`month.end_date`) so
-- the balance shown on the entry screen matches what the letter will post
-- into. An explicit `p_as_of_date` still overrides the default for reports
-- that need a specific cutoff.

create or replace function public.aps_letter_balances(
  p_fiscal_year_id uuid,
  p_as_of_date date default null,
  p_warehouse_ids uuid[] default null
)
returns table (
  warehouse_id uuid,
  classification_id uuid,
  balance text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_as_of date;
begin
  if auth.uid() is null or not public.aps_can_create_letters() then
    raise exception 'aps_letter_balances: aps.letters:create is required' using errcode = '42501';
  end if;

  -- No cutoff asked for: default to the end of the active posting month so
  -- the balance badge reflects everything that can be posted into it.
  -- No period open: report nothing rather than pick a date the project
  -- never chose.
  v_as_of := coalesce(
    p_as_of_date,
    (select month.end_date from public.fiscal_months as month where month.is_active limit 1)
  );
  if v_as_of is null then
    return;
  end if;

  return query
  with year_bounds as (
    select year.start_date
      from public.fiscal_years as year
     where year.id = p_fiscal_year_id
  ),
  opening as (
    select opening.warehouse_id, opening.classification_id, sum(opening.amount) as amount
      from public.opening_balances as opening
     where opening.fiscal_year_id = p_fiscal_year_id
       and (p_warehouse_ids is null or opening.warehouse_id = any (p_warehouse_ids))
     group by opening.warehouse_id, opening.classification_id
  ),
  movement as (
    select line.warehouse_id, line.classification_id,
           coalesce(
             sum(case when line.direction = 'in' then line.amount else -line.amount end),
             0
           ) as amount
      from public.letter_lines as line
      join public.letters as letter on letter.id = line.letter_id
      cross join year_bounds as bounds
     where letter.status = 'approved'
       and letter.letter_date >= bounds.start_date
       and letter.letter_date <= v_as_of
       and (p_warehouse_ids is null or line.warehouse_id = any (p_warehouse_ids))
     group by line.warehouse_id, line.classification_id
  )
  select coalesce(opening.warehouse_id, movement.warehouse_id),
         coalesce(opening.classification_id, movement.classification_id),
         (coalesce(opening.amount, 0) + coalesce(movement.amount, 0))::numeric(18, 2)::text
    from opening
    full join movement
      on movement.warehouse_id = opening.warehouse_id
     and movement.classification_id = opening.classification_id;
end;
$$;

revoke all on function public.aps_letter_balances(uuid, date, uuid[]) from public, anon;
grant execute on function public.aps_letter_balances(uuid, date, uuid[]) to authenticated, service_role;
comment on function public.aps_letter_balances(uuid, date, uuid[]) is
  'Physical balance per (warehouse, classification): opening balance plus approved movement from the fiscal year start to the given date, defaulting to the end of the active posting month. Returns no rows when no date is asked for and no period is open. Powers the entry-screen balance badges.';
