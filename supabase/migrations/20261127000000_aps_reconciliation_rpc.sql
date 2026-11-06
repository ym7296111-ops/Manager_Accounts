-- APS reconciliation screen, phase 2: permissions and RPCs only.
-- No UI is changed. Book amounts reuse the approved-letter/opening-balance
-- calculation from 20261114000000 through the end of the selected month.

-- ---------------------------------------------------------------------------
-- 1) Permissions
-- ---------------------------------------------------------------------------
insert into public.permissions
  (slug, module, name_ar, name_en, description, is_delegatable)
values
  (
    'aps.reconciliation:manage',
    'aps',
    'إدارة المطابقات',
    'Manage reconciliations',
    'إنشاء جلسات المطابقة وإدخال أرقام المحاسب',
    false
  ),
  (
    'aps.reconciliation:close_month',
    'aps',
    'إغلاق شهر المطابقة',
    'Close reconciliation month',
    'إغلاق جلسات شهر المطابقة بعد التحقق من انعدام الفروق',
    true
  ),
  (
    'aps.reconciliation:reopen_month',
    'aps',
    'إعادة فتح شهر المطابقة',
    'Reopen reconciliation month',
    'إعادة فتح شهر المطابقة؛ تنفيذ العملية مقيد بدور المالك وحده',
    false
  )
on conflict (slug) do update
  set module = excluded.module,
      name_ar = excluded.name_ar,
      name_en = excluded.name_en,
      description = excluded.description,
      is_delegatable = excluded.is_delegatable;

insert into public.role_permissions (role_id, permission_id)
select role.id, permission.id
  from public.roles as role
 cross join public.permissions as permission
 where role.slug in ('owner', 'super_admin')
   and permission.slug in (
     'aps.reconciliation:manage', 'aps.reconciliation:close_month'
   )
on conflict (role_id, permission_id) do nothing;

insert into public.role_permissions (role_id, permission_id)
select role.id, permission.id
  from public.roles as role
 cross join public.permissions as permission
 where role.slug = 'owner'
   and permission.slug = 'aps.reconciliation:reopen_month'
on conflict (role_id, permission_id) do nothing;

alter type public.audit_action
  add value if not exists 'aps.reconciliation_closed';
alter type public.audit_action
  add value if not exists 'aps.reconciliation_reopened';

-- ---------------------------------------------------------------------------
-- 2) Preserve the legacy opening RPC, then expose the new screen contract
-- ---------------------------------------------------------------------------
alter function public.aps_open_reconciliation(uuid, uuid)
  rename to aps_open_legacy_reconciliation;

create function public.aps_open_reconciliation(
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
     supersedes_session_id, status, opened_by, created_by)
  values
    (v_month.fiscal_year_id, p_month_id, p_station_id, v_sequence,
     v_previous, 'open', v_actor, v_actor)
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

-- ---------------------------------------------------------------------------
-- 3) Record an accountant amount
-- ---------------------------------------------------------------------------
create function public.aps_record_reconciliation(
  p_session_id uuid,
  p_classification_id uuid,
  p_accountant_amount numeric
)
returns table (
  id uuid,
  accountant_amount numeric,
  book_amount numeric,
  difference numeric
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_status text;
  v_line public.aps_reconciliation_lines;
begin
  if v_actor is null or not public.aps_can_manage_reconciliation() then
    raise exception 'aps_record_reconciliation: aps.reconciliation:manage is required'
      using errcode = '42501';
  end if;
  if p_accountant_amount is null
     or p_accountant_amount < 0
     or p_accountant_amount in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) then
    raise exception 'aps_record_reconciliation: accountant amount must be a non-negative number'
      using errcode = '22023';
  end if;

  select session.status into v_status
    from public.aps_reconciliation_sessions as session
   where session.id = p_session_id
   for update;
  if not found then
    raise exception 'aps_record_reconciliation: unknown session %', p_session_id
      using errcode = 'P0002';
  end if;
  if v_status <> 'open' then
    raise exception 'aps_record_reconciliation: a % session does not accept entries', v_status
      using errcode = '22023';
  end if;

  update public.aps_reconciliation_lines
     set accountant_amount = p_accountant_amount::numeric(18, 2)
   where session_id = p_session_id
     and classification_id = p_classification_id
  returning * into v_line;
  if not found then
    raise exception 'aps_record_reconciliation: classification % is not in session %',
      p_classification_id, p_session_id using errcode = 'P0002';
  end if;

  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
  values (
    v_actor,
    'aps.reconciliation_item_recorded'::public.audit_action,
    'aps_reconciliation_lines',
    v_line.id::text,
    jsonb_build_object(
      'session_id', p_session_id,
      'classification_id', p_classification_id,
      'accountant_amount', v_line.accountant_amount,
      'book_amount', v_line.book_amount,
      'difference', v_line.difference
    )
  );

  return query
    select v_line.id, v_line.accountant_amount, v_line.book_amount, v_line.difference;
