-- APS reconciliation: explicit workflow identity and empty-session guard.
-- All pre-existing rows are conservatively classified as legacy. New screen
-- sessions are tagged explicitly; close/reopen never infer the flow from items.
-- Defense-in-depth: even if flow_type is tampered with, a session that has
-- legacy items must not be closed/reopened by the screen RPCs. Therefore both
-- flow_type = 'screen' AND NOT EXISTS (legacy items) are required below.
--
-- TODO(security): service_role retains direct write privileges on
-- aps_reconciliation_*; handle their reduction in a separate PR.

alter table public.aps_reconciliation_sessions
  add column if not exists flow_type text not null default 'legacy';

-- Conservative backfill, including sessions created directly during phase 1.
update public.aps_reconciliation_sessions
   set flow_type = 'legacy'
 where flow_type is distinct from 'legacy';

alter table public.aps_reconciliation_sessions
  alter column flow_type set default 'legacy',
  alter column flow_type set not null;

alter table public.aps_reconciliation_sessions
  drop constraint if exists aps_reconciliation_sessions_flow_type_check;
alter table public.aps_reconciliation_sessions
  add constraint aps_reconciliation_sessions_flow_type_check
  check (flow_type in ('legacy', 'screen'));

comment on column public.aps_reconciliation_sessions.flow_type is
  'Workflow identity: legacy dual-comparison or the new reconciliation screen. Defaults to legacy for safe direct inserts.';

