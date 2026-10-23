-- Core schema for the admin system: profiles, RBAC, workspaces, settings and audit trail.
-- Applied automatically by .github/workflows/supabase-migration.yml on every push to main.

-- ---------------------------------------------------------------------------
-- Extensions and shared helpers
-- ---------------------------------------------------------------------------
create extension if not exists "pgcrypto";

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type public.user_status as enum ('invited', 'active', 'suspended');

create type public.audit_action as enum (
  'auth.sign_in',
  'auth.sign_out',
  'auth.failed_sign_in',
  'user.created',
  'user.updated',
  'user.suspended',
  'user.deleted',
  'role.granted',
  'role.revoked',
  'settings.updated',
  'backup.created',
  'backup.restored',
  'support.ticket_created'
);

-- ---------------------------------------------------------------------------
-- Profiles (1:1 with auth.users)
-- ---------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text,
  email text not null,
  avatar_url text,
  phone text,
  status public.user_status not null default 'active',
  preferred_theme text not null default 'system' check (preferred_theme in ('light', 'dark', 'system')),
  preferred_locale text not null default 'ar',
  last_sign_in_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index profiles_status_idx on public.profiles (status);
create index profiles_email_idx on public.profiles (lower(email));

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name, avatar_url, status)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)),
    new.raw_user_meta_data ->> 'avatar_url',
    'active'
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Roles and permissions (RBAC)
-- ---------------------------------------------------------------------------
create table public.roles (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name_ar text not null,
  name_en text not null,
  description text,
  is_system boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger roles_set_updated_at
  before update on public.roles
  for each row execute function public.set_updated_at();

create table public.permissions (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  module text not null,
  name_ar text not null,
  name_en text not null,
  description text,
  created_at timestamptz not null default now()
);

create index permissions_module_idx on public.permissions (module);

create table public.role_permissions (
  role_id uuid not null references public.roles (id) on delete cascade,
  permission_id uuid not null references public.permissions (id) on delete cascade,
  granted_at timestamptz not null default now(),
  primary key (role_id, permission_id)
);

create table public.user_roles (
  user_id uuid not null references public.profiles (id) on delete cascade,
  role_id uuid not null references public.roles (id) on delete cascade,
  granted_by uuid references public.profiles (id) on delete set null,
  granted_at timestamptz not null default now(),
  primary key (user_id, role_id)
);

create index user_roles_role_idx on public.user_roles (role_id);

create or replace function public.has_permission(p_permission text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.user_roles ur
    join public.role_permissions rp on rp.role_id = ur.role_id
    join public.permissions p on p.id = rp.permission_id
    join public.profiles pr on pr.id = ur.user_id
    where ur.user_id = auth.uid()
      and pr.status = 'active'
      and (p.slug = p_permission or p.slug = '*')
  );
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.has_permission('*');
$$;

-- ---------------------------------------------------------------------------
-- Workspaces (the three collapsible sidebar sections)
-- ---------------------------------------------------------------------------
create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name_ar text not null,
  name_en text not null,
  description text,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger workspaces_set_updated_at
  before update on public.workspaces
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Application settings (general, appearance, notifications)
-- ---------------------------------------------------------------------------
create table public.app_settings (
  key text primary key,
  group_slug text not null default 'general',
  value jsonb not null default '{}'::jsonb,
  is_public boolean not null default false,
  updated_by uuid references public.profiles (id) on delete set null,
  updated_at timestamptz not null default now()
);

create index app_settings_group_idx on public.app_settings (group_slug);

create trigger app_settings_set_updated_at
  before update on public.app_settings
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Audit trail
-- ---------------------------------------------------------------------------
create table public.audit_logs (
  id bigint generated always as identity primary key,
  actor_id uuid references public.profiles (id) on delete set null,
  action public.audit_action not null,
  entity text,
  entity_id text,
  metadata jsonb not null default '{}'::jsonb,
  ip_address inet,
  user_agent text,
  created_at timestamptz not null default now()
);

create index audit_logs_actor_idx on public.audit_logs (actor_id, created_at desc);
create index audit_logs_action_idx on public.audit_logs (action, created_at desc);

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
  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
  values (auth.uid(), p_action, p_entity, p_entity_id, p_metadata);
end;
$$;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.roles enable row level security;
alter table public.permissions enable row level security;
alter table public.role_permissions enable row level security;
alter table public.user_roles enable row level security;
alter table public.workspaces enable row level security;
alter table public.app_settings enable row level security;
alter table public.audit_logs enable row level security;

create policy "Users read their own profile"
  on public.profiles for select
  using (auth.uid() = id or public.is_admin());

create policy "Users update their own preferences"
  on public.profiles for update
  using (auth.uid() = id or public.is_admin())
  with check (auth.uid() = id or public.is_admin());

create policy "Admins manage profiles"
  on public.profiles for all
  using (public.is_admin())
  with check (public.is_admin());

create policy "Signed-in users read roles"
  on public.roles for select
  using (auth.role() = 'authenticated');

create policy "Admins manage roles"
  on public.roles for all
  using (public.is_admin())
  with check (public.is_admin());

create policy "Signed-in users read permissions"
  on public.permissions for select
  using (auth.role() = 'authenticated');

create policy "Admins manage permissions"
  on public.permissions for all
  using (public.is_admin())
  with check (public.is_admin());

create policy "Signed-in users read role permissions"
  on public.role_permissions for select
  using (auth.role() = 'authenticated');

create policy "Admins manage role permissions"
  on public.role_permissions for all
  using (public.is_admin())
  with check (public.is_admin());

create policy "Users read their own assignments"
  on public.user_roles for select
  using (auth.uid() = user_id or public.is_admin());

create policy "Admins manage user roles"
  on public.user_roles for all
  using (public.is_admin())
  with check (public.is_admin());

create policy "Signed-in users read active workspaces"
  on public.workspaces for select
  using (auth.role() = 'authenticated');

create policy "Admins manage workspaces"
  on public.workspaces for all
  using (public.is_admin())
  with check (public.is_admin());

create policy "Public settings are readable"
  on public.app_settings for select
  using (is_public or public.is_admin());

create policy "Admins manage settings"
  on public.app_settings for all
  using (public.is_admin())
  with check (public.is_admin());

create policy "Admins read audit logs"
  on public.audit_logs for select
  using (public.is_admin());

-- ---------------------------------------------------------------------------
-- Grants and realtime
-- ---------------------------------------------------------------------------
grant usage on schema public to anon, authenticated, service_role;
grant select on public.app_settings to anon;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant all on all tables in schema public to service_role;
alter default privileges in schema public grant all on tables to service_role;

alter publication supabase_realtime add table public.workspaces;
alter publication supabase_realtime add table public.app_settings;
