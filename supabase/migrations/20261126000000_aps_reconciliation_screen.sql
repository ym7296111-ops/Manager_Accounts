-- APS Reconciliation Screen - Simple Version
-- This migration creates tables for the reconciliation screen feature.
-- Uses unique table names to avoid conflicts with existing aps_reconciliation tables.

-- ============================================
-- 1. Create Reconciliation Sessions Table
-- ============================================
create table if not exists public.aps_reconciliation_screen_sessions (
  id uuid primary key default gen_random_uuid(),
  fiscal_month_id uuid not null references public.fiscal_months (id) on delete restrict,
  station_id uuid not null references public.stations (id) on delete restrict,
  status text not null default 'open' check (status in ('open', 'closed')),
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  closed_by uuid references public.profiles (id) on delete set null,
  close_reason text,
  updated_at timestamptz not null default now()
);

-- Unique constraint: only one open session per (month + station)
create unique index if not exists aps_reconciliation_screen_sessions_open_unique
  on public.aps_reconciliation_screen_sessions (fiscal_month_id, station_id)
  where status = 'open';

-- Indexes for performance
create index if not exists aps_reconciliation_screen_sessions_month_idx
  on public.aps_reconciliation_screen_sessions (fiscal_month_id);

create index if not exists aps_reconciliation_screen_sessions_station_idx
  on public.aps_reconciliation_screen_sessions (station_id);

create index if not exists aps_reconciliation_screen_sessions_status_idx
  on public.aps_reconciliation_screen_sessions (status);

-- Updated_at trigger
create or replace function public.aps_reconciliation_screen_sessions_set_updated_at()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger aps_reconciliation_screen_sessions_updated_at
  before update on public.aps_reconciliation_screen_sessions
  for each row execute function public.aps_reconciliation_screen_sessions_set_updated_at();

-- ============================================
-- 2. Create Reconciliation Lines Table
-- ============================================
create table if not exists public.aps_reconciliation_screen_lines (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.aps_reconciliation_screen_sessions (id) on delete cascade,
  classification_id uuid not null references public.classifications (id) on delete restrict,
  book_amount numeric(19, 2) not null default 0.00,
  accountant_amount numeric(19, 2),
  difference numeric(19, 2) generated always as (coalesce(accountant_amount, 0) - book_amount) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Ensure one line per classification per session
  unique (session_id, classification_id)
);

-- Indexes
create index if not exists aps_reconciliation_screen_lines_session_idx
  on public.aps_reconciliation_screen_lines (session_id);

create index if not exists aps_reconciliation_screen_lines_classification_idx
  on public.aps_reconciliation_screen_lines (classification_id);

-- Updated_at trigger
create or replace function public.aps_reconciliation_screen_lines_set_updated_at()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger aps_reconciliation_screen_lines_updated_at
  before update on public.aps_reconciliation_screen_lines
  for each row execute function public.aps_reconciliation_screen_lines_set_updated_at();

-- ============================================
-- 3. Permissions
-- ============================================

-- Check if permission exists before inserting
insert into public.permissions (slug, module, name_ar, name_en, description)
values (
  'aps.reconciliation:manage',
  'aps',
  'إدارة المطابقات',
  'Manage reconciliations',
  'إدخال أرقام المحاسب وإنشاء جلسات المطابقة'
)
on conflict (slug) do nothing;

insert into public.permissions (slug, module, name_ar, name_en, description)
values (
  'aps.reconciliation:close_month',
  'aps',
  'إغلاق شهر المطابقة',
  'Close reconciliation month',
  'إغلاق جلسة المطابقة بعد التحقق من عدم وجود فروق'
)
on conflict (slug) do nothing;

insert into public.permissions (slug, module, name_ar, name_en, description)
values (
  'aps.reconciliation:reopen_month',
  'aps',
  'إعادة فتح شهر المطابقة',
  'Reopen reconciliation month',
  'إعادة فتح جلسة المطابقة المغلق (للمالك فقط)'
)
on conflict (slug) do nothing;

