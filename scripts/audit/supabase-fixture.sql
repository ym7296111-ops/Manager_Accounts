-- OFFLINE AUDIT ONLY. Minimal auth/storage contracts for PostgreSQL 17.
-- This is NOT a Supabase installation, migration, or production bootstrap.
-- The audit runner only loads it into a disposable database via a Unix socket.
-- `cron.schedule` below is a contract stub because this embedded PostgreSQL
-- build does not ship pg_cron; hosted/local-Supabase migration CI tests the real extension.
--
-- Platform mirror: Supabase installs pgcrypto into the dedicated `extensions`
-- schema and keeps that schema OFF the migration search_path. Installing it in
-- `public` here (as a bare cluster would) hid a real CI failure — an unqualified
-- `digest()` raised 42883 while `supabase db start` applied the migrations. The
-- block below reproduces the platform layout so the offline audit catches
-- schema-qualification bugs before CI does.
do $$
begin
  if not exists (select from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
  if not exists (select from pg_roles where rolname = 'supabase_admin') then
    create role supabase_admin nologin;
  end if;
end;
$$;

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
grant usage on schema extensions to anon, authenticated, service_role;

create schema auth;
create table auth.users (
  id uuid primary key,
  aud text not null default 'authenticated',
  role text not null default 'authenticated',
  email text not null,
  encrypted_password text,
  email_confirmed_at timestamptz,
  last_sign_in_at timestamptz,
  raw_app_meta_data jsonb not null default '{}',
  raw_user_meta_data jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;
create function auth.role() returns text language sql stable as $$
  select nullif(current_setting('request.jwt.claim.role', true), '');
$$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid(), auth.role() to anon, authenticated, service_role;

create schema storage;
create table storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[]
);
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name text not null
);
alter table storage.objects enable row level security;
grant usage on schema storage to anon, authenticated, service_role;
grant select, insert, update, delete on storage.objects to anon, authenticated, service_role;
grant all on storage.buckets to service_role;

create publication supabase_realtime;

create schema cron;
create table cron.job (
  jobid bigint generated always as identity primary key,
  jobname text not null,
  schedule text not null,
  command text not null,
  database text not null default current_database(),
  username text not null default current_user,
  active boolean not null default true
);
create function cron.schedule(job_name text, schedule text, command text)
returns bigint
language plpgsql
as $$
declare
  v_job_id bigint;
begin
  insert into cron.job(jobname, schedule, command)
  values (job_name, schedule, command)
  returning jobid into v_job_id;

  return v_job_id;
end;
$$;
create function cron.unschedule(job_id bigint)
returns boolean
language plpgsql
as $$
declare
  v_rows integer;
begin
  delete from cron.job where cron.job.jobid = $1;
  get diagnostics v_rows = row_count;
  return v_rows = 1;
end;
$$;
