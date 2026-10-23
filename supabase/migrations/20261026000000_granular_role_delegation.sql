-- Phase 1: individual capability delegation and password-reset queue hardening.
-- Forward-only: the historical plaintext password column is removed here; no
-- previous migration is edited. Secrets flow only through GoTrue in Edge.

-- ---------------------------------------------------------------------------
-- Capability catalogue (never grant these to ordinary roles by default)
-- ---------------------------------------------------------------------------
insert into public.permissions (slug, module, name_ar, name_en, description)
values
  ('users.approve', 'system', 'اعتماد المستخدمين', 'Approve users',
   'اعتماد أو رفض حسابات التسجيل المعلقة دون إدارة الأدوار أو الحالة'),
  ('password_reset.manage', 'system', 'إدارة طلبات استعادة كلمة المرور', 'Manage password reset requests',
   'قراءة الطابور الآمن واعتماد أو رفض طلبات استعادة كلمة المرور')
on conflict (slug) do nothing;

-- ---------------------------------------------------------------------------
-- User-scoped capability grants
-- ---------------------------------------------------------------------------
create table if not exists public.user_capabilities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  permission_id uuid not null references public.permissions(id) on delete restrict,
  granted_by uuid references public.profiles(id) on delete set null,
  granted_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid references public.profiles(id) on delete set null,
  constraint user_capabilities_no_self_grant check (granted_by is null or granted_by <> user_id),
  constraint user_capabilities_revocation_pair check
    ((revoked_at is null and revoked_by is null) or (revoked_at is not null))
);

create unique index if not exists user_capabilities_one_live_grant_idx
  on public.user_capabilities (user_id, permission_id)
  where revoked_at is null;
create index if not exists user_capabilities_user_active_idx
  on public.user_capabilities (user_id, expires_at)
  where revoked_at is null;

alter table public.user_capabilities enable row level security;
drop policy if exists user_capabilities_select_self on public.user_capabilities;
create policy user_capabilities_select_self on public.user_capabilities
  for select to authenticated using (user_id = auth.uid());
revoke all on public.user_capabilities from public, anon;
revoke insert, update, delete on public.user_capabilities from authenticated;
grant select on public.user_capabilities to authenticated;
revoke all on public.user_capabilities from service_role;
grant select, insert, update, delete on public.user_capabilities to service_role;

-- Realtime lets a live session invalidate its own cached effective capabilities
-- immediately after a grant or revocation. The table's RLS remains self-only.
do $publication$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = 'user_capabilities'
     ) then
    alter publication supabase_realtime add table public.user_capabilities;
  end if;
end;
$publication$;

-- Internal actor-scoped predicate used by both has_permission() (auth.uid)
-- and service-only RPCs whose executor comes from a verified Edge JWT.
create or replace function public.user_has_permission(
  p_user_id uuid,
  p_permission text
) returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select p_user_id is not null
     and p_permission is not null
     and exists (
       select 1
         from public.profiles as profile
        where profile.id = p_user_id
          and profile.status = 'active'
          and profile.approval_status = 'approved'
     )
     and (
       exists (
         select 1
           from public.user_roles as ur
           join public.role_permissions as rp on rp.role_id = ur.role_id
           join public.permissions as granted on granted.id = rp.permission_id
          where ur.user_id = p_user_id
            and (granted.slug = p_permission or granted.slug = '*')
       )
       or (
         p_permission <> '*'
         and exists (
           select 1
             from public.user_capabilities as uc
             join public.permissions as delegated on delegated.id = uc.permission_id
            where uc.user_id = p_user_id
              and delegated.slug = p_permission
              and delegated.slug not in ('*', 'roles.manage')
              and uc.revoked_at is null
              and (uc.expires_at is null or uc.expires_at > now())
         )
       )
     );
$$;
revoke all on function public.user_has_permission(uuid, text) from public, anon, authenticated;
grant execute on function public.user_has_permission(uuid, text) to service_role;

