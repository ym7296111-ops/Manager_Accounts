-- Approval role selection: the service-only approval proxy may grant an
-- explicit, NON-protected target role in the same transaction as the approval.
-- Forward-only after 20261017010000_protect_original_owner.sql. Never rename or
-- rewrite an applied migration.
--
-- Contract changes:
--   * NEW overload admin_approve_user(uuid, varchar, uuid, text) — grants
--     p_target_role (NULL/blank falls back to 'viewer') on approve. Protected
--     roles (slug 'owner' or is_super_admin) can NEVER be granted here; the
--     same invariant admin_set_user_roles enforces.
--   * The existing 3-arg and 2-arg overloads keep their exact signatures (the
--     audit asserts has_function_privilege on 'admin_approve_user(uuid,varchar,uuid)')
--     and now delegate to the 4-arg core with 'viewer', preserving today's
--     behaviour for every existing caller.
--   * The 4-arg form has NO default parameter, so 3-argument calls can never
--     become "function is not unique" ambiguous between overloads.
--
-- Approval authority is unchanged and non-negotiable: only an approved, active
-- executor holding 'owner' or 'super_admin' may approve/reject, and only via
-- the service_role JWT bridge that passes a verified executor id.

create or replace function public.admin_approve_user(
  p_user_id uuid, p_action varchar(20), p_executor_id uuid, p_target_role text
) returns void language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_executor_role text;
declare v_old_status text;
declare v_granted_role_slug text;
declare v_role_id uuid;
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
  -- Resolve the grantable target role BEFORE any write: it must exist and must
  -- not be a protected system role. NULL/blank falls back to the least
  -- privileged baseline role ('viewer').
  if p_action = 'approve' then
    select r.id, r.slug
      into v_role_id, v_granted_role_slug
      from public.roles as r
     where r.slug = coalesce(nullif(btrim(p_target_role), ''), 'viewer')
       and r.slug <> 'owner'
       and r.is_super_admin is false;
    if v_role_id is null then
      raise exception 'invalid_role' using errcode = '22023';
    end if;
  end if;
  update public.profiles set approval_status = case when p_action = 'approve' then 'approved' else 'rejected' end,
    updated_at = now() where id = p_user_id;
  if p_action = 'approve' then
    update auth.users set email_confirmed_at = coalesce(email_confirmed_at, now()) where id = p_user_id;
    insert into public.user_roles (user_id, role_id, granted_by, granted_at)
    values (p_user_id, v_role_id, p_executor_id, now())
    on conflict (user_id, role_id) do nothing;
  end if;
  -- audit_action is an enum; store the exact event name in metadata rather than
  -- introducing a new enum value that cannot be used in the same transaction.
  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
    values (p_executor_id, 'user.updated'::public.audit_action, 'user', p_user_id::text,
      jsonb_build_object('event', 'user.approval_' || p_action, 'executor_role', v_executor_role,
        'old_approval_status', v_old_status,
        'granted_role', case when p_action = 'approve' then v_granted_role_slug else null end));
end;
$$;

-- Legacy 3-arg overload: unchanged signature, now delegates with 'viewer'.
create or replace function public.admin_approve_user(
  p_user_id uuid, p_action varchar(20), p_executor_id uuid
) returns void language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  perform public.admin_approve_user(p_user_id, p_action, p_executor_id, 'viewer');
end;
$$;

-- Two-argument form for trusted SQL callers with a verified request identity.
create or replace function public.admin_approve_user(p_user_id uuid, p_action varchar(20))
returns void language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  perform public.admin_approve_user(p_user_id, p_action, auth.uid(), 'viewer');
end;
$$;

revoke all on function public.admin_approve_user(uuid, varchar, uuid, text) from public, anon, authenticated;
grant execute on function public.admin_approve_user(uuid, varchar, uuid, text) to service_role;
revoke all on function public.admin_approve_user(uuid, varchar, uuid) from public, anon, authenticated;
grant execute on function public.admin_approve_user(uuid, varchar, uuid) to service_role;
revoke all on function public.admin_approve_user(uuid, varchar) from public, anon, authenticated;
grant execute on function public.admin_approve_user(uuid, varchar) to service_role;

comment on function public.admin_approve_user(uuid, varchar, uuid, text) is
  'Service-only approval bridge core: approve/reject a pending signup and grant an explicit non-protected target role (viewer by default) in the same transaction.';
