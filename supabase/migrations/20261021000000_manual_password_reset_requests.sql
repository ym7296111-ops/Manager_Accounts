-- Manual password reset approval flow (interim recovery path).
--
-- Free mail providers make self-service OTP recovery impractical on this
-- template today (e.g. the Resend sandbox address `onboarding@resend.dev`
-- only delivers to the account owner's own mailbox). Until a verified SMTP
-- domain exists, "forgot password" becomes a REQUEST that an owner or
-- super_admin approves:
--
--   visitor (anon)          → INSERT into public.password_reset_requests
--   owner / super_admin     → SELECT the queue, then approve/reject through
--                             the service-only Edge Function
--                             `admin-reset-password`, which writes the new
--                             password with supabase.auth.admin.updateUserById.
--
-- SECURITY WARNING — plaintext at rest while pending:
--   `new_password` stores the requested password IN PLAINTEXT for as long as
--   the row is pending. The table is therefore locked down hard: RLS allows
--   INSERT for everyone but SELECT/UPDATE only for owner/super_admin, the
--   finalize RPC wipes the password the moment the row leaves 'pending', and
--   operators are asked (README → "Password Recovery: Current State & Future
--   Reference") to purge processed rows periodically.
--
-- Forward-only and replay-safe: every statement is guarded (if not exists /
-- drop-then-create policies / create or replace functions).

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------
create table if not exists public.password_reset_requests (
  id uuid primary key default gen_random_uuid(),
  -- Normalized on the client before INSERT; the check makes the unique
  -- pending index and the auth.users lookup case-safe.
  email text not null,
  -- Plaintext ONLY while pending (see warning above). The lifecycle check
  -- guarantees a pending row always carries a password and a processed row
  -- never does.
  new_password text,
  status varchar(20) not null default 'pending'
    check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  processed_at timestamptz,
  processed_by uuid references public.profiles (id) on delete set null,
  constraint password_reset_requests_email_normalized
    check (email = lower(btrim(email)) and length(email) between 3 and 320),
  constraint password_reset_requests_password_lifecycle
    check (
      (status = 'pending' and new_password is not null)
      or (status <> 'pending' and new_password is null)
    )
);

comment on table public.password_reset_requests is
  'Interim manual-approval password recovery queue. new_password is PLAINTEXT while pending and is wiped by admin_finalize_password_reset_request the moment the row is approved/rejected. INSERT is public; SELECT/UPDATE are owner/super_admin only (RLS).';

-- Queue listing (admin UI) reads by status, newest first.
create index if not exists password_reset_requests_status_created_idx
  on public.password_reset_requests (status, created_at desc);

-- One open request per address: a duplicate submit while a request is still
-- pending is refused (23505) instead of flooding the admin queue.
create unique index if not exists password_reset_requests_one_pending_per_email
  on public.password_reset_requests (email)
  where status = 'pending';

-- ---------------------------------------------------------------------------
-- Authorization helper (RLS mirror of the executor check inside the RPCs)
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER avoids recursive profile RLS; the function reveals only a
-- boolean. Same authority as admin_approve_user: an ACTIVE, APPROVED profile
-- holding the 'owner' or 'super_admin' role — never a role name shown to UI.
create or replace function public.is_password_reset_admin()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
      from public.profiles as p
      join public.user_roles as ur on ur.user_id = p.id
      join public.roles as r on r.id = ur.role_id
     where p.id = auth.uid()
       and p.status = 'active'
       and p.approval_status = 'approved'
       and r.slug in ('owner', 'super_admin')
  );
$$;
revoke all on function public.is_password_reset_admin() from public, anon;
grant execute on function public.is_password_reset_admin() to authenticated, service_role;
comment on function public.is_password_reset_admin() is
  'TRUE when the caller (auth.uid()) is an active, approved holder of owner/super_admin — the only roles allowed to read or transition password_reset_requests.';

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
alter table public.password_reset_requests enable row level security;

-- Everyone (including anonymous visitors locked out of their account) may
-- SUBMIT a request — but only a well-formed pending one: no pre-approved
-- rows, no processed metadata from the client.
drop policy if exists password_reset_requests_public_insert on public.password_reset_requests;
create policy password_reset_requests_public_insert on public.password_reset_requests
  for insert to anon, authenticated
  with check (status = 'pending' and processed_at is null and processed_by is null);

-- The queue is readable ONLY by owner/super_admin. No policy exists for anon,
-- and there is deliberately no DELETE policy: purging processed rows is an
-- operator task (SQL editor / scheduled job), not an API operation.
drop policy if exists password_reset_requests_admin_select on public.password_reset_requests;
create policy password_reset_requests_admin_select on public.password_reset_requests
  for select to authenticated
  using (public.is_password_reset_admin());

drop policy if exists password_reset_requests_admin_update on public.password_reset_requests;
create policy password_reset_requests_admin_update on public.password_reset_requests
  for update to authenticated
  using (public.is_password_reset_admin())
  with check (public.is_password_reset_admin());

-- Same approved-accounts-only fence every other RLS table received in
-- 20261017000000 (that migration's loop only covered tables existing then).
drop policy if exists approved_access_only on public.password_reset_requests;
create policy approved_access_only on public.password_reset_requests
  as restrictive for all to authenticated
  using (public.is_approved_user())
  with check (public.is_approved_user());

-- Explicit grants (never rely on auto-exposed defaults for a table holding
-- plaintext passwords): anon may ONLY insert; authenticated reads/updates
-- strictly through the policies above.
revoke all on public.password_reset_requests from public;
revoke all on public.password_reset_requests from anon;
revoke all on public.password_reset_requests from authenticated;
grant insert on public.password_reset_requests to anon;
grant insert, select, update on public.password_reset_requests to authenticated;
revoke all on public.password_reset_requests from service_role;
grant select, insert, update, delete on public.password_reset_requests to service_role;

-- ---------------------------------------------------------------------------
-- Service-only RPCs (Edge Function `admin-reset-password` is the sole caller)
-- ---------------------------------------------------------------------------
-- Approval is a two-phase commit around the GoTrue admin API:
--
--   1. admin_claim_password_reset_request  — re-checks the executor, locks the
--      pending row, resolves the auth.users id behind the requested email and
--      hands the plaintext password to the trusted proxy. NO state change.
--   2. the proxy writes the password (supabase.auth.admin.updateUserById).
--   3. admin_finalize_password_reset_request — moves the row to
--      approved/rejected, WIPES new_password, stamps processed_at/by and
--      writes the audit trail. Rejection skips phases 1–2 entirely.
--
-- If phase 2 fails the row stays pending and can be retried; if phase 3 fails
-- after a successful password write the row also stays pending and a retry is
-- idempotent (the same password is written again).

create or replace function public.admin_claim_password_reset_request(
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

  -- Executor authority: active + approved profile holding owner/super_admin.
  perform 1
     from public.profiles
    where id = p_executor_id
      and approval_status = 'approved'
      and status = 'active'
    for update;
  if not found then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  if not exists (
    select 1
      from public.user_roles as ur
      join public.roles as r on r.id = ur.role_id
     where ur.user_id = p_executor_id
       and r.slug in ('owner', 'super_admin')
  ) then
    raise exception 'permission_denied' using errcode = '42501';
  end if;

  select pr.id, pr.email, pr.new_password, pr.status
    into v_request
    from public.password_reset_requests as pr
   where pr.id = p_request_id
   for update;
  if not found then
    raise exception 'request_not_found' using errcode = 'P0002';
  end if;
  if v_request.status <> 'pending' then
    raise exception 'invalid_transition' using errcode = '22023';
  end if;

  -- Resolve the Auth account behind the requested email. The row is stored
  -- lowercased; auth.users.email is matched case-insensitively.
  select u.id
    into v_auth_user_id
    from auth.users as u
   where lower(u.email::text) = v_request.email
   limit 1;
  if v_auth_user_id is null then
    raise exception 'user_not_found' using errcode = 'P0002';
  end if;

  return jsonb_build_object(
    'request_id', v_request.id,
    'email', v_request.email,
    'new_password', v_request.new_password,
    'auth_user_id', v_auth_user_id
  );
end;
$$;
revoke all on function public.admin_claim_password_reset_request(uuid, uuid) from public, anon, authenticated;
grant execute on function public.admin_claim_password_reset_request(uuid, uuid) to service_role;
comment on function public.admin_claim_password_reset_request(uuid, uuid) is
  'Service-only: verifies the executor (owner/super_admin), locks a PENDING password_reset_requests row, resolves the auth.users id behind its email and returns {request_id,email,new_password,auth_user_id} for the GoTrue admin write. Never mutates state.';

create or replace function public.admin_finalize_password_reset_request(
  p_request_id uuid,
  p_action varchar(20),
  p_executor_id uuid
) returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_request record;
begin
  if p_request_id is null or p_executor_id is null
     or p_action is null or p_action not in ('approve', 'reject') then
    raise exception 'invalid_action' using errcode = '22023';
  end if;

  -- Executor authority: active + approved profile holding owner/super_admin.
  perform 1
     from public.profiles
    where id = p_executor_id
      and approval_status = 'approved'
      and status = 'active'
    for update;
  if not found then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  if not exists (
    select 1
      from public.user_roles as ur
      join public.roles as r on r.id = ur.role_id
     where ur.user_id = p_executor_id
       and r.slug in ('owner', 'super_admin')
  ) then
    raise exception 'permission_denied' using errcode = '42501';
  end if;

  select pr.id, pr.email, pr.status
    into v_request
    from public.password_reset_requests as pr
   where pr.id = p_request_id
   for update;
  if not found then
    raise exception 'request_not_found' using errcode = 'P0002';
  end if;
  -- A row already approved/rejected can never transition again.
  if v_request.status <> 'pending' then
    raise exception 'invalid_transition' using errcode = '22023';
  end if;

  update public.password_reset_requests
     set status = case when p_action = 'approve' then 'approved' else 'rejected' end,
         -- The plaintext password never outlives the pending state.
         new_password = null,
         processed_at = now(),
         processed_by = p_executor_id
   where id = p_request_id;

  -- audit_action is an enum; the exact event name lives in metadata (same
  -- convention as the approval workflow).
  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
  values (
    p_executor_id,
    'user.updated'::public.audit_action,
    'password_reset_requests',
    p_request_id::text,
    jsonb_build_object(
      'event', case when p_action = 'approve'
                    then 'password_reset.approved'
                    else 'password_reset.rejected' end,
      'target_email', v_request.email
    )
  );
end;
$$;
revoke all on function public.admin_finalize_password_reset_request(uuid, varchar, uuid) from public, anon, authenticated;
grant execute on function public.admin_finalize_password_reset_request(uuid, varchar, uuid) to service_role;
comment on function public.admin_finalize_password_reset_request(uuid, varchar, uuid) is
  'Service-only: verifies the executor (owner/super_admin) and moves a PENDING password_reset_requests row to approved/rejected, wiping new_password, stamping processed_at/processed_by and writing the audit trail.';
