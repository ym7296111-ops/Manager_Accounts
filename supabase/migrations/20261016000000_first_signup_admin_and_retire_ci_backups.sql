-- First-signup authority is assigned by Auth triggers, and the old CI backup
-- queue is retired in favor of Supabase-managed database backups.
--
-- SECURITY NOTE: the database can serialize the first signup, but it cannot
-- identify the project owner. With public signup enabled, the first registrant
-- wins. Keep the app private until the intended owner has registered.

-- ---------------------------------------------------------------------------
-- 1) Durable, owner-only claim for the first Auth signup
-- ---------------------------------------------------------------------------
create table if not exists public.first_admin_bootstrap_state (
  singleton boolean primary key default true check (singleton),
  claimed boolean not null default false,
  first_user_id uuid references auth.users(id) on delete set null deferrable initially deferred,
  claimed_at timestamptz
);

alter table public.first_admin_bootstrap_state enable row level security;
alter table public.first_admin_bootstrap_state force row level security;

drop policy if exists "Database owners manage first admin bootstrap state"
  on public.first_admin_bootstrap_state;
create policy "Database owners manage first admin bootstrap state"
  on public.first_admin_bootstrap_state
  for all
  to postgres, supabase_admin
  using (true)
  with check (true);

revoke all on public.first_admin_bootstrap_state
  from public, anon, authenticated, service_role;

-- Existing projects must never promote a later signup just because their
-- original Auth users were removed. A prior Auth user, protected assignment,
-- or legacy bootstrap audit event permanently closes automatic first-signup
-- elevation for that project.
insert into public.first_admin_bootstrap_state (singleton, claimed, first_user_id, claimed_at)
select
  true,
  exists (select 1 from auth.users)
  or exists (
    select 1
      from public.user_roles as ur
      join public.roles as r on r.id = ur.role_id
     where r.slug = 'super_admin' or r.is_super_admin
  )
  or exists (
    select 1
      from public.audit_logs as al
     where al.action = 'role.granted'::public.audit_action
       and al.entity = 'user_roles'
       and al.metadata ->> 'bootstrap_method' in (
         'scripts/sql/grant-first-super-admin.sql',
         'scripts/bootstrap-admin.ts'
       )
  ),
  null,
  case
    when exists (select 1 from auth.users)
      or exists (
        select 1
          from public.user_roles as ur
          join public.roles as r on r.id = ur.role_id
         where r.slug = 'super_admin' or r.is_super_admin
      )
      or exists (
        select 1
          from public.audit_logs as al
         where al.action = 'role.granted'::public.audit_action
           and al.entity = 'user_roles'
           and al.metadata ->> 'bootstrap_method' in (
             'scripts/sql/grant-first-super-admin.sql',
             'scripts/bootstrap-admin.ts'
           )
      )
    then clock_timestamp()
    else null
  end
on conflict (singleton) do nothing;

comment on table public.first_admin_bootstrap_state is
  'Owner-only durable marker for first Auth signup. Once claimed, it never re-opens if the original user is deleted.';

-- BEFORE INSERT serializes Auth signups and confirms the first account in the
-- same transaction. If profile/role provisioning later fails, this claim rolls
-- back with the Auth user insert.
create or replace function public.confirm_first_auth_user_email()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_claimed boolean;
begin
  perform pg_advisory_xact_lock(hashtextextended('admin_authority_invariant', 0));

  select s.claimed
    into v_claimed
    from public.first_admin_bootstrap_state as s
   where s.singleton is true
   for update;

  if not found then
    raise exception 'First-admin signup state is missing; refusing Auth signup.';
  end if;

  if not v_claimed then
    update public.first_admin_bootstrap_state
       set claimed = true,
           first_user_id = new.id,
           claimed_at = clock_timestamp()
     where singleton is true;

    new.email_confirmed_at := coalesce(new.email_confirmed_at, clock_timestamp());
  end if;

  return new;
end;
$$;

revoke all on function public.confirm_first_auth_user_email()
  from public, anon, authenticated, service_role;

drop trigger if exists on_auth_user_confirm_first_email on auth.users;
create trigger on_auth_user_confirm_first_email
  before insert on auth.users
  for each row execute function public.confirm_first_auth_user_email();