create or replace function public.has_permission(p_permission text)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select auth.uid() is not null
     and coalesce(public.user_has_permission(auth.uid(), p_permission), false);
$$;
revoke all on function public.has_permission(text) from public, anon;
grant execute on function public.has_permission(text) to authenticated, service_role;

-- Deliberately role-only: a delegated capability can never make its holder an
-- administrator, even if malformed legacy data contains a wildcard slug.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce(public.user_has_permission(auth.uid(), '*'), false);
$$;
revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated, service_role;

create or replace function public.get_my_capabilities()
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select case
    when auth.uid() is null
      or not coalesce(public.is_active_user(), false)
      or not exists (
        select 1 from public.profiles p
         where p.id = auth.uid() and p.approval_status = 'approved'
      ) then '[]'::jsonb
    else coalesce(
      (
        select to_jsonb(array_agg(distinct effective.slug order by effective.slug))
          from (
            select permission.slug
              from public.user_roles as ur
              join public.role_permissions as rp on rp.role_id = ur.role_id
              join public.permissions as permission on permission.id = rp.permission_id
             where ur.user_id = auth.uid()
            union
            select permission.slug
              from public.user_capabilities as uc
              join public.permissions as permission on permission.id = uc.permission_id
             where uc.user_id = auth.uid()
               and permission.slug not in ('*', 'roles.manage')
               and uc.revoked_at is null
               and (uc.expires_at is null or uc.expires_at > now())
          ) as effective
      ),
      '[]'::jsonb
    )
  end;
$$;
revoke all on function public.get_my_capabilities() from public, anon;
grant execute on function public.get_my_capabilities() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Owner/super-admin controlled grant, revoke and read RPCs
-- ---------------------------------------------------------------------------
create or replace function public.admin_grant_capability(
  p_user_id uuid,
  p_permission_slug text,
  p_expires_at timestamptz,
  p_executor_id uuid
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_permission_id uuid;
  v_grant_id uuid;
begin
  if p_user_id is null or p_executor_id is null
     or p_permission_slug not in ('users.approve', 'password_reset.manage') then
    raise exception 'invalid_action' using errcode = '22023';
  end if;
  if p_user_id = p_executor_id then
    raise exception 'self_delegation_denied' using errcode = '42501';
  end if;
  if p_expires_at is not null and p_expires_at <= now() then
    raise exception 'invalid_expiry' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.profiles p
     where p.id = p_executor_id and p.status = 'active' and p.approval_status = 'approved'
  ) or not exists (
    select 1 from public.user_roles ur
      join public.roles r on r.id = ur.role_id
     where ur.user_id = p_executor_id and r.slug in ('owner', 'super_admin')
  ) then
    raise exception 'permission_denied' using errcode = '42501';
  end if;

  perform 1 from public.profiles p
   where p.id = p_user_id and p.status = 'active' and p.approval_status = 'approved'
   for update;
  if not found or public.is_original_owner(p_user_id) then
    raise exception 'target_not_eligible' using errcode = '42501';
  end if;

  select id into v_permission_id from public.permissions where slug = p_permission_slug;
  if v_permission_id is null then
    raise exception 'invalid_capability' using errcode = '22023';
  end if;
  -- Retire an expired row before re-granting the same capability. This keeps
  -- the partial unique index while preserving the previous grant as history.
  update public.user_capabilities
     set revoked_at = now(), revoked_by = p_executor_id
   where user_id = p_user_id
     and permission_id = v_permission_id
     and revoked_at is null
     and expires_at is not null
     and expires_at <= now();
  if found then
    insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
    values (
      p_executor_id,
      'user.updated'::public.audit_action,
      'user_capabilities',
      p_user_id::text,
      jsonb_build_object(
        'event', 'capability.expired',
        'target_user_id', p_user_id,
        'permission_slug', p_permission_slug
      )
    );
  end if;

  if exists (
    select 1 from public.user_capabilities uc
     where uc.user_id = p_user_id and uc.permission_id = v_permission_id
       and uc.revoked_at is null
  ) then
    raise exception 'capability_already_granted' using errcode = '23505';
  end if;

  insert into public.user_capabilities (user_id, permission_id, granted_by, expires_at)
  values (p_user_id, v_permission_id, p_executor_id, p_expires_at)
  returning id into v_grant_id;

  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
  values (
    p_executor_id,
    'user.updated'::public.audit_action,
    'user_capabilities',
    v_grant_id::text,
    jsonb_build_object(
      'event', 'capability.granted',
      'target_user_id', p_user_id,
      'permission_slug', p_permission_slug,
      'expires_at', p_expires_at
    )
  );
  return v_grant_id;
