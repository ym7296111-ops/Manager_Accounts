-- Forward-only hardening after 20261017000000_add_user_approval_workflow.sql.
-- Never rename/rewrite an applied migration. The bootstrap trigger still grants
-- the first owner: its initial INSERT is the only permissible first assignment.
-- PostgreSQL superusers/table owners can disable triggers; they are outside
-- the application's trust boundary. API callers, including service_role, cannot.

create or replace function public.is_original_owner(p_user_id uuid)
returns boolean language sql stable security definer set search_path = pg_catalog, public as $$
  select p_user_id is not null and (
    exists (select 1 from public.first_admin_bootstrap_state s
      where s.singleton and s.first_user_id = p_user_id)
    or exists (select 1 from public.user_roles ur join public.roles r on r.id = ur.role_id
      where ur.user_id = p_user_id and r.slug = 'owner')
  );
$$;
revoke all on function public.is_original_owner(uuid) from public, anon;
grant execute on function public.is_original_owner(uuid) to authenticated, service_role;

create or replace function public.is_owner_role(p_role_id uuid)
returns boolean language sql stable security definer set search_path = pg_catalog, public as $$
  select exists (select 1 from public.roles r where r.id = p_role_id and r.slug = 'owner');
$$;
revoke all on function public.is_owner_role(uuid) from public, anon;
grant execute on function public.is_owner_role(uuid) to authenticated, service_role;

-- RLS is RESTRICTIVE (AND with existing policies) and write-only: owners
-- remain visible to administrators, but cannot be targeted via the API.
drop policy if exists owner_role_immutable_update on public.user_roles;
create policy owner_role_immutable_update on public.user_roles as restrictive for update to authenticated
  using (not public.is_owner_role(role_id) and not public.is_original_owner(user_id))
  with check (not public.is_owner_role(role_id) and not public.is_original_owner(user_id));
drop policy if exists owner_role_immutable_delete on public.user_roles;
create policy owner_role_immutable_delete on public.user_roles as restrictive for delete to authenticated
  using (not public.is_owner_role(role_id) and not public.is_original_owner(user_id));
drop policy if exists owner_role_immutable_insert on public.user_roles;
create policy owner_role_immutable_insert on public.user_roles as restrictive for insert to authenticated
  with check (not public.is_owner_role(role_id) and not public.is_original_owner(user_id));
drop policy if exists owner_profile_immutable_delete on public.profiles;
create policy owner_profile_immutable_delete on public.profiles as restrictive for delete to authenticated
  using (not public.is_original_owner(id));

-- RLS alone does not constrain SECURITY DEFINER or service_role. Triggers
-- also catch cascades, direct SQL and RPC updates, without blocking reads or
-- the first atomic signup assignment. A denied transaction cannot write to
-- audit_logs (that insert would roll back); RAISE LOG survives as a DB log.
create or replace function public.guard_original_owner_assignments()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if tg_op = 'INSERT' then
    -- Initial owner signup has no previous assignment; no other role may be
    -- provisioned for that identity until the owner role exists.
    if public.is_original_owner(new.user_id) and (
      not public.is_owner_role(new.role_id)
      or exists (select 1 from public.user_roles ur where ur.user_id = new.user_id)
    ) then
      raise log 'owner_protection: role insert refused actor=% target=%', auth.uid(), new.user_id;
      raise exception 'owner_protection: owner role assignments are immutable' using errcode = '42501';
    end if;
    return new;
  end if;
  if public.is_original_owner(old.user_id) or public.is_owner_role(old.role_id) then
    raise log 'owner_protection: role mutation refused actor=% target=%', auth.uid(), old.user_id;
    raise exception 'owner_protection: owner role assignments are immutable' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  if public.is_original_owner(new.user_id) or public.is_owner_role(new.role_id) then
    raise log 'owner_protection: role retarget refused actor=% target=%', auth.uid(), new.user_id;
    raise exception 'owner_protection: owner role assignments are immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_original_owner_assignments() from public, anon, authenticated, service_role;
