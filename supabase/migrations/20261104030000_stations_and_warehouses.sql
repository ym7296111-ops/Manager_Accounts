-- Project Settings -> Stations & Warehouses (Phase 1: schema only).
--
-- Deliberately minimal by design. The expected volume is <= 20 stations and
-- <= 10 warehouses per station (~200 rows total), so there is no partitioning,
-- no history/soft-delete table, no pagination scaffolding and no performance
-- tuning. Two plain tables, sequence-minted codes, and an RLS gate.
--
-- Codes (ST-01 / WH-001) are minted server-side from sequences; the client
-- never supplies them and the UI must not send a `code` value.
--
-- Access is gated by the existing `project.settings:manage` capability through
-- public.can_manage_project_settings(), created in
-- 20261104020000_project_settings_access.sql. No UI ships with this migration.

-- ---------------------------------------------------------------------------
-- 1) Code sequences
-- ---------------------------------------------------------------------------
create sequence if not exists public.station_code_seq
  start with 1
  increment by 1
  minvalue 1
  no cycle;

create sequence if not exists public.warehouse_code_seq
  start with 1
  increment by 1
  minvalue 1
  no cycle;

-- ---------------------------------------------------------------------------
-- 2) Code minting functions
--
-- SECURITY DEFINER so the inserting role never needs USAGE on the sequence, and
-- so a caller cannot burn sequence values by calling nextval() directly.
--
-- Note on padding: lpad() TRUNCATES on the right when the input is already
-- wider than the requested width, so lpad('100', 2, '0') yields '10' - station
-- 100 would silently mint 'ST-10' and collide with the unique index. Padding is
-- applied only while the value fits in two digits; beyond that the full digits
-- are kept (ST-100). Same reasoning for the three-digit warehouse codes.
-- ---------------------------------------------------------------------------
create or replace function public.next_station_code()
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_next bigint := nextval('public.station_code_seq');
begin
  return 'ST-' || case
    when v_next < 100 then lpad(v_next::text, 2, '0')
    else v_next::text
  end;
end;
$$;

revoke all on function public.next_station_code() from public, anon;
grant execute on function public.next_station_code() to authenticated, service_role;

create or replace function public.next_warehouse_code()
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_next bigint := nextval('public.warehouse_code_seq');
begin
  return 'WH-' || case
    when v_next < 1000 then lpad(v_next::text, 3, '0')
    else v_next::text
  end;
end;
$$;

revoke all on function public.next_warehouse_code() from public, anon;
grant execute on function public.next_warehouse_code() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3) Tables
-- ---------------------------------------------------------------------------
create table if not exists public.stations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  code text not null unique default public.next_station_code(),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint stations_name_not_blank check (char_length(btrim(name)) >= 1)
);

create table if not exists public.warehouses (
  id uuid primary key default gen_random_uuid(),
  station_id uuid not null references public.stations (id) on delete restrict,
  name text not null,
  code text not null unique default public.next_warehouse_code(),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint warehouses_name_not_blank check (char_length(btrim(name)) >= 1)
);

-- Postgres does not index foreign keys implicitly. At ~200 rows this is
-- negligible either way, but listing a station's warehouses is the only read
-- path the UI will have, so the index costs nothing and avoids a seq scan.
create index if not exists warehouses_station_id_idx on public.warehouses (station_id);

-- ---------------------------------------------------------------------------
-- 4) updated_at triggers (reuses the shared helper from the core schema)
-- ---------------------------------------------------------------------------
drop trigger if exists stations_set_updated_at on public.stations;
create trigger stations_set_updated_at
  before update on public.stations
  for each row execute function public.set_updated_at();

drop trigger if exists warehouses_set_updated_at on public.warehouses;
create trigger warehouses_set_updated_at
  before update on public.warehouses
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 5) Row Level Security - both read and write require project.settings:manage
-- ---------------------------------------------------------------------------
alter table public.stations enable row level security;
alter table public.stations force row level security;
alter table public.warehouses enable row level security;
alter table public.warehouses force row level security;

drop policy if exists stations_project_settings_select on public.stations;
create policy stations_project_settings_select
  on public.stations
  for select
  to authenticated
  using (public.can_manage_project_settings());

drop policy if exists stations_project_settings_insert on public.stations;
create policy stations_project_settings_insert
  on public.stations
  for insert
  to authenticated
  with check (public.can_manage_project_settings());

drop policy if exists stations_project_settings_update on public.stations;
create policy stations_project_settings_update
  on public.stations
  for update
  to authenticated
  using (public.can_manage_project_settings())
  with check (public.can_manage_project_settings());

drop policy if exists stations_project_settings_delete on public.stations;
create policy stations_project_settings_delete
  on public.stations
  for delete
  to authenticated
  using (public.can_manage_project_settings());

drop policy if exists warehouses_project_settings_select on public.warehouses;
create policy warehouses_project_settings_select
  on public.warehouses
  for select
  to authenticated
  using (public.can_manage_project_settings());

drop policy if exists warehouses_project_settings_insert on public.warehouses;
create policy warehouses_project_settings_insert
  on public.warehouses
  for insert
  to authenticated
  with check (public.can_manage_project_settings());

drop policy if exists warehouses_project_settings_update on public.warehouses;
create policy warehouses_project_settings_update
  on public.warehouses
  for update
  to authenticated
  using (public.can_manage_project_settings())
  with check (public.can_manage_project_settings());

drop policy if exists warehouses_project_settings_delete on public.warehouses;
create policy warehouses_project_settings_delete
  on public.warehouses
  for delete
  to authenticated
  using (public.can_manage_project_settings());

-- ---------------------------------------------------------------------------
-- 6) Preconditions
-- ---------------------------------------------------------------------------
do $verify_stations_and_warehouses$
begin
  if not exists (
    select 1 from public.permissions where slug = 'project.settings:manage'
  ) then
    raise exception 'Project settings permission is missing';
  end if;

  if not exists (
    select 1
      from pg_proc as proc
      join pg_namespace as namespace on namespace.oid = proc.pronamespace
     where namespace.nspname = 'public'
       and proc.proname = 'can_manage_project_settings'
  ) then
    raise exception 'can_manage_project_settings() is missing';
  end if;

  if not exists (
    select 1
      from pg_proc as proc
      join pg_namespace as namespace on namespace.oid = proc.pronamespace
     where namespace.nspname = 'public'
       and proc.proname = 'set_updated_at'
  ) then
    raise exception 'set_updated_at() is missing';
  end if;
end;
$verify_stations_and_warehouses$;

notify pgrst, 'reload schema';
