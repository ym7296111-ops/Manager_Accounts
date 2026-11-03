-- APS reconciliation phase 1: month close / reopen.
--
-- Adds two month-level capabilities on top of the reconciliation sessions and
-- items introduced by 20261114000000_aps_reconciliation.sql:
--
--   * aps.reconciliation:close_month — locks a fiscal month (is_closed = true)
--     after every approved session for that month has zero differences.
--   * aps.reconciliation:reopen_month — unlocks a closed month (owner only).
--
-- Both actions are audited with new audit_action enum values.
--
-- Phase 1 scope: database and permissions only. No UI, no client-side
-- changes, no new tables.

-- ---------------------------------------------------------------------------
-- 1) Permissions
-- ---------------------------------------------------------------------------
insert into public.permissions (slug, module, name_ar, name_en, description)
values
  (
    'aps.reconciliation:close_month',
    'aps',
    'قفل شهر المطابقة',
    'Close reconciliation month',
    'قفل شهر مالي بعد التأكد من أن كل الفروق في كل جلسات المطابقة المعتمدة لهذا الشهر صفر'
  )
on conflict (slug) do nothing;

insert into public.permissions (slug, module, name_ar, name_en, description)
values
  (
    'aps.reconciliation:reopen_month',
    'aps',
    'إعادة فتح شهر المطابقة',
    'Reopen reconciliation month',
    'إعادة فتح شهر مغلق بعد تصحيح خطأ (المالك فقط)'
  )
on conflict (slug) do nothing;

-- close_month: owner (granted automatically by the permissions insert trigger)
-- and super_admin explicitly.
insert into public.role_permissions (role_id, permission_id)
select role.id, permission.id
  from public.roles as role
 cross join public.permissions as permission
 where role.slug = 'super_admin'
   and permission.slug = 'aps.reconciliation:close_month'
on conflict (role_id, permission_id) do nothing;

-- reopen_month: owner only (granted automatically by the trigger). No explicit
-- grant here — the owner role already receives every new catalog permission.

-- ---------------------------------------------------------------------------
-- 2) Audit vocabulary
-- ---------------------------------------------------------------------------
alter type public.audit_action
  add value if not exists 'aps.reconciliation_closed';
alter type public.audit_action
  add value if not exists 'aps.reconciliation_reopened';

-- ---------------------------------------------------------------------------
-- 3) Capability guard functions
-- ---------------------------------------------------------------------------
create or replace function public.aps_can_close_reconciliation_month()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce(public.is_active_user(), false)
     and coalesce(public.has_permission('aps.reconciliation:close_month'), false);
$$;

revoke all on function public.aps_can_close_reconciliation_month() from public, anon;
grant execute on function public.aps_can_close_reconciliation_month() to authenticated, service_role;

create or replace function public.aps_can_reopen_reconciliation_month()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce(public.is_active_user(), false)
     and coalesce(public.has_permission('aps.reconciliation:reopen_month'), false);
$$;

revoke all on function public.aps_can_reopen_reconciliation_month() from public, anon;
grant execute on function public.aps_can_reopen_reconciliation_month() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4) RPC: close a reconciliation month
-- ---------------------------------------------------------------------------
-- Preconditions:
--   * caller holds aps.reconciliation:close_month
--   * the month exists and is not already closed
--   * every session for the month is approved or cancelled (none open)
--   * every item in every approved session has a non-null accountant figure
--     and both differences equal zero
--   * a written reason (3–500 chars) is supplied
-- Effect:
--   * sets fiscal_months.is_closed = true
--   * writes an audit_logs row with action aps.reconciliation_closed
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
  v_month public.fiscal_months%rowtype;
  v_reason text;
  v_open_sessions integer;
  v_items_with_difference integer;
  v_items_without_accountant integer;
