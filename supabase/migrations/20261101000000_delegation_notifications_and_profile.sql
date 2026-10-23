-- =============================================================================
-- 20261101000000_delegation_notifications_and_profile.sql
--
-- Complete the capability-delegation lifecycle on the notification & self-service
-- visibility side (forward-only; grant/revoke RPC bodies stay untouched):
--
--   1. Extend `public.user_notifications`:
--      * Add structured `metadata jsonb` column (object-checked).
--      * Allow `'delegation_event'` in `user_notifications_type_check`
--        (covering `granted`, `revoked`, and `expiring` events).
--   2. Lifecycle triggers on `public.user_capabilities`:
--      * AFTER INSERT -> notify delegatee (`event = 'granted'`).
--      * AFTER UPDATE OF revoked_at -> resolve open expiry notices + notify
--        delegatee (`event = 'revoked'`).
--      * AFTER UPDATE OF expires_at -> resolve stale expiry notices upon renewal.
--      Every trigger isolates notification work inside an EXCEPTION block so a
--      feed failure can never abort a grant, renewal, or revocation.
--   3. Scheduled expiry sweep `public.generate_delegation_expiry_notifications()`:
--      * Scans live expiring grants (`expires_at BETWEEN now() AND now() + 7d`).
--      * Emits deduplicated `T-7` / `T-1` notices to both `granted_by` and `user_id`
--        using `delegation_expiring:<capability_id>:<window>:<user_id>`.
--      * Scheduled daily at 03:20 UTC via `pg_cron`.
--   4. Self-service profile read RPCs:
--      * `public.get_my_delegated_capabilities()` — active delegations for `auth.uid()`.
--      * `public.get_my_roles()` — current assigned roles for `auth.uid()`.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1) Schema extension on public.user_notifications
-- ---------------------------------------------------------------------------
alter table public.user_notifications
  add column if not exists metadata jsonb not null default '{}'::jsonb;

alter table public.user_notifications
  drop constraint if exists user_notifications_metadata_object_check;
alter table public.user_notifications
  add constraint user_notifications_metadata_object_check check (
    jsonb_typeof(metadata) = 'object'
  );

alter table public.user_notifications
  drop constraint if exists user_notifications_type_check;
alter table public.user_notifications
  add constraint user_notifications_type_check check (
    type in (
      'user_approval_requested',
      'password_reset_requested',
      'user_approved',
      'user_rejected',
      'delegation_event'
    )
  );

comment on column public.user_notifications.type is
  'Closed event allowlist: user_approval_requested, password_reset_requested, user_approved, user_rejected, delegation_event.';
comment on column public.user_notifications.metadata is
  'Structured event metadata (for example delegation_event payload: event, slug, granter_email, expires_at, days, window).';

-- ---------------------------------------------------------------------------
-- 2) Internal helper to resolve stale delegation expiry notifications
-- ---------------------------------------------------------------------------
create or replace function public.resolve_delegation_expiry_notifications(
  p_capability_id uuid
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_rows integer := 0;
begin
  if p_capability_id is null then
    return 0;
  end if;

  update public.user_notifications as n
     set resolved_at = coalesce(n.resolved_at, now()),
         is_read = true,
         read_at = coalesce(n.read_at, now())
   where n.type = 'delegation_event'
     and n.related_id = p_capability_id
     and (
       n.metadata ->> 'event' = 'expiring'
       or n.dedupe_key like 'delegation_expiring:%'
     )
     and n.resolved_at is null;

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

revoke all on function public.resolve_delegation_expiry_notifications(uuid)
  from public, anon, authenticated;
grant execute on function public.resolve_delegation_expiry_notifications(uuid)
  to service_role;

comment on function public.resolve_delegation_expiry_notifications(uuid) is
  'Service-only lifecycle helper: resolves unread/open delegation expiry notifications when a grant is renewed or revoked.';

-- ---------------------------------------------------------------------------
-- 3) Triggers on public.user_capabilities (granted, revoked, renewed)
-- ---------------------------------------------------------------------------