-- Grant permissions to owner role
insert into public.role_permissions (role_id, permission_id)
select role.id, permission.id
  from public.roles as role
 cross join public.permissions as permission
 where role.slug = 'owner'
   and permission.slug in (
     'aps.reconciliation:manage',
     'aps.reconciliation:close_month',
     'aps.reconciliation:reopen_month'
   )
on conflict (role_id, permission_id) do nothing;

-- ============================================
-- 4. Helper Functions
-- ============================================

-- Check if user can manage reconciliation
create or replace function public.aps_can_manage_reconciliation()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce(public.is_active_user(), false)
     and coalesce(public.has_permission('aps.reconciliation:manage'), false);
$$;

revoke all on function public.aps_can_manage_reconciliation() from public, anon;
grant execute on function public.aps_can_manage_reconciliation() to authenticated, service_role;

-- Check if user can close reconciliation month
create or replace function public.aps_can_close_reconciliation()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce(public.is_active_user(), false)
     and coalesce(public.has_permission('aps.reconciliation:close_month'), false);
$$;

revoke all on function public.aps_can_close_reconciliation() from public, anon;
grant execute on function public.aps_can_close_reconciliation() to authenticated, service_role;

-- Check if user can reopen reconciliation month (owner only)
create or replace function public.aps_can_reopen_reconciliation()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce(public.is_active_user(), false)
     and coalesce(public.has_permission('aps.reconciliation:reopen_month'), false);
$$;

revoke all on function public.aps_can_reopen_reconciliation() from public, anon;
grant execute on function public.aps_can_reopen_reconciliation() to authenticated, service_role;

-- ============================================
-- 5. RPC Functions
-- ============================================

-- Open a new reconciliation session
create or replace function public.aps_open_reconciliation(
  p_fiscal_month_id uuid,
  p_station_id uuid
)
returns public.aps_reconciliation_screen_sessions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing_open_session uuid;
  v_classification record;
  v_session public.aps_reconciliation_screen_sessions;
begin
  -- Check permission
  if not public.aps_can_manage_reconciliation() then
    raise exception 'Permission denied: aps.reconciliation:manage required';
  end if;

  -- Check that there is no existing open session for this month+station
  select id into v_existing_open_session
    from public.aps_reconciliation_screen_sessions
   where fiscal_month_id = p_fiscal_month_id
     and station_id = p_station_id
     and status = 'open'
   limit 1;

  if v_existing_open_session is not null then
    raise exception 'An open reconciliation session already exists for this month and station';
  end if;

  -- Create the session
  insert into public.aps_reconciliation_screen_sessions (fiscal_month_id, station_id)
  values (p_fiscal_month_id, p_station_id)
  returning * into v_session;

  -- Fill the session with lines for all active leaf classifications
  for v_classification in
    select c.id, c.code, c.name
      from public.classifications c
     where c.is_leaf = true
       and c.is_active = true
  loop
    insert into public.aps_reconciliation_screen_lines (session_id, classification_id, book_amount)
    values (v_session.id, v_classification.id, 0.00);
  end loop;

  return v_session;
end;
$$;

revoke all on function public.aps_open_reconciliation(uuid, uuid) from public, anon;
grant execute on function public.aps_open_reconciliation(uuid, uuid) to authenticated, service_role;

-- Record accountant amount for a classification
create or replace function public.aps_record_reconciliation(
  p_session_id uuid,
  p_classification_id uuid,
  p_accountant_amount numeric(19, 2)
)
returns public.aps_reconciliation_screen_lines
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.aps_reconciliation_screen_sessions;
  v_line public.aps_reconciliation_screen_lines;