create or replace function public.aps_open_reconciliation(
  p_month_id uuid,
  p_station_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_month record;
  v_session_id uuid;
  v_sequence integer;
  v_previous uuid;
  v_line_count integer;
begin
  if v_actor is null or not public.aps_can_manage_reconciliation() then
    raise exception 'aps_open_reconciliation: aps.reconciliation:manage is required'
      using errcode = '42501';
  end if;

  select month.fiscal_year_id, month.end_date
    into v_month
    from public.fiscal_months as month
   where month.id = p_month_id;
  if not found then
    raise exception 'aps_open_reconciliation: unknown fiscal month %', p_month_id
      using errcode = 'P0002';
  end if;

  if not exists (select 1 from public.stations as station where station.id = p_station_id) then
    raise exception 'aps_open_reconciliation: unknown station %', p_station_id
      using errcode = 'P0002';
  end if;

  if exists (
    select 1
      from public.aps_reconciliation_sessions as session
     where session.fiscal_month_id = p_month_id
       and session.station_id = p_station_id
       and session.status = 'open'
  ) then
    raise exception 'aps_open_reconciliation: an open session already exists for this month and station'
      using errcode = '22023';
  end if;

  select coalesce(max(session.sequence_number), 0) + 1,
         (
           select prior.id
             from public.aps_reconciliation_sessions as prior
            where prior.fiscal_month_id = p_month_id
              and prior.station_id = p_station_id
              and prior.status = 'approved'
            order by prior.sequence_number desc
            limit 1
         )
    into v_sequence, v_previous
    from public.aps_reconciliation_sessions as session
   where session.fiscal_month_id = p_month_id
     and session.station_id = p_station_id;

  insert into public.aps_reconciliation_sessions
    (fiscal_year_id, fiscal_month_id, station_id, sequence_number,
     supersedes_session_id, status, opened_by, created_by, flow_type)
  values
    (v_month.fiscal_year_id, p_month_id, p_station_id, v_sequence,
     v_previous, 'open', v_actor, v_actor, 'screen')
  returning id into v_session_id;

  -- Classifications are global; the station scopes their warehouses and all
  -- book movements. Only active leaves receive lines in a new screen session.
  insert into public.aps_reconciliation_lines
    (session_id, classification_id, book_amount)
  select v_session_id,
         leaf.id,
         coalesce(
           amounts.book_opening + amounts.book_move_in - amounts.book_move_out,
           0
         )::numeric(18, 2)
    from public.classifications as leaf
    left join public.aps_reconciliation_book_amounts(
      v_month.fiscal_year_id, p_month_id, p_station_id
    ) as amounts on amounts.classification_id = leaf.id
   where leaf.is_leaf
     and leaf.is_active;

  get diagnostics v_line_count = row_count;
  if v_line_count = 0 then
    raise exception 'aps_open_reconciliation: no active leaf classifications exist'
      using errcode = '22023';
  end if;

  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
  values (
    v_actor,
    'aps.reconciliation_opened'::public.audit_action,
    'aps_reconciliation_sessions',
    v_session_id::text,
    jsonb_build_object(
      'fiscal_month_id', p_month_id,
      'station_id', p_station_id,
      'line_count', v_line_count,
      'source', 'reconciliation_screen'
    )
  );

  return v_session_id;
end;
$$;

revoke all on function public.aps_open_reconciliation(uuid, uuid)
  from public, anon;
grant execute on function public.aps_open_reconciliation(uuid, uuid)
  to authenticated, service_role;

create or replace function public.aps_close_reconciliation_month(
  p_month_id uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_reason text := btrim(coalesce(p_reason, ''));
  v_open_count integer;
  v_closed_count integer;
begin
  if v_actor is null
     or not coalesce(public.is_active_user(), false)
     or not coalesce(public.has_permission('aps.reconciliation:close_month'), false) then
    raise exception 'aps_close_reconciliation_month: aps.reconciliation:close_month is required'
      using errcode = '42501';
  end if;
  if char_length(v_reason) < 3 or char_length(v_reason) > 500 then
    raise exception 'aps_close_reconciliation_month: a reason between 3 and 500 characters is required'
      using errcode = '22023';
  end if;

  perform session.id
    from public.aps_reconciliation_sessions as session
   where session.fiscal_month_id = p_month_id
     and session.status = 'open'
     and session.flow_type = 'screen'
     and not exists (
       select 1 from public.aps_reconciliation_items as it
        where it.session_id = session.id
     )
   for update;
  get diagnostics v_open_count = row_count;
  if v_open_count = 0 then
    raise exception 'aps_close_reconciliation_month: no open sessions exist for month %', p_month_id
      using errcode = 'P0002';
  end if;

  if exists (
    select 1
      from public.aps_reconciliation_lines as line
      join public.aps_reconciliation_sessions as session on session.id = line.session_id
     where session.fiscal_month_id = p_month_id
       and session.status = 'open'
       and session.flow_type = 'screen'
     and not exists (
       select 1 from public.aps_reconciliation_items as it
        where it.session_id = session.id
     )
       and line.difference <> 0
  ) then
    raise exception 'aps_close_reconciliation_month: all differences must be zero'
      using errcode = '22023';
  end if;

  with closed as (
    update public.aps_reconciliation_sessions as session
       set status = 'closed',
           closed_at = now(),
           closed_by = v_actor,
           close_reason = v_reason
     where fiscal_month_id = p_month_id
       and status = 'open'
       and session.flow_type = 'screen'
     and not exists (
       select 1 from public.aps_reconciliation_items as it
        where it.session_id = session.id
     )
    returning id, station_id
  )
  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
  select v_actor,
         'aps.reconciliation_closed'::public.audit_action,
         'aps_reconciliation_sessions',
         closed.id::text,
         jsonb_build_object(
           'fiscal_month_id', p_month_id,
           'station_id', closed.station_id,
           'reason', v_reason
         )
    from closed;
  get diagnostics v_closed_count = row_count;

  if v_closed_count <> v_open_count then
    raise exception 'aps_close_reconciliation_month: session state changed concurrently'
      using errcode = '40001';
  end if;
end;
$$;

revoke all on function public.aps_close_reconciliation_month(uuid, text)
  from public, anon;
grant execute on function public.aps_close_reconciliation_month(uuid, text)
  to authenticated, service_role;

create or replace function public.aps_reopen_reconciliation_month(
  p_month_id uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_reason text := btrim(coalesce(p_reason, ''));
  v_closed_count integer;
begin
  if v_actor is null
     or not coalesce(public.is_active_user(), false)
     or not exists (
       select 1
         from public.user_roles as user_role
         join public.roles as role on role.id = user_role.role_id
        where user_role.user_id = v_actor
          and role.slug = 'owner'
     ) then
    raise exception 'aps_reopen_reconciliation_month: the owner role is required'
      using errcode = '42501';
  end if;
  if char_length(v_reason) < 3 or char_length(v_reason) > 500 then
    raise exception 'aps_reopen_reconciliation_month: a reason between 3 and 500 characters is required'
      using errcode = '22023';
  end if;

  if exists (
    select 1 from public.aps_reconciliation_sessions as session
     where session.fiscal_month_id = p_month_id and session.status = 'open'
  ) then
    raise exception 'aps_reopen_reconciliation_month: the month already has an open session'
      using errcode = '22023';
  end if;

  perform session.id
    from public.aps_reconciliation_sessions as session
   where session.fiscal_month_id = p_month_id
     and session.status = 'closed'
     and session.flow_type = 'screen'
     and not exists (
       select 1 from public.aps_reconciliation_items as it
        where it.session_id = session.id
     )
   for update;
  get diagnostics v_closed_count = row_count;
  if v_closed_count = 0 then
    raise exception 'aps_reopen_reconciliation_month: no closed sessions exist for month %', p_month_id
      using errcode = 'P0002';
  end if;

  with reopened as (
    update public.aps_reconciliation_sessions as session
       set status = 'open',
           closed_at = null,
           closed_by = null,
           close_reason = null
     where fiscal_month_id = p_month_id
       and status = 'closed'
       and session.flow_type = 'screen'
     and not exists (
       select 1 from public.aps_reconciliation_items as it
        where it.session_id = session.id
     )
    returning id, station_id
  )
  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
  select v_actor,
         'aps.reconciliation_reopened'::public.audit_action,
         'aps_reconciliation_sessions',
         reopened.id::text,
         jsonb_build_object(
           'fiscal_month_id', p_month_id,
           'station_id', reopened.station_id,
           'reason', v_reason
         )
    from reopened;
end;
$$;

revoke all on function public.aps_reopen_reconciliation_month(uuid, text)
  from public, anon;
grant execute on function public.aps_reopen_reconciliation_month(uuid, text)
  to authenticated, service_role;


notify pgrst, 'reload schema';