-- (a) AFTER INSERT -> notify the delegatee (user_id)
create or replace function public.handle_delegation_granted_notification()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_slug text;
  v_granter_email text;
  v_metadata jsonb;
  v_params jsonb;
begin
  begin
    select perm.slug
      into v_slug
      from public.permissions as perm
     where perm.id = new.permission_id;

    if new.granted_by is not null then
      select p.email
        into v_granter_email
        from public.profiles as p
       where p.id = new.granted_by;
    end if;

    v_metadata := jsonb_build_object(
      'event', 'granted',
      'slug', v_slug,
      'granter_email', v_granter_email,
      'expires_at', new.expires_at
    );

    v_params := jsonb_strip_nulls(
      jsonb_build_object(
        'event', 'granted',
        'slug', coalesce(v_slug, ''),
        'granter_email', coalesce(v_granter_email, ''),
        'expires_at', case
          when new.expires_at is null then ''
          else to_char(new.expires_at at time zone 'UTC', 'YYYY-MM-DD')
        end
      )
    );

    insert into public.user_notifications (
      user_id,
      type,
      title_key,
      body_key,
      params,
      metadata,
      link,
      related_id,
      dedupe_key
    )
    values (
      new.user_id,
      'delegation_event',
      'notifications.type.delegation_granted.title',
      'notifications.type.delegation_granted.body',
      v_params,
      v_metadata,
      '/profile#delegations',
      new.id,
      format('delegation_granted:%s:%s', new.id, new.user_id)
    )
    on conflict (user_id, dedupe_key) do nothing;
  exception when others then
    raise warning 'in_app_notification: delegation_granted failed for %: %',
      new.id, sqlerrm;
  end;

  return new;
end;
$$;

revoke all on function public.handle_delegation_granted_notification()
  from public, anon, authenticated, service_role;

drop trigger if exists user_capabilities_notify_granted on public.user_capabilities;
create trigger user_capabilities_notify_granted
  after insert on public.user_capabilities
  for each row
  execute function public.handle_delegation_granted_notification();

-- (b) AFTER UPDATE OF revoked_at -> resolve expiry notices + notify delegatee
create or replace function public.handle_delegation_revoked_notification()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_slug text;
  v_metadata jsonb;
  v_params jsonb;
begin
  begin
    perform public.resolve_delegation_expiry_notifications(new.id);

    select perm.slug
      into v_slug
      from public.permissions as perm
     where perm.id = new.permission_id;

    v_metadata := jsonb_build_object(
      'event', 'revoked',
      'slug', v_slug
    );

    v_params := jsonb_build_object(
      'event', 'revoked',
      'slug', coalesce(v_slug, '')
    );

    insert into public.user_notifications (
      user_id,
      type,
      title_key,
      body_key,
      params,
      metadata,
      link,
      related_id,
      dedupe_key
    )
    values (
      new.user_id,
      'delegation_event',
      'notifications.type.delegation_revoked.title',
      'notifications.type.delegation_revoked.body',
      v_params,
      v_metadata,
      '/profile#delegations',
      new.id,
      format('delegation_revoked:%s:%s', new.id, new.user_id)
    )
    on conflict (user_id, dedupe_key) do nothing;
  exception when others then
    raise warning 'in_app_notification: delegation_revoked failed for %: %',
      new.id, sqlerrm;
  end;

  return new;
end;
$$;

revoke all on function public.handle_delegation_revoked_notification()
  from public, anon, authenticated, service_role;

drop trigger if exists user_capabilities_notify_revoked on public.user_capabilities;
create trigger user_capabilities_notify_revoked
  after update of revoked_at on public.user_capabilities
  for each row
  when (old.revoked_at is null and new.revoked_at is not null)
  execute function public.handle_delegation_revoked_notification();

