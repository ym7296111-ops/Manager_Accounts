-- Close the lifecycle of owner-directed queue notifications when their source
-- request is approved or rejected. Forward-only: no existing objects are dropped.

alter table public.user_notifications
  add column if not exists related_id uuid,
  add column if not exists resolved_at timestamptz;

comment on column public.user_notifications.related_id is
  'Identifier of the source request (target user id for approval requests, password_reset_requests.id for reset requests).';
comment on column public.user_notifications.resolved_at is
  'Timestamp when the source request was approved or rejected; resolved notifications are also marked read.';

-- Recover associations for notifications created before this migration. The
-- stable dedupe keys already encode each source UUID; join against the source
-- tables instead of casting untrusted text. Then close rows whose source is
-- already processed, so existing stale badges are cleared on deployment.
update public.user_notifications as n
   set related_id = p.id
  from public.profiles as p
 where n.type = 'user_approval_requested'
   and n.related_id is null
   and n.dedupe_key = format('user_approval_requested:%s', p.id);

update public.user_notifications as n
   set related_id = r.id
  from public.password_reset_requests as r
 where n.type = 'password_reset_requested'
   and n.related_id is null
   and n.dedupe_key = format('password_reset_requested:%s', r.id);

update public.user_notifications as n
   set resolved_at = coalesce(n.resolved_at, now()),
       is_read = true,
       read_at = coalesce(n.read_at, now())
  from public.profiles as p
 where n.type = 'user_approval_requested'
   and n.related_id = p.id
   and p.approval_status in ('approved', 'rejected');

update public.user_notifications as n
   set resolved_at = coalesce(n.resolved_at, now()),
       is_read = true,
       read_at = coalesce(n.read_at, now())
  from public.password_reset_requests as r
 where n.type = 'password_reset_requested'
   and n.related_id = r.id
   and r.status in ('approved', 'rejected');

create index if not exists user_notifications_related_open_idx
  on public.user_notifications (type, related_id)
  where related_id is not null and resolved_at is null;

