-- =============================================================================
-- In-app notification system (bell + dropdown).
--
-- Scope: an in-product notification feed ONLY. No email, no push, no external
-- transport of any kind. This migration deliberately does not touch the
-- existing `notification_*` tables (those are the SMTP/template carrier
-- subsystem), does not touch `public.audit_logs`, and does not touch auth.
--
-- Design decisions recorded in
-- docs/consultations/2026-10-19-granular-role-delegation-feature-proposal.md
-- and the in-app notifications design review:
--   1. Table name is `user_notifications`, NOT `notifications`, to avoid any
--      semantic collision with the `notification_*` mail namespace.
--   2. Content is stored as i18n KEYS + params, never as rendered strings, so
--      the same row renders correctly in both Arabic and English.
--   3. A trigger failure NEVER fails the operation that caused it: every
--      trigger body isolates its work in an exception block and degrades to a
--      WARNING. Losing a notification is acceptable; losing an approval is not.
--   4. Recipient resolution is centralised in ONE function,
--      `resolve_notification_recipients`, so that when granular delegation
--      lands there is a single place to switch from role-slug matching to
--      capability matching.
--   5. Retention is 90 days, enforced by a scheduled prune.
--
-- Applied automatically by .github/workflows/supabase-migration.yml on every
-- push to main.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1) Table
-- ---------------------------------------------------------------------------
create table if not exists public.user_notifications (
  id uuid primary key default gen_random_uuid(),
  -- Cascade, not set null: a deleted account's feed is meaningless. This
  -- differs from audit_logs (a ledger, which keeps actor_id via set null).
  user_id uuid not null references public.profiles (id) on delete cascade,
  type text not null,
  title_key text not null,
  body_key text not null,
  -- Interpolation values only (masked identifiers). Never rendered prose.
  params jsonb not null default '{}'::jsonb,
  -- In-app route only; validated to a relative path below. No external URLs.
  link text,
  is_read boolean not null default false,
  read_at timestamptz,
  -- Stable idempotency key so a replayed trigger cannot duplicate a row.
  dedupe_key text not null,
  created_at timestamptz not null default now(),

  constraint user_notifications_type_check check (
    type in (
      'user_approval_requested',
      'password_reset_requested',
      'user_approved',
      'user_rejected'
    )
  ),
  constraint user_notifications_params_object_check check (
    jsonb_typeof(params) = 'object'
  ),
  constraint user_notifications_link_relative_check check (
    link is null or (link like '/%' and link not like '//%')
  ),
  constraint user_notifications_read_at_consistency check (
    (is_read = false and read_at is null) or (is_read = true and read_at is not null)
  ),
  constraint user_notifications_title_key_shape_check check (
    title_key ~ '^notifications\.type\.[a-z_]+\.(title|body)$'
  ),
  constraint user_notifications_body_key_shape_check check (
    body_key ~ '^notifications\.type\.[a-z_]+\.(title|body)$'
  )
);

comment on table public.user_notifications is
  'In-app notification feed (bell + dropdown). In-product only: no email, no push, no external transport. Content is stored as i18n keys plus masked params, never as rendered strings.';
comment on column public.user_notifications.type is
  'Closed event allowlist: user_approval_requested, password_reset_requested, user_approved, user_rejected.';
comment on column public.user_notifications.params is
  'Interpolation values only (masked identifiers such as l***@example.invalid). Never rendered prose and never a credential.';
comment on column public.user_notifications.link is
  'Relative in-app route only. External/protocol-relative URLs are refused by a CHECK constraint.';
comment on column public.user_notifications.dedupe_key is
  'Idempotency key scoped per recipient; a replayed trigger cannot duplicate a notification.';

-- One open row per (recipient, event). Partial-free: the key is always present.
create unique index if not exists user_notifications_recipient_dedupe_idx
  on public.user_notifications (user_id, dedupe_key);

-- The bell query: unread first, newest first, for one recipient.
create index if not exists user_notifications_feed_idx
  on public.user_notifications (user_id, created_at desc);
create index if not exists user_notifications_unread_idx
  on public.user_notifications (user_id, is_read)
  where is_read = false;

-- Retention sweep scans by age across all recipients.
create index if not exists user_notifications_created_at_idx
  on public.user_notifications (created_at);

-- ---------------------------------------------------------------------------
-- 2) Row level security
-- ---------------------------------------------------------------------------
-- FORCE as defense in depth: even a table owner / BYPASSRLS-less superuser path
-- through the API cannot skip the policy.
alter table public.user_notifications enable row level security;
alter table public.user_notifications force row level security;

-- Ownership only, never capability. A pending or rejected account has an EMPTY
-- capability set (see useAuthCapabilities), yet it is exactly the account that
-- must receive "your request was approved". Capability gating here would make
-- the bell unusable for the users who need it most.
drop policy if exists "Users read their own notifications" on public.user_notifications;
create policy "Users read their own notifications"
  on public.user_notifications for select
  using (user_id = auth.uid());

-- No INSERT / UPDATE / DELETE policy on purpose: every mutation goes through a
-- SECURITY DEFINER function below, mirroring user_roles / role_permissions.