drop trigger if exists user_roles_guard_original_owner on public.user_roles;
create trigger user_roles_guard_original_owner before insert or update or delete on public.user_roles
  for each row execute function public.guard_original_owner_assignments();

create or replace function public.guard_original_owner_profile()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if tg_op = 'DELETE' then
    if public.is_original_owner(old.id) then
      raise log 'owner_protection: profile delete refused actor=% target=%', auth.uid(), old.id;
      raise exception 'owner_protection: owner account cannot be deleted' using errcode = '42501';
    end if;
    return old;
  end if;
  if public.is_original_owner(old.id) and
     (new.status is distinct from old.status or new.approval_status is distinct from old.approval_status) then
    raise log 'owner_protection: profile mutation refused actor=% target=%', auth.uid(), old.id;
    raise exception 'owner_protection: owner cannot be suspended or unapproved' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_original_owner_profile() from public, anon, authenticated, service_role;
drop trigger if exists profiles_guard_original_owner on public.profiles;
create trigger profiles_guard_original_owner before update or delete on public.profiles
  for each row execute function public.guard_original_owner_profile();

-- Supabase Auth Admin deletes auth.users (which cascades to profiles/roles).
-- Block it at the root. Restrict Auth bans/deactivation as well; allow normal
-- token refresh and sign-in metadata updates so the owner can keep logging in.
create or replace function public.guard_original_owner_auth_user()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if tg_op = 'DELETE' then
    if public.is_original_owner(old.id) then
      raise log 'owner_protection: auth delete refused actor=% target=%', auth.uid(), old.id;
      raise exception 'owner_protection: owner Auth account cannot be deleted' using errcode = '42501';
    end if;
    return old;
  end if;
  if public.is_original_owner(old.id) and (
    new.email is distinct from old.email
    or new.email_confirmed_at is distinct from old.email_confirmed_at
    or to_jsonb(new)->>'banned_until' is distinct from to_jsonb(old)->>'banned_until'
    or to_jsonb(new)->>'deleted_at' is distinct from to_jsonb(old)->>'deleted_at'
  ) then
    raise log 'owner_protection: auth mutation refused actor=% target=%', auth.uid(), old.id;
    raise exception 'owner_protection: owner Auth account cannot be disabled' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_original_owner_auth_user() from public, anon, authenticated, service_role;
drop trigger if exists auth_users_guard_original_owner on auth.users;
create trigger auth_users_guard_original_owner before update or delete on auth.users
  for each row execute function public.guard_original_owner_auth_user();

-- Protect the role catalog and effective permission matrix as well as the
-- assignment. The normal owner-auto-grant trigger may still INSERT new perms.
create or replace function public.guard_original_owner_role()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if old.slug = 'owner' then
    raise log 'owner_protection: owner role mutation refused actor=% role=%', auth.uid(), old.id;
    raise exception 'owner_protection: owner role is immutable' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function public.guard_original_owner_role() from public, anon, authenticated, service_role;
drop trigger if exists roles_guard_original_owner on public.roles;
create trigger roles_guard_original_owner before update or delete on public.roles
  for each row execute function public.guard_original_owner_role();

create or replace function public.guard_original_owner_permissions()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if public.is_owner_role(old.role_id) then
    raise log 'owner_protection: permission mutation refused actor=% role=%', auth.uid(), old.role_id;
    raise exception 'owner_protection: owner permissions are immutable' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function public.guard_original_owner_permissions() from public, anon, authenticated, service_role;
drop trigger if exists role_permissions_guard_original_owner on public.role_permissions;
create trigger role_permissions_guard_original_owner before update or delete on public.role_permissions
  for each row execute function public.guard_original_owner_permissions();

create or replace function public.guard_original_owner_permission_catalog()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if old.slug is distinct from new.slug and exists (
    select 1 from public.role_permissions rp join public.roles r on r.id = rp.role_id
    where rp.permission_id = old.id and r.slug = 'owner'
  ) then
    raise log 'owner_protection: permission slug mutation refused actor=% permission=%', auth.uid(), old.id;
    raise exception 'owner_protection: owner permission slugs are immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_original_owner_permission_catalog() from public, anon, authenticated, service_role;