-- AFTER INSERT provisions the profile and role atomically. No user metadata,
-- client RPC, anon/authenticated API role, or service_role claim participates
-- in the role choice.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_first_user_id uuid;
  v_role_id uuid;
  v_role_slug text;
  v_rows_inserted integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('admin_authority_invariant', 0));

  select s.first_user_id
    into v_first_user_id
    from public.first_admin_bootstrap_state as s
   where s.singleton is true
   for update;

  if not found then
    raise exception 'First-admin signup state is missing; refusing Auth signup.';
  end if;

  insert into public.profiles (id, email, full_name, avatar_url, status)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)),
    new.raw_user_meta_data ->> 'avatar_url',
    'active'
  )
  on conflict (id) do nothing;

  if v_first_user_id = new.id then
    if new.email_confirmed_at is null then
      raise exception 'The first Auth signup must have a confirmed email.';
    end if;

    select r.id
      into v_role_id
      from public.roles as r
     where r.slug = 'super_admin'
       and r.is_super_admin is true
       and exists (
         select 1
           from public.role_permissions as rp
           join public.permissions as p on p.id = rp.permission_id
          where rp.role_id = r.id
            and p.slug = '*'
       );
    v_role_slug := 'super_admin';
  else
    select r.id
      into v_role_id
      from public.roles as r
     where r.slug = 'viewer'
       and r.is_super_admin is false;
    v_role_slug := 'viewer';
  end if;

  if v_role_id is null then
    raise exception 'Required signup role % is missing or incomplete.', v_role_slug;
  end if;

  insert into public.user_roles (user_id, role_id, granted_by)
  values (new.id, v_role_id, null)
  on conflict (user_id, role_id) do nothing;

  get diagnostics v_rows_inserted = row_count;
  if v_rows_inserted <> 1 then
    raise exception 'Signup role % was not newly assigned.', v_role_slug;
  end if;

  insert into public.audit_logs (
    actor_id,
    actor_type,
    actor_ref,
    action,
    entity,
    entity_id,
    metadata
  )
  values (
    null,
    'auth_signup_trigger',
    'auth.users.on_auth_user_created',
    'role.granted'::public.audit_action,
    'user_roles',
    new.id::text,
    jsonb_build_object(
      'role_slugs', jsonb_build_array(v_role_slug),
      'target_user_id', new.id,
      'assignment_source', 'auth.users.on_auth_user_created',
      'first_signup', v_first_user_id = new.id
    )
  );

  return new;
end;
$$;

revoke all on function public.handle_new_user()
  from public, anon, authenticated, service_role;

-- Keep the existing AFTER INSERT trigger name while replacing its body.
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

comment on function public.handle_new_user() is
  'Auth trigger: creates an active profile and grants super_admin only to the durably claimed first signup; every later signup receives viewer.';
comment on column public.audit_logs.actor_type is
  'How the actor was identified: user, db_role, manual, automated_bootstrap, or auth_signup_trigger. NULL on legacy rows.';

-- Remove the obsolete bootstrap API paths so no caller can use them after the
-- trigger-based flow is deployed.
drop function if exists public.bootstrap_first_super_admin(text);
drop function if exists public.check_bootstrap_readiness();

-- ---------------------------------------------------------------------------
-- 2) Retire the GitHub backup queue; backups are managed in Supabase
-- ---------------------------------------------------------------------------
-- Stop both historical scheduler names before removing their generator.
do $retire_backup_cron$
declare
  v_job_id bigint;
begin
  for v_job_id in
    select j.jobid
      from cron.job as j
     where j.jobname in (
       'generate-scheduled-backup-requests-europe-paris-0100',
       'generate-scheduled-backup-requests-hourly'
     )
       and j.database = current_database()
  loop
    perform cron.unschedule(v_job_id);
  end loop;
end;
$retire_backup_cron$;

update public.backup_settings
   set enabled = false,
       updated_at = clock_timestamp(),
       updated_by = null
 where singleton is true;

-- Preserve historical rows, but do not leave queued/running items that imply a
-- worker still exists. The existing trigger stamps finished_at on these rows.
update public.backup_logs
   set status = 'failed',
       error_summary = 'Legacy backup worker retired; use Supabase-managed backups.'
 where status in ('queued', 'running');

revoke all on public.backup_settings, public.backup_logs
  from public, anon, authenticated, service_role;

-- Keep any historical objects in the private bucket for owner-reviewed cleanup,
-- but remove the application-facing read policy for that retired artifact path.
drop policy if exists backup_objects_super_admin_read on storage.objects;

drop function if exists public.admin_trigger_manual_backup();
drop function if exists public.admin_update_backup_settings(boolean, integer);
drop function if exists public.admin_claim_next_backup_job();
drop function if exists public.generate_scheduled_backup_requests();

drop trigger if exists backup_logs_stamp_finished on public.backup_logs;
drop function if exists public.backup_logs_stamp_finished();

do $retire_backup_realtime$
begin
  if exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'backup_logs'
  ) then
    alter publication supabase_realtime drop table public.backup_logs;
  end if;

  if exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'backup_settings'
  ) then
    alter publication supabase_realtime drop table public.backup_settings;
  end if;
end;
$retire_backup_realtime$;

notify pgrst, 'reload schema';
