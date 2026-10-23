-- Phase 2 hardening: isolate the super-admin role behind a machine flag.
--
-- Context (Option A, adopted): role management stays confined to `super_admin`
-- through the SQL Editor/owner; this migration hardens everything around it.
--
--   1. public.roles.is_super_admin  — marks THE single protected break-glass
--      role. A partial unique index (idx_one_super_admin) guarantees at most
--      ONE such role can ever exist.
--   2. public.audit_logs gains actor_type / actor_ref so manual (SQL Editor)
--      operations can be attributed later. NOTE: `actor_id` already exists as
--      the auth uuid FK to public.profiles — the free-form manual identity is
--      stored in `actor_ref` (text) to avoid colliding with that column.
--   3. public.is_super_admin_role(role_id) — SECURITY DEFINER helper used by
--      the write guards below (and by future sanitised read paths).
--   4. Guard triggers (SECURITY INVOKER — current_user must reflect the real
--      caller, same idiom as guard_role_permissions_writes):
--        * roles: INSERT/UPDATE/DELETE touching an is_super_admin row is
--          owner-only; flipping the flag itself is owner-only even for
--          service_role (service_role must never modify is_super_admin).
--        * user_roles: INSERT/DELETE/UPDATE touching an is_super_admin role is
--          owner-only (granting/revoking the break-glass role = SQL Editor).
--   5. New RPCs:
--        * get_my_capabilities()  — capability array for the UI (never role
--          names): ["*"] for the break-glass holder, real slugs otherwise.
--        * admin_list_roles()     — roles with is_super_admin = FALSE only,
--          gated by has_permission('roles.manage') (wildcard-aware).
--   6. Hardened RPCs (create or replace, same signatures):
--        * admin_set_user_roles / admin_set_role_permissions refuse targets
--          that hold is_super_admin with a UNIFORM answer — 'Operation not
--          permitted' (42501) — identical for missing and for protected
--          targets, so the refusal reveals neither existence nor protection.
--          Requested role slugs naming a protected role are folded into the
--          unknown-slug list (indistinguishable from a typo).
--
-- Client contract mirror: src/hooks/useAuthCapabilities.ts,
-- src/hooks/useUsersManagement.ts (isProtected), src/hooks/useNotificationAccess.ts.

-- ---------------------------------------------------------------------------
-- 1) roles.is_super_admin + the one-super-admin invariant
-- ---------------------------------------------------------------------------

alter table public.roles
  add column if not exists is_super_admin boolean not null default false;

comment on column public.roles.is_super_admin is
  'Marks the single protected super-admin (break-glass) role. Managed exclusively by the database owner via SQL Editor; API surfaces must never create, flip, or delete it.';

create unique index if not exists idx_one_super_admin
  on public.roles (is_super_admin)
  where is_super_admin = true;

-- Existing installations: flag the seeded system role. (Fresh databases get
-- the same flag from supabase/seed.sql, which runs after the migrations.)
update public.roles
   set is_super_admin = true
 where slug = 'super_admin'
   and is_super_admin is distinct from true;

-- ---------------------------------------------------------------------------
-- 2) audit_logs: manual-actor attribution columns
-- ---------------------------------------------------------------------------

-- actor_id (uuid, FK to profiles) already identifies authenticated actors;
-- actor_ref carries the free-form identity for manual/SQL-Editor operations.
alter table public.audit_logs
  add column if not exists actor_type text,
  add column if not exists actor_ref text;

comment on column public.audit_logs.actor_type is
  'How the actor was identified: ''user'' (auth actor_id), or ''db_role''/''manual'' (actor_ref). NULL on legacy rows.';
comment on column public.audit_logs.actor_ref is
  'Free-form actor identity for manual/SQL-Editor operations (db role name or email). NULL when the auth uuid actor_id is used.';

-- ---------------------------------------------------------------------------
-- 3) Helper: is this role the protected super-admin role?
-- ---------------------------------------------------------------------------

