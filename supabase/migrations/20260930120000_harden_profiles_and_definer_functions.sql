-- Security hardening for the core schema.
--
--   1. profiles: authenticated users may only UPDATE a whitelist of
--      self-service columns (column level privileges).
--   2. SECURITY DEFINER helpers are no longer executable by PUBLIC / anon.
--   3. write_audit_log only accepts calls from active, signed-in users.
--   4. A BEFORE UPDATE trigger blocks non-admins from changing status/email
--      (defense in depth on top of the column privileges).
--   5. Admins change a user's status through a checked RPC, because the
--      column privileges above also apply to admins using the anon/auth API.

-- ---------------------------------------------------------------------------
-- 1) Column level UPDATE privileges on public.profiles
-- ---------------------------------------------------------------------------
revoke update on table public.profiles from authenticated;
revoke update on table public.profiles from anon;

grant update (full_name, avatar_url, phone, preferred_theme, preferred_locale)
  on table public.profiles
  to authenticated;

-- ---------------------------------------------------------------------------
-- 2) Lock down SECURITY DEFINER functions
-- ---------------------------------------------------------------------------
revoke execute on function public.has_permission(text) from public, anon;
revoke execute on function public.is_admin() from public, anon;
revoke execute on function public.write_audit_log(public.audit_action, text, text, jsonb)
  from public, anon;
revoke execute on function public.handle_new_user() from public, anon, authenticated;

grant execute on function public.has_permission(text) to authenticated, service_role;
grant execute on function public.is_admin() to authenticated, service_role;
grant execute on function public.write_audit_log(public.audit_action, text, text, jsonb)
  to authenticated, service_role;

-- New functions must be granted explicitly from now on.
alter default privileges in schema public revoke execute on functions from public;
alter default privileges in schema public revoke execute on functions from anon;

-- ---------------------------------------------------------------------------
-- 3) Helper: is the caller an active, signed-in user?
-- ---------------------------------------------------------------------------
create or replace function public.is_active_user()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.status = 'active'
  );
$$;

revoke execute on function public.is_active_user() from public, anon;
grant execute on function public.is_active_user() to authenticated, service_role;

-- Only active users may write audit entries; the actor is always auth.uid().
create or replace function public.write_audit_log(
  p_action public.audit_action,
  p_entity text default null,
  p_entity_id text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or not public.is_active_user() then
    raise exception 'write_audit_log: caller is not an active authenticated user'
      using errcode = '42501';
  end if;

  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
  values (auth.uid(), p_action, p_entity, p_entity_id, coalesce(p_metadata, '{}'::jsonb));
end;
$$;

-- CREATE OR REPLACE keeps existing privileges, restate them for clarity.
revoke execute on function public.write_audit_log(public.audit_action, text, text, jsonb)
  from public, anon;
grant execute on function public.write_audit_log(public.audit_action, text, text, jsonb)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4) Guard trigger: only admins / trusted backends may change status or email
-- ---------------------------------------------------------------------------
-- SECURITY INVOKER on purpose: `current_user` must reflect the real caller.
-- (Inside a SECURITY DEFINER function it would always be the owner, which
-- would silently turn the "trusted context" branch below into a bypass.)
create or replace function public.guard_profile_protected_columns()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.status is not distinct from old.status
     and new.email is not distinct from old.email then
    return new;
  end if;

  -- Trusted server-side contexts: the service_role key, migrations, and
  -- SECURITY DEFINER routines owned by postgres (e.g. admin_set_user_status),
  -- which run with current_user = owner.
  if current_user in ('service_role', 'postgres', 'supabase_admin') then
    return new;
  end if;

  if public.is_admin() then
    return new;
  end if;

  raise exception 'Only administrators can change profile status or email'
    using errcode = '42501';
end;
$$;

revoke execute on function public.guard_profile_protected_columns() from public, anon, authenticated;

drop trigger if exists profiles_guard_protected_columns on public.profiles;
create trigger profiles_guard_protected_columns
  before update on public.profiles
  for each row execute function public.guard_profile_protected_columns();

-- ---------------------------------------------------------------------------
-- 5) Admin RPC to change a user's status (audited)
-- ---------------------------------------------------------------------------
create or replace function public.admin_set_user_status(
  p_user_id uuid,
  p_status public.user_status
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'admin_set_user_status: administrator privileges required'
      using errcode = '42501';
  end if;

  if p_user_id = auth.uid() and p_status <> 'active' then
    raise exception 'admin_set_user_status: administrators cannot suspend themselves'
      using errcode = '42501';
  end if;

  update public.profiles
     set status = p_status
   where id = p_user_id;

  if not found then
    raise exception 'admin_set_user_status: user % not found', p_user_id
      using errcode = 'P0002';
  end if;

  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
  values (
    auth.uid(),
    case when p_status = 'suspended' then 'user.suspended'::public.audit_action
         else 'user.updated'::public.audit_action end,
    'profiles',
    p_user_id::text,
    jsonb_build_object('status', p_status)
  );
end;
$$;

revoke execute on function public.admin_set_user_status(uuid, public.user_status) from public, anon;
grant execute on function public.admin_set_user_status(uuid, public.user_status)
  to authenticated, service_role;
