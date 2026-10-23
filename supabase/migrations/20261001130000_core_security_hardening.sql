-- Emergency core hardening for administrator invariants, RBAC writes, and
-- automatic backup request generation.
--
-- The shared advisory lock serializes every supported change to the effective
-- administrator set. Table locks and target-row FOR UPDATE locks provide a
-- second, explicit layer for the profile and role-assignment invariant.

-- ---------------------------------------------------------------------------
-- 1) Shared administrator-invariant lock + race-safe status RPC
-- ---------------------------------------------------------------------------
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
  -- All sanctioned status, assignment, and permission mutations take this
  -- transaction-scoped lock before checking administrator capabilities.
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

  -- PostgreSQL has no table-level FOR UPDATE syntax. This explicit
  -- SHARE ROW EXCLUSIVE reservation serializes profile/assignment writes;
  -- the target profile is then locked with SELECT ... FOR UPDATE below.
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

  select count(distinct p.id)
    into v_active_super_admin_count
    from public.profiles as p
    join public.user_roles as ur on ur.user_id = p.id
    join public.roles as r on r.id = ur.role_id
   where p.status = 'active'
     and r.slug = 'super_admin';

  select exists (
    select 1
      from public.profiles as p
      join public.user_roles as ur on ur.user_id = p.id
      join public.roles as r on r.id = ur.role_id
     where p.id = p_user_id
       and p.status = 'active'
       and r.slug = 'super_admin'
  )
    into v_target_is_active_super_admin;

  if p_status = 'suspended'
     and v_active_super_admin_count = 1
     and v_target_is_active_super_admin then
    raise exception 'admin_set_user_status: last-admin-lockout — cannot suspend the only active super_admin'
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

revoke all on function public.admin_set_user_status(uuid, public.user_status)
  from public, anon, service_role;
grant execute on function public.admin_set_user_status(uuid, public.user_status)
  to authenticated;

-- ---------------------------------------------------------------------------
-- 2) Protect role assignments and expose one guarded SECURITY DEFINER RPC
-- ---------------------------------------------------------------------------
-- FORCE RLS as defense in depth. The read policy remains available; there are
-- intentionally no client INSERT/UPDATE/DELETE policies.
alter table public.user_roles enable row level security;
alter table public.user_roles force row level security;
drop policy if exists "Admins manage user roles" on public.user_roles;

revoke insert, update, delete, truncate
  on table public.user_roles
  from public, anon, authenticated, service_role;

-- Role catalog and grant-matrix writes are also privileged state: none of the
-- current clients writes these tables directly (role_permissions uses its
-- guarded RPC), so close the alternative REST paths, including service_role.
drop policy if exists "Admins manage roles" on public.roles;
drop policy if exists "Admins manage permissions" on public.permissions;
drop policy if exists "Admins manage role permissions" on public.role_permissions;
revoke insert, update, delete, truncate
  on table public.roles, public.permissions, public.role_permissions
  from public, anon, authenticated, service_role;

-- Prevent client profile INSERT/DELETE as well: profile creation is handled by
-- handle_new_user(), and a direct profile DELETE would cascade into user_roles.
drop policy if exists "Admins manage profiles" on public.profiles;
revoke insert, delete on table public.profiles from public, anon, authenticated, service_role;

-- Keep the trigger on role_permissions as a second guard if table privileges
-- are ever accidentally re-granted. The approved SECURITY DEFINER RPC executes
-- as its database owner; API roles must use that RPC instead of direct DML.
create or replace function public.guard_role_permissions_writes()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  if current_user not in ('postgres', 'supabase_admin') then
    raise exception 'role_permissions is write-protected; use admin_set_role_permissions'
      using errcode = '42501';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke execute on function public.guard_role_permissions_writes()
  from public, anon, authenticated, service_role;

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
    raise exception 'admin_set_user_roles: user % not found', p_user_id
      using errcode = 'P0002';
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
     select 1 from public.roles as r where r.slug = s.slug
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

revoke all on function public.admin_set_user_roles(uuid, text[])
  from public, anon, service_role;