create or replace function public.is_super_admin_role(p_role_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select case
    when p_role_id is null then false
    else exists (
      select 1
        from public.roles as r
       where r.id = p_role_id
         and r.is_super_admin
    )
  end;
$$;

revoke all on function public.is_super_admin_role(uuid) from public, anon;
grant execute on function public.is_super_admin_role(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4) Write guards (defense in depth under the table-privilege revocations)
-- ---------------------------------------------------------------------------

-- SECURITY INVOKER on purpose: current_user must reflect the real caller.
create or replace function public.guard_super_admin_role_writes()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'INSERT' then
    -- Creating a new protected role is owner-only.
    if new.is_super_admin and current_user not in ('postgres', 'supabase_admin') then
      raise exception 'Operation not permitted'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if tg_op = 'UPDATE' then
    -- Strict rule: service_role must never MODIFY is_super_admin — flipping
    -- the flag is owner-only, even where row updates are tolerated below.
    if new.is_super_admin is distinct from old.is_super_admin
       and current_user not in ('postgres', 'supabase_admin') then
      raise exception 'Operation not permitted'
        using errcode = '42501';
    end if;
    -- Row-level: only trusted server-side contexts may touch the row at all.
    if old.is_super_admin
       and current_user not in ('postgres', 'supabase_admin', 'service_role') then
      raise exception 'Operation not permitted'
        using errcode = '42501';
    end if;
    return new;
  end if;

  -- DELETE
  if old.is_super_admin
     and current_user not in ('postgres', 'supabase_admin', 'service_role') then
    raise exception 'Operation not permitted'
      using errcode = '42501';
  end if;
  return old;
end;
$$;

revoke all on function public.guard_super_admin_role_writes()
  from public, anon, authenticated, service_role;

drop trigger if exists roles_guard_super_admin on public.roles;
create trigger roles_guard_super_admin
  before insert or update or delete on public.roles
  for each row execute function public.guard_super_admin_role_writes();

-- SECURITY INVOKER on purpose (same rationale).
create or replace function public.guard_super_admin_assignments()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_role_id uuid;
begin
  if tg_op = 'DELETE' then
    v_role_id := old.role_id;
  else
    v_role_id := new.role_id;
  end if;

  -- Granting or revoking the protected role is owner-only (SQL Editor/owner).
  -- Service_role is deliberately NOT exempt: it must never modify who is
  -- super admin. The check short-circuits before the helper for owner callers.
  if current_user not in ('postgres', 'supabase_admin') then
    if tg_op in ('INSERT', 'DELETE') and public.is_super_admin_role(v_role_id) then
      raise exception 'Operation not permitted'
        using errcode = '42501';
    end if;
    if tg_op = 'UPDATE'
       and (public.is_super_admin_role(old.role_id) or public.is_super_admin_role(new.role_id)) then
      raise exception 'Operation not permitted'
        using errcode = '42501';
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function public.guard_super_admin_assignments()
  from public, anon, authenticated, service_role;

drop trigger if exists user_roles_guard_super_admin on public.user_roles;
create trigger user_roles_guard_super_admin
  before insert or update or delete on public.user_roles
  for each row execute function public.guard_super_admin_assignments();

-- ---------------------------------------------------------------------------
-- 5) get_my_capabilities() — the UI capability channel (no role names ever)
-- ---------------------------------------------------------------------------

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
      then '[]'::jsonb
    else coalesce(
      (
        select to_jsonb(array_agg(distinct p.slug order by p.slug))
          from public.user_roles as ur
          join public.role_permissions as rp on rp.role_id = ur.role_id
          join public.permissions as p on p.id = rp.permission_id
         where ur.user_id = auth.uid()
      ),
      '[]'::jsonb
    )
  end;
$$;

-- A refusal/anonymous caller gets [] — never an error oracle.
revoke all on function public.get_my_capabilities() from public, anon;
grant execute on function public.get_my_capabilities() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6) admin_list_roles() — sanitised role catalogue (protected rows excluded)
-- ---------------------------------------------------------------------------

create or replace function public.admin_list_roles()
returns setof public.roles
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  -- has_permission('roles.manage') is wildcard-aware: holding '*' passes too.
  if auth.uid() is null
     or not coalesce(public.is_active_user(), false)
     or not coalesce(public.has_permission('roles.manage'), false) then
    raise exception 'Operation not permitted'
      using errcode = '42501';
  end if;

  return query
    select r.*
      from public.roles as r
     where not r.is_super_admin
     order by r.slug, r.id;
end;
$$;

revoke all on function public.admin_list_roles() from public, anon, service_role;
grant execute on function public.admin_list_roles() to authenticated;

-- ---------------------------------------------------------------------------
-- 7) Hardened admin_set_user_roles (same signature — create or replace)
-- ---------------------------------------------------------------------------

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

-- ---------------------------------------------------------------------------
-- 8) Hardened admin_set_role_permissions (same signature — create or replace)
-- ---------------------------------------------------------------------------

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
  v_target_is_super_admin boolean;
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

  -- Phase 2 hardening (super-admin isolation): the protected super-admin role
  -- is managed exclusively through the SQL Editor/owner. A missing target and
  -- a protected one receive ONE uniform answer ('Operation not permitted',
  -- 42501) so the refusal reveals neither existence nor protection.
  select r.is_super_admin
    into v_target_is_super_admin
    from public.roles as r
   where r.id = target_role_id;

  if not found or v_target_is_super_admin then
    raise exception 'Operation not permitted'
      using errcode = '42501';
  end if;

  select r.slug, r.updated_at
    into v_role_slug, v_role_updated_at
    from public.roles as r
   where r.id = target_role_id
   for update;

  if not found then
    -- Uniform refusal (race path): identical to the protected-target answer.
    raise exception 'Operation not permitted'
      using errcode = '42501';
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

revoke all on function public.admin_set_user_roles(uuid, text[])
  from public, anon, service_role;
grant execute on function public.admin_set_user_roles(uuid, text[])
  to authenticated;

revoke all on function public.admin_set_role_permissions(uuid, text[])
  from public, anon, service_role;
grant execute on function public.admin_set_role_permissions(uuid, text[])
  to authenticated;
