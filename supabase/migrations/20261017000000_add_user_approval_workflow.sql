-- Approval is separate from the existing active/suspended account status.
-- Do not re-approve rejected users if this migration is replayed.
alter table public.profiles add column if not exists approval_status varchar(20)
  default 'pending' check (approval_status in ('pending', 'approved', 'rejected'));

-- Existing accounts, including owner and profiles without assignments, are grandfathered once.
-- The marker makes replay safe even after new signups.
create table if not exists public.approval_migration_state (
  singleton boolean primary key default true check (singleton), completed boolean not null default false
);
alter table public.approval_migration_state enable row level security;
revoke all on public.approval_migration_state from public, anon, authenticated;
insert into public.approval_migration_state (singleton) values (true) on conflict do nothing;
do $backfill$
begin
  if not (select completed from public.approval_migration_state where singleton) then
    update public.profiles set approval_status = 'approved';
    update public.approval_migration_state set completed = true where singleton;
  end if;
end $backfill$;

-- Existing BEFORE INSERT trigger confirms the first owner's email atomically;
-- this AFTER INSERT trigger provisions the owner but NOT a viewer for later signups.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_first_user_id uuid;
  v_auth_user_count bigint;
  v_role_id uuid;
  v_role_slug text;
  v_rows_inserted integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('admin_authority_invariant', 0));

  select s.first_user_id
    into v_first_user_id
    from public.first_admin_bootstrap_state as s
   where s.singleton is true
   for update;

  if not found then
    raise exception 'First-admin signup state is missing; refusing Auth signup.';
  end if;

  insert into public.profiles (id, email, full_name, avatar_url, status, approval_status)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)),
    new.raw_user_meta_data ->> 'avatar_url',
    'active',
    case when v_first_user_id = new.id then 'approved' else 'pending' end
  )
  on conflict (id) do nothing;

  if v_first_user_id = new.id then
    select count(*)
      into v_auth_user_count
      from auth.users;

    if v_auth_user_count <> 1 then
      raise exception 'The first owner signup must be the only Auth user at grant time.';
    end if;

    if new.email_confirmed_at is null then
      raise exception 'The first Auth signup must have a confirmed email.';
    end if;

    select r.id
      into v_role_id
      from public.roles as r
     where r.slug = 'owner'
       and r.is_super_admin is true
       and exists (
         select 1 from public.permissions as p where p.slug = '*'
       )
       and not exists (
         select 1
           from public.permissions as p
          where not exists (
            select 1
              from public.role_permissions as rp
             where rp.role_id = r.id
               and rp.permission_id = p.id
          )
       );
    v_role_slug := 'owner';
    if v_role_id is null then
      raise exception 'Required signup role % is missing or incomplete.', v_role_slug;
    end if;
  end if;

  -- Later signups receive NO role until an authorized approval. Owner only.
  if v_first_user_id = new.id then
    insert into public.user_roles (user_id, role_id, granted_by)
    values (new.id, v_role_id, null)
    on conflict (user_id, role_id) do nothing;

    get diagnostics v_rows_inserted = row_count;
    if v_rows_inserted <> 1 then
      raise exception 'Signup role % was not newly assigned.', v_role_slug;
    end if;

    insert into public.audit_logs (
      actor_id,
      actor_type,
      actor_ref,
      action,
      entity,
      entity_id,
      metadata
    )
    values (
      null,
      'auth_signup_trigger',
      'auth.users.on_auth_user_created',
      'role.granted'::public.audit_action,
      'user_roles',
      new.id::text,
      jsonb_build_object(
        'role_slugs', jsonb_build_array(v_role_slug),
        'target_user_id', new.id,
        'assignment_source', 'auth.users.on_auth_user_created',
        'first_signup', v_first_user_id = new.id
      )
    );
  end if;

  return new;
end;
$$;

revoke all on function public.confirm_first_auth_user_email()
  from public, anon, authenticated, service_role;
revoke all on function public.handle_new_user() from public, anon, authenticated, service_role;

-- Prevent a leaked/old viewer assignment from granting pending users capabilities.
create or replace function public.is_active_user()
returns boolean language sql stable security definer set search_path = pg_catalog, public as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid()
    and p.status = 'active' and p.approval_status = 'approved');
$$;
revoke all on function public.is_active_user() from public, anon;
grant execute on function public.is_active_user() to authenticated, service_role;

-- SECURITY DEFINER avoids recursive profile RLS; this function reveals only a boolean.
create or replace function public.is_approved_user()
returns boolean language sql stable security definer set search_path = pg_catalog, public as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid()
    and p.approval_status = 'approved');
$$;
revoke all on function public.is_approved_user() from public, anon;
grant execute on function public.is_approved_user() to authenticated, service_role;