end;
$$;
revoke all on function public.admin_grant_capability(uuid, text, timestamptz, uuid)
  from public, anon, authenticated;
grant execute on function public.admin_grant_capability(uuid, text, timestamptz, uuid)
  to service_role;

create or replace function public.admin_revoke_capability(
  p_capability_id uuid,
  p_executor_id uuid
) returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_capability record;
begin
  if p_capability_id is null or p_executor_id is null then
    raise exception 'invalid_action' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.profiles p
     where p.id = p_executor_id and p.status = 'active' and p.approval_status = 'approved'
  ) or not exists (
    select 1 from public.user_roles ur
      join public.roles r on r.id = ur.role_id
     where ur.user_id = p_executor_id and r.slug in ('owner', 'super_admin')
  ) then
    raise exception 'permission_denied' using errcode = '42501';
  end if;

  select uc.id, uc.user_id, permission.slug, uc.revoked_at
    into v_capability
    from public.user_capabilities uc
    join public.permissions permission on permission.id = uc.permission_id
   where uc.id = p_capability_id
   for update of uc;
  if not found then
    raise exception 'capability_not_found' using errcode = 'P0002';
  end if;
  if v_capability.revoked_at is not null then
    raise exception 'capability_already_revoked' using errcode = '22023';
  end if;

  update public.user_capabilities
     set revoked_at = now(), revoked_by = p_executor_id
   where id = p_capability_id;
  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
  values (
    p_executor_id,
    'user.updated'::public.audit_action,
    'user_capabilities',
    p_capability_id::text,
    jsonb_build_object(
      'event', 'capability.revoked',
      'target_user_id', v_capability.user_id,
      'permission_slug', v_capability.slug
    )
  );