grant execute on function public.admin_set_user_roles(uuid, text[])
  to authenticated;

-- ---------------------------------------------------------------------------
-- 3) Make the permission-matrix RPC share the invariant lock
-- ---------------------------------------------------------------------------
-- The matrix RPC is the only client write path for role_permissions. Replacing
-- it here ensures it cannot race a user-status or user-role change.
create or replace function public.admin_set_role_permissions(
  target_role_id uuid,
  permission_slugs text[]
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_role_slug text;
  v_role_updated_at timestamptz;
  v_requested_slugs text[];
  v_missing_slugs text[];
  v_desired_ids uuid[];
  v_current_ids uuid[];
  v_grant_ids uuid[];
  v_revoke_ids uuid[];
  v_granted_slugs text[];
  v_revoked_slugs text[];
  v_actor_holds_target boolean;
  v_star_before boolean;
  v_manage_before boolean;
  v_star_after boolean;
  v_manage_after boolean;
  v_active_admins_after bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended('admin_authority_invariant', 0));

  if v_actor is null or not public.is_admin() then
    raise exception 'admin_set_role_permissions: administrator privileges required'
      using errcode = '42501';
  end if;

  select r.slug, r.updated_at
    into v_role_slug, v_role_updated_at
    from public.roles as r
   where r.id = target_role_id
   for update;

  if not found then
    raise exception 'admin_set_role_permissions: role % not found', target_role_id
      using errcode = 'P0002';
  end if;

  -- Preserve the per-role lost-update lock as well as the shared administrator
  -- invariant lock above.
  perform pg_advisory_xact_lock(
    hashtextextended('admin_set_role_permissions:' || target_role_id::text, 0)
  );

  select coalesce(array_agg(distinct s.slug order by s.slug), '{}'::text[])
    into v_requested_slugs
    from unnest(coalesce(permission_slugs, '{}'::text[])) as s(slug)
   where s.slug is not null
     and s.slug <> '';

  select coalesce(array_agg(s.slug), '{}'::text[])
    into v_missing_slugs
    from unnest(v_requested_slugs) as s(slug)
   where not exists (
     select 1 from public.permissions as p where p.slug = s.slug
   );

  if cardinality(v_missing_slugs) > 0 then
    raise exception 'admin_set_role_permissions: unknown permission slug(s): %',
      array_to_string(v_missing_slugs, ', ')
      using errcode = 'P0002';
  end if;

  select
    coalesce(array_agg(p.id order by p.slug), '{}'::uuid[]),
    coalesce(array_agg(p.slug order by p.slug), '{}'::text[])
    into v_desired_ids, v_requested_slugs
    from public.permissions as p
   where p.slug = any (v_requested_slugs);

  select coalesce(array_agg(rp.permission_id), '{}'::uuid[])
    into v_current_ids
    from public.role_permissions as rp
   where rp.role_id = target_role_id;

  select coalesce(array_agg(w.permission_id), '{}'::uuid[])
    into v_grant_ids
    from unnest(v_desired_ids) as w(permission_id)
   where not (w.permission_id = any (v_current_ids));

  select coalesce(array_agg(w.permission_id), '{}'::uuid[])
    into v_revoke_ids
    from unnest(v_current_ids) as w(permission_id)
   where not (w.permission_id = any (v_desired_ids));

  if v_role_slug = 'super_admin' and not ('*' = any (v_requested_slugs)) then
    raise exception 'admin_set_role_permissions: system-role-locked — super_admin must keep ''*'''
      using errcode = 'RBA03';
  end if;

  select exists (
    select 1
      from public.user_roles as ur
     where ur.user_id = v_actor
       and ur.role_id = target_role_id
  )
    into v_actor_holds_target;

  select
    coalesce(bool_or(p.slug = '*'), false),
    coalesce(bool_or(p.slug in ('*', 'roles.manage')), false)
    into v_star_before, v_manage_before
    from public.user_roles as ur
    join public.role_permissions as rp on rp.role_id = ur.role_id
    join public.permissions as p on p.id = rp.permission_id
   where ur.user_id = v_actor;

  select
    coalesce(bool_or(p.slug = '*'), false),
    coalesce(bool_or(p.slug in ('*', 'roles.manage')), false)
    into v_star_after, v_manage_after
    from (
      select rp.permission_id
        from public.user_roles as ur
        join public.role_permissions as rp on rp.role_id = ur.role_id
       where ur.user_id = v_actor
         and ur.role_id <> target_role_id
      union
      select desired.permission_id
        from unnest(v_desired_ids) as desired(permission_id)
       where v_actor_holds_target
    ) as effective
    join public.permissions as p on p.id = effective.permission_id;

  if v_star_before and not v_star_after then
    raise exception 'admin_set_role_permissions: self-demotion guard — the caller would lose ''*'''
      using errcode = 'RBA01';
  end if;

  if v_manage_before and not v_manage_after then
    raise exception 'admin_set_role_permissions: self-demotion guard — the caller would lose ''roles.manage'''
      using errcode = 'RBA01';
  end if;

  -- is_admin() is defined by the '*' capability, so roles.manage alone must
  -- never satisfy the last-active-administrator invariant.
  select count(distinct p.id)
    into v_active_admins_after
    from public.profiles as p
    join public.user_roles as ur on ur.user_id = p.id
    join (
      select rp.role_id, rp.permission_id
        from public.role_permissions as rp
       where rp.role_id <> target_role_id
      union
      select target_role_id, desired.permission_id
        from unnest(v_desired_ids) as desired(permission_id)
    ) as effective on effective.role_id = ur.role_id
    join public.permissions as permission on permission.id = effective.permission_id
   where p.status = 'active'
     and permission.slug = '*';

  if v_active_admins_after < 1 then
    raise exception 'admin_set_role_permissions: last-admin-lockout — no active administrator would remain'
      using errcode = 'RBA02';
  end if;

  if cardinality(v_revoke_ids) > 0 then
    delete from public.role_permissions as rp
     where rp.role_id = target_role_id
       and rp.permission_id = any (v_revoke_ids);
  end if;

  if cardinality(v_grant_ids) > 0 then
    insert into public.role_permissions (role_id, permission_id)
    select target_role_id, granted.permission_id
      from unnest(v_grant_ids) as granted(permission_id)
    on conflict (role_id, permission_id) do nothing;
  end if;

  select coalesce(array_agg(p.slug order by p.slug), '{}'::text[])
    into v_granted_slugs
    from public.permissions as p
   where p.id = any (v_grant_ids);

  select coalesce(array_agg(p.slug order by p.slug), '{}'::text[])
    into v_revoked_slugs
    from public.permissions as p
   where p.id = any (v_revoke_ids);

  if cardinality(v_grant_ids) > 0 or cardinality(v_revoke_ids) > 0 then
    update public.roles as r
       set updated_at = now()
     where r.id = target_role_id
    returning r.updated_at into v_role_updated_at;

    perform public.write_audit_log(
      'role.permissions_updated'::public.audit_action,
      'role_permissions',
      target_role_id::text,
      jsonb_build_object(
        'role_slug', v_role_slug,
        'granted', to_jsonb(v_granted_slugs),
        'revoked', to_jsonb(v_revoked_slugs)
      )
    );
  end if;

  return jsonb_build_object(
    'role_id', target_role_id,
    'role_slug', v_role_slug,
    'granted', to_jsonb(v_granted_slugs),
    'revoked', to_jsonb(v_revoked_slugs),
    'updated_at', v_role_updated_at
  );