-- RESTRICTIVE policies are ANDed with *every* existing permissive policy.
-- Pending users can read only their own profile (to see their approval state).
drop policy if exists approved_users_only on public.profiles;
create policy approved_users_only on public.profiles as restrictive for select to authenticated
  using (id = auth.uid() or public.is_approved_user());
drop policy if exists approved_profile_writes_only on public.profiles;
create policy approved_profile_writes_only on public.profiles as restrictive for update to authenticated
  using (public.is_approved_user())
  with check (public.is_approved_user());
-- Only self-service columns remain writable via the authenticated API.
revoke update (approval_status) on public.profiles from authenticated;
-- An approved actor must not be able to fabricate a second profile or delete one.
drop policy if exists approved_profile_inserts_only on public.profiles;
create policy approved_profile_inserts_only on public.profiles as restrictive for insert to authenticated
  with check (public.is_approved_user());
drop policy if exists approved_profile_deletes_only on public.profiles;
create policy approved_profile_deletes_only on public.profiles as restrictive for delete to authenticated
  using (public.is_approved_user());

-- Apply to every existing RLS-protected public table, including roles, tickets,
-- audit, notification, and settings tables. Anon/public policies are unchanged.
do $rls$
declare v_table record;
begin
  for v_table in
    select c.relname from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r','p') and c.relrowsecurity
      and c.relname <> 'profiles'
  loop
    execute format('drop policy if exists approved_access_only on public.%I', v_table.relname);
    execute format('create policy approved_access_only on public.%I as restrictive for all to authenticated using (public.is_approved_user()) with check (public.is_approved_user())', v_table.relname);
  end loop;
end $rls$;

-- Only the trusted service proxy may invoke this entry point. The proxy
-- verifies the JWT with auth.getUser and passes the verified actor ID.
create or replace function public.admin_approve_user(
  p_user_id uuid, p_action varchar(20), p_executor_id uuid
) returns void language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_executor_role text;
declare v_old_status text;
begin
  if current_setting('request.jwt.claim.role', true) is distinct from 'service_role' then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  if p_action not in ('approve', 'reject') or p_action is null or p_user_id is null then
    raise exception 'invalid_action' using errcode = '22023';
  end if;
  -- Lock the actor and target so concurrent approvals/rejections cannot race.
  perform 1 from public.profiles where id = p_executor_id
    and approval_status = 'approved' and status = 'active' for update;
  if not found then raise exception 'permission_denied' using errcode = '42501'; end if;
  select r.slug into v_executor_role from public.user_roles ur
    join public.roles r on r.id = ur.role_id
    where ur.user_id = p_executor_id and r.slug in ('owner','super_admin')
    order by case when r.slug = 'owner' then 0 else 1 end limit 1;
  if v_executor_role is null then raise exception 'permission_denied' using errcode = '42501'; end if;
  select approval_status into v_old_status from public.profiles where id = p_user_id for update;
  if not found then raise exception 'user_not_found' using errcode = 'P0002'; end if;
  if v_old_status <> 'pending' or p_user_id = p_executor_id then
    raise exception 'invalid_transition' using errcode = '22023';
  end if;
  update public.profiles set approval_status = case when p_action = 'approve' then 'approved' else 'rejected' end,
    updated_at = now() where id = p_user_id;
  if p_action = 'approve' then
    update auth.users set email_confirmed_at = coalesce(email_confirmed_at, now()) where id = p_user_id;
    insert into public.user_roles (user_id, role_id, granted_by, granted_at)
      select p_user_id, r.id, p_executor_id, now() from public.roles r where r.slug = 'viewer'
      on conflict (user_id, role_id) do nothing;
  end if;
  -- audit_action is an enum; store the exact event name in metadata rather than
  -- introducing a new enum value that cannot be used in the same transaction.
  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
    values (p_executor_id, 'user.updated'::public.audit_action, 'user', p_user_id::text,
      jsonb_build_object('event', 'user.approval_' || p_action, 'executor_role', v_executor_role,
        'old_approval_status', v_old_status));
end;
$$;
revoke all on function public.admin_approve_user(uuid, varchar, uuid) from public, anon, authenticated;
grant execute on function public.admin_approve_user(uuid, varchar, uuid) to service_role;

-- Two-argument form for trusted SQL callers with a verified request identity.
-- The Edge proxy uses the explicit verified actor overload above, since a
-- service_role JWT has no user subject of its own.
create or replace function public.admin_approve_user(p_user_id uuid, p_action varchar(20))
returns void language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  perform public.admin_approve_user(p_user_id, p_action, auth.uid());
end;
$$;
revoke all on function public.admin_approve_user(uuid, varchar) from public, anon, authenticated;
grant execute on function public.admin_approve_user(uuid, varchar) to service_role;