-- Keep the existing four-argument enqueue contract. This overload adds the
-- source identifier after fan-out; both operations remain in the trigger's
-- exception subtransaction, so notification failures never abort the cause.
create or replace function public.enqueue_user_notification(
  p_type text,
  p_subject_id uuid,
  p_dedupe_key text,
  p_link text,
  p_related_id uuid
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_inserted integer;
begin
  v_inserted := public.enqueue_user_notification(
    p_type,
    p_subject_id,
    p_dedupe_key,
    p_link
  );

  if p_related_id is not null then
    update public.user_notifications
       set related_id = p_related_id
     where type = p_type
       and dedupe_key = p_dedupe_key
       and related_id is distinct from p_related_id;
  end if;

  return v_inserted;
end;
$$;
revoke all on function public.enqueue_user_notification(text, uuid, text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.enqueue_user_notification(text, uuid, text, text, uuid)
  to service_role;
comment on function public.enqueue_user_notification(text, uuid, text, text, uuid) is
  'Service-only overload: fans out through the stable four-argument helper and tags each idempotent row with its source request id.';

create or replace function public.resolve_related_notifications(
  p_related_id uuid,
  p_type text
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_rows integer;
begin
  if p_related_id is null
     or p_type is null
     or p_type not in ('user_approval_requested', 'password_reset_requested') then
    raise exception 'resolve_related_notifications: invalid related id or notification type'
      using errcode = '22023';
  end if;

  update public.user_notifications
     set resolved_at = coalesce(resolved_at, now()),
         is_read = true,
         read_at = coalesce(read_at, now())
   where related_id = p_related_id
     and type = p_type;

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;
revoke all on function public.resolve_related_notifications(uuid, text)
  from public, anon, authenticated;
grant execute on function public.resolve_related_notifications(uuid, text)
  to service_role;
comment on function public.resolve_related_notifications(uuid, text) is
  'Service-only lifecycle transition: resolve every recipient copy of one queue event and clear its unread state.';

-- A new signup waiting for approval -> notify owners and associate each row
-- with the profile id that the owner will approve/reject.
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
      '/settings/system/users',
      new.id
    );
  exception when others then
    raise warning 'in_app_notification: user_approval_requested failed for %: %',
      new.id, sqlerrm;
  end;
  return new;
end;
$$;

-- A manual password-reset request entered the queue -> notify owners and
-- associate each row with the queue request id (not the requester profile id).
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
    select p.id
      into v_requester
      from public.profiles as p
     where lower(btrim(p.email)) = new.email
     limit 1;

    perform public.enqueue_user_notification(
      'password_reset_requested',
      v_requester,
      format('password_reset_requested:%s', new.id),
      '/settings/system/password-resets',
      new.id
    );
  exception when others then
    raise warning 'in_app_notification: password_reset_requested failed for %: %',
      new.id, sqlerrm;
  end;
  return new;
end;
$$;

-- Approval core: retain the existing authorization, role validation, owner
-- protection, and audit behavior; resolve the source queue event atomically
-- after the decision and audit record have succeeded.
create or replace function public.admin_approve_user(
  p_user_id uuid,
  p_action varchar(20),
  p_executor_id uuid,
  p_target_role text
) returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_executor_role text;
  v_old_status text;
  v_granted_role_slug text;
  v_role_id uuid;
begin
  if p_action not in ('approve', 'reject') or p_action is null or p_user_id is null then
    raise exception 'invalid_action' using errcode = '22023';
  end if;

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

  select approval_status
    into v_old_status
    from public.profiles
   where id = p_user_id
   for update;
  if not found then
    raise exception 'user_not_found' using errcode = 'P0002';
  end if;
  if public.is_original_owner(p_user_id) then
    raise log 'owner_protection: approval RPC refused actor=% target=%', p_executor_id, p_user_id;
    raise exception 'owner_protection: owner approval is immutable' using errcode = '42501';
  end if;
  if v_old_status <> 'pending' or p_user_id = p_executor_id then
    raise exception 'invalid_transition' using errcode = '22023';
  end if;

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

  update public.profiles
     set approval_status = case when p_action = 'approve' then 'approved' else 'rejected' end,
         updated_at = now()
   where id = p_user_id;

  if p_action = 'approve' then
    update auth.users
       set email_confirmed_at = coalesce(email_confirmed_at, now())
     where id = p_user_id;
    insert into public.user_roles (user_id, role_id, granted_by, granted_at)
    values (p_user_id, v_role_id, p_executor_id, now())
    on conflict (user_id, role_id) do nothing;
  end if;

  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
  values (
    p_executor_id,
    'user.updated'::public.audit_action,
    'user',
    p_user_id::text,
    jsonb_build_object(
      'event', 'user.approval_' || p_action,
      'executor_role', v_executor_role,
      'old_approval_status', v_old_status,
      'granted_role', case when p_action = 'approve' then v_granted_role_slug else null end
    )
  );

  perform public.resolve_related_notifications(p_user_id, 'user_approval_requested');
end;
$$;

-- Keep legacy RPC signatures, but route them through the lifecycle-aware core
-- so approvals through any supported overload also close the original queue row.
create or replace function public.admin_approve_user(
  p_user_id uuid,
  p_action varchar(20),
  p_executor_id uuid
) returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  perform public.admin_approve_user(p_user_id, p_action, p_executor_id, 'viewer');
end;
$$;

create or replace function public.admin_approve_user(
  p_user_id uuid,
  p_action varchar(20)
) returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  perform public.admin_approve_user(p_user_id, p_action, auth.uid(), 'viewer');
end;
$$;

-- Password-reset finalization: resolve all owner copies after the request state
-- and its audit row have been committed in this same transaction.
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
  if v_request.status <> 'pending' then
    raise exception 'invalid_transition' using errcode = '22023';
  end if;

  update public.password_reset_requests
     set status = case when p_action = 'approve' then 'approved' else 'rejected' end,
         new_password = null,
         processed_at = now(),
         processed_by = p_executor_id
   where id = p_request_id;

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

  perform public.resolve_related_notifications(p_request_id, 'password_reset_requested');
end;
$$;
