-- Owner-configurable capability delegation.
--
-- Until now the set of permissions that may be delegated to an individual user
-- was hardcoded as ('users.approve', 'password_reset.manage') inside
-- public.admin_grant_capability (20261026000000) and mirrored in the Edge
-- bridge and the browser. This forward-only migration moves that policy into
-- data the owner controls:
--
--   * public.permissions.is_delegatable marks which catalogue entries may be
--     granted through user_capabilities. Seeded ON for exactly the two
--     previously hardcoded slugs, so behaviour is unchanged until an owner
--     opts another permission in.
--   * A guard trigger makes the protected pair ('*', 'roles.manage') NEVER
--     delegatable, whichever path writes the row (RPC, table API, SQL). This
--     keeps delegated grants structurally incapable of minting an admin:
--     public.get_my_capabilities already ignores those slugs in grants, and
--     now they cannot even be flagged grantable.
--   * public.admin_set_permission_delegatable is the sanctioned write path
--     (owner/super_admin only, audited). Browser calls are bound to
--     auth.uid(); service-role calls (Edge, audit harness) pass the executor
--     explicitly, like the sibling capability RPCs.
--   * public.admin_grant_capability is replayed with the hardcoded list
--     replaced by a check on the flag, so disabling a permission stops NEW
--     grants immediately. Existing live grants are never retroactively
--     revoked by a flag flip: they end by explicit revoke or expiry, exactly
--     as before — the owner's kill switches stay admin_revoke_capability and
--     the per-grant expiry.
--   * public.get_user_capabilities (the dialog's "active delegations" read)
--     carried the same hardcoded pair as a filter. It is replayed WITHOUT
--     any slug filter — deliberately not "is_delegatable = true" either: a
--     still-live grant must remain visible and revocable after its
--     permission is disabled. Granting is the gated operation; listing and
--     revoking must work for anything already granted.

-- ---------------------------------------------------------------------------
-- The flag
-- ---------------------------------------------------------------------------
alter table public.permissions
  add column if not exists is_delegatable boolean not null default false;

-- Historical behaviour, preserved exactly: these two were the hardcoded list.
update public.permissions
   set is_delegatable = true
 where slug in ('users.approve', 'password_reset.manage');

comment on column public.permissions.is_delegatable is
  'May be granted to an individual user via user_capabilities (admin_grant_capability). Managed by admin_set_permission_delegatable; never true for ''*'' or ''roles.manage'' (permissions_guard_delegatable).';

-- ---------------------------------------------------------------------------
-- Protected permissions can never become delegatable
-- ---------------------------------------------------------------------------
create or replace function public.guard_permission_delegatable()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  -- Unconditional by design: unlike column guards, there is NO trusted
  -- context that may delegate the wildcard or role management — not the
  -- service role, not a migration, not a SECURITY DEFINER routine.
  if new.is_delegatable and new.slug in ('*', 'roles.manage') then
    raise exception 'permission_is_protected' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke execute on function public.guard_permission_delegatable() from public, anon, authenticated;

drop trigger if exists permissions_guard_delegatable on public.permissions;
create trigger permissions_guard_delegatable
  before insert or update on public.permissions
  for each row execute function public.guard_permission_delegatable();

-- ---------------------------------------------------------------------------
-- Owner/super-admin write RPC
-- ---------------------------------------------------------------------------
create or replace function public.admin_set_permission_delegatable(
  p_permission_slug text,
  p_is_delegatable boolean,
  p_executor_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_permission record;
  v_changed boolean := false;
begin
  if p_permission_slug is null or p_permission_slug = ''
     or p_is_delegatable is null or p_executor_id is null then
    raise exception 'invalid_action' using errcode = '22023';
  end if;

  -- Browser calls carry a JWT: the executor must be the caller, never an id
  -- merely asserted by the client. service_role/maintenance contexts have no
  -- auth.uid() and identify the executor themselves (sibling RPC contract).
  if auth.uid() is not null and auth.uid() <> p_executor_id then
    raise exception 'permission_denied' using errcode = '42501';
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

  if p_permission_slug in ('*', 'roles.manage') then
    raise exception 'permission_is_protected' using errcode = '42501';
  end if;

  select id, slug, is_delegatable
    into v_permission
    from public.permissions
   where slug = p_permission_slug
   for update;
  if not found then
    raise exception 'invalid_capability' using errcode = '22023';
  end if;

  -- Idempotent: re-asserting the current state is a success, not an error,
  -- so a toggle racing a refetch can never surface a spurious failure.
  if v_permission.is_delegatable <> p_is_delegatable then
    update public.permissions
       set is_delegatable = p_is_delegatable
     where id = v_permission.id;
    v_changed := true;

    insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
    values (
      p_executor_id,
      'role.permissions_updated'::public.audit_action,
      'permissions',
      v_permission.id::text,
      jsonb_build_object(
        'event', 'permission.delegatable_updated',
        'permission_slug', v_permission.slug,
        'is_delegatable', p_is_delegatable,
        'previous_is_delegatable', v_permission.is_delegatable
      )
    );
  end if;

  return jsonb_build_object(
    'permission_slug', v_permission.slug,
    'is_delegatable', p_is_delegatable,
    'changed', v_changed
  );
end;
$$;
revoke all on function public.admin_set_permission_delegatable(text, boolean, uuid)
  from public, anon;
grant execute on function public.admin_set_permission_delegatable(text, boolean, uuid)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Grant RPC: the hardcoded allow-list becomes the is_delegatable flag.
-- Full replay of 20261026000000; the only differences are the first guard and
-- the permission lookup (now reads the flag, locking the row FOR SHARE so a
-- grant cannot race an owner's disable).
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
  v_is_delegatable boolean;
  v_grant_id uuid;
begin
  if p_user_id is null or p_executor_id is null then
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

  select id, is_delegatable into v_permission_id, v_is_delegatable
    from public.permissions where slug = p_permission_slug
   for share;
  if v_permission_id is null then
    raise exception 'invalid_capability' using errcode = '22023';
  end if;
  if not v_is_delegatable then
    raise exception 'capability_not_delegatable' using errcode = '42501';
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

-- ---------------------------------------------------------------------------
-- Read RPC: drop the mirrored hardcoded pair (see header). Full replay of
-- 20261026000000 minus the slug filter; executor gate unchanged.
-- ---------------------------------------------------------------------------
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
     order by permission.slug, uc.granted_at desc;
end;
$$;
revoke all on function public.get_user_capabilities(uuid, uuid) from public, anon, authenticated;
grant execute on function public.get_user_capabilities(uuid, uuid) to service_role;

notify pgrst, 'reload schema';
