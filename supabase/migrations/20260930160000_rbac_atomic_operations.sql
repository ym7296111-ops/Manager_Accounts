-- RBAC atomic write path for the Roles & Permissions screen.
--
--   1. role_permissions becomes write-protected: direct INSERT/UPDATE/DELETE
--      from the client is revoked AND blocked by a guard trigger, so the only
--      sanctioned write path is the RPC below (defense in depth).
--   2. admin_set_role_permissions(target_role_id, permission_slugs) applies a
--      permission set in ONE transaction (diff-based: revoke extras, grant
--      missing) with database-level lockout guards:
--        * Self-Demotion Guard  — the caller can never lose the critical
--          capabilities `*` / `roles.manage` through any of their roles.
--        * Last-Admin Lockout   — the edit can never leave the system without
--          a single active holder of those critical capabilities (backstop
--          against concurrent edits racing each other).
--        * System invariant     — `super_admin` always keeps `*`.
--   3. `role_permission_matrix` (security_invoker view) exposes the full
--      cartesian catalog (roles x permissions + grants) so the screen can
--      fetch everything it renders — including empty roles and orphan
--      permissions — in a SINGLE round trip.
--   4. Audit: new `role.permissions_updated` action, written inside the same
--      transaction via write_audit_log().
--
-- Client contracts mirrored here live in src/hooks/useRolesManagement.ts.

-- ---------------------------------------------------------------------------
-- 1) Audit enum value
-- ---------------------------------------------------------------------------
-- PostgreSQL 12+ allows ADD VALUE inside a transaction; the value is only
-- referenced at RPC runtime, never inside this migration's own statements.
alter type public.audit_action add value if not exists 'role.permissions_updated';

-- ---------------------------------------------------------------------------
-- 2) Write protection on role_permissions
-- ---------------------------------------------------------------------------
revoke insert, update, delete on table public.role_permissions from anon, authenticated;

-- Guard trigger: even if table privileges are ever re-granted by mistake, only
-- trusted server-side contexts may write the grant matrix directly. The RPC
-- below is SECURITY DEFINER (owner = postgres), so its writes pass this guard
-- while `current_user` for direct API callers reflects their real role.
-- SECURITY INVOKER on purpose: `current_user` must reflect the real caller.
create or replace function public.guard_role_permissions_writes()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if current_user not in ('service_role', 'postgres', 'supabase_admin') then
    raise exception 'role_permissions is write-protected; use admin_set_role_permissions'
      using errcode = '42501';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke execute on function public.guard_role_permissions_writes() from public, anon, authenticated;

drop trigger if exists role_permissions_guard_writes on public.role_permissions;
create trigger role_permissions_guard_writes
  before insert or update or delete on public.role_permissions
  for each row execute function public.guard_role_permissions_writes();

-- ---------------------------------------------------------------------------
-- 3) Read view: full RBAC matrix in one round trip
-- ---------------------------------------------------------------------------
-- security_invoker: underlying RLS of roles / permissions / role_permissions /
-- user_roles applies for the calling role, exactly as direct selects would.
create or replace view public.role_permission_matrix
with (security_invoker = true) as
select
  r.id         as role_id,
  r.slug       as role_slug,
  r.name_ar    as role_name_ar,
  r.name_en    as role_name_en,
  r.is_system  as role_is_system,
  p.id         as permission_id,
  p.slug       as permission_slug,
  p.module     as permission_module,
  p.name_ar    as permission_name_ar,
  p.name_en    as permission_name_en,
  p.description as permission_description,
  (rp.permission_id is not null) as granted,
  exists (
    select 1
    from public.user_roles ur
    where ur.role_id = r.id
      and ur.user_id = auth.uid()
  ) as held_by_actor,
  (
    select count(*)::int
    from public.user_roles ur
    where ur.role_id = r.id
  ) as assigned_user_count
from public.roles r
cross join public.permissions p
left join public.role_permissions rp
  on rp.role_id = r.id
 and rp.permission_id = p.id;