begin
  -- Check permission
  if not public.aps_can_manage_reconciliation() then
    raise exception 'Permission denied: aps.reconciliation:manage required';
  end if;

  -- Check that session exists and is open
  select * into v_session from public.aps_reconciliation_screen_sessions
   where id = p_session_id
     and status = 'open'
   limit 1;

  if v_session is null then
    raise exception 'Reconciliation session not found or not open';
  end if;

  -- Update or insert the line
  update public.aps_reconciliation_screen_lines
     set accountant_amount = p_accountant_amount,
         updated_at = now()
   where session_id = p_session_id
     and classification_id = p_classification_id
  returning * into v_line;

  if v_line is null then
    -- If line doesn't exist, create it
    insert into public.aps_reconciliation_screen_lines (session_id, classification_id, book_amount, accountant_amount)
    values (p_session_id, p_classification_id, 0.00, p_accountant_amount)
    returning * into v_line;
  end if;

  return v_line;
end;
$$;

revoke all on function public.aps_record_reconciliation(uuid, uuid, numeric) from public, anon;
grant execute on function public.aps_record_reconciliation(uuid, uuid, numeric) to authenticated, service_role;

-- Close a reconciliation month (all sessions for the month must have zero differences)
create or replace function public.aps_close_reconciliation_month(
  p_fiscal_month_id uuid,
  p_reason text
)
returns public.aps_reconciliation_screen_sessions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.aps_reconciliation_screen_sessions;
  v_non_zero_diff_count bigint;
  v_open_session_count bigint;
begin
  -- Check permission
  if not public.aps_can_close_reconciliation() then
    raise exception 'Permission denied: aps.reconciliation:close_month required';
  end if;

  -- Check that there is at least one open session for this month
  select count(*) into v_open_session_count
    from public.aps_reconciliation_screen_sessions
   where fiscal_month_id = p_fiscal_month_id
     and status = 'open';

  if v_open_session_count = 0 then
    raise exception 'No open reconciliation sessions found for this month';
  end if;

  -- Check that all lines in all open sessions have zero difference
  select count(*) into v_non_zero_diff_count
    from public.aps_reconciliation_screen_lines l
   join public.aps_reconciliation_screen_sessions s on l.session_id = s.id
   where s.fiscal_month_id = p_fiscal_month_id
     and s.status = 'open'
     and l.difference != 0.00;

  if v_non_zero_diff_count > 0 then
    raise exception 'Cannot close month: there are % differences that are not zero', v_non_zero_diff_count;
  end if;

  -- Close all open sessions for this month
  update public.aps_reconciliation_screen_sessions
     set status = 'closed',
         closed_at = now(),
         closed_by = auth.uid(),
         close_reason = p_reason,
         updated_at = now()
   where fiscal_month_id = p_fiscal_month_id
     and status = 'open'
   returning * into v_session;

  return v_session;
end;
$$;

revoke all on function public.aps_close_reconciliation_month(uuid, text) from public, anon;
grant execute on function public.aps_close_reconciliation_month(uuid, text) to authenticated, service_role;

-- Reopen a reconciliation month (owner only)
create or replace function public.aps_reopen_reconciliation_month(
  p_fiscal_month_id uuid,
  p_reason text
)
returns public.aps_reconciliation_screen_sessions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.aps_reconciliation_screen_sessions;
  v_closed_count bigint;
begin
  -- Check permission
  if not public.aps_can_reopen_reconciliation() then
    raise exception 'Permission denied: aps.reconciliation:reopen_month required';
  end if;

  -- Check that there is at least one closed session for this month
  select count(*) into v_closed_count
    from public.aps_reconciliation_screen_sessions
   where fiscal_month_id = p_fiscal_month_id
     and status = 'closed'
   limit 1;

  if v_closed_count = 0 then
    raise exception 'No closed reconciliation sessions found for this month';
  end if;

  -- Reopen all closed sessions for this month
  update public.aps_reconciliation_screen_sessions
     set status = 'open',
         closed_at = null,
         closed_by = null,
         close_reason = null,
         updated_at = now()
   where fiscal_month_id = p_fiscal_month_id
     and status = 'closed'
   returning * into v_session;

  return v_session;
end;
$$;

revoke all on function public.aps_reopen_reconciliation_month(uuid, text) from public, anon;
grant execute on function public.aps_reopen_reconciliation_month(uuid, text) to authenticated, service_role;