drop trigger if exists permissions_guard_original_owner_slug on public.permissions;
create trigger permissions_guard_original_owner_slug before update on public.permissions
  for each row execute function public.guard_original_owner_permission_catalog();

-- Additional explicit RPC guards, even if a future table policy changes.
create or replace function public.admin_set_user_status(
  p_user_id uuid,
  p_status public.user_status
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_target_status public.user_status;
  v_active_super_admin_count bigint;
  v_target_is_active_super_admin boolean;
begin
  perform pg_advisory_xact_lock(hashtextextended('admin_authority_invariant', 0));

  if v_actor is null or not public.is_admin() then
    raise exception 'admin_set_user_status: administrator privileges required'
      using errcode = '42501';
  end if;

  if p_user_id is null or p_status is null then
    raise exception 'admin_set_user_status: user id and status are required'
      using errcode = '22023';
  end if;

  if p_user_id = v_actor and p_status <> 'active' then
    raise exception 'admin_set_user_status: administrators cannot suspend themselves'
      using errcode = '42501';
  end if;

  lock table public.profiles,
             public.user_roles,
             public.roles,
             public.role_permissions
    in share row exclusive mode;

  select p.status
    into v_target_status
    from public.profiles as p
   where p.id = p_user_id
   for update;

  if not found then
    raise exception 'admin_set_user_status: user % not found', p_user_id
      using errcode = 'P0002';
  end if;

  if public.is_original_owner(p_user_id) then
    raise log 'owner_protection: status RPC refused actor=% target=%', v_actor, p_user_id;
    raise exception 'owner_protection: owner status is immutable' using errcode = '42501';
  end if;

  select count(distinct p.id)
    into v_active_super_admin_count
    from public.profiles as p
    join public.user_roles as ur on ur.user_id = p.id
    join public.roles as r on r.id = ur.role_id
   where p.status = 'active'
     and r.is_super_admin;

  select exists (
    select 1
      from public.profiles as p
      join public.user_roles as ur on ur.user_id = p.id
      join public.roles as r on r.id = ur.role_id
     where p.id = p_user_id
       and p.status = 'active'
       and r.is_super_admin
  )
    into v_target_is_active_super_admin;

  if p_status = 'suspended'
     and v_active_super_admin_count = 1
     and v_target_is_active_super_admin then
    raise exception 'admin_set_user_status: last-admin-lockout — cannot suspend the only active protected administrator'
      using errcode = 'RBA02';
  end if;

  update public.profiles
     set status = p_status
   where id = p_user_id;

  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
  values (
    v_actor,
    case when p_status = 'suspended' then 'user.suspended'::public.audit_action
         else 'user.updated'::public.audit_action end,
    'profiles',
    p_user_id::text,
    jsonb_build_object('status', p_status, 'previous_status', v_target_status)
  );
end;
$$;


create or replace function public.admin_set_user_roles(
  p_user_id uuid,
  p_role_slugs text[]
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_target_status public.user_status;
  v_requested_slugs text[];
  v_missing_slugs text[];
  v_desired_ids uuid[];
  v_current_ids uuid[];
  v_grant_ids uuid[];
  v_revoke_ids uuid[];
  v_granted_slugs text[];
  v_revoked_slugs text[];
  v_actor_star_before boolean;
  v_actor_manage_before boolean;
  v_actor_star_after boolean;
  v_actor_manage_after boolean;
  v_target_star_after boolean;
  v_active_super_admin_count bigint;
  v_active_super_admin_count_after bigint;
  v_active_admin_count_after bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended('admin_authority_invariant', 0));

  if v_actor is null or not public.is_active_user() or not public.is_admin() then
    raise exception 'admin_set_user_roles: active administrator privileges required'
      using errcode = '42501';
  end if;

  if p_user_id is null then
    raise exception 'admin_set_user_roles: user id is required'
      using errcode = '22023';
  end if;

  if public.is_original_owner(p_user_id) then
    raise log 'owner_protection: roles RPC refused actor=% target=%', v_actor, p_user_id;
    raise exception 'owner_protection: owner roles are immutable' using errcode = '42501';
  end if;

  -- Phase 2 hardening (super-admin isolation): a missing target and a target
  -- that holds the protected super-admin role receive ONE uniform answer
  -- ('Operation not permitted', 42501). The caller learns neither which case
  -- occurred nor that a protected role exists at all.
  if not exists (select 1 from public.profiles as p where p.id = p_user_id)
     or exists (
       select 1
         from public.user_roles as ur
         join public.roles as r on r.id = ur.role_id
        where ur.user_id = p_user_id
          and r.is_super_admin
     ) then
    raise exception 'Operation not permitted'
      using errcode = '42501';
  end if;

  lock table public.profiles,
             public.user_roles,
             public.roles,
             public.role_permissions
    in share row exclusive mode;

  select p.status
    into v_target_status
    from public.profiles as p
   where p.id = p_user_id
   for update;

  if not found then
    -- Uniform refusal (race path): identical to the protected-target answer.
    raise exception 'Operation not permitted'
      using errcode = '42501';
  end if;

  select coalesce(array_agg(distinct btrim(s.slug) order by btrim(s.slug)), '{}'::text[])
    into v_requested_slugs
    from unnest(coalesce(p_role_slugs, '{}'::text[])) as s(slug)
   where s.slug is not null
     and btrim(s.slug) <> '';

  select coalesce(array_agg(s.slug order by s.slug), '{}'::text[])
    into v_missing_slugs
    from unnest(v_requested_slugs) as s(slug)
   where not exists (
     -- Phase 2: a protected (is_super_admin) role slug is folded into the
     -- unknown list, so naming it is indistinguishable from a typo.
     select 1 from public.roles as r where r.slug = s.slug and not r.is_super_admin
   );

  if cardinality(v_missing_slugs) > 0 then
    raise exception 'admin_set_user_roles: unknown role slug(s): %',
      array_to_string(v_missing_slugs, ', ')
      using errcode = 'P0002';
  end if;

  select coalesce(array_agg(r.id order by r.slug), '{}'::uuid[])
    into v_desired_ids
    from public.roles as r
   where r.slug = any (v_requested_slugs);

  select coalesce(array_agg(ur.role_id order by ur.role_id), '{}'::uuid[])
    into v_current_ids
    from public.user_roles as ur
   where ur.user_id = p_user_id;

  select coalesce(array_agg(w.role_id), '{}'::uuid[])
    into v_grant_ids
    from unnest(v_desired_ids) as w(role_id)
   where not (w.role_id = any (v_current_ids));

  select coalesce(array_agg(w.role_id), '{}'::uuid[])
    into v_revoke_ids
    from unnest(v_current_ids) as w(role_id)
   where not (w.role_id = any (v_desired_ids));

  -- The self-demotion guard is capability-based across every assigned role,
  -- not membership-based: a caller must retain '*' and roles.manage whenever
  -- those capabilities are currently held.
  if p_user_id = v_actor then
    select
      coalesce(bool_or(p.slug = '*'), false),
      coalesce(bool_or(p.slug in ('*', 'roles.manage')), false)
      into v_actor_star_before, v_actor_manage_before
      from public.user_roles as ur
      join public.role_permissions as rp on rp.role_id = ur.role_id
      join public.permissions as p on p.id = rp.permission_id
     where ur.user_id = v_actor;

    select
      coalesce(bool_or(p.slug = '*'), false),
      coalesce(bool_or(p.slug in ('*', 'roles.manage')), false)
      into v_actor_star_after, v_actor_manage_after
      from unnest(v_desired_ids) as desired(role_id)
      join public.role_permissions as rp on rp.role_id = desired.role_id
      join public.permissions as p on p.id = rp.permission_id;

    if v_actor_star_before and not v_actor_star_after then
      raise exception 'admin_set_user_roles: self-demotion guard — the caller would lose ''*'''
        using errcode = 'RBA01';
    end if;

    if v_actor_manage_before and not v_actor_manage_after then
      raise exception 'admin_set_user_roles: self-demotion guard — the caller would lose ''roles.manage'''
        using errcode = 'RBA01';
    end if;
  end if;

  select count(distinct p.id)
    into v_active_super_admin_count
    from public.profiles as p
    join public.user_roles as ur on ur.user_id = p.id
    join public.roles as r on r.id = ur.role_id
   where p.status = 'active'
     and r.slug = 'super_admin';

  select count(distinct p.id)
    into v_active_super_admin_count_after
    from public.profiles as p
   where p.status = 'active'
     and (
       (p.id <> p_user_id and exists (
          select 1
            from public.user_roles as ur
            join public.roles as r on r.id = ur.role_id
           where ur.user_id = p.id
             and r.slug = 'super_admin'
       ))
       or (p.id = p_user_id and 'super_admin' = any (v_requested_slugs))
     );

  if v_active_super_admin_count > 0 and v_active_super_admin_count_after = 0 then
    raise exception 'admin_set_user_roles: last-admin-lockout — an active super_admin must remain'
      using errcode = 'RBA02';
  end if;

  select exists (
    select 1
      from unnest(v_desired_ids) as desired(role_id)
      join public.role_permissions as rp on rp.role_id = desired.role_id
      join public.permissions as p on p.id = rp.permission_id
     where p.slug = '*'
  )
    into v_target_star_after;

  select count(distinct p.id)
    into v_active_admin_count_after
    from public.profiles as p
   where p.status = 'active'
     and (
       (p.id <> p_user_id and exists (
          select 1
            from public.user_roles as ur
            join public.role_permissions as rp on rp.role_id = ur.role_id
            join public.permissions as permission on permission.id = rp.permission_id
           where ur.user_id = p.id
             and permission.slug = '*'
       ))
       or (p.id = p_user_id and v_target_status = 'active' and v_target_star_after)
     );

  if v_active_admin_count_after < 1 then
    raise exception 'admin_set_user_roles: last-admin-lockout — an active administrator must remain'
      using errcode = 'RBA02';
  end if;

  select coalesce(array_agg(r.slug order by r.slug), '{}'::text[])
    into v_granted_slugs
    from public.roles as r
   where r.id = any (v_grant_ids);

  select coalesce(array_agg(r.slug order by r.slug), '{}'::text[])
    into v_revoked_slugs
    from public.roles as r
   where r.id = any (v_revoke_ids);

  if cardinality(v_revoke_ids) > 0 then
    delete from public.user_roles as ur
     where ur.user_id = p_user_id
       and ur.role_id = any (v_revoke_ids);
  end if;

  if cardinality(v_grant_ids) > 0 then
    insert into public.user_roles (user_id, role_id, granted_by)
    select p_user_id, granted.role_id, v_actor
      from unnest(v_grant_ids) as granted(role_id)
    on conflict (user_id, role_id) do nothing;
  end if;

  if cardinality(v_grant_ids) > 0 then
    insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
    values (
      v_actor,
      'role.granted'::public.audit_action,
      'user_roles',
      p_user_id::text,
      jsonb_build_object('role_slugs', to_jsonb(v_granted_slugs))
    );
  end if;

  if cardinality(v_revoke_ids) > 0 then
    insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
    values (
      v_actor,
      'role.revoked'::public.audit_action,
      'user_roles',
      p_user_id::text,
      jsonb_build_object('role_slugs', to_jsonb(v_revoked_slugs))
    );
  end if;

  return jsonb_build_object(
    'user_id', p_user_id,
    'granted', to_jsonb(v_granted_slugs),
    'revoked', to_jsonb(v_revoked_slugs)
  );
end;
$$;


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
  if public.is_original_owner(p_user_id) then
    raise log 'owner_protection: approval RPC refused actor=% target=%', p_executor_id, p_user_id;
    raise exception 'owner_protection: owner approval is immutable' using errcode = '42501';
  end if;
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
-- Existing EXECUTE grants remain unchanged: authenticated may call the two
-- admin-set RPCs; only service_role may invoke either approval overload.