revoke all on table public.role_permission_matrix from public, anon;
grant select on table public.role_permission_matrix to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4) The atomic, guarded write RPC
-- ---------------------------------------------------------------------------
-- Custom SQLSTATEs so the client maps failures to translated codes without
-- sniffing prose:
--   42501  forbidden              RBA01  self-demotion
--   P0002  not found / bad slug   RBA02  last-admin-lockout
--                                 RBA03  system-role-locked
create or replace function public.admin_set_role_permissions(
  target_role_id uuid,
  permission_slugs text[]
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_role_slug text;
  v_role_updated_at timestamptz;
  v_requested_slugs text[];
  v_missing_slugs text[];
  v_desired_ids uuid[];
  v_desired_slugs text[];
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
  v_holders_after bigint;
begin
  -- (a) Only active administrators may call (same gate as the RLS policies).
  if v_actor is null or not public.is_admin() then
    raise exception 'admin_set_role_permissions: administrator privileges required'
      using errcode = '42501';
  end if;

  -- (b) The target role must exist.
  select slug, updated_at
    into v_role_slug, v_role_updated_at
    from public.roles
   where id = target_role_id;

  if not found then
    raise exception 'admin_set_role_permissions: role % not found', target_role_id
      using errcode = 'P0002';
  end if;

  -- Serialize concurrent edits of the SAME role (lost-update protection).
  perform pg_advisory_xact_lock(
    hashtextextended('admin_set_role_permissions:' || target_role_id::text, 0)
  );

  -- (c) Normalize the desired set: trim, drop nulls/blanks, dedupe.
  select coalesce(array_agg(distinct t.slug order by t.slug), '{}')
    into v_requested_slugs
    from unnest(coalesce(permission_slugs, '{}')) as t(slug)
   where t.slug is not null and t.slug <> '';

  -- (d) Every requested slug must exist.
  select coalesce(array_agg(t.slug), '{}')
    into v_missing_slugs
    from unnest(v_requested_slugs) as t(slug)
   where not exists (select 1 from public.permissions p where p.slug = t.slug);

  if cardinality(v_missing_slugs) > 0 then
    raise exception 'admin_set_role_permissions: unknown permission slug(s): %',
      array_to_string(v_missing_slugs, ', ')
      using errcode = 'P0002';
  end if;

  select
    coalesce(array_agg(p.id order by p.slug), '{}'),
    coalesce(array_agg(p.slug order by p.slug), '{}')
    into v_desired_ids, v_desired_slugs
    from public.permissions p
   where p.slug = any (v_requested_slugs);

  select coalesce(array_agg(rp.permission_id), '{}')
    into v_current_ids
    from public.role_permissions rp
   where rp.role_id = target_role_id;

  -- Diff-based apply: revoke extras, grant missing (idempotent, retriable).
  select coalesce(array_agg(t.pid), '{}')
    into v_grant_ids
    from unnest(v_desired_ids) as t(pid)
   where not (t.pid = any (v_current_ids));

  select coalesce(array_agg(t.pid), '{}')
    into v_revoke_ids
    from unnest(v_current_ids) as t(pid)
   where not (t.pid = any (v_desired_ids));

  -- (e) System invariant: super_admin can never lose `*`.
  if v_role_slug = 'super_admin' and not ('*' = any (v_requested_slugs)) then
    raise exception 'admin_set_role_permissions: system-role-locked — super_admin must keep ''*'''
      using errcode = 'RBA03';
  end if;

  -- Capability semantics mirror public.has_permission: `*` grants everything.
  select exists (
    select 1 from public.user_roles ur
    where ur.user_id = v_actor and ur.role_id = target_role_id
  ) into v_actor_holds_target;

  -- (f) Self-Demotion Guard: the caller must keep `*` AND `roles.manage`
  --     (capability-level, across EVERY role they hold — not membership-level).
  select
    coalesce(bool_or(p.slug = '*'), false),
    coalesce(bool_or(p.slug in ('*', 'roles.manage')), false)
    into v_star_before, v_manage_before
    from public.user_roles ur
    join public.role_permissions rp on rp.role_id = ur.role_id
    join public.permissions p on p.id = rp.permission_id
   where ur.user_id = v_actor;

  select
    coalesce(bool_or(p.slug = '*'), false),
    coalesce(bool_or(p.slug in ('*', 'roles.manage')), false)
    into v_star_after, v_manage_after
    from (
      select rp.permission_id as pid
        from public.user_roles ur
        join public.role_permissions rp on rp.role_id = ur.role_id
       where ur.user_id = v_actor
         and ur.role_id <> target_role_id
      union
      select t.pid
        from unnest(v_desired_ids) as t(pid)
       where v_actor_holds_target
    ) effective
    join public.permissions p on p.id = effective.pid;

  if v_star_before and not v_star_after then
    raise exception 'admin_set_role_permissions: self-demotion guard — the caller would lose ''*'''
      using errcode = 'RBA01';
  end if;

  if v_manage_before and not v_manage_after then
    raise exception 'admin_set_role_permissions: self-demotion guard — the caller would lose ''roles.manage'''
      using errcode = 'RBA01';
  end if;

  -- (g) Last-Admin Lockout backstop: the system must never end up without an
  --     active holder of the critical capabilities (guards concurrent edits
  --     racing each other across different roles).
  select count(distinct pr.id)
    into v_holders_after
    from public.profiles pr
    join public.user_roles ur on ur.user_id = pr.id
    join (
      select rp.role_id as role_id, rp.permission_id as pid
        from public.role_permissions rp
       where rp.role_id <> target_role_id
      union
      select target_role_id as role_id, t.pid
        from unnest(v_desired_ids) as t(pid)
    ) effective on effective.role_id = ur.role_id
    join public.permissions p on p.id = effective.pid
   where pr.status = 'active'
     and (p.slug = '*' or p.slug = 'roles.manage');

  if v_holders_after < 1 then
    raise exception 'admin_set_role_permissions: last-admin-lockout — no active administrator would remain'
      using errcode = 'RBA02';
  end if;

  -- (h) Apply the diff (revokes first, then grants) — one transaction.
  if cardinality(v_revoke_ids) > 0 then
    delete from public.role_permissions
     where role_id = target_role_id
       and permission_id = any (v_revoke_ids);
  end if;

  if cardinality(v_grant_ids) > 0 then
    insert into public.role_permissions (role_id, permission_id)
    select target_role_id, t.pid
      from unnest(v_grant_ids) as t(pid)
    on conflict (role_id, permission_id) do nothing;
  end if;

  -- (i) Canonical slugs for the response + audit trail.
  select coalesce(array_agg(p.slug order by p.slug), '{}')
    into v_granted_slugs
    from public.permissions p
   where p.id = any (v_grant_ids);

  select coalesce(array_agg(p.slug order by p.slug), '{}')
    into v_revoked_slugs
    from public.permissions p
   where p.id = any (v_revoke_ids);

  if cardinality(v_grant_ids) > 0 or cardinality(v_revoke_ids) > 0 then
    -- Touch the role so readers can observe the change; set_updated_at applies.
    update public.roles
       set updated_at = now()
     where id = target_role_id
    returning updated_at into v_role_updated_at;

    perform public.write_audit_log(
      'role.permissions_updated',
      'role_permissions',
      target_role_id::text,
      jsonb_build_object(
        'role_slug', v_role_slug,
        'granted', to_jsonb(v_granted_slugs),
        'revoked', to_jsonb(v_revoked_slugs)
      )
    );
  end if;

  -- (j) Authoritative result: the applied diff + the role's new timestamp.
  return jsonb_build_object(
    'role_id', target_role_id,
    'role_slug', v_role_slug,
    'granted', to_jsonb(v_granted_slugs),
    'revoked', to_jsonb(v_revoked_slugs),
    'updated_at', v_role_updated_at
  );
end;
$$;

revoke execute on function public.admin_set_role_permissions(uuid, text[]) from public, anon;
grant execute on function public.admin_set_role_permissions(uuid, text[])
  to authenticated, service_role;