end;
$$;
revoke all on function public.admin_revoke_capability(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.admin_revoke_capability(uuid, uuid) to service_role;

create or replace function public.get_user_capabilities(
  p_user_id uuid,
  p_executor_id uuid
) returns table (
  id uuid,
  permission_slug text,
  granted_at timestamptz,
  expires_at timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_user_id is null or p_executor_id is null then
    raise exception 'invalid_action' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.profiles p
     where p.id = p_executor_id and p.status = 'active' and p.approval_status = 'approved'
  ) or not exists (
    select 1 from public.user_roles ur
      join public.roles r on r.id = ur.role_id
     where ur.user_id = p_executor_id and r.slug in ('owner', 'super_admin')
  ) then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  return query
    select uc.id, permission.slug, uc.granted_at, uc.expires_at
      from public.user_capabilities uc
      join public.permissions permission on permission.id = uc.permission_id
     where uc.user_id = p_user_id
       and uc.revoked_at is null
       and (uc.expires_at is null or uc.expires_at > now())
       and permission.slug in ('users.approve', 'password_reset.manage')
     order by permission.slug, uc.granted_at desc;
end;
$$;
revoke all on function public.get_user_capabilities(uuid, uuid) from public, anon, authenticated;
grant execute on function public.get_user_capabilities(uuid, uuid) to service_role;

-- A delegated approval actor sees only pending applicant records, never the
-- general profiles relation. Non-owner roles are fixed to viewer by the core
-- approval RPC below.
create or replace function public.get_approval_queue(p_executor_id uuid)
returns table (
  id uuid,
  email text,
  full_name text,
  status public.user_status,
  approval_status varchar(20),
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_executor_id is null
     or not coalesce(public.user_has_permission(p_executor_id, 'users.approve'), false) then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  return query
    select p.id, p.email, p.full_name, p.status, p.approval_status, p.created_at, p.updated_at
      from public.profiles p
     where p.approval_status = 'pending'
       and not public.is_original_owner(p.id)
       and not exists (
         select 1 from public.user_roles ur join public.roles r on r.id = ur.role_id
          where ur.user_id = p.id and r.is_super_admin
       )
     order by p.created_at, p.id
     limit 500;
end;
$$;
revoke all on function public.get_approval_queue(uuid) from public, anon, authenticated;
grant execute on function public.get_approval_queue(uuid) to service_role;

-- The previous claim RPC read the plaintext column. It is obsolete and must
-- not survive the removal of that column or remain callable by service role.
drop function if exists public.admin_claim_password_reset_request(uuid, uuid);

-- ---------------------------------------------------------------------------
-- Password-reset request status and data minimization
-- ---------------------------------------------------------------------------
do $enum$
begin
  create type public.password_reset_request_status as enum
    ('awaiting_password', 'pending_approval', 'approved', 'rejected');
exception when duplicate_object then null;
end;
$enum$;

-- Drop objects that depend on the old text status before converting its type.
drop index if exists public.password_reset_requests_one_pending_per_email;
drop policy if exists password_reset_requests_admin_select on public.password_reset_requests;
drop policy if exists password_reset_requests_admin_update on public.password_reset_requests;
drop policy if exists password_reset_requests_public_insert on public.password_reset_requests;
drop policy if exists approved_access_only on public.password_reset_requests;
drop trigger if exists password_reset_requests_notify on public.password_reset_requests;
drop view if exists public.password_reset_requests_safe;
alter table public.password_reset_requests
  drop constraint if exists password_reset_requests_password_lifecycle,
  drop constraint if exists password_reset_requests_status_check;
alter table public.password_reset_requests
  alter column status drop default;

-- A legacy pending request survives as a request for approval, but the old
-- plaintext is intentionally discarded; the approver supplies a new value.
update public.password_reset_requests
   set status = 'pending_approval'
 where status::text = 'pending';

alter table public.password_reset_requests
  alter column status type public.password_reset_request_status
  using status::text::public.password_reset_request_status;
alter table public.password_reset_requests
  alter column status set default 'pending_approval'::public.password_reset_request_status;

alter table public.password_reset_requests
  drop column if exists new_password;

create unique index if not exists password_reset_requests_one_pending_per_email
  on public.password_reset_requests (email)
  where status in (
    'pending_approval'::public.password_reset_request_status,
    'awaiting_password'::public.password_reset_request_status
  );

comment on table public.password_reset_requests is
  'Manual password-reset queue. Passwords are never stored here; the safe view exposes only id, email, created_at and status to password_reset.manage users.';
comment on column public.password_reset_requests.status is
  'awaiting_password is an in-flight GoTrue write; pending_approval is actionable; terminal states are approved and rejected.';

-- The old helper, SELECT/UPDATE policies and grants are removed. The safe view
-- is the only authenticated read surface; the base table has no API SELECT.
create or replace function public.is_password_reset_admin()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select auth.uid() is not null
     and coalesce(public.has_permission('password_reset.manage'), false);
$$;
revoke all on function public.is_password_reset_admin() from public, anon;
grant execute on function public.is_password_reset_admin() to authenticated, service_role;

alter table public.password_reset_requests enable row level security;
drop policy if exists password_reset_requests_admin_select on public.password_reset_requests;
drop policy if exists password_reset_requests_admin_update on public.password_reset_requests;
drop policy if exists password_reset_requests_public_insert on public.password_reset_requests;
create policy password_reset_requests_public_insert on public.password_reset_requests
  for insert to anon, authenticated
  with check (
    status = 'pending_approval'::public.password_reset_request_status
    and processed_at is null and processed_by is null
  );
-- Keep approved-account status as a restrictive fence for authenticated callers.
drop policy if exists approved_access_only on public.password_reset_requests;
create policy approved_access_only on public.password_reset_requests
  as restrictive for all to authenticated
  using (public.is_approved_user())
  with check (public.is_approved_user());

revoke all on public.password_reset_requests from public, anon, authenticated;
grant insert on public.password_reset_requests to anon, authenticated;
revoke all on public.password_reset_requests from service_role;
grant select, insert, update, delete on public.password_reset_requests to service_role;

create trigger password_reset_requests_notify
  after insert on public.password_reset_requests
  for each row
  when (new.status = 'pending_approval'::public.password_reset_request_status)
  execute function public.handle_password_reset_request_notification();

-- Preserve the aggregate dashboard implementation while updating its queue
-- count for the new lifecycle. Replacing the stored definition avoids editing
-- the already-published dashboard migration and fails closed if its contract
-- has drifted unexpectedly.
do $dashboard$
declare
  v_definition text;
  v_old text := 'where status = ''pending'';';
  v_new text := 'where status in (''pending_approval''::public.password_reset_request_status, ''awaiting_password''::public.password_reset_request_status);';
begin
  select pg_get_functiondef('public.get_executive_dashboard(integer)'::regprocedure)
    into v_definition;
  if position(v_old in v_definition) > 0 then
    execute replace(v_definition, v_old, v_new);
  elsif position(v_new in v_definition) = 0 then
    raise exception 'get_executive_dashboard reset status predicate was not found';
  end if;
end;
$dashboard$;

create or replace view public.password_reset_requests_safe
with (security_barrier = true)
as
  select request.id, request.email, request.created_at, request.status
    from public.password_reset_requests as request
   where public.is_password_reset_admin();
revoke all on public.password_reset_requests_safe from public, anon;
grant select on public.password_reset_requests_safe to authenticated, service_role;
comment on view public.password_reset_requests_safe is
  'Safe manual reset queue surface: id, email, created_at and status only; requires effective password_reset.manage.';

-- ---------------------------------------------------------------------------
-- Password-reset service bridge: authorize/claim, external GoTrue, finalize
-- ---------------------------------------------------------------------------
create or replace function public.admin_approve_password_reset_request(
  p_request_id uuid,
  p_executor_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_request record;
  v_auth_user_id uuid;
begin
  if p_request_id is null or p_executor_id is null then
    raise exception 'invalid_action' using errcode = '22023';
  end if;
  if not coalesce(public.user_has_permission(p_executor_id, 'password_reset.manage'), false) then
    raise exception 'permission_denied' using errcode = '42501';
  end if;

  select pr.id, pr.email, pr.status into v_request
    from public.password_reset_requests pr
   where pr.id = p_request_id
   for update;
  if not found then
    raise exception 'request_not_found' using errcode = 'P0002';
  end if;
  if v_request.status <> 'pending_approval' then
    raise exception 'invalid_transition' using errcode = '22023';
  end if;

  select u.id into v_auth_user_id
    from auth.users u
   where lower(u.email::text) = v_request.email
   limit 1;
  if v_auth_user_id is null then
    raise exception 'user_not_found' using errcode = 'P0002';
  end if;

  update public.password_reset_requests
     set status = 'awaiting_password'::public.password_reset_request_status
   where id = p_request_id;

  return jsonb_build_object(
    'request_id', v_request.id,
    'email', v_request.email,
    'auth_user_id', v_auth_user_id
  );
end;
$$;
revoke all on function public.admin_approve_password_reset_request(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.admin_approve_password_reset_request(uuid, uuid) to service_role;
comment on function public.admin_approve_password_reset_request(uuid, uuid) is
  'Service-only approval preparation: verifies password_reset.manage, atomically reserves a pending request, and returns its Auth user id. The plaintext password is intentionally accepted only by the Edge Function and GoTrue, never by SQL.';

create or replace function public.admin_release_password_reset_request(
  p_request_id uuid,
  p_executor_id uuid
) returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_request_id is null or p_executor_id is null
     or not exists (
       select 1 from public.profiles p
        where p.id = p_executor_id and p.status = 'active' and p.approval_status = 'approved'
     ) then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  -- Cleanup-only recovery after GoTrue failure. This function is service-role
  -- only and grants no new access; it merely reopens a reserved request.
  update public.password_reset_requests
     set status = 'pending_approval'::public.password_reset_request_status
   where id = p_request_id
     and status = 'awaiting_password'::public.password_reset_request_status;
  if not found then
    raise exception 'invalid_transition' using errcode = '22023';
  end if;
end;
$$;
revoke all on function public.admin_release_password_reset_request(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.admin_release_password_reset_request(uuid, uuid) to service_role;

create or replace function public.admin_finalize_password_reset_request(
  p_request_id uuid,
  p_action varchar(20),
  p_executor_id uuid
) returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_request record;
  v_expected_status public.password_reset_request_status;
begin
  if p_request_id is null or p_executor_id is null
     or p_action is null or p_action not in ('approve', 'reject') then
    raise exception 'invalid_action' using errcode = '22023';
  end if;
  if not coalesce(public.user_has_permission(p_executor_id, 'password_reset.manage'), false) then
    raise exception 'permission_denied' using errcode = '42501';
  end if;

  v_expected_status := case when p_action = 'approve'
    then 'awaiting_password'::public.password_reset_request_status
    else 'pending_approval'::public.password_reset_request_status end;
  select pr.id, pr.email, pr.status into v_request
    from public.password_reset_requests pr
   where pr.id = p_request_id
   for update;
  if not found then
    raise exception 'request_not_found' using errcode = 'P0002';
  end if;
  if v_request.status <> v_expected_status then
    raise exception 'invalid_transition' using errcode = '22023';
  end if;

  update public.password_reset_requests
     set status = case when p_action = 'approve'
       then 'approved'::public.password_reset_request_status
       else 'rejected'::public.password_reset_request_status end,
         processed_at = now(),
         processed_by = p_executor_id
   where id = p_request_id;

  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
  values (
    p_executor_id,
    'user.updated'::public.audit_action,
    'password_reset_requests',
    p_request_id::text,
    jsonb_build_object(
      'event', case when p_action = 'approve'
                    then 'password_reset.approved'
                    else 'password_reset.rejected' end,
      'target_email', v_request.email
    )
  );
  perform public.resolve_related_notifications(p_request_id, 'password_reset_requested');
end;
$$;
revoke all on function public.admin_finalize_password_reset_request(uuid, varchar, uuid)
  from public, anon, authenticated;
grant execute on function public.admin_finalize_password_reset_request(uuid, varchar, uuid)
  to service_role;

-- ---------------------------------------------------------------------------
-- Approval authority: grant users.approve without exposing profiles or roles
-- ---------------------------------------------------------------------------
create or replace function public.admin_approve_user(
  p_user_id uuid,
  p_action varchar(20),
  p_executor_id uuid,
  p_target_role text
) returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_executor_role text;
  v_old_status text;
  v_granted_role_slug text;
  v_role_id uuid;
  v_role_admin boolean;
begin
  if p_action not in ('approve', 'reject') or p_action is null
     or p_user_id is null or p_executor_id is null then
    raise exception 'invalid_action' using errcode = '22023';
  end if;
  if not coalesce(public.user_has_permission(p_executor_id, 'users.approve'), false) then
    raise exception 'permission_denied' using errcode = '42501';
  end if;

  select r.slug into v_executor_role
    from public.user_roles ur join public.roles r on r.id = ur.role_id
   where ur.user_id = p_executor_id and r.slug in ('owner', 'super_admin')
   order by case when r.slug = 'owner' then 0 else 1 end limit 1;
  v_role_admin := v_executor_role is not null;
  if not v_role_admin then v_executor_role := 'delegated'; end if;

  select approval_status into v_old_status
    from public.profiles where id = p_user_id for update;
  if not found then
    raise exception 'user_not_found' using errcode = 'P0002';
  end if;
  if public.is_original_owner(p_user_id) then
    raise log 'owner_protection: approval RPC refused actor=% target=%', p_executor_id, p_user_id;
    raise exception 'owner_protection: owner approval is immutable' using errcode = '42501';
  end if;
  if v_old_status <> 'pending' or p_user_id = p_executor_id then
    raise exception 'invalid_transition' using errcode = '22023';
  end if;

  if p_action = 'approve' then
    if not v_role_admin and coalesce(nullif(btrim(p_target_role), ''), 'viewer') <> 'viewer' then
      raise exception 'delegated_role_forbidden' using errcode = '42501';
    end if;
    select r.id, r.slug into v_role_id, v_granted_role_slug
      from public.roles r
     where r.slug = coalesce(nullif(btrim(p_target_role), ''), 'viewer')
       and r.slug <> 'owner' and r.is_super_admin is false
       and (v_role_admin or r.slug = 'viewer');
    if v_role_id is null then
      raise exception 'invalid_role' using errcode = '22023';
    end if;
  end if;

  update public.profiles
     set approval_status = case when p_action = 'approve' then 'approved' else 'rejected' end,
         updated_at = now()
   where id = p_user_id;
  if p_action = 'approve' then
    update auth.users set email_confirmed_at = coalesce(email_confirmed_at, now()) where id = p_user_id;
    insert into public.user_roles (user_id, role_id, granted_by, granted_at)
    values (p_user_id, v_role_id, p_executor_id, now())
    on conflict (user_id, role_id) do nothing;
  end if;

  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
  values (
    p_executor_id,
    'user.updated'::public.audit_action,
    'user',
    p_user_id::text,
    jsonb_build_object(
      'event', 'user.approval_' || p_action,
      'executor_role', v_executor_role,
      'old_approval_status', v_old_status,
      'granted_role', case when p_action = 'approve' then v_granted_role_slug else null end
    )
  );
  perform public.resolve_related_notifications(p_user_id, 'user_approval_requested');
end;
$$;

create or replace function public.admin_approve_user(
  p_user_id uuid, p_action varchar(20), p_executor_id uuid
) returns void language plpgsql security definer
set search_path = pg_catalog, public
as $$
begin
  perform public.admin_approve_user(p_user_id, p_action, p_executor_id, 'viewer');
end;
$$;
create or replace function public.admin_approve_user(
  p_user_id uuid, p_action varchar(20)
) returns void language plpgsql security definer
set search_path = pg_catalog, public
as $$
begin
  perform public.admin_approve_user(p_user_id, p_action, auth.uid(), 'viewer');
end;
$$;
revoke all on function public.admin_approve_user(uuid, varchar, uuid, text)
  from public, anon, authenticated;
grant execute on function public.admin_approve_user(uuid, varchar, uuid, text) to service_role;
revoke all on function public.admin_approve_user(uuid, varchar, uuid)
  from public, anon, authenticated;
grant execute on function public.admin_approve_user(uuid, varchar, uuid) to service_role;
revoke all on function public.admin_approve_user(uuid, varchar)
  from public, anon, authenticated;
grant execute on function public.admin_approve_user(uuid, varchar) to service_role;

-- The approval Edge Function also serves a limited, sanitized queue read.
comment on function public.admin_approve_user(uuid, varchar, uuid, text) is
  'Service-only approval/rejection. Requires owner/super_admin or users.approve; delegated actors may approve only as viewer and cannot alter roles or account status.';