end;
$$;

revoke all on function public.admin_set_role_permissions(uuid, text[])
  from public, anon, service_role;
grant execute on function public.admin_set_role_permissions(uuid, text[])
  to authenticated;

-- ---------------------------------------------------------------------------
-- 4) Automatically enqueue a backup when its working-day interval is due
-- ---------------------------------------------------------------------------
create or replace function public.generate_scheduled_backup_requests()
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_settings_enabled boolean;
  v_interval_working_days integer;
  v_last_success_at timestamptz;
  v_last_success_date date;
  v_today_paris date;
  v_working_days_elapsed integer;
  v_request_id uuid;
  v_now timestamptz;
begin
  -- Shares the existing manual-request/worker gate, so concurrent cron runs,
  -- manual requests and job claims cannot race the one-active-request invariant.
  perform pg_advisory_xact_lock(hashtextextended('backup_request_gate', 0));
  v_now := clock_timestamp();

  select bs.enabled, bs.interval_working_days
    into v_settings_enabled, v_interval_working_days
    from public.backup_settings as bs
   where bs.singleton
   for share;

  if not found or not v_settings_enabled then
    return null;
  end if;

  -- Idempotence: an outstanding manual OR automatic request owns the single
  -- active slot. The unique partial index remains the final database guard.
  if exists (
    select 1
      from public.backup_logs as b
     where b.status in ('queued', 'running')
  ) then
    return null;
  end if;

  select coalesce(b.finished_at, b.requested_at)
    into v_last_success_at
    from public.backup_logs as b
   where b.status = 'completed'
   order by coalesce(b.finished_at, b.requested_at) desc, b.requested_at desc, b.id desc
   limit 1;

  v_today_paris := (v_now at time zone 'Europe/Paris')::date;

  -- With no successful backup in the ledger, the first scheduled run is due
  -- immediately; subsequent runs use completed_at (or requested_at for legacy
  -- completed rows that predate the finished_at telemetry column).
  if v_last_success_at is null then
    v_working_days_elapsed := v_interval_working_days;
  else
    v_last_success_date := (v_last_success_at at time zone 'Europe/Paris')::date;

    select count(*)::integer
      into v_working_days_elapsed
      from generate_series(
             v_last_success_date + 1,
             v_today_paris,
             interval '1 day'
           ) as day_series(work_day)
     where extract(isodow from day_series.work_day) between 1 and 5;
  end if;

  if v_working_days_elapsed < v_interval_working_days then
    return null;
  end if;

  insert into public.backup_logs (backup_type, status, requested_by)
  values ('automatic', 'queued', null)
  returning id into v_request_id;

  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
  values (
    null,
    'backup.created'::public.audit_action,
    'backup',
    v_request_id::text,
    jsonb_build_object(
      'backup_type', 'automatic',
      'status', 'queued',
      'source', 'pg_cron',
      'interval_working_days', v_interval_working_days,
      'working_days_elapsed', v_working_days_elapsed
    )
  );

  return v_request_id;