end;
$$;

revoke all on function public.aps_record_reconciliation(uuid, uuid, numeric)
  from public, anon;
grant execute on function public.aps_record_reconciliation(uuid, uuid, numeric)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4) Close every open station session for a month
-- ---------------------------------------------------------------------------
create function public.aps_close_reconciliation_month(
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
     and not exists (
       select 1 from public.aps_reconciliation_items as legacy_item
        where legacy_item.session_id = session.id
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
       and not exists (
         select 1 from public.aps_reconciliation_items as legacy_item
          where legacy_item.session_id = session.id
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
       and not exists (
         select 1 from public.aps_reconciliation_items as legacy_item
          where legacy_item.session_id = session.id
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

-- ---------------------------------------------------------------------------
-- 5) Reopen a closed month (owner role only, not merely the wildcard)
-- ---------------------------------------------------------------------------
create function public.aps_reopen_reconciliation_month(
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
     and not exists (
       select 1 from public.aps_reconciliation_items as legacy_item
        where legacy_item.session_id = session.id
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
       and not exists (
         select 1 from public.aps_reconciliation_items as legacy_item
          where legacy_item.session_id = session.id
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

-- ---------------------------------------------------------------------------
-- 6) Replace temporary direct writes with RPC-only writes and dedicated reads
-- ---------------------------------------------------------------------------
revoke all on table public.aps_reconciliation_sessions, public.aps_reconciliation_lines
  from public, anon, authenticated;
grant select on table public.aps_reconciliation_sessions, public.aps_reconciliation_lines
  to authenticated;
grant all on table public.aps_reconciliation_sessions, public.aps_reconciliation_lines
  to service_role;

drop policy if exists aps_reconciliation_sessions_project_settings_select
  on public.aps_reconciliation_sessions;
drop policy if exists aps_reconciliation_sessions_project_settings_insert
  on public.aps_reconciliation_sessions;
drop policy if exists aps_reconciliation_sessions_project_settings_update
  on public.aps_reconciliation_sessions;
drop policy if exists aps_reconciliation_sessions_project_settings_delete
  on public.aps_reconciliation_sessions;
drop policy if exists aps_reconciliation_lines_project_settings_select
  on public.aps_reconciliation_lines;
drop policy if exists aps_reconciliation_lines_project_settings_insert
  on public.aps_reconciliation_lines;
drop policy if exists aps_reconciliation_lines_project_settings_update
  on public.aps_reconciliation_lines;
drop policy if exists aps_reconciliation_lines_project_settings_delete
  on public.aps_reconciliation_lines;

create policy aps_reconciliation_screen_sessions_read
  on public.aps_reconciliation_sessions
  for select to authenticated
  using (
    public.has_permission('aps.reconciliation:manage')
    or public.has_permission('aps.reconciliation:close_month')
    or public.has_permission('aps.reconciliation:reopen_month')
  );

create policy aps_reconciliation_lines_read
  on public.aps_reconciliation_lines
  for select to authenticated
  using (
    public.has_permission('aps.reconciliation:manage')
    or public.has_permission('aps.reconciliation:close_month')
    or public.has_permission('aps.reconciliation:reopen_month')
  );

comment on function public.aps_open_legacy_reconciliation(uuid, uuid) is
  'Legacy dual-comparison workflow. The reconciliation screen uses aps_open_reconciliation.';
comment on function public.aps_open_reconciliation(uuid, uuid) is
  'Opens a screen session and fills active-leaf lines with book balances through month end.';
comment on function public.aps_record_reconciliation(uuid, uuid, numeric) is
  'Records a non-negative accountant amount in an open screen session.';
comment on function public.aps_close_reconciliation_month(uuid, text) is
  'Closes all open station sessions for a month when every generated difference is zero.';
comment on function public.aps_reopen_reconciliation_month(uuid, text) is
  'Owner-only reopening of all closed station sessions for a month, with an audited reason.';

notify pgrst, 'reload schema';
