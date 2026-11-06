-- APS reconciliation screen, phase 1: schema only.
--
-- aps_reconciliation_sessions already backs the existing monthly reconciliation
-- workflow, so this forward-only migration extends it instead of attempting to
-- create a conflicting table. Its legacy states remain valid; `closed` is added
-- for the new screen. No UI, permission, helper function, or RPC is introduced.

-- ---------------------------------------------------------------------------
-- 1) Sessions
-- ---------------------------------------------------------------------------
alter table public.aps_reconciliation_sessions
  add column if not exists closed_at timestamptz,
  add column if not exists closed_by uuid references auth.users (id),
  add column if not exists close_reason text,
  add column if not exists created_by uuid references auth.users (id);

-- Existing sessions were created by opened_by. Backfill their creator, then
-- default future API inserts to the authenticated user. The column stays
-- nullable, matching the requested schema and supporting privileged SQL jobs.
update public.aps_reconciliation_sessions
   set created_by = opened_by
 where created_by is null;

alter table public.aps_reconciliation_sessions
  alter column created_by set default auth.uid();

alter table public.aps_reconciliation_sessions
  drop constraint if exists aps_reconciliation_sessions_status_check;
alter table public.aps_reconciliation_sessions
  add constraint aps_reconciliation_sessions_status_check
  check (status in ('open', 'closed', 'approved', 'cancelled'));

alter table public.aps_reconciliation_sessions
  drop constraint if exists aps_reconciliation_sessions_lifecycle_check;
alter table public.aps_reconciliation_sessions
  add constraint aps_reconciliation_sessions_lifecycle_check check (
    (
      status = 'open'
      and approved_by is null
      and approved_at is null
      and cancelled_by is null
      and cancelled_at is null
      and cancel_reason is null
    )
    or (
      status = 'closed'
      and approved_by is null
      and approved_at is null
      and cancelled_by is null
      and cancelled_at is null
      and cancel_reason is null
    )
    or (
      status = 'approved'
      and approved_by is not null
      and approved_at is not null
      and cancelled_by is null
      and cancelled_at is null
      and cancel_reason is null
    )
    or (
      status = 'cancelled'
      and cancelled_by is not null
      and cancelled_at is not null
      and cancel_reason is not null
      and char_length(btrim(cancel_reason)) >= 3
    )
  );

-- Reuse the existing partial unique index rather than maintaining two indexes
-- with identical predicates. The new name is the public schema contract.
do $rename_open_session_index$
begin
  if to_regclass('public.aps_reconciliation_sessions_open_key') is not null
     and to_regclass('public.aps_reconciliation_one_open_idx') is null then
    alter index public.aps_reconciliation_sessions_open_key
      rename to aps_reconciliation_one_open_idx;
  end if;
end
$rename_open_session_index$;

create unique index if not exists aps_reconciliation_one_open_idx
  on public.aps_reconciliation_sessions (fiscal_month_id, station_id)
  where status = 'open';

-- ---------------------------------------------------------------------------
-- 2) Lines
-- ---------------------------------------------------------------------------
create table if not exists public.aps_reconciliation_lines (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.aps_reconciliation_sessions (id) on delete cascade,
  classification_id uuid not null references public.classifications (id) on delete restrict,
  book_amount numeric(18, 2) not null default 0,
  accountant_amount numeric(18, 2) not null default 0,
  difference numeric(18, 2) generated always as (accountant_amount - book_amount) stored,
  created_at timestamptz not null default now(),
  constraint aps_reconciliation_lines_session_classification_key
    unique (session_id, classification_id)
);

comment on column public.aps_reconciliation_lines.book_amount is
  'Calculated book amount for this classification.';
comment on column public.aps_reconciliation_lines.accountant_amount is
  'Amount entered manually by the accountant.';
comment on column public.aps_reconciliation_lines.difference is
  'Stored generated difference: accountant_amount - book_amount.';

-- ---------------------------------------------------------------------------
-- 3) Row Level Security and table privileges
-- ---------------------------------------------------------------------------
alter table public.aps_reconciliation_sessions enable row level security;
alter table public.aps_reconciliation_sessions force row level security;
alter table public.aps_reconciliation_lines enable row level security;
alter table public.aps_reconciliation_lines force row level security;

revoke all on table public.aps_reconciliation_sessions, public.aps_reconciliation_lines
  from public, anon, authenticated;
grant select, insert, update, delete
  on table public.aps_reconciliation_sessions, public.aps_reconciliation_lines
  to authenticated;
grant all
  on table public.aps_reconciliation_sessions, public.aps_reconciliation_lines
  to service_role;

-- Temporary access gate until dedicated reconciliation permissions are added
-- in phase 2. The existing legacy read policy remains intact for its RPC/UI.
drop policy if exists aps_reconciliation_sessions_project_settings_select
  on public.aps_reconciliation_sessions;
create policy aps_reconciliation_sessions_project_settings_select
  on public.aps_reconciliation_sessions
  for select to authenticated
  using (public.can_manage_project_settings());

drop policy if exists aps_reconciliation_sessions_project_settings_insert
  on public.aps_reconciliation_sessions;
create policy aps_reconciliation_sessions_project_settings_insert
  on public.aps_reconciliation_sessions
  for insert to authenticated
  with check (public.can_manage_project_settings());

drop policy if exists aps_reconciliation_sessions_project_settings_update
  on public.aps_reconciliation_sessions;
create policy aps_reconciliation_sessions_project_settings_update
  on public.aps_reconciliation_sessions
  for update to authenticated
  using (public.can_manage_project_settings())
  with check (public.can_manage_project_settings());

drop policy if exists aps_reconciliation_sessions_project_settings_delete
  on public.aps_reconciliation_sessions;
create policy aps_reconciliation_sessions_project_settings_delete
  on public.aps_reconciliation_sessions
  for delete to authenticated
  using (public.can_manage_project_settings());

drop policy if exists aps_reconciliation_lines_project_settings_select
  on public.aps_reconciliation_lines;
create policy aps_reconciliation_lines_project_settings_select
  on public.aps_reconciliation_lines
  for select to authenticated
  using (public.can_manage_project_settings());

drop policy if exists aps_reconciliation_lines_project_settings_insert
  on public.aps_reconciliation_lines;
create policy aps_reconciliation_lines_project_settings_insert
  on public.aps_reconciliation_lines
  for insert to authenticated
  with check (public.can_manage_project_settings());

drop policy if exists aps_reconciliation_lines_project_settings_update
  on public.aps_reconciliation_lines;
create policy aps_reconciliation_lines_project_settings_update
  on public.aps_reconciliation_lines
  for update to authenticated
  using (public.can_manage_project_settings())
  with check (public.can_manage_project_settings());

drop policy if exists aps_reconciliation_lines_project_settings_delete
  on public.aps_reconciliation_lines;
create policy aps_reconciliation_lines_project_settings_delete
  on public.aps_reconciliation_lines
  for delete to authenticated
  using (public.can_manage_project_settings());

notify pgrst, 'reload schema';
