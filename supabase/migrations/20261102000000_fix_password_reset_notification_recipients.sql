-- =============================================================================
-- Fix password-reset / approval notification recipients + owner protection
--
-- 1. resolve_notification_recipients: queue events now fan out by effective
--    capability (public.user_has_permission) instead of the owner/super_admin
--    role slug, so delegated holders are notified:
--      * user_approval_requested  -> 'users.approve'
--      * password_reset_requested -> 'password_reset.manage'
--    user_has_permission already requires an active + approved profile and is
--    SECURITY DEFINER with an explicit user id, so it is safe inside the
--    notification triggers where auth.uid() is NULL (anon visitor inserts).
--    The explicit active/approved predicate is kept for readability/defence.
--
-- 2. admin_approve_password_reset_request: refuse (42501 owner_protection)
--    when the request targets the original owner's account, so a delegated
--    password_reset.manage holder can never reset the owner's password.
--    The check runs on the resolved target auth user, before the request is
--    reserved (no state change on refusal).
--
-- 3. password_reset.manage stays delegatable (seeded in
--    20261030000000_permission_delegatable.sql, PR #78-era); re-asserted
--    idempotently so a drifted catalogue self-heals.
--
-- Forward-only: no published migration is edited.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1) Capability-based notification recipients
-- ---------------------------------------------------------------------------
create or replace function public.resolve_notification_recipients(
  p_type text,
  p_subject_id uuid default null
)
returns setof uuid
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  -- Queue events: everyone who effectively holds the matching capability.
  if p_type = 'user_approval_requested' then
    return query
      select p.id
        from public.profiles as p
       where p.status = 'active'
         and p.approval_status = 'approved'
         and public.user_has_permission(p.id, 'users.approve');
    return;
  end if;

  if p_type = 'password_reset_requested' then
    return query
      select p.id
        from public.profiles as p
       where p.status = 'active'
         and p.approval_status = 'approved'
         and public.user_has_permission(p.id, 'password_reset.manage');
    return;
  end if;

  -- Subject-directed decisions: the affected account itself.
  if p_type in ('user_approved', 'user_rejected') then
    if p_subject_id is not null then
      return query select p_subject_id;
    end if;
    return;
  end if;

  raise exception 'resolve_notification_recipients: unknown notification type'
    using errcode = '22023';
end;
$$;

revoke all on function public.resolve_notification_recipients(text, uuid) from public, anon;
grant execute on function public.resolve_notification_recipients(text, uuid) to authenticated, service_role;

comment on function public.resolve_notification_recipients(text, uuid) is
  'Single point of change for notification fan-out. Queue events resolve by effective capability: user_approval_requested -> users.approve, password_reset_requested -> password_reset.manage (delegated holders included).';

-- ---------------------------------------------------------------------------
-- 2) Original-owner protection in the reset-approval preparation RPC
--    (full replacement of the 20261026000000 definition + the owner check)
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

  -- The original owner's credential is never reset through this delegated
  -- flow, regardless of who executes it.
  if public.is_original_owner(v_auth_user_id) then
    raise exception 'owner_protection: cannot reset owner password via delegation' using errcode = '42501';
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
  'Service-only approval preparation: verifies password_reset.manage, refuses the original owner (42501 owner_protection), atomically reserves a pending request, and returns its Auth user id. The plaintext password is intentionally accepted only by the Edge Function and GoTrue, never by SQL.';

-- ---------------------------------------------------------------------------
-- 3) password_reset.manage remains delegatable (idempotent re-assertion)
-- ---------------------------------------------------------------------------
update public.permissions
   set is_delegatable = true
 where slug = 'password_reset.manage'
   and is_delegatable is distinct from true;