-- (c) AFTER UPDATE OF expires_at -> resolve previous expiry warnings on renewal
create or replace function public.handle_delegation_expiry_renewed()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  begin
    perform public.resolve_delegation_expiry_notifications(new.id);
  exception when others then
    raise warning 'in_app_notification: delegation_expiry_renewed failed for %: %',
      new.id, sqlerrm;
  end;

  return new;
end;
$$;

revoke all on function public.handle_delegation_expiry_renewed()
  from public, anon, authenticated, service_role;

drop trigger if exists user_capabilities_resolve_expiry_on_renewal on public.user_capabilities;
create trigger user_capabilities_resolve_expiry_on_renewal
  after update of expires_at on public.user_capabilities
  for each row
  when (old.expires_at is distinct from new.expires_at)
  execute function public.handle_delegation_expiry_renewed();

-- ---------------------------------------------------------------------------
-- 4) Scheduled expiry warnings (T-7 and T-1)
-- ---------------------------------------------------------------------------
create or replace function public.generate_delegation_expiry_notifications()
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_cap record;
  v_window text;
  v_days integer;
  v_rows integer;
  v_inserted integer := 0;
begin
  for v_cap in
    select uc.id,
           uc.user_id,
           uc.granted_by,
           uc.expires_at,
           perm.slug,
           delegatee.email as delegate_email
      from public.user_capabilities as uc
      join public.permissions as perm on perm.id = uc.permission_id
      join public.profiles as delegatee on delegatee.id = uc.user_id
     where uc.revoked_at is null
       and uc.expires_at is not null
       and uc.expires_at between now() and now() + interval '7 days'
  loop
    v_window := case
      when v_cap.expires_at <= now() + interval '1 day' then 'T-1'
      else 'T-7'
    end;

    v_days := greatest(
      1,
      ceil(extract(epoch from (v_cap.expires_at - now())) / 86400.0)::integer
    );

    -- (a) Notify the granter (granted_by) when present and valid in profiles
    if v_cap.granted_by is not null
       and exists (select 1 from public.profiles as gp where gp.id = v_cap.granted_by) then
      insert into public.user_notifications (
        user_id,
        type,
        title_key,
        body_key,
        params,
        metadata,
        link,
        related_id,
        dedupe_key
      )
      values (
        v_cap.granted_by,
        'delegation_event',
        'notifications.type.delegation_expiring_granter.title',
        'notifications.type.delegation_expiring_granter.body',
        jsonb_build_object(
          'event', 'expiring',
          'slug', v_cap.slug,
          'email', coalesce(v_cap.delegate_email, ''),
          'days', v_days::text,
          'window', v_window,
          'recipient_role', 'granter'
        ),
        jsonb_build_object(
          'event', 'expiring',
          'slug', v_cap.slug,
          'email', v_cap.delegate_email,
          'days', v_days,
          'window', v_window,
          'recipient_role', 'granter',
          'expires_at', v_cap.expires_at
        ),
        '/settings/system/users',
        v_cap.id,
        format('delegation_expiring:%s:%s:%s', v_cap.id, v_window, v_cap.granted_by)
      )
      on conflict (user_id, dedupe_key) do nothing;

      get diagnostics v_rows = row_count;
      v_inserted := v_inserted + v_rows;
    end if;

    -- (b) Notify the delegatee (user_id)
    insert into public.user_notifications (
      user_id,
      type,
      title_key,
      body_key,
      params,
      metadata,
      link,
      related_id,
      dedupe_key
    )
    values (
      v_cap.user_id,
      'delegation_event',
      'notifications.type.delegation_expiring.title',
      'notifications.type.delegation_expiring.body',
      jsonb_build_object(
        'event', 'expiring',
        'slug', v_cap.slug,
        'days', v_days::text,
        'window', v_window,
        'recipient_role', 'delegate'
      ),
      jsonb_build_object(
        'event', 'expiring',
        'slug', v_cap.slug,
        'days', v_days,
        'window', v_window,
        'recipient_role', 'delegate',
        'expires_at', v_cap.expires_at
      ),
      '/profile#delegations',
      v_cap.id,
      format('delegation_expiring:%s:%s:%s', v_cap.id, v_window, v_cap.user_id)
    )
    on conflict (user_id, dedupe_key) do nothing;

    get diagnostics v_rows = row_count;
    v_inserted := v_inserted + v_rows;
  end loop;

  return v_inserted;