-- ============================================
-- 6. Row Level Security (RLS)
-- ============================================

-- Enable RLS on sessions table
alter table public.aps_reconciliation_screen_sessions enable row level security;

create policy "Allow read access to reconciliation screen sessions for authorized users"
  on public.aps_reconciliation_screen_sessions for select
  using (public.aps_can_manage_reconciliation() or public.aps_can_close_reconciliation() or public.aps_can_reopen_reconciliation());

create policy "Allow insert on reconciliation screen sessions for managers"
  on public.aps_reconciliation_screen_sessions for insert
  with check (public.aps_can_manage_reconciliation());

create policy "Allow update on reconciliation screen sessions for managers and closers"
  on public.aps_reconciliation_screen_sessions for update
  using (
    public.aps_can_manage_reconciliation() or
    (public.aps_can_close_reconciliation() and new.status = 'closed') or
    (public.aps_can_reopen_reconciliation() and new.status = 'open')
  );

-- Enable RLS on lines table
alter table public.aps_reconciliation_screen_lines enable row level security;

create policy "Allow read access to reconciliation screen lines for authorized users"
  on public.aps_reconciliation_screen_lines for select
  using (public.aps_can_manage_reconciliation() or public.aps_can_close_reconciliation() or public.aps_can_reopen_reconciliation());

create policy "Allow insert on reconciliation screen lines for managers"
  on public.aps_reconciliation_screen_lines for insert
  with check (public.aps_can_manage_reconciliation());

create policy "Allow update on reconciliation screen lines for managers"
  on public.aps_reconciliation_screen_lines for update
  using (public.aps_can_manage_reconciliation());

create policy "Allow delete on reconciliation screen lines for managers"
  on public.aps_reconciliation_screen_lines for delete
  using (public.aps_can_manage_reconciliation());

-- ============================================
-- 7. Comments
-- ============================================

comment on table public.aps_reconciliation_screen_sessions is 'APS Reconciliation Screen Sessions - Simple version for reconciliation screen feature';
comment on table public.aps_reconciliation_screen_lines is 'APS Reconciliation Screen Lines - Individual classification amounts';

comment on column public.aps_reconciliation_screen_sessions.status is 'Session status: open or closed';
comment on column public.aps_reconciliation_screen_sessions.fiscal_month_id is 'Foreign key to fiscal_months table';
comment on column public.aps_reconciliation_screen_sessions.station_id is 'Foreign key to stations table';
comment on column public.aps_reconciliation_screen_sessions.closed_at is 'Timestamp when session was closed';
comment on column public.aps_reconciliation_screen_sessions.closed_by is 'User who closed the session';
comment on column public.aps_reconciliation_screen_sessions.close_reason is 'Reason for closing the session';

comment on column public.aps_reconciliation_screen_lines.session_id is 'Foreign key to aps_reconciliation_screen_sessions';
comment on column public.aps_reconciliation_screen_lines.classification_id is 'Foreign key to classifications table';
comment on column public.aps_reconciliation_screen_lines.book_amount is 'Computed book amount from system';
comment on column public.aps_reconciliation_screen_lines.accountant_amount is 'Manually entered amount by accountant';
comment on column public.aps_reconciliation_screen_lines.difference is 'Computed difference: accountant_amount - book_amount';

comment on function public.aps_open_reconciliation(uuid, uuid) is 'Opens a new reconciliation session for a fiscal month and station';
comment on function public.aps_record_reconciliation(uuid, uuid, numeric) is 'Records accountant amount for a classification in a session';
comment on function public.aps_close_reconciliation_month(uuid, text) is 'Closes all open sessions for a fiscal month (requires all differences = 0)';
comment on function public.aps_reconciliation_screen_sessions_set_updated_at() is 'Sets updated_at timestamp for reconciliation screen sessions';
comment on function public.aps_reconciliation_screen_lines_set_updated_at() is 'Sets updated_at timestamp for reconciliation screen lines';