-- Close the direct write path; reading stays for the owner's own rows.
revoke all on table public.user_notifications from public, anon;
grant select on table public.user_notifications to authenticated;
revoke insert, update, delete, truncate, references, trigger
  on table public.user_notifications
  from authenticated, anon;

-- ---------------------------------------------------------------------------
-- 3) Recipient resolution — THE single point of change
-- ---------------------------------------------------------------------------
-- Today this matches the role slugs 'owner' / 'super_admin', which is exactly
-- the authority `admin_approve_user` and `is_password_reset_admin()` already
-- require. When granular delegation (Capabilities) lands, ONLY this function
-- changes: switch the owner-directed branch from role-slug matching to
-- `has_permission('<capability>')`.
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
  -- Owner-directed queue events.
  if p_type in ('user_approval_requested', 'password_reset_requested') then
    return query
      select ur.user_id
        from public.user_roles as ur
        join public.roles as r on r.id = ur.role_id
        join public.profiles as p on p.id = ur.user_id
       where r.slug in ('owner', 'super_admin')
         and p.status = 'active'
         and p.approval_status = 'approved'
       group by ur.user_id;
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
  'Single point of change for notification fan-out. Owner-directed events currently resolve by role slug (owner/super_admin); switch this one function to capability matching when granular delegation lands.';

-- ---------------------------------------------------------------------------
-- 4) Enqueue helper (fan-out + idempotent insert)
-- ---------------------------------------------------------------------------
create or replace function public.enqueue_user_notification(
  p_type text,
  p_subject_id uuid,
  p_dedupe_key text,
  p_link text
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_recipient uuid;
  v_inserted integer := 0;
  v_rows integer;
  v_subject_email text;
  v_subject_name text;
  v_params jsonb;
  v_title_key text;
  v_body_key text;
begin
  if p_dedupe_key is null or length(btrim(p_dedupe_key)) = 0 then
    raise exception 'enqueue_user_notification: dedupe_key is required'
      using errcode = '22023';
  end if;

  v_title_key := format('notifications.type.%s.title', p_type);
  v_body_key := format('notifications.type.%s.body', p_type);

  -- Params: owner-directed rows carry a MASKED identifier for the subject, so
  -- an owner can tell two queue items apart without the feed becoming a place
  -- where addresses accumulate in clear text.
  if p_type in ('user_approval_requested', 'password_reset_requested') then
    select lower(btrim(p.email)), coalesce(nullif(btrim(p.full_name), ''), null)
      into v_subject_email, v_subject_name
      from public.profiles as p
     where p.id = p_subject_id;

    v_params := jsonb_strip_nulls(
      jsonb_build_object(
        'subject_email',
        regexp_replace(
          coalesce(v_subject_email, ''),
          '([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*(@[A-Za-z0-9.-]+\.[A-Za-z]{2,})',
          '\1***\2',
          'gi'
        ),
        'subject_name', v_subject_name
      )
    );
  else
    v_params := '{}'::jsonb;
  end if;

  for v_recipient in
    select r.recipient
      from public.resolve_notification_recipients(p_type, p_subject_id) as r(recipient)
  loop
    insert into public.user_notifications (
      user_id, type, title_key, body_key, params, link, dedupe_key
    )
    values (
      v_recipient, p_type, v_title_key, v_body_key, v_params, p_link, p_dedupe_key
    )
    on conflict (user_id, dedupe_key) do nothing;

    get diagnostics v_rows = row_count;
    v_inserted := v_inserted + v_rows;
  end loop;

  return v_inserted;
end;
$$;

revoke all on function public.enqueue_user_notification(text, uuid, text, text) from public, anon;
grant execute on function public.enqueue_user_notification(text, uuid, text, text) to service_role;

comment on function public.enqueue_user_notification(text, uuid, text, text) is
  'Internal fan-out helper. Service-only: trigger functions are SECURITY DEFINER and call it directly, so the browser never needs EXECUTE.';

-- ---------------------------------------------------------------------------
-- 5) Trigger functions
-- ---------------------------------------------------------------------------
-- Every body wraps its work in an exception block: a notification failure
-- degrades to a WARNING and the originating operation still commits.

-- (a) A new signup is waiting for approval -> notify the owners.
create or replace function public.handle_approval_request_notification()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  begin
    perform public.enqueue_user_notification(
      'user_approval_requested',
      new.id,
      format('user_approval_requested:%s', new.id),
      '/settings/system/users'
    );
  exception when others then
    raise warning 'in_app_notification: user_approval_requested failed for %: %',
      new.id, sqlerrm;
  end;
  return new;
end;
$$;

-- (b) A manual password reset request entered the queue -> notify the owners.
create or replace function public.handle_password_reset_request_notification()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_requester uuid;
begin
  begin
    -- The queue row is keyed by email; resolve the owning profile when one
    -- exists so the masked param is meaningful. A null subject is fine: the
    -- params helper tolerates it.
    select p.id
      into v_requester
      from public.profiles as p
     where lower(btrim(p.email)) = new.email
     limit 1;

    perform public.enqueue_user_notification(
      'password_reset_requested',
      v_requester,
      format('password_reset_requested:%s', new.id),
      '/settings/system/password-resets'
    );
  exception when others then
    raise warning 'in_app_notification: password_reset_requested failed for %: %',
      new.id, sqlerrm;
  end;
  return new;