begin
  if v_actor is null or not public.aps_can_close_reconciliation_month() then
    raise exception 'aps_close_reconciliation_month: aps.reconciliation:close_month is required'
      using errcode = '42501';
  end if;

  v_reason := btrim(coalesce(p_reason, ''));
  if char_length(v_reason) < 3 or char_length(v_reason) > 500 then
    raise exception 'aps_close_reconciliation_month: a written reason between 3 and 500 characters is required'
      using errcode = '22023';
  end if;

  select * into v_month
    from public.fiscal_months as month
   where month.id = p_month_id;
  if not found then
    raise exception 'aps_close_reconciliation_month: unknown fiscal month %', p_month_id
      using errcode = 'P0002';
  end if;
  if v_month.is_closed then
    raise exception 'aps_close_reconciliation_month: fiscal month % is already closed', p_month_id
      using errcode = '22023';
  end if;

  -- No open session may remain for this month.
  select count(*)::integer into v_open_sessions
    from public.aps_reconciliation_sessions as session
   where session.fiscal_month_id = p_month_id
     and session.status = 'open';
  if v_open_sessions > 0 then
    raise exception 'aps_close_reconciliation_month: % session(s) are still open for this month; approve or cancel them first',
      v_open_sessions using errcode = '22023';
  end if;

  -- Every item in every approved session must have zero differences.
  select count(*)::integer into v_items_with_difference
    from public.aps_reconciliation_items as item
    join public.aps_reconciliation_sessions as session on session.id = item.session_id
   where session.fiscal_month_id = p_month_id
     and session.status = 'approved'
     and (
           item.movement_difference is not null and item.movement_difference <> 0
           or item.closing_difference is not null and item.closing_difference <> 0
         );
  if v_items_with_difference > 0 then
    raise exception 'aps_close_reconciliation_month: % item(s) still have a non-zero difference',
      v_items_with_difference using errcode = '22023';
  end if;

  -- Every item in every approved session must have accountant figures.
  select count(*)::integer into v_items_without_accountant
    from public.aps_reconciliation_items as item
    join public.aps_reconciliation_sessions as session on session.id = item.session_id
   where session.fiscal_month_id = p_month_id
     and session.status = 'approved'
     and (item.accountant_move is null or item.accountant_closing is null);
  if v_items_without_accountant > 0 then
    raise exception 'aps_close_reconciliation_month: % item(s) have no accountant figures',
      v_items_without_accountant using errcode = '22023';
  end if;

  update public.fiscal_months
     set is_closed = true,
         updated_at = now()
   where id = p_month_id;

  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
  values (
    v_actor,
    'aps.reconciliation_closed'::public.audit_action,
    'fiscal_months',
    p_month_id::text,
    jsonb_build_object(
      'fiscal_month_id', p_month_id,
      'month_name', v_month.name,
      'fiscal_year_id', v_month.fiscal_year_id,
      'reason', v_reason
    )
  );
end;
$$;

revoke all on function public.aps_close_reconciliation_month(uuid, text) from public, anon;
grant execute on function public.aps_close_reconciliation_month(uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5) RPC: reopen a reconciliation month (owner only)
-- ---------------------------------------------------------------------------
-- Preconditions:
--   * caller holds aps.reconciliation:reopen_month (owner role)
--   * the month exists and is currently closed
--   * a written reason (3–500 chars) is supplied
-- Effect:
--   * sets fiscal_months.is_closed = false
--   * writes an audit_logs row with action aps.reconciliation_reopened
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
  v_month public.fiscal_months%rowtype;
  v_reason text;
begin
  if v_actor is null or not public.aps_can_reopen_reconciliation_month() then
    raise exception 'aps_reopen_reconciliation_month: aps.reconciliation:reopen_month is required'
      using errcode = '42501';
  end if;

  v_reason := btrim(coalesce(p_reason, ''));
  if char_length(v_reason) < 3 or char_length(v_reason) > 500 then
    raise exception 'aps_reopen_reconciliation_month: a written reason between 3 and 500 characters is required'
      using errcode = '22023';
  end if;

  select * into v_month
    from public.fiscal_months as month
   where month.id = p_month_id;
  if not found then
    raise exception 'aps_reopen_reconciliation_month: unknown fiscal month %', p_month_id
      using errcode = 'P0002';
  end if;
  if not v_month.is_closed then
    raise exception 'aps_reopen_reconciliation_month: fiscal month % is not closed', p_month_id
      using errcode = '22023';
  end if;

  update public.fiscal_months
     set is_closed = false,
         updated_at = now()
   where id = p_month_id;

  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
  values (
    v_actor,
    'aps.reconciliation_reopened'::public.audit_action,
    'fiscal_months',
    p_month_id::text,
    jsonb_build_object(
      'fiscal_month_id', p_month_id,
      'month_name', v_month.name,
      'fiscal_year_id', v_month.fiscal_year_id,
      'reason', v_reason
    )
  );
