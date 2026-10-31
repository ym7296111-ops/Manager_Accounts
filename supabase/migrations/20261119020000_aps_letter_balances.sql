-- APS party tree, phase 3: physical balances for the entry screen.
--
-- The tree shows a balance badge on every (warehouse, classification) row. The
-- figure must be the warehouse's physical balance — opening balance plus every
-- approved movement since the fiscal year began — which is exactly the
-- arithmetic `aps_reconciliation_book_amounts()` already performs per station.
-- `aps_letter_balances()` restates it per warehouse, because the entry screen
-- writes warehouses, not stations.
--
-- It is a SECURITY DEFINER reader for the same reason the entry options are:
-- `opening_balances` is not readable by the letter-entry role, and the badge
-- must never widen that. The capability gate is the letter-creation one — the
-- only people who see this screen. Amounts return as text so money never
-- crosses the wire as a float.
--
-- The second half gives the negative-balance warning a permanent home: the
-- entry screen warns but never blocks, and `aps_approve_letter()` records any
-- (warehouse, classification) this letter pushes below zero in its audit row.
-- The approve body is otherwise byte-identical to phase 2.

create or replace function public.aps_letter_balances(
  p_fiscal_year_id uuid,
  p_as_of_date date default current_date,
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
begin
  if auth.uid() is null or not public.aps_can_create_letters() then
    raise exception 'aps_letter_balances: aps.letters:create is required' using errcode = '42501';
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
      join public.warehouses as warehouse on warehouse.id = line.warehouse_id
      cross join year_bounds as bounds
     where letter.status = 'approved'
       and letter.letter_date >= bounds.start_date
       and letter.letter_date <= coalesce(p_as_of_date, current_date)
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
  'Physical balance per (warehouse, classification): opening balance plus approved movement from the fiscal year start to the given date. Powers the entry-screen balance badges.';

-- ---------------------------------------------------------------------------
-- Approval audit records the pairs this letter pushes below zero
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
      -- A negative physical balance warns on the entry screen but never blocks
      -- the save; approval is where the warning becomes part of the record.
      -- The figure is opening + approved movement up to this letter's date
      -- (this letter excluded, then its own net added) — the same arithmetic
      -- the reconciliation book amounts and aps_letter_balances() report.
      'negative_balance_pairs', (
        select coalesce(
          jsonb_agg(
            jsonb_build_object(
              'warehouse_code', warehouse.code,
              'classification_code', classification.code,
              'balance_after', pair.balance_after
            )
            order by warehouse.code, classification.code
          ),
          '[]'::jsonb
        )
          from (
            select line.warehouse_id, line.classification_id,
                   coalesce((
                     select sum(opening.amount)
                       from public.opening_balances as opening
                      where opening.fiscal_year_id = v_letter.fiscal_year_id
                        and opening.warehouse_id = line.warehouse_id
                        and opening.classification_id = line.classification_id
                   ), 0)
                   + coalesce((
                     select sum(case when other.direction = 'in' then other.amount else -other.amount end)
                       from public.letter_lines as other
                       join public.letters as other_letter on other_letter.id = other.letter_id
                      where other_letter.status = 'approved'
                        and other_letter.id <> p_letter_id
                        and other_letter.letter_date >= v_year.start_date
                        and other_letter.letter_date <= v_letter.letter_date
                        and other.warehouse_id = line.warehouse_id
                        and other.classification_id = line.classification_id
                   ), 0)
                   + sum(case when line.direction = 'in' then line.amount else -line.amount end) as balance_after
              from public.letter_lines as line
             where line.letter_id = p_letter_id
             group by line.warehouse_id, line.classification_id
          ) as pair
          join public.warehouses as warehouse on warehouse.id = pair.warehouse_id
          join public.classifications as classification on classification.id = pair.classification_id
         where pair.balance_after < 0
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

do $verify_aps_letter_balances$
begin
  if not exists (
    select 1 from pg_proc as proc
     where proc.oid = 'public.aps_letter_balances(uuid,date,uuid[])'::regprocedure
       and proc.prosecdef
  ) then
    raise exception 'aps letter balances: function missing or not security definer';
  end if;
  if not exists (
    select 1 from pg_proc as proc
     where proc.oid = 'public.aps_approve_letter(uuid)'::regprocedure
       and proc.prosrc like '%negative_balance_pairs%'
  ) then
    raise exception 'aps letter balances: aps_approve_letter was not replaced';
  end if;
  raise notice 'aps letter balances: reader installed, approval audit extended';
end
$verify_aps_letter_balances$;

notify pgrst, 'reload schema';
