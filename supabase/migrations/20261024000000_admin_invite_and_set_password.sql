-- ---------------------------------------------------------------------------
-- Admin user-management tools: explicit invite + admin-initiated password set
-- ---------------------------------------------------------------------------
-- Two capabilities, three service-only RPCs:
--
--   Edge `admin-invite-user`  → admin_invite_user
--   Edge `admin-set-password` → admin_verify_password_reset_authority  (gate)
--                             → GoTrue auth.admin.updateUserById       (write)
--                             → admin_record_password_reset            (audit)
--
-- SECURITY MODEL
-- * All three are SECURITY DEFINER with a pinned `search_path`, and EXECUTE is
--   granted to service_role only. Authorization is enforced by privilege: an
--   anon or authenticated caller cannot reach the function body at all, which
--   is why no `request.jwt.claim.role` check appears here (that check was
--   deliberately removed from admin_approve_user by
--   20261019000000_remove_service_role_check.sql for the same reason).
-- * The executor id ALWAYS arrives from the verified JWT via the Edge
--   Function; it is never trusted from a request parameter.
-- * NO password ever enters SQL. The plaintext is generated inside the Edge
--   Function, written straight to GoTrue, returned once, and never stored —
--   not in a table, not in audit metadata, not in a log line.
--
-- NAMING
-- `admin_verify_password_reset_authority` deliberately avoids the verb
-- `claim`. In this codebase `claim` means "lock and take a queued row"
-- (admin_claim_password_reset_request, admin_claim_next_backup_job). This
-- gate INSERTs/UPDATEs/DELETEs nothing, so it is named for what it does.
-- `admin_record_password_reset` likewise drops the doubled `admin_…admin_`
-- prefix that no other function in the catalogue carries.