end;
$$;

revoke all on function public.aps_reopen_reconciliation_month(uuid, text) from public, anon;
grant execute on function public.aps_reopen_reconciliation_month(uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6) Preconditions
-- ---------------------------------------------------------------------------
do $verify_aps_close_reopen_month$
declare
  v_close_perm integer;
  v_reopen_perm integer;
  v_close_grants integer;
  v_reopen_grants integer;
  v_closed_action integer;
  v_reopened_action integer;
  v_close_fn regprocedure;
  v_reopen_fn regprocedure;
  v_close_guard regprocedure;
  v_reopen_guard regprocedure;
begin
  select count(*) into v_close_perm
    from public.permissions
   where slug = 'aps.reconciliation:close_month' and module = 'aps';
  if v_close_perm <> 1 then
    raise exception 'aps.reconciliation:close_month is missing';
  end if;

  select count(*) into v_reopen_perm
    from public.permissions
   where slug = 'aps.reconciliation:reopen_month' and module = 'aps';
  if v_reopen_perm <> 1 then
    raise exception 'aps.reconciliation:reopen_month is missing';
  end if;

  select count(*) into v_close_grants
    from public.role_permissions as grant_row
    join public.roles as role on role.id = grant_row.role_id
    join public.permissions as permission on permission.id = grant_row.permission_id
   where role.slug in ('owner', 'super_admin')
     and permission.slug = 'aps.reconciliation:close_month';
  if v_close_grants < 2 then
    raise exception 'owner and super_admin must hold aps.reconciliation:close_month';
  end if;

  select count(*) into v_reopen_grants
    from public.role_permissions as grant_row
    join public.roles as role on role.id = grant_row.role_id
    join public.permissions as permission on permission.id = grant_row.permission_id
   where role.slug = 'owner'
     and permission.slug = 'aps.reconciliation:reopen_month';
  if v_reopen_grants <> 1 then
    raise exception 'owner must hold aps.reconciliation:reopen_month';
  end if;

  select count(*) into v_closed_action
    from pg_catalog.pg_enum as enum
    join pg_catalog.pg_type as type on type.oid = enum.enumtypid
   where type.typname = 'audit_action'
     and enumlabel = 'aps.reconciliation_closed';
  if v_closed_action <> 1 then
    raise exception 'audit_action is missing aps.reconciliation_closed';
  end if;

  select count(*) into v_reopened_action
    from pg_catalog.pg_enum as enum
    join pg_catalog.pg_type as type on type.oid = enum.enumtypid
   where type.typname = 'audit_action'
     and enumlabel = 'aps.reconciliation_reopened';
  if v_reopened_action <> 1 then
    raise exception 'audit_action is missing aps.reconciliation_reopened';
  end if;

  select 'public.aps_close_reconciliation_month(uuid, text)'::regprocedure into v_close_fn;
  select 'public.aps_reopen_reconciliation_month(uuid, text)'::regprocedure into v_reopen_fn;
  select 'public.aps_can_close_reconciliation_month()'::regprocedure into v_close_guard;
  select 'public.aps_can_reopen_reconciliation_month()'::regprocedure into v_reopen_guard;

  if v_close_fn is null or v_reopen_fn is null or v_close_guard is null or v_reopen_guard is null then
    raise exception 'the close/reopen functions or guards are incomplete';
  end if;

  if not exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'fiscal_months'
       and column_name = 'is_closed'
  ) then
    raise exception 'fiscal_months.is_closed is missing';
  end if;
end
$verify_aps_close_reopen_month$;

notify pgrst, 'reload schema';