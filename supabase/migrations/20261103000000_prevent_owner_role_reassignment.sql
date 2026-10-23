-- =============================================================================
-- 20261103000000_prevent_owner_role_reassignment.sql
--
-- B1 (pre-release audit) hardening, forward-only:
--   1) `public.admin_set_user_roles(uuid, text[])` refuses the 'owner' slug
--      explicitly (42501, owner_protection) instead of letting it fall through
--      to the misleading "unknown role slug" (P0002) branch. The function body
--      is otherwise byte-identical to 20261031000000: advisory lock, actor
--      gate, original-owner immutability, super-admin isolation, self-demotion
--      and last-admin guards, and auto-suspend/reactivate are all preserved.
--   2) New `user_roles_guard_owner_singleton` trigger: defense-in-depth
--      backstop that refuses ANY second owner-role INSERT — direct SQL
--      included, with deliberately no current_user exemption — once an owner
--      holder exists. The only legitimate owner grant in history (fresh
--      first-signup race winner, or the one-time legacy backfill) is allowed
--      exactly while no holder exists yet. UPDATE/DELETE of owner rows stay
--      covered by the existing guard_original_owner_assignments trigger.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1) Explicit owner-slug refusal inside admin_set_user_roles
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
  v_next_status public.user_status;
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
    raise exception 'Operation not permitted'
      using errcode = '42501';
  end if;

  select coalesce(array_agg(distinct btrim(s.slug) order by btrim(s.slug)), '{}'::text[])
    into v_requested_slugs
    from unnest(coalesce(p_role_slugs, '{}'::text[])) as s(slug)
   where s.slug is not null
     and btrim(s.slug) <> '';

  -- B1 (pre-release audit): the owner role is minted exactly once by the
  -- bootstrap flow and must never appear in a requested set — not even from
  -- an administrator. Refuse explicitly with 42501, matching every other
  -- owner_protection refusal. (The is_super_admin flag check below would also
  -- catch 'owner' today, but that is incidental: this guard states the
  -- invariant outright so no future flag or catalog change can silently
  -- reopen it, and it reports the real reason instead of "unknown slug".)
  if 'owner' = any (v_requested_slugs) then
    raise log 'owner_protection: owner grant refused actor=% target=%', v_actor, p_user_id;
    raise exception 'owner_protection: owner role cannot be granted' using errcode = '42501';
  end if;

  select coalesce(array_agg(s.slug order by s.slug), '{}'::text[])
    into v_missing_slugs
    from unnest(v_requested_slugs) as s(slug)
   where not exists (
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

  -- Effective target status after role assignment:
  --   * 0 desired roles -> automatically suspend the account;
  --   * >=1 desired role on a role-less suspended account -> restore 'active'.
  if cardinality(v_desired_ids) = 0 then
    v_next_status := 'suspended'::public.user_status;
  elsif v_target_status = 'suspended'::public.user_status and cardinality(v_current_ids) = 0 then
    v_next_status := 'active'::public.user_status;
  else
    v_next_status := v_target_status;
  end if;

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
   where (
       (p.id <> p_user_id and p.status = 'active' and exists (
          select 1
            from public.user_roles as ur
            join public.roles as r on r.id = ur.role_id
           where ur.user_id = p.id
             and r.slug = 'super_admin'
       ))
       or (p.id = p_user_id and v_next_status = 'active' and 'super_admin' = any (v_requested_slugs))
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
   where (
       (p.id <> p_user_id and p.status = 'active' and exists (
          select 1
            from public.user_roles as ur
            join public.role_permissions as rp on rp.role_id = ur.role_id
            join public.permissions as permission on permission.id = rp.permission_id
           where ur.user_id = p.id
             and permission.slug = '*'
       ))
       or (p.id = p_user_id and v_next_status = 'active' and v_target_star_after)
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

  if v_next_status is distinct from v_target_status then
    update public.profiles
       set status = v_next_status,
           updated_at = now()
     where id = p_user_id;
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

revoke all on function public.admin_set_user_roles(uuid, text[]) from public, anon;
grant execute on function public.admin_set_user_roles(uuid, text[]) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2) Singleton backstop: at most one owner holder, ever
-- ---------------------------------------------------------------------------
create or replace function public.guard_owner_role_singleton()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  -- Only INSERT can mint a new holder: UPDATE/DELETE touching the owner role
  -- row are already refused unconditionally by
  -- guard_original_owner_assignments, so this trigger watches INSERT only.
  if tg_op = 'INSERT' and public.is_owner_role(new.role_id) then
    -- First-ever assignment (bootstrap race winner or one-time legacy
    -- backfill) is legitimate; both run under the advisory lock with the
    -- singleton state as the serializer. Anything after that — including
    -- direct SQL by a database owner, for which there is intentionally no
    -- exemption — is refused. A denied transaction cannot write to
    -- audit_logs; RAISE LOG survives as a DB log.
    if exists (select 1 from public.user_roles ur where ur.role_id = new.role_id) then
      raise log 'owner_protection: second owner grant refused actor=% target=%', auth.uid(), new.user_id;
      raise exception 'owner_protection: owner role cannot be granted' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.guard_owner_role_singleton()
  from public, anon, authenticated, service_role;

drop trigger if exists user_roles_guard_owner_singleton on public.user_roles;
create trigger user_roles_guard_owner_singleton
  before insert on public.user_roles
  for each row execute function public.guard_owner_role_singleton();

notify pgrst, 'reload schema';