end;
$$;

revoke all on function public.generate_delegation_expiry_notifications()
  from public, anon, authenticated;
grant execute on function public.generate_delegation_expiry_notifications()
  to service_role;

comment on function public.generate_delegation_expiry_notifications() is
  'Emits T-7 and T-1 delegation expiry notifications to granters and delegatees; idempotent via dedupe_key.';

do $delegation_expiry_cron$
declare
  v_job_id bigint;
  v_command constant text := $command$select public.generate_delegation_expiry_notifications();$command$;
begin
  for v_job_id in
    select j.jobid
      from cron.job as j
     where j.jobname = 'generate-delegation-expiry-notifications-daily-0320'
       and j.database = current_database()
       and j.username = current_user
  loop
    perform cron.unschedule(v_job_id);
  end loop;

  perform cron.schedule(
    'generate-delegation-expiry-notifications-daily-0320',
    '20 3 * * *',
    v_command
  );
end;
$delegation_expiry_cron$;

-- ---------------------------------------------------------------------------
-- 5) Self-service Profile RPCs (caller-scoped via auth.uid())
-- ---------------------------------------------------------------------------
create or replace function public.get_my_delegated_capabilities()
returns table (
  id uuid,
  slug text,
  granted_by uuid,
  granted_by_email text,
  granted_at timestamptz,
  expires_at timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_caller uuid := auth.uid();
begin
  if v_caller is null
     or not coalesce(public.is_active_user(), false)
     or not exists (
       select 1
         from public.profiles as p
        where p.id = v_caller
          and p.approval_status = 'approved'
     ) then
    return;
  end if;

  return query
    select uc.id,
           perm.slug,
           uc.granted_by,
           granter.email as granted_by_email,
           uc.granted_at,
           uc.expires_at
      from public.user_capabilities as uc
      join public.permissions as perm on perm.id = uc.permission_id
      left join public.profiles as granter on granter.id = uc.granted_by
     where uc.user_id = v_caller
       and uc.revoked_at is null
       and (uc.expires_at is null or uc.expires_at > now())
       and perm.slug not in ('*', 'roles.manage')
     order by uc.granted_at desc, perm.slug asc;
end;
$$;

revoke all on function public.get_my_delegated_capabilities() from public, anon;
grant execute on function public.get_my_delegated_capabilities() to authenticated, service_role;

comment on function public.get_my_delegated_capabilities() is
  'Returns the signed-in caller''s active individual capability delegations for /profile.';

create or replace function public.get_my_roles()
returns table (
  slug text,
  name_ar text,
  name_en text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_caller uuid := auth.uid();
begin
  if v_caller is null
     or not coalesce(public.is_active_user(), false)
     or not exists (
       select 1
         from public.profiles as p
        where p.id = v_caller
          and p.approval_status = 'approved'
     ) then
    return;
  end if;

  return query
    select r.slug,
           r.name_ar,
           r.name_en
      from public.user_roles as ur
      join public.roles as r on r.id = ur.role_id
     where ur.user_id = v_caller
     order by r.slug asc;
end;
$$;

revoke all on function public.get_my_roles() from public, anon;
grant execute on function public.get_my_roles() to authenticated, service_role;

comment on function public.get_my_roles() is
  'Returns the signed-in caller''s current role assignments for /profile.';

notify pgrst, 'reload schema';