end;
$$;

revoke all on function public.generate_scheduled_backup_requests()
  from public, anon, authenticated, service_role;

-- pg_cron runs schedules in UTC by default on Supabase. Europe/Paris is UTC+1
-- in winter and UTC+2 in summer, so check both possible UTC hour slots. If the
-- cluster has a custom cron.timezone, use an hourly schedule with a Paris-time
-- predicate instead; in both cases the generator itself is invoked at 01:00
-- Europe/Paris without changing cluster-wide settings or requiring a restart.
create extension if not exists pg_cron with schema pg_catalog;

do $cron_job$
declare
  v_job_id bigint;
  v_schedule text;
  v_cron_timezone text := coalesce(current_setting('cron.timezone', true), 'GMT');
  v_command constant text := $command$
    select case
      when extract(hour from (clock_timestamp() at time zone 'Europe/Paris')) = 1
        then public.generate_scheduled_backup_requests()
      else null::uuid
    end;
  $command$;
begin
  -- Remove any prior copy created by an interrupted/manual replay before
  -- installing exactly one named schedule.
  for v_job_id in
    select j.jobid
      from cron.job as j
     where j.jobname = 'generate-scheduled-backup-requests-europe-paris-0100'
       and j.database = current_database()
       and j.username = current_user
  loop
    perform cron.unschedule(v_job_id);
  end loop;

  if lower(v_cron_timezone) in ('gmt', 'utc', 'etc/gmt', 'etc/utc') then
    v_schedule := '0 0,23 * * *';
  else
    v_schedule := '0 * * * *';
  end if;

  perform cron.schedule(
    'generate-scheduled-backup-requests-europe-paris-0100',
    v_schedule,
    v_command
  );
end;
$cron_job$;