end;
$$;

-- (c) An approval decision was made -> notify the affected account.
create or replace function public.handle_approval_status_notification()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_type text;
begin
  begin
    v_type := case new.approval_status
      when 'approved' then 'user_approved'
      when 'rejected' then 'user_rejected'
      else null
    end;

    if v_type is not null then
      perform public.enqueue_user_notification(
        v_type,
        new.id,
        format('%s:%s', v_type, new.id),
        '/profile'
      );
    end if;
  exception when others then
    raise warning 'in_app_notification: approval decision failed for %: %',
      new.id, sqlerrm;
  end;
  return new;
end;
$$;

revoke all on function public.handle_approval_request_notification() from public, anon;
revoke all on function public.handle_password_reset_request_notification() from public, anon;
revoke all on function public.handle_approval_status_notification() from public, anon;

-- ---------------------------------------------------------------------------
-- 6) Triggers
-- ---------------------------------------------------------------------------
drop trigger if exists profiles_notify_approval_request on public.profiles;
create trigger profiles_notify_approval_request
  after insert on public.profiles
  for each row
  when (new.approval_status = 'pending')
  execute function public.handle_approval_request_notification();

drop trigger if exists password_reset_requests_notify on public.password_reset_requests;
create trigger password_reset_requests_notify
  after insert on public.password_reset_requests
  for each row
  when (new.status = 'pending')
  execute function public.handle_password_reset_request_notification();

drop trigger if exists profiles_notify_approval_status on public.profiles;
create trigger profiles_notify_approval_status
  after update of approval_status on public.profiles
  for each row
  when (
    old.approval_status is distinct from new.approval_status
    and new.approval_status in ('approved', 'rejected')
  )
  execute function public.handle_approval_status_notification();

-- ---------------------------------------------------------------------------
-- 7) Client RPCs (read stays a plain RLS-filtered SELECT)
-- ---------------------------------------------------------------------------
create or replace function public.mark_notification_read(p_notification_id uuid)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_rows integer;
begin
  if auth.uid() is null then
    raise exception 'permission_denied' using errcode = '42501';
  end if;

  update public.user_notifications as n
     set is_read = true,
         read_at = coalesce(n.read_at, now())
   where n.id = p_notification_id
     and n.user_id = auth.uid()
     and n.is_read = false;

  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

create or replace function public.mark_all_notifications_read()
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_rows integer;
begin
  if auth.uid() is null then
    raise exception 'permission_denied' using errcode = '42501';
  end if;

  update public.user_notifications as n
     set is_read = true,
         read_at = coalesce(n.read_at, now())
   where n.user_id = auth.uid()
     and n.is_read = false;

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

revoke all on function public.mark_notification_read(uuid) from public, anon;
revoke all on function public.mark_all_notifications_read() from public, anon;
grant execute on function public.mark_notification_read(uuid) to authenticated;
grant execute on function public.mark_all_notifications_read() to authenticated, service_role;

comment on function public.mark_notification_read(uuid) is
  'Marks one of the CALLER''S notifications read. Ownership is enforced in the WHERE clause, so another user''s id is a no-op rather than an oracle.';
comment on function public.mark_all_notifications_read() is
  'Marks every unread notification of the CALLER read and returns how many changed.';

-- ---------------------------------------------------------------------------
-- 8) Retention (90 days)
-- ---------------------------------------------------------------------------
create or replace function public.prune_expired_user_notifications()
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_rows integer;
begin
  delete from public.user_notifications as n
   where n.created_at < now() - interval '90 days';

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

revoke all on function public.prune_expired_user_notifications() from public, anon, authenticated;
grant execute on function public.prune_expired_user_notifications() to service_role;

comment on function public.prune_expired_user_notifications() is
  'Deletes in-app notifications older than 90 days. Scheduled below; never exposed to the browser.';

do $retention_job$
declare
  v_job_id bigint;
  v_command constant text := $command$select public.prune_expired_user_notifications();$command$;
begin
  for v_job_id in
    select j.jobid
      from cron.job as j
     where j.jobname = 'prune-expired-user-notifications-daily-0315'
       and j.database = current_database()
       and j.username = current_user
  loop
    perform cron.unschedule(v_job_id);
  end loop;

  perform cron.schedule(
    'prune-expired-user-notifications-daily-0315',
    '15 3 * * *',
    v_command
  );
end;
$retention_job$;

-- ---------------------------------------------------------------------------
-- 9) Realtime publication (invalidation signal only)
-- ---------------------------------------------------------------------------
-- Default replica identity (primary key only) is deliberate: the wire carries
-- an id, never a column value. Clients treat the event as a cache-invalidation
-- signal and refetch over PostgREST under RLS — the same contract the profiles
-- realtime migration documents.
do $realtime_publication$
begin
  if not exists (
    select 1
      from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'user_notifications'
  ) then
    alter publication supabase_realtime add table public.user_notifications;
  end if;
end;
$realtime_publication$;
