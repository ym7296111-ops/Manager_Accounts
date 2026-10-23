-- Cloud backup request ledger and tightly scoped administrative controls.
-- This migration records requests; a trusted cloud worker is responsible for
-- performing exports and updating running/completed/failed state.

-- Reuse the existing backup.created audit action for the request event.

create table public.backup_settings (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default false,
  interval_working_days integer not null default 5 check (interval_working_days between 1 and 365),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null
);

insert into public.backup_settings(singleton) values (true) on conflict (singleton) do nothing;

create table public.backup_logs (
  id uuid primary key default gen_random_uuid(),
  backup_type text not null check (backup_type in ('manual', 'automatic')),
  status text not null default 'queued' check (status in ('queued', 'running', 'completed', 'failed')),
  requested_by uuid references public.profiles(id) on delete set null,
  requested_at timestamptz not null default now(),
  artifact_path text,
  error_summary text,
  constraint backup_completed_has_artifact check (status <> 'completed' or artifact_path is not null)
);

create index backup_logs_requested_at_idx on public.backup_logs(requested_at desc);
create index backup_logs_active_idx on public.backup_logs(status) where status in ('queued', 'running');
create unique index backup_logs_one_active_request_idx on public.backup_logs ((true)) where status in ('queued', 'running');

alter table public.backup_settings enable row level security;
alter table public.backup_logs enable row level security;
revoke all on public.backup_settings, public.backup_logs from public, anon, authenticated;
grant select on public.backup_settings, public.backup_logs to authenticated;
grant select, insert, update on public.backup_settings, public.backup_logs to service_role;

create policy backup_settings_super_admin_read on public.backup_settings
  for select to authenticated using (
    public.is_active_user() and exists (
      select 1 from public.user_roles ur join public.roles r on r.id = ur.role_id
      where ur.user_id = auth.uid() and r.slug = 'super_admin'
    )
  );
create policy backup_logs_super_admin_read on public.backup_logs
  for select to authenticated using (
    public.is_active_user() and exists (
      select 1 from public.user_roles ur join public.roles r on r.id = ur.role_id
      where ur.user_id = auth.uid() and r.slug = 'super_admin'
    )
  );

create or replace function public.admin_trigger_manual_backup()
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_id uuid;
begin
  if v_actor is null or not public.is_active_user() or not exists (
    select 1 from public.user_roles ur join public.roles r on r.id = ur.role_id
    where ur.user_id = v_actor and r.slug = 'super_admin'
  ) then
    raise exception 'backup forbidden' using errcode = '42501';
  end if;

  -- Serialize all requests, including races from separate tabs/sessions.
  perform pg_advisory_xact_lock(hashtextextended('backup_request_gate', 0));
  if exists (select 1 from public.backup_logs where status in ('queued', 'running')) then
    raise exception 'backup already in progress' using errcode = 'BKP01';
  end if;

  insert into public.backup_logs(backup_type, status, requested_by)
  values ('manual', 'queued', v_actor) returning id into v_id;

  insert into public.audit_logs(actor_id, action, entity, entity_id, metadata)
  values (v_actor, 'backup.created', 'backup', v_id::text,
          jsonb_build_object('backup_type', 'manual', 'status', 'queued'));
  return v_id;
end;
$$;
revoke all on function public.admin_trigger_manual_backup() from public, anon;
grant execute on function public.admin_trigger_manual_backup() to authenticated;

create or replace function public.admin_update_backup_settings(p_enabled boolean, p_interval_working_days integer)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare v_actor uuid := auth.uid();
begin
  if v_actor is null or not public.is_active_user() or not exists (
    select 1 from public.user_roles ur join public.roles r on r.id = ur.role_id
    where ur.user_id = v_actor and r.slug = 'super_admin'
  ) then
    raise exception 'backup forbidden' using errcode = '42501';
  end if;
  if p_interval_working_days is null or p_interval_working_days not between 1 and 365 then
    raise exception 'invalid working day interval' using errcode = '22023';
  end if;
  update public.backup_settings
     set enabled = p_enabled, interval_working_days = p_interval_working_days,
         updated_at = now(), updated_by = v_actor
   where singleton;
  insert into public.audit_logs(actor_id, action, entity, metadata)
  values (v_actor, 'settings.updated', 'backup_settings',
          jsonb_build_object('enabled', p_enabled, 'interval_working_days', p_interval_working_days));
end;
$$;
revoke all on function public.admin_update_backup_settings(boolean, integer) from public, anon;
grant execute on function public.admin_update_backup_settings(boolean, integer) to authenticated;

-- Private artifact bucket. Only trusted server-side workers may write objects;
-- authenticated super-admins may read through short-lived signed URLs.
insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('private-backups', 'private-backups', false, 1073741824, array['application/sql', 'application/octet-stream', 'application/gzip'])
on conflict (id) do update set public = false;
drop policy if exists backup_objects_super_admin_read on storage.objects;
create policy backup_objects_super_admin_read on storage.objects for select to authenticated
  using (bucket_id = 'private-backups' and public.is_active_user() and exists (
    select 1 from public.user_roles ur join public.roles r on r.id = ur.role_id
    where ur.user_id = auth.uid() and r.slug = 'super_admin'
  ));
revoke insert, update, delete on storage.objects from anon, authenticated;

-- Realtime is used as an invalidation signal; the client refetches through RLS.
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'backup_logs') then
    alter publication supabase_realtime add table public.backup_logs;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'backup_settings') then
    alter publication supabase_realtime add table public.backup_settings;
  end if;
end;
$$;