-- ---------------------------------------------------------------------------
-- 1. admin_invite_user — approve, activate and grant a role in one transaction
-- ---------------------------------------------------------------------------
-- Called by `admin-invite-user` AFTER `auth.admin.createUser` has succeeded, so
-- `handle_new_user()` has already inserted the profile. This RPC completes the
-- provisioning: approval, activation, email confirmation and the role grant.
create or replace function public.admin_invite_user(
  p_user_id uuid,
  p_target_role text,
  p_executor_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_executor_role text;
  v_role_id uuid;
  v_role_slug text;
begin
  if p_user_id is null or p_executor_id is null then
    raise exception 'invalid_action' using errcode = '22023';
  end if;

  -- Executor authority: an approved, active profile holding owner/super_admin.
  -- Locked so a concurrent role change cannot slip between the check and the
  -- grant.
  perform 1
     from public.profiles
    where id = p_executor_id
      and approval_status = 'approved'
      and status = 'active'
    for update;
  if not found then
    raise exception 'permission_denied' using errcode = '42501';
  end if;

  select r.slug
    into v_executor_role
    from public.user_roles as ur
    join public.roles as r on r.id = ur.role_id
   where ur.user_id = p_executor_id
     and r.slug in ('owner', 'super_admin')
   order by case when r.slug = 'owner' then 0 else 1 end
   limit 1;
  if v_executor_role is null then
    raise exception 'permission_denied' using errcode = '42501';
  end if;

  -- Role allow-list. `owner` and anything flagged `is_super_admin` are never
  -- grantable through an invite, whatever the caller asks for; the list is an
  -- explicit enumeration rather than "anything that is not owner" so that a
  -- newly seeded system role cannot become invitable by accident.
  select r.id, r.slug
    into v_role_id, v_role_slug
    from public.roles as r
   where r.slug = btrim(coalesce(p_target_role, ''))
     and r.slug in ('viewer', 'editor', 'admin', 'executive')
     and r.is_super_admin is false;
  if v_role_id is null then
    raise exception 'invalid_role' using errcode = '22023';
  end if;

  -- Target must exist. The Edge Function created the Auth account first, which
  -- fired handle_new_user() and inserted the profile.
  perform 1 from public.profiles where id = p_user_id for update;
  if not found then
    raise exception 'user_not_found' using errcode = 'P0002';
  end if;

  -- Owner protection: the original owner is never the target of an invite.
  if public.is_original_owner(p_user_id) then
    raise log 'owner_protection: invite refused actor=% target=%', p_executor_id, p_user_id;
    raise exception 'owner_protection: owner account cannot be invited' using errcode = '42501';
  end if;

  -- Approve + activate. handle_new_user() leaves approval_status at its
  -- 'pending' default, so an invited user could not sign in without this.
  update public.profiles
     set approval_status = 'approved',
         status = 'active',
         updated_at = now()
   where id = p_user_id;

  update auth.users
     set email_confirmed_at = coalesce(email_confirmed_at, now())
   where id = p_user_id;

  -- The invited role is the user's ONLY role. Since
  -- 20261017000000_add_user_approval_workflow.sql a non-first signup receives
  -- no role at all until an authorized approval, so there is nothing to
  -- supersede here — and the Edge Function can only reach this RPC for an
  -- account it has just created, because auth.admin.createUser refuses an
  -- address that is already registered.
  insert into public.user_roles (user_id, role_id, granted_by, granted_at)
  values (p_user_id, v_role_id, p_executor_id, now())
  on conflict (user_id, role_id) do nothing;

  -- `audit_action` is an enum; the exact event name lives in metadata rather
  -- than in a new enum value that could not be used in the same transaction
  -- (same convention as admin_approve_user).
  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
  values (
    p_executor_id,
    'user.created'::public.audit_action,
    'user',
    p_user_id::text,
    jsonb_build_object(
      'event', 'user.invited',
      'executor_role', v_executor_role,
      'granted_role', v_role_slug
    )
  );

  return jsonb_build_object(
    'user_id', p_user_id,
    'granted_role', v_role_slug
  );
end;
$$;

revoke all on function public.admin_invite_user(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.admin_invite_user(uuid, text, uuid) to service_role;

comment on function public.admin_invite_user(uuid, text, uuid) is
  'Service-only: approves, activates and email-confirms an already-created Auth account, then grants exactly one of viewer/editor/admin/executive (never owner or any is_super_admin role). Writes audit_logs event=user.invited. Never receives a password.';

-- ---------------------------------------------------------------------------
-- 2. admin_verify_password_reset_authority — read-only gate, NO state change
-- ---------------------------------------------------------------------------
-- Called by `admin-set-password` before it writes a password to GoTrue. The
-- actual credential write happens outside SQL (auth.admin.updateUserById), so
-- this function is the only place the decision is authorised.
create or replace function public.admin_verify_password_reset_authority(
  p_user_id uuid,
  p_executor_id uuid
) returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_executor_role text;
begin
  if p_user_id is null or p_executor_id is null then
    raise exception 'invalid_action' using errcode = '22023';
  end if;

  -- Executor authority, identical predicate to the other admin RPCs. The row
  -- lock is not a data write; it closes the window in which the executor could
  -- lose owner/super_admin between this check and the GoTrue write.
  perform 1
     from public.profiles
    where id = p_executor_id
      and approval_status = 'approved'
      and status = 'active'
    for update;
  if not found then
    raise exception 'permission_denied' using errcode = '42501';
  end if;

  select r.slug
    into v_executor_role
    from public.user_roles as ur
    join public.roles as r on r.id = ur.role_id
   where ur.user_id = p_executor_id
     and r.slug in ('owner', 'super_admin')
   order by case when r.slug = 'owner' then 0 else 1 end
   limit 1;
  if v_executor_role is null then
    raise exception 'permission_denied' using errcode = '42501';
  end if;

  -- Target eligibility: an approved, active account. A pending signup has no
  -- session to recover, and a suspended account must be reactivated first.
  perform 1
     from public.profiles
    where id = p_user_id
      and approval_status = 'approved'
      and status = 'active';
  if not found then
    raise exception 'user_not_found' using errcode = 'P0002';
  end if;

  -- The original owner's password can never be set by another administrator.
  -- Reuses the existing helper from 20261017010000_protect_original_owner.sql
  -- rather than restating the predicate, so both stay in step.
  if public.is_original_owner(p_user_id) then
    raise log 'owner_protection: password reset refused actor=% target=%', p_executor_id, p_user_id;
    raise exception 'owner_protection: owner password cannot be reset' using errcode = '42501';
  end if;

  -- Nothing to return and nothing to write: reaching the end of the body IS
  -- the positive verdict.
end;
$$;

revoke all on function public.admin_verify_password_reset_authority(uuid, uuid) from public, anon, authenticated;
grant execute on function public.admin_verify_password_reset_authority(uuid, uuid) to service_role;

comment on function public.admin_verify_password_reset_authority(uuid, uuid) is
  'Service-only, READ-ONLY gate: confirms the executor holds owner/super_admin and that the target is approved, active and not the original owner. Writes nothing; returning without raising is the authorization. Does not lock or claim a queue row (hence not named claim_*).';

-- ---------------------------------------------------------------------------
-- 3. admin_record_password_reset — audit trail, written after the GoTrue write
-- ---------------------------------------------------------------------------
create or replace function public.admin_record_password_reset(
  p_user_id uuid,
  p_executor_id uuid
) returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_executor_role text;
begin
  if p_user_id is null or p_executor_id is null then
    raise exception 'invalid_action' using errcode = '22023';
  end if;

  -- Re-check authority even though the verify gate already ran: the password
  -- has been written by the time we get here, and an executor who lost
  -- owner/super_admin in between must not be able to author the audit record.
  perform 1
     from public.profiles
    where id = p_executor_id
      and approval_status = 'approved'
      and status = 'active';
  if not found then
    raise exception 'permission_denied' using errcode = '42501';
  end if;

  select r.slug
    into v_executor_role
    from public.user_roles as ur
    join public.roles as r on r.id = ur.role_id
   where ur.user_id = p_executor_id
     and r.slug in ('owner', 'super_admin')
   order by case when r.slug = 'owner' then 0 else 1 end
   limit 1;
  if v_executor_role is null then
    raise exception 'permission_denied' using errcode = '42501';
  end if;

  perform 1 from public.profiles where id = p_user_id;
  if not found then
    raise exception 'user_not_found' using errcode = 'P0002';
  end if;

  if public.is_original_owner(p_user_id) then
    raise log 'owner_protection: password reset audit refused actor=% target=%', p_executor_id, p_user_id;
    raise exception 'owner_protection: owner password cannot be reset' using errcode = '42501';
  end if;

  -- The metadata intentionally carries NO credential material: neither the
  -- plaintext nor a hash. The audit trail records who acted on whom and when;
  -- the password itself existed only in the Edge Function and on screen.
  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
  values (
    p_executor_id,
    'user.updated'::public.audit_action,
    'user',
    p_user_id::text,
    jsonb_build_object(
      'event', 'user.password_reset_by_admin',
      'executor_role', v_executor_role
    )
  );
end;
$$;

revoke all on function public.admin_record_password_reset(uuid, uuid) from public, anon, authenticated;
grant execute on function public.admin_record_password_reset(uuid, uuid) to service_role;

comment on function public.admin_record_password_reset(uuid, uuid) is
  'Service-only: writes the audit trail (event=user.password_reset_by_admin) after an admin-initiated password has been written to GoTrue. Re-verifies executor authority and owner protection. Stores no credential material of any kind.';
