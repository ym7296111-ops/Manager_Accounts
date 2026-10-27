-- APS workspace, phase 2: monthly aggregate reconciliation.
--
-- This migration is the data model approved in
-- `docs/consultations/2026-10-27-aps-reconciliation-design-study.md`, with the
-- answers given by the project owner:
--
--   * A session is scoped to (fiscal year + fiscal month + station).
--   * An item is one leaf classification inside that station.
--   * **Dual comparison**, because the accountant sends two reports: the month's
--     movement and the closing statement. Every item therefore carries four
--     numbers — two computed by the system, two typed by the accountant — and
--     two differences, both of which must reach zero before approval.
--   * The settlement difference is a zero-tolerance rule: no percentage, no
--     absolute allowance, no "acceptable variance".
--   * A settlement is the fifth letter type and carries a mandatory reference
--     to the session that produced it.
--   * Approval is a **separate capability** from data entry.
--   * After approval a session is closed forever; correcting it means a new
--     session with a higher sequence number pointing at the previous one.
--
-- Deliberate decisions worth reviewing:
--
--   * The `basis` column from the design study is **not** created. It existed
--     to choose between movement and closing balance; with the dual comparison
--     both are computed and stored, so the flag would be a dead switch that
--     silently changes nothing.
--   * `settlement_warehouse_id` lives on the session, not on each item. The
--     settlement function creates every line in one warehouse chosen by the
--     accountant; a per-item column would repeat the same value N times.
--   * `book_opening` is the year's `opening_balances` (summed across the
--     station's warehouses) plus every approved movement from the year's start
--     up to this month. Without the second part, any month after the first
--     would compare its closing balance against a year-start figure and could
--     never balance. The year opening stays the only hand-entered starting
--     point.
--   * Items are created for **every active leaf**, plus any inactive leaf that
--     still carries an amount, so a classification that has just been retired
--     can still be reconciled for the month it was closed in. The accountant's
--     report can also mention a classification the system has nothing on, and a
--     missing row would make that movement invisible.
--     `aps_fill_reconciliation_zeros()` exists so a quiet month does not
--     require typing ten zeroes by hand.

-- ---------------------------------------------------------------------------
-- 1) Permissions
-- ---------------------------------------------------------------------------
-- `aps.reconciliation:manage` already exists (it gates reading the letters, and
-- is the entry capability). Approval is a separate capability, but RBAC may
-- grant both to one person. Any recording by the approver is noted in the audit
-- entry; the database does not reject self-approval.
insert into public.permissions (slug, module, name_ar, name_en, description)
values (
  'aps.reconciliation:approve',
  'aps',
  'اعتماد المطابقات الشهرية',
  'Approve reconciliations',
  'اعتماد جلسة مطابقة وقفلها نهائياً بعد التحقق من انعدام كل الفروق'
)
on conflict (slug) do nothing;

-- This additional approval permission applies only to settlement letters.
-- Existing ordinary-letter approval continues to use aps.letters:create.
insert into public.permissions (slug, module, name_ar, name_en, description)
values (
  'aps.letters:approve',
  'aps',
  'اعتماد خطابات التسوية',
  'Approve settlement letters',
  'اعتماد خطابات تسوية المطابقة بالإضافة إلى صلاحية إنشاء الخطابات'
)
on conflict (slug) do nothing;

insert into public.role_permissions (role_id, permission_id)
select role.id, permission.id
  from public.roles as role
 cross join public.permissions as permission
 where role.slug in ('owner', 'super_admin')
   and permission.slug in (
     'aps.reconciliation:manage', 'aps.reconciliation:approve', 'aps.letters:approve'
   )
on conflict (role_id, permission_id) do nothing;

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

create or replace function public.aps_can_approve_reconciliation()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce(public.is_active_user(), false)
     and coalesce(public.has_permission('aps.reconciliation:approve'), false);
$$;

revoke all on function public.aps_can_approve_reconciliation() from public, anon;
grant execute on function public.aps_can_approve_reconciliation() to authenticated, service_role;

-- An approver must be able to read the letters behind the numbers, so the read
-- predicate now includes them too.
create or replace function public.aps_can_read_letters()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce(public.is_active_user(), false)
     and (
       coalesce(public.has_permission('aps.letters:read'), false)
       or coalesce(public.has_permission('aps.reconciliation:manage'), false)
       or coalesce(public.has_permission('aps.reconciliation:approve'), false)
     );
$$;

revoke all on function public.aps_can_read_letters() from public, anon;
grant execute on function public.aps_can_read_letters() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2) Audit vocabulary
-- ---------------------------------------------------------------------------
-- Only the actions that change state or record a human number are logged.
-- Recomputation is derived data: logging it would bury the real events.
alter type public.audit_action
  add value if not exists 'aps.reconciliation_opened';
alter type public.audit_action
  add value if not exists 'aps.reconciliation_item_recorded';
alter type public.audit_action
  add value if not exists 'aps.reconciliation_settlement_created';
alter type public.audit_action
  add value if not exists 'aps.reconciliation_approved';
alter type public.audit_action
  add value if not exists 'aps.reconciliation_cancelled';

-- ---------------------------------------------------------------------------
-- 3) Tables
-- ---------------------------------------------------------------------------
create table if not exists public.aps_reconciliation_sessions (
  id uuid primary key default gen_random_uuid(),
  fiscal_year_id uuid not null references public.fiscal_years (id) on delete restrict,
  fiscal_month_id uuid not null references public.fiscal_months (id) on delete restrict,
  station_id uuid not null references public.stations (id) on delete restrict,
  sequence_number integer not null default 1,
  supersedes_session_id uuid references public.aps_reconciliation_sessions (id)
    on delete restrict,
  status text not null default 'open',
  settlement_warehouse_id uuid references public.warehouses (id) on delete restrict,
  note text,
  opened_by uuid not null default auth.uid() references public.profiles (id) on delete restrict,
  opened_at timestamptz not null default now(),
  approved_by uuid references public.profiles (id) on delete restrict,
  approved_at timestamptz,
  cancelled_by uuid references public.profiles (id) on delete restrict,
  cancelled_at timestamptz,
  cancel_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint aps_reconciliation_sessions_status_check check (
    status in ('open', 'approved', 'cancelled')
  ),
  constraint aps_reconciliation_sessions_sequence_positive check (sequence_number >= 1),
  -- A later attempt supersedes the last approved session, but it may be a
  -- fresh attempt after earlier ones were cancelled: then there is nothing to
  -- supersede yet and the pointer stays empty.
  constraint aps_reconciliation_sessions_supersede_check check (
    supersedes_session_id is null or sequence_number > 1
  ),
  constraint aps_reconciliation_sessions_lifecycle_check check (
    (
      status = 'open'
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
  ),
  constraint aps_reconciliation_sessions_month_station_sequence_key
    unique (fiscal_month_id, station_id, sequence_number)
);

comment on column public.aps_reconciliation_sessions.sequence_number is
  '1 for the original session; each corrective session for the same month and station increments it and points at the previous approved session.';
comment on column public.aps_reconciliation_sessions.settlement_warehouse_id is
  'The warehouse chosen by the accountant when a settlement letter was created for this session.';

create table if not exists public.aps_reconciliation_items (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.aps_reconciliation_sessions (id) on delete cascade,
  classification_id uuid not null references public.classifications (id) on delete restrict,
  -- Computed from the year's opening balances plus approved letters, for the
  -- station's warehouses. Never taken from a client.
  book_opening numeric(18, 2) not null default 0,
  book_move_in numeric(18, 2) not null default 0,
  book_move_out numeric(18, 2) not null default 0,
  book_move numeric(18, 2) not null default 0,
  book_closing numeric(18, 2) not null default 0,
  -- Typed by the accountant. NULL means "not entered yet", which is different
  -- from an explicit 0.
  accountant_move numeric(18, 2),
  accountant_closing numeric(18, 2),
  movement_difference numeric(18, 2),
  closing_difference numeric(18, 2),
  recorded_by uuid references public.profiles (id) on delete set null,
  recorded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint aps_reconciliation_items_classification_key unique (session_id, classification_id)
);

comment on column public.aps_reconciliation_items.book_move is
  'In minus out for the month, from approved letters only.';
comment on column public.aps_reconciliation_items.movement_difference is
  'book_move - accountant_move. NULL until the accountant enters a movement.';
comment on column public.aps_reconciliation_items.closing_difference is
  'book_closing - accountant_closing. NULL until the accountant enters a closing balance.';

-- One open session per month and station; an approved or cancelled one is
-- history and may repeat.
create unique index if not exists aps_reconciliation_sessions_open_key
  on public.aps_reconciliation_sessions (fiscal_month_id, station_id)
  where status = 'open';

create index if not exists aps_reconciliation_sessions_month_idx
  on public.aps_reconciliation_sessions (fiscal_month_id, station_id, sequence_number desc);
create index if not exists aps_reconciliation_sessions_station_idx
  on public.aps_reconciliation_sessions (station_id, status);
create index if not exists aps_reconciliation_items_session_idx
  on public.aps_reconciliation_items (session_id, classification_id);
create index if not exists aps_reconciliation_items_classification_idx
  on public.aps_reconciliation_items (classification_id);

create trigger aps_reconciliation_sessions_set_updated_at
  before update on public.aps_reconciliation_sessions
  for each row execute function public.set_updated_at();

create trigger aps_reconciliation_items_set_updated_at
  before update on public.aps_reconciliation_items
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 4) Session guard
-- ---------------------------------------------------------------------------
create or replace function public.aps_reconciliation_sessions_before_write()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_month_year uuid;
  v_bounds record;
begin
  -- The month must belong to the stated fiscal year; otherwise the movement
  -- window and the year's opening balances come from different years.
  select month.fiscal_year_id, month.start_date, month.end_date
    into v_bounds
    from public.fiscal_months as month
   where month.id = new.fiscal_month_id;
  if not found then
    raise exception 'aps reconciliation: unknown fiscal month %', new.fiscal_month_id
      using errcode = '23503';
  end if;
  v_month_year := v_bounds.fiscal_year_id;
  if v_month_year <> new.fiscal_year_id then
    raise exception 'aps reconciliation: fiscal month % does not belong to fiscal year %',
      new.fiscal_month_id, new.fiscal_year_id using errcode = '23514';
  end if;

  if not exists (
    select 1 from public.warehouses as warehouse where warehouse.station_id = new.station_id
  ) then
    raise exception 'aps reconciliation: station % has no warehouse to reconcile',
      new.station_id using errcode = '23514';
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'open' then
      raise exception 'aps reconciliation: sessions are created open' using errcode = '23514';
    end if;
    new.opened_by := coalesce(new.opened_by, auth.uid());
    if new.opened_by is null then
      raise exception 'aps reconciliation: opened_by is required' using errcode = '23514';
    end if;
    new.approved_by := null;
    new.approved_at := null;
    new.cancelled_by := null;
    new.cancelled_at := null;
    new.cancel_reason := null;
  else
    -- A session is identified by its month, station and sequence. Approval only
    -- flips the status and stamps the approver; nothing else may change after
    -- the numbers are certified.
    if new.fiscal_year_id is distinct from old.fiscal_year_id
       or new.fiscal_month_id is distinct from old.fiscal_month_id
       or new.station_id is distinct from old.station_id
       or new.sequence_number is distinct from old.sequence_number
       or new.supersedes_session_id is distinct from old.supersedes_session_id
       or new.opened_by is distinct from old.opened_by
    then
      raise exception 'aps reconciliation: a session cannot be moved or renumbered'
        using errcode = '23514';
    end if;

    if old.status = 'approved' and new.status is distinct from old.status then
      raise exception 'aps reconciliation: an approved session is final' using errcode = '23514';
    end if;
    if old.status = 'approved'
       and (
         new.settlement_warehouse_id is distinct from old.settlement_warehouse_id
         or new.note is distinct from old.note
       )
    then
      raise exception 'aps reconciliation: an approved session is immutable' using errcode = '23514';
    end if;
    if old.status = 'cancelled' and new.status is distinct from old.status then
      raise exception 'aps reconciliation: a cancelled session stays cancelled'
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.aps_reconciliation_sessions_before_write()
  from public, anon, authenticated, service_role;

create trigger aps_reconciliation_sessions_before_write
  before insert or update on public.aps_reconciliation_sessions
  for each row execute function public.aps_reconciliation_sessions_before_write();

-- ---------------------------------------------------------------------------
-- 5) Item guard + derived numbers
-- ---------------------------------------------------------------------------
-- The four book numbers and the two differences are never taken from a client:
-- a client that could write `book_move` could certify any number it liked. Only
-- the two `accountant_*` columns accept input, and only while the session is
-- open.
create or replace function public.aps_reconciliation_items_before_write()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_status text;
begin
  select session.status into v_status
    from public.aps_reconciliation_sessions as session
   where session.id = new.session_id;
  if not found then
    raise exception 'aps reconciliation: unknown session %', new.session_id
      using errcode = '23503';
  end if;

  if tg_op = 'INSERT' then
    if v_status <> 'open' then
      raise exception 'aps reconciliation: items are only created while the session is open'
        using errcode = '23514';
    end if;
  else
    if new.session_id is distinct from old.session_id
       or new.classification_id is distinct from old.classification_id
    then
      raise exception 'aps reconciliation: an item cannot change session or classification'
        using errcode = '23514';
    end if;
    if v_status <> 'open' then
      raise exception 'aps reconciliation: a % session no longer accepts numbers', v_status
        using errcode = '23514';
    end if;
    -- The book numbers are recomputed by aps_refresh_reconciliation(), which
    -- writes through this same trigger, so they are not refused here. What keeps
    -- them out of a client's hands is that `authenticated` holds SELECT only on
    -- this table: there is no INSERT or UPDATE path except these functions.
  end if;

  if not exists (
    select 1 from public.classifications as classification
     where classification.id = new.classification_id
       and classification.is_leaf
  ) then
    raise exception 'aps reconciliation: classification % is not a leaf', new.classification_id
      using errcode = '23514';
  end if;

  new.book_move := coalesce(new.book_move_in, 0) - coalesce(new.book_move_out, 0);
  new.book_closing := coalesce(new.book_opening, 0) + new.book_move;

  if new.accountant_move is null then
    new.movement_difference := null;
  else
    new.movement_difference := new.book_move - new.accountant_move;
  end if;
  if new.accountant_closing is null then
    new.closing_difference := null;
  else
    new.closing_difference := new.book_closing - new.accountant_closing;
  end if;

  if tg_op = 'UPDATE'
     and (
       new.accountant_move is distinct from old.accountant_move
       or new.accountant_closing is distinct from old.accountant_closing
     )
  then
    new.recorded_by := coalesce(auth.uid(), old.recorded_by);
    new.recorded_at := now();
  end if;

  return new;
end;
$$;

revoke all on function public.aps_reconciliation_items_before_write()
  from public, anon, authenticated, service_role;

create trigger aps_reconciliation_items_before_write
  before insert or update on public.aps_reconciliation_items
  for each row execute function public.aps_reconciliation_items_before_write();

-- ---------------------------------------------------------------------------
-- 6) The computed side: opening + movement per leaf
-- ---------------------------------------------------------------------------
create or replace function public.aps_reconciliation_book_amounts(
  p_fiscal_year_id uuid,
  p_fiscal_month_id uuid,
  p_station_id uuid
)
returns table (
  classification_id uuid,
  book_opening numeric(18, 2),
  book_move_in numeric(18, 2),
  book_move_out numeric(18, 2)
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with year_bounds as (
    select year.start_date
      from public.fiscal_years as year
     where year.id = p_fiscal_year_id
  ),
  month_bounds as (
    select month.start_date, month.end_date
      from public.fiscal_months as month
     where month.id = p_fiscal_month_id
       and month.fiscal_year_id = p_fiscal_year_id
  ),
  station_warehouses as (
    select warehouse.id
      from public.warehouses as warehouse
     where warehouse.station_id = p_station_id
  ),
  -- The year's opening balances are the only hand-entered starting point. The
  -- opening of a month other than the first is that figure plus every approved
  -- movement since the year began, otherwise the second month of the year would
  -- compare its closing balance against a year-start figure and never balance.
  year_opening as (
    select balance.classification_id, sum(balance.amount) as amount
      from public.opening_balances as balance
      join station_warehouses as warehouse on warehouse.id = balance.warehouse_id
     where balance.fiscal_year_id = p_fiscal_year_id
     group by balance.classification_id
  ),
  prior_movement as (
    select line.classification_id,
           coalesce(
             sum(case when line.direction = 'in' then line.amount else -line.amount end),
             0
           ) as amount
      from public.letter_lines as line
      join public.letters as letter on letter.id = line.letter_id
      join station_warehouses as warehouse on warehouse.id = line.warehouse_id
      cross join month_bounds as bounds
      cross join year_bounds as year
     where letter.status = 'approved'
       and letter.letter_date >= year.start_date
       and letter.letter_date < bounds.start_date
     group by line.classification_id
  ),
  opening as (
    select coalesce(year_opening.classification_id, prior.classification_id) as classification_id,
           coalesce(year_opening.amount, 0) + coalesce(prior.amount, 0) as amount
      from year_opening
      full join prior_movement as prior
        on prior.classification_id = year_opening.classification_id
  ),
  movement as (
    select line.classification_id,
           coalesce(sum(line.amount) filter (where line.direction = 'in'), 0) as in_amount,
           coalesce(sum(line.amount) filter (where line.direction = 'out'), 0) as out_amount
      from public.letter_lines as line
      join public.letters as letter on letter.id = line.letter_id
      join station_warehouses as warehouse on warehouse.id = line.warehouse_id
      cross join month_bounds as bounds
     where letter.status = 'approved'
       and letter.letter_date between bounds.start_date and bounds.end_date
     group by line.classification_id
  )
  select coalesce(opening.classification_id, movement.classification_id),
         coalesce(opening.amount, 0)::numeric(18, 2),
         coalesce(movement.in_amount, 0)::numeric(18, 2),
         coalesce(movement.out_amount, 0)::numeric(18, 2)
    from opening
    full join movement on movement.classification_id = opening.classification_id
$$;

revoke all on function public.aps_reconciliation_book_amounts(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7) Session lifecycle
-- ---------------------------------------------------------------------------
create or replace function public.aps_open_reconciliation(
  p_fiscal_month_id uuid,
  p_station_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_month record;
  v_station record;
  v_sequence integer;
  v_previous uuid;
  v_session_id uuid;
  v_items integer;
begin
  if v_actor is null or not public.aps_can_manage_reconciliation() then
    raise exception 'aps_open_reconciliation: aps.reconciliation:manage is required'
      using errcode = '42501';
  end if;

  select month.fiscal_year_id, month.start_date, month.end_date, month.name
    into v_month
    from public.fiscal_months as month
   where month.id = p_fiscal_month_id;
  if not found then
    raise exception 'aps_open_reconciliation: unknown fiscal month %', p_fiscal_month_id
      using errcode = 'P0002';
  end if;

  select station.code, station.name into v_station
    from public.stations as station
   where station.id = p_station_id;
  if not found then
    raise exception 'aps_open_reconciliation: unknown station %', p_station_id
      using errcode = 'P0002';
  end if;

  if exists (
    select 1
      from public.aps_reconciliation_sessions as session
     where session.fiscal_month_id = p_fiscal_month_id
       and session.station_id = p_station_id
       and session.status = 'open'
  ) then
    raise exception 'aps_open_reconciliation: % already has an open session for %',
      v_station.code, v_month.name using errcode = '22023';
  end if;

  select coalesce(max(session.sequence_number), 0) + 1,
         (
           select prior.id
             from public.aps_reconciliation_sessions as prior
            where prior.fiscal_month_id = p_fiscal_month_id
              and prior.station_id = p_station_id
              and prior.status = 'approved'
            order by prior.sequence_number desc
            limit 1
         )
    into v_sequence, v_previous
    from public.aps_reconciliation_sessions as session
   where session.fiscal_month_id = p_fiscal_month_id
     and session.station_id = p_station_id;

  insert into public.aps_reconciliation_sessions
    (fiscal_year_id, fiscal_month_id, station_id, sequence_number, supersedes_session_id,
     status, opened_by)
  values
    (v_month.fiscal_year_id, p_fiscal_month_id, p_station_id, v_sequence, v_previous,
     'open', v_actor)
  returning id into v_session_id;

  -- One row per active leaf, plus any inactive leaf that still carries an
  -- opening balance or movement. A classification the accountant reports on but
  -- the system has nothing for must still have a row to type into.
  insert into public.aps_reconciliation_items
    (session_id, classification_id, book_opening, book_move_in, book_move_out)
  select v_session_id,
         leaf.id,
         coalesce(amounts.book_opening, 0),
         coalesce(amounts.book_move_in, 0),
         coalesce(amounts.book_move_out, 0)
    from public.classifications as leaf
    left join public.aps_reconciliation_book_amounts(
      v_month.fiscal_year_id, p_fiscal_month_id, p_station_id
    ) as amounts on amounts.classification_id = leaf.id
   where leaf.is_leaf
     and (
       leaf.is_active
       or coalesce(amounts.book_opening, 0) <> 0
       or coalesce(amounts.book_move_in, 0) <> 0
       or coalesce(amounts.book_move_out, 0) <> 0
     );

  get diagnostics v_items = row_count;

  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
  values (
    v_actor,
    'aps.reconciliation_opened'::public.audit_action,
    'aps_reconciliation_sessions',
    v_session_id::text,
    jsonb_build_object(
      'fiscal_year_id', v_month.fiscal_year_id,
      'fiscal_month_id', p_fiscal_month_id,
      'month_name', v_month.name,
      'station_id', p_station_id,
      'station_code', v_station.code,
      'sequence_number', v_sequence,
      'supersedes_session_id', v_previous,
      'item_count', v_items
    )
  );

  return v_session_id;
end;
$$;

revoke all on function public.aps_open_reconciliation(uuid, uuid) from public, anon;
grant execute on function public.aps_open_reconciliation(uuid, uuid) to authenticated, service_role;

create or replace function public.aps_refresh_reconciliation(p_session_id uuid)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_session public.aps_reconciliation_sessions%rowtype;
  v_items integer;
begin
  select * into v_session
    from public.aps_reconciliation_sessions as session
   where session.id = p_session_id
   for update;
  if not found then
    raise exception 'aps_refresh_reconciliation: unknown session %', p_session_id
      using errcode = 'P0002';
  end if;
  if v_session.status <> 'open' then
    raise exception 'aps_refresh_reconciliation: a % session is final', v_session.status
      using errcode = '22023';
  end if;

  -- The capability check is skipped for an internal call made by another
  -- reconciliation routine in the same transaction; every public entry point
  -- already checked it before calling.
  if auth.uid() is not null
     and not public.aps_can_manage_reconciliation()
     and not public.aps_can_approve_reconciliation()
  then
    raise exception 'aps_refresh_reconciliation: a reconciliation capability is required'
      using errcode = '42501';
  end if;

  update public.aps_reconciliation_items as item
     set book_opening = amounts.book_opening,
         book_move_in = amounts.book_move_in,
         book_move_out = amounts.book_move_out
    from (
      select * from public.aps_reconciliation_book_amounts(
        v_session.fiscal_year_id, v_session.fiscal_month_id, v_session.station_id
      )
    ) as amounts
   where item.session_id = p_session_id
     and item.classification_id = amounts.classification_id;

  insert into public.aps_reconciliation_items
    (session_id, classification_id, book_opening, book_move_in, book_move_out)
  select p_session_id,
         amounts.classification_id,
         amounts.book_opening,
         amounts.book_move_in,
         amounts.book_move_out
    from (
      select * from public.aps_reconciliation_book_amounts(
        v_session.fiscal_year_id, v_session.fiscal_month_id, v_session.station_id
      )
    ) as amounts
    join public.classifications as leaf on leaf.id = amounts.classification_id
   where leaf.is_leaf
     and (
       amounts.book_opening <> 0 or amounts.book_move_in <> 0 or amounts.book_move_out <> 0
     )
     and not exists (
       select 1
         from public.aps_reconciliation_items as existing
        where existing.session_id = p_session_id
          and existing.classification_id = amounts.classification_id
     );

  select count(*)::integer into v_items
    from public.aps_reconciliation_items as item
   where item.session_id = p_session_id;

  return v_items;
end;
$$;

revoke all on function public.aps_refresh_reconciliation(uuid) from public, anon;
grant execute on function public.aps_refresh_reconciliation(uuid) to authenticated, service_role;

create or replace function public.aps_record_reconciliation_item(
  p_session_id uuid,
  p_classification_id uuid,
  p_accountant_move numeric,
  p_accountant_closing numeric
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_session public.aps_reconciliation_sessions%rowtype;
  v_item public.aps_reconciliation_items%rowtype;
  v_move numeric(18, 2) := p_accountant_move;
  v_closing numeric(18, 2) := p_accountant_closing;
  v_previous_move numeric(18, 2);
  v_previous_closing numeric(18, 2);
begin
  if v_actor is null or not public.aps_can_manage_reconciliation() then
    raise exception 'aps_record_reconciliation_item: aps.reconciliation:manage is required'
      using errcode = '42501';
  end if;

  -- Net movement is signed: more outgoing than incoming is a negative value.
  if v_closing is not null and v_closing < 0 then
    raise exception 'aps_record_reconciliation_item: a closing balance is never negative'
      using errcode = '22023';
  end if;

  select * into v_session
    from public.aps_reconciliation_sessions as session
   where session.id = p_session_id
   for update;
  if not found then
    raise exception 'aps_record_reconciliation_item: unknown session %', p_session_id
      using errcode = 'P0002';
  end if;
  if v_session.status <> 'open' then
    raise exception 'aps_record_reconciliation_item: a % session no longer accepts numbers',
      v_session.status using errcode = '22023';
  end if;

  select * into v_item
    from public.aps_reconciliation_items as item
   where item.session_id = p_session_id
     and item.classification_id = p_classification_id;
  if not found then
    raise exception 'aps_record_reconciliation_item: classification % is not in this session',
      p_classification_id using errcode = 'P0002';
  end if;

  v_previous_move := v_item.accountant_move;
  v_previous_closing := v_item.accountant_closing;

  update public.aps_reconciliation_items
     set accountant_move = v_move,
         accountant_closing = v_closing
   where id = v_item.id
  returning * into v_item;

  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
  values (
    v_actor,
    'aps.reconciliation_item_recorded'::public.audit_action,
    'aps_reconciliation_items',
    v_item.id::text,
    jsonb_build_object(
      'session_id', p_session_id,
      'classification_id', p_classification_id,
      'previous_accountant_move', v_previous_move,
      'previous_accountant_closing', v_previous_closing,
      'accountant_move', v_item.accountant_move,
      'accountant_closing', v_item.accountant_closing,
      'book_move', v_item.book_move,
      'book_closing', v_item.book_closing,
      'movement_difference', v_item.movement_difference,
      'closing_difference', v_item.closing_difference
    )
  );

  return jsonb_build_object(
    'item_id', v_item.id,
    'book_move', v_item.book_move,
    'book_closing', v_item.book_closing,
    'accountant_move', v_item.accountant_move,
    'accountant_closing', v_item.accountant_closing,
    'movement_difference', v_item.movement_difference,
    'closing_difference', v_item.closing_difference
  );
end;
$$;

revoke all on function public.aps_record_reconciliation_item(uuid, uuid, numeric, numeric)
  from public, anon;
grant execute on function public.aps_record_reconciliation_item(uuid, uuid, numeric, numeric)
  to authenticated, service_role;

-- Fill an explicit zero for every empty item whose book numbers are already
-- zero. A quiet month then needs one call instead of ten manual zeroes, and the
-- zeroes are still recorded as inputs rather than silently assumed.
create or replace function public.aps_fill_reconciliation_zeros(p_session_id uuid)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_session public.aps_reconciliation_sessions%rowtype;
  v_filled integer;
begin
  if v_actor is null or not public.aps_can_manage_reconciliation() then
    raise exception 'aps_fill_reconciliation_zeros: aps.reconciliation:manage is required'
      using errcode = '42501';
  end if;

  select * into v_session
    from public.aps_reconciliation_sessions as session
   where session.id = p_session_id
   for update;
  if not found then
    raise exception 'aps_fill_reconciliation_zeros: unknown session %', p_session_id
      using errcode = 'P0002';
  end if;
  if v_session.status <> 'open' then
    raise exception 'aps_fill_reconciliation_zeros: a % session is final', v_session.status
      using errcode = '22023';
  end if;

  update public.aps_reconciliation_items
     set accountant_move = 0,
         accountant_closing = 0
   where session_id = p_session_id
     and accountant_move is null
     and accountant_closing is null
     and book_move = 0
     and book_closing = 0;

  get diagnostics v_filled = row_count;

  if v_filled > 0 then
    insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
    values (
      v_actor,
      'aps.reconciliation_item_recorded'::public.audit_action,
      'aps_reconciliation_sessions',
      p_session_id::text,
      jsonb_build_object(
        'session_id', p_session_id,
        'bulk', true,
        'filled_zero_items', v_filled
      )
    );
  end if;

  return v_filled;
end;
$$;

revoke all on function public.aps_fill_reconciliation_zeros(uuid) from public, anon;
grant execute on function public.aps_fill_reconciliation_zeros(uuid) to authenticated, service_role;

create or replace function public.aps_cancel_reconciliation(p_session_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_session public.aps_reconciliation_sessions%rowtype;
  v_reason text;
begin
  if v_actor is null or not public.aps_can_manage_reconciliation() then
    raise exception 'aps_cancel_reconciliation: aps.reconciliation:manage is required'
      using errcode = '42501';
  end if;

  v_reason := btrim(coalesce(p_reason, ''));
  if char_length(v_reason) < 3 or char_length(v_reason) > 500 then
    raise exception 'aps_cancel_reconciliation: a written reason between 3 and 500 characters is required'
      using errcode = '22023';
  end if;

  select * into v_session
    from public.aps_reconciliation_sessions as session
   where session.id = p_session_id
   for update;
  if not found then
    raise exception 'aps_cancel_reconciliation: unknown session %', p_session_id
      using errcode = 'P0002';
  end if;
  if v_session.status <> 'open' then
    raise exception 'aps_cancel_reconciliation: only an open session can be cancelled, this one is %',
      v_session.status using errcode = '22023';
  end if;

  -- Once a settlement is approved the books have moved. Cancelling the session
  -- would leave that correction standing with nothing that explains it, so the
  -- session becomes a record that must be superseded instead.
  if exists (
    select 1
      from public.letters as letter
     where letter.reconciliation_session_id = p_session_id
       and letter.status = 'approved'
  ) then
    raise exception 'aps_cancel_reconciliation: an approved settlement letter already changed the books; cancel the letter first or correct the session with a new one'
      using errcode = '22023';
  end if;

  update public.aps_reconciliation_sessions
     set status = 'cancelled',
         cancelled_by = v_actor,
         cancelled_at = now(),
         cancel_reason = v_reason
   where id = p_session_id;

  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
  values (
    v_actor,
    'aps.reconciliation_cancelled'::public.audit_action,
    'aps_reconciliation_sessions',
    p_session_id::text,
    jsonb_build_object(
      'fiscal_month_id', v_session.fiscal_month_id,
      'station_id', v_session.station_id,
      'sequence_number', v_session.sequence_number,
      'reason', v_reason
    )
  );
end;
$$;

revoke all on function public.aps_cancel_reconciliation(uuid, text) from public, anon;
grant execute on function public.aps_cancel_reconciliation(uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 8) The settlement letter
-- ---------------------------------------------------------------------------
-- The difference is signed as `book - accountant`. A positive value means our
-- books carry more than the accountant's, so the settlement moves stock **out**;
-- a negative value needs an **in** line. One line per differing classification,
-- all in a single warehouse chosen here.
--
-- A difference in the opening balance cannot be settled: a movement letter
-- changes the movement and the closing balance by the same amount, so it can
-- never close a gap that exists only in the opening figure. That case is
-- reported precisely instead of being folded into a number that will not add up.
-- Trim Unicode whitespace and common invisible/bidi controls at the edges so
-- pasted Arabic text cannot satisfy the reason length with invisible characters.
create or replace function public.aps_trim_settlement_reason(p_reason text)
returns text
language sql
immutable
strict
parallel safe
set search_path = pg_catalog
as $$
  select btrim(
    p_reason,
    U&'\0009\000A\000B\000C\000D\0020\0085\00A0\061C\1680\180E\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\200B\200C\200D\200E\200F\2028\2029\202A\202B\202C\202D\202E\202F\205F\2060\2066\2067\2068\2069\3000\FEFF'
  );
$$;

revoke all on function public.aps_trim_settlement_reason(text)
  from public, anon, authenticated, service_role;

-- Remove the old two-argument entry point so it cannot bypass the reason.
drop function if exists public.aps_create_reconciliation_settlement(uuid, uuid);

create or replace function public.aps_create_reconciliation_settlement(
  p_session_id uuid,
  p_warehouse_id uuid,
  p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_session public.aps_reconciliation_sessions%rowtype;
  v_warehouse record;
  v_month record;
  v_number numeric;
  v_letter_id uuid;
  v_opening_gap integer;
  v_lines integer;
  v_reason text;
begin
  if v_actor is null or not public.aps_can_manage_reconciliation() then
    raise exception 'aps_create_reconciliation_settlement: aps.reconciliation:manage is required'
      using errcode = '42501';
  end if;

  v_reason := public.aps_trim_settlement_reason(coalesce(p_reason, ''));
  if char_length(v_reason) < 3 or char_length(v_reason) > 500 then
    raise exception 'aps_create_reconciliation_settlement: a written reason between 3 and 500 characters is required'
      using errcode = '22023';
  end if;

  select * into v_session
    from public.aps_reconciliation_sessions as session
   where session.id = p_session_id
   for update;
  if not found then
    raise exception 'aps_create_reconciliation_settlement: unknown session %', p_session_id
      using errcode = 'P0002';
  end if;
  if v_session.status <> 'open' then
    raise exception 'aps_create_reconciliation_settlement: a % session is final', v_session.status
      using errcode = '22023';
  end if;

  select warehouse.id, warehouse.code, warehouse.name, warehouse.station_id
    into v_warehouse
    from public.warehouses as warehouse
   where warehouse.id = p_warehouse_id;
  if not found then
    raise exception 'aps_create_reconciliation_settlement: unknown warehouse %', p_warehouse_id
      using errcode = 'P0002';
  end if;
  if v_warehouse.station_id <> v_session.station_id then
    raise exception 'aps_create_reconciliation_settlement: warehouse % belongs to another station',
      v_warehouse.code using errcode = '22023';
  end if;

  if exists (
    select 1
      from public.letters as letter
     where letter.reconciliation_session_id = p_session_id
       and letter.status <> 'cancelled'
  ) then
    raise exception 'aps_create_reconciliation_settlement: this session already has a settlement letter'
      using errcode = '22023';
  end if;

  -- Recompute first: a settlement must be built on the numbers as they are now,
  -- not on a stale screenshot.
  perform public.aps_refresh_reconciliation(p_session_id);

  select count(*)::integer into v_lines
    from public.aps_reconciliation_items as item
   where item.session_id = p_session_id
     and item.movement_difference is not null
     and item.movement_difference <> 0;

  if v_lines = 0 then
    raise exception 'aps_create_reconciliation_settlement: there is no difference to settle'
      using errcode = '22023';
  end if;

  select count(*)::integer into v_opening_gap
    from public.aps_reconciliation_items as item
   where item.session_id = p_session_id
     and item.movement_difference is not null
     and item.closing_difference is not null
     and item.movement_difference <> 0
     and item.closing_difference <> item.movement_difference;
  if v_opening_gap > 0 then
    raise exception 'aps_create_reconciliation_settlement: % item(s) differ in the opening balance; a movement letter cannot close that — correct the opening balances instead',
      v_opening_gap using errcode = '22023';
  end if;

  select month.start_date, month.end_date, month.name
    into v_month
    from public.fiscal_months as month
   where month.id = v_session.fiscal_month_id;

  select coalesce(max(letter.letter_number::numeric), 0) + 1
    into v_number
    from public.letters as letter
   where letter.fiscal_year_id = v_session.fiscal_year_id
     and letter.letter_number ~ '^[0-9]+$';

  insert into public.letters
    (fiscal_year_id, letter_type, letter_number, letter_date, status, created_by,
     reconciliation_session_id, settlement_reason)
  values
    (v_session.fiscal_year_id, 'settlement', coalesce(v_number, 1)::text,
     v_month.end_date, 'draft', v_actor, p_session_id, v_reason)
  returning id into v_letter_id;

  insert into public.letter_lines
    (letter_id, direction, warehouse_id, classification_id, amount, note)
  select v_letter_id,
         case when item.movement_difference > 0 then 'out' else 'in' end,
         p_warehouse_id,
         item.classification_id,
         abs(item.movement_difference),
         'تسوية مطابقة ' || v_month.name
    from public.aps_reconciliation_items as item
   where item.session_id = p_session_id
     and item.movement_difference is not null
     and item.movement_difference <> 0;

  update public.aps_reconciliation_sessions
     set settlement_warehouse_id = p_warehouse_id
   where id = p_session_id;

  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
  values (
    v_actor,
    'aps.reconciliation_settlement_created'::public.audit_action,
    'aps_reconciliation_sessions',
    p_session_id::text,
    jsonb_build_object(
      'session_id', p_session_id,
      'letter_id', v_letter_id,
      'letter_number', coalesce(v_number, 1)::text,
      'warehouse_id', p_warehouse_id,
      'warehouse_code', v_warehouse.code,
      'line_count', v_lines,
      'reason', v_reason
    )
  );

  return v_letter_id;
end;
$$;

revoke all on function public.aps_create_reconciliation_settlement(uuid, uuid, text)
  from public, anon;
grant execute on function public.aps_create_reconciliation_settlement(uuid, uuid, text)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 9) Approval
-- ---------------------------------------------------------------------------
create or replace function public.aps_approve_reconciliation(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_session public.aps_reconciliation_sessions%rowtype;
  v_month record;
  v_missing integer;
  v_drafts integer;
  v_movement_differences integer;
  v_closing_differences integer;
  v_items integer;
  v_approver_current_items integer;
  v_approver_recorded_any boolean;
begin
  if v_actor is null or not public.aps_can_approve_reconciliation() then
    raise exception 'aps_approve_reconciliation: aps.reconciliation:approve is required'
      using errcode = '42501';
  end if;

  select * into v_session
    from public.aps_reconciliation_sessions as session
   where session.id = p_session_id
   for update;
  if not found then
    raise exception 'aps_approve_reconciliation: unknown session %', p_session_id
      using errcode = 'P0002';
  end if;
  if v_session.status <> 'open' then
    raise exception 'aps_approve_reconciliation: only an open session can be approved, this one is %',
      v_session.status using errcode = '22023';
  end if;

  -- Freeze-time recomputation: the numbers certified are the numbers that exist
  -- now, not the ones from the last manual refresh. Check for an empty session
  -- only after refreshing, which can add rows with new book movements.
  v_items := public.aps_refresh_reconciliation(p_session_id);
  if v_items = 0 then
    raise exception 'aps_approve_reconciliation: a session without items cannot be approved'
      using errcode = '22023';
  end if;

  select count(*)::integer into v_drafts
    from public.letters as letter
   where letter.reconciliation_session_id = p_session_id
     and letter.status = 'draft';
  if v_drafts > 0 then
    raise exception 'aps_approve_reconciliation: % settlement letter(s) for this session are still drafts and must be approved first',
      v_drafts using errcode = '22023';
  end if;

  select count(*)::integer into v_missing
    from public.aps_reconciliation_items as item
   where item.session_id = p_session_id
     and (item.accountant_move is null or item.accountant_closing is null);
  if v_missing > 0 then
    raise exception 'aps_approve_reconciliation: % item(s) have no accountant figures',
      v_missing using errcode = '22023';
  end if;

  select count(*)::integer into v_movement_differences
    from public.aps_reconciliation_items as item
   where item.session_id = p_session_id
     and item.movement_difference <> 0;
  select count(*)::integer into v_closing_differences
    from public.aps_reconciliation_items as item
   where item.session_id = p_session_id
     and item.closing_difference <> 0;

  if v_movement_differences > 0 or v_closing_differences > 0 then
    raise exception 'aps_approve_reconciliation: % movement difference(s) and % closing difference(s) remain',
      v_movement_differences, v_closing_differences using errcode = '22023';
  end if;

  -- A session may have several recorders. The flag covers any figures the
  -- approver entered in this session, including bulk zeroes and values later
  -- overwritten by someone else. The count describes the current last recorder
  -- on each item, so the two fields answer different audit questions.
  select count(*)::integer into v_approver_current_items
    from public.aps_reconciliation_items as item
   where item.session_id = p_session_id
     and item.recorded_by = v_actor;

  select v_approver_current_items > 0 or exists (
    select 1
      from public.audit_logs as log
     where log.actor_id = v_actor
       and log.action = 'aps.reconciliation_item_recorded'::public.audit_action
       and log.metadata ->> 'session_id' = p_session_id::text
       and (
         (log.entity = 'aps_reconciliation_sessions' and log.metadata ->> 'bulk' = 'true')
         or (
           log.entity = 'aps_reconciliation_items'
           and (
             log.metadata ->> 'accountant_move' is not null
             or log.metadata ->> 'accountant_closing' is not null
           )
         )
       )
  ) into v_approver_recorded_any;

  select month.name into v_month
    from public.fiscal_months as month
   where month.id = v_session.fiscal_month_id;

  update public.aps_reconciliation_sessions
     set status = 'approved',
         approved_by = v_actor,
         approved_at = now()
   where id = p_session_id;

  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
  values (
    v_actor,
    'aps.reconciliation_approved'::public.audit_action,
    'aps_reconciliation_sessions',
    p_session_id::text,
    jsonb_build_object(
      'fiscal_year_id', v_session.fiscal_year_id,
      'fiscal_month_id', v_session.fiscal_month_id,
      'month_name', v_month.name,
      'station_id', v_session.station_id,
      'sequence_number', v_session.sequence_number,
      'item_count', v_items,
      'settlement_warehouse_id', v_session.settlement_warehouse_id,
      'approver_recorded_any_item', v_approver_recorded_any,
      'current_items_recorded_by_approver', v_approver_current_items
    )
  );
end;
$$;

revoke all on function public.aps_approve_reconciliation(uuid) from public, anon;
grant execute on function public.aps_approve_reconciliation(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 10) Extend letters with the settlement type
-- ---------------------------------------------------------------------------
alter table public.letters
  add column if not exists reconciliation_session_id uuid
    references public.aps_reconciliation_sessions (id) on delete restrict;
alter table public.letters
  add column if not exists settlement_reason text;

comment on column public.letters.settlement_reason is
  'Written reason for this settlement letter, retained independently for each cancelled or replacement letter.';

alter table public.letters
  drop constraint if exists letters_type_check;
alter table public.letters
  add constraint letters_type_check check (
    letter_type in ('inbound', 'outbound', 'internal_transfer', 'external_transfer', 'settlement')
  );

-- A settlement has no counterparty: it is our own correction against our own
-- books, so it behaves like an internal transfer for this rule.
alter table public.letters
  drop constraint if exists letters_counterparty_matches_type;
alter table public.letters
  add constraint letters_counterparty_matches_type check (
    (letter_type in ('inbound', 'outbound') and party_id is not null and sister_company_id is null)
    or (letter_type = 'external_transfer'
        and sister_company_id is not null
        and party_id is null)
    or (
      letter_type in ('internal_transfer', 'settlement')
      and party_id is null
      and sister_company_id is null
    )
  );

alter table public.letters
  drop constraint if exists letters_settlement_session_check;
alter table public.letters
  add constraint letters_settlement_session_check check (
    (letter_type = 'settlement') = (reconciliation_session_id is not null)
  );

-- The reason belongs to each letter, not the session: cancelling and replacing
-- a settlement must preserve the original reason. The write trigger trims it.
alter table public.letters
  drop constraint if exists letters_settlement_reason_check;
alter table public.letters
  add constraint letters_settlement_reason_check check (
    (letter_type = 'settlement'
     and settlement_reason is not null
     and char_length(settlement_reason) between 3 and 500)
    or (letter_type <> 'settlement' and settlement_reason is null)
  );

-- One live settlement per session: a cancelled one may be replaced.
create unique index if not exists letters_settlement_session_key
  on public.letters (reconciliation_session_id)
  where reconciliation_session_id is not null and status <> 'cancelled';

create index if not exists letters_reconciliation_session_idx
  on public.letters (reconciliation_session_id)
  where reconciliation_session_id is not null;

-- ---------------------------------------------------------------------------
-- 11) Letter write guard, extended for settlements
-- ---------------------------------------------------------------------------
create or replace function public.aps_letters_before_write()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_party record;
  v_sister record;
  v_year record;
  v_typed text;
  v_expected_branch text;
  v_session public.aps_reconciliation_sessions%rowtype;
begin
  -- Apply the same whitespace normalization to RPC and direct writes so the
  -- length constraint cannot be satisfied with surrounding whitespace alone.
  if new.settlement_reason is not null then
    new.settlement_reason := public.aps_trim_settlement_reason(new.settlement_reason);
  end if;

  -- Normalise first: the unique key must see the canonical value, and the raw
  -- text is only kept when the caller actually supplied something new.
  v_typed := new.letter_number;
  new.letter_number := public.aps_normalize_letter_number(new.letter_number);
  if tg_op = 'INSERT' or new.letter_number is distinct from old.letter_number then
    new.letter_number_raw := coalesce(nullif(btrim(coalesce(v_typed, '')), ''), new.letter_number);
  end if;
  new.letter_number_raw := coalesce(new.letter_number_raw, new.letter_number);

  if new.letter_number is null or new.letter_number = '' then
    raise exception 'aps letters: a letter number is required' using errcode = '23514';
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'aps letters: letters are created as drafts; use aps_approve_letter()'
        using errcode = '23514';
    end if;
    new.created_by := coalesce(new.created_by, auth.uid());
    if new.created_by is null then
      raise exception 'aps letters: created_by is required' using errcode = '23514';
    end if;
    new.approved_at := null;
    new.approved_by := null;
    new.cancelled_at := null;
    new.cancelled_by := null;
    new.cancel_reason := null;
  else
    if new.created_by is distinct from old.created_by then
      raise exception 'aps letters: the author of a letter cannot change'
        using errcode = '23514';
    end if;
    -- A settlement must not be converted into an ordinary draft to evade the
    -- settlement-specific approval capability or discard its audit context.
    if old.letter_type = 'settlement' and new.letter_type <> 'settlement' then
      raise exception 'aps letters: a settlement cannot change its letter type'
        using errcode = '23514';
    end if;

    -- A settled letter is frozen. The only permitted change is the one-way
    -- trip from `approved` to `cancelled`, and even that may not touch a
    -- single content column.
    if old.status in ('approved', 'cancelled') then
      if new.status is distinct from old.status
         and not (old.status = 'approved' and new.status = 'cancelled') then
        raise exception 'aps letters: % letters cannot change status to %', old.status, new.status
          using errcode = '23514';
      end if;
      if new.letter_number is distinct from old.letter_number
         or new.letter_number_raw is distinct from old.letter_number_raw
         or new.letter_date is distinct from old.letter_date
         or new.letter_type is distinct from old.letter_type
         or new.fiscal_year_id is distinct from old.fiscal_year_id
         or new.party_id is distinct from old.party_id
         or new.sister_company_id is distinct from old.sister_company_id
         or new.counterparty_code is distinct from old.counterparty_code
         or new.counterparty_name is distinct from old.counterparty_name
         or new.source_total is distinct from old.source_total
         or new.destination_total is distinct from old.destination_total
         or new.has_reclassification is distinct from old.has_reclassification
         or new.reclassification_reason is distinct from old.reclassification_reason
         or new.reconciliation_session_id is distinct from old.reconciliation_session_id
         or new.settlement_reason is distinct from old.settlement_reason
      then
        raise exception 'aps letters: a % letter is immutable', old.status
          using errcode = '23514';
      end if;
    end if;

    if new.status = 'approved' and old.status = 'draft' then
      if new.approved_at is null or new.approved_by is null then
        raise exception 'aps letters: approval must record the approver'
          using errcode = '23514';
      end if;
      -- aps_approve_letter() retains its normal author/settings-manager check
      -- and requires create for every letter. Settlement approval additionally
      -- needs the dedicated capability, even on any other write path.
      if new.letter_type = 'settlement'
         and (
           auth.uid() is null
           or not public.aps_can_create_letters()
           or not coalesce(public.has_permission('aps.letters:approve'), false)
         )
      then
        raise exception 'aps letters: settlement approval requires aps.letters:create and aps.letters:approve'
          using errcode = '42501';
      end if;
    end if;
  end if;

  -- Counterparty: exclusive per type, snapshotted, branch-matched.
  if new.letter_type in ('inbound', 'outbound') then
    if new.party_id is null or new.sister_company_id is not null then
      raise exception 'aps letters: a % letter needs exactly one party and no sister company',
        new.letter_type using errcode = '23514';
    end if;
    select party.branch, party.code, party.name
      into v_party
      from public.parties as party
     where party.id = new.party_id;
    if not found then
      raise exception 'aps letters: unknown party %', new.party_id using errcode = '23503';
    end if;
    v_expected_branch := case when new.letter_type = 'inbound' then 'inbound' else 'outbound' end;
    if v_party.branch <> v_expected_branch then
      raise exception 'aps letters: a % letter needs a % party, % is %',
        new.letter_type, v_expected_branch, v_party.code, v_party.branch
        using errcode = '23514';
    end if;
    new.counterparty_code := v_party.code;
    new.counterparty_name := v_party.name;
  elsif new.letter_type = 'external_transfer' then
    if new.sister_company_id is null or new.party_id is not null then
      raise exception 'aps letters: an external transfer needs exactly one sister company'
        using errcode = '23514';
    end if;
    select company.code, company.name
      into v_sister
      from public.sister_companies as company
     where company.id = new.sister_company_id;
    if not found then
      raise exception 'aps letters: unknown sister company %', new.sister_company_id
        using errcode = '23503';
    end if;
    new.counterparty_code := v_sister.code;
    new.counterparty_name := v_sister.name;
  elsif new.letter_type = 'settlement' then
    -- A caller with only letter-creation rights must not bypass the settlement
    -- RPC by inserting a settlement directly or converting another draft.
    -- Trusted maintenance without an authenticated actor remains unchanged.
    if auth.uid() is not null
       and (tg_op = 'INSERT' or old.letter_type is distinct from 'settlement')
       and not public.aps_can_manage_reconciliation()
    then
      raise exception 'aps letters: creating a settlement requires aps.reconciliation:manage'
        using errcode = '42501';
    end if;
    if new.party_id is not null or new.sister_company_id is not null then
      raise exception 'aps letters: a settlement has no counterparty' using errcode = '23514';
    end if;
    new.counterparty_code := null;
    new.counterparty_name := null;

    if new.reconciliation_session_id is null then
      raise exception 'aps letters: a settlement must belong to a reconciliation session'
        using errcode = '23514';
    end if;
    select * into v_session
      from public.aps_reconciliation_sessions as session
     where session.id = new.reconciliation_session_id;
    if not found then
      raise exception 'aps letters: unknown reconciliation session %',
        new.reconciliation_session_id using errcode = '23503';
    end if;
    if v_session.status <> 'open' then
      raise exception 'aps letters: reconciliation session is % and no longer accepts a settlement',
        v_session.status using errcode = '23514';
    end if;
    if v_session.fiscal_year_id <> new.fiscal_year_id then
      raise exception 'aps letters: the settlement must stay in the session fiscal year'
        using errcode = '23514';
    end if;
  else
    if new.party_id is not null or new.sister_company_id is not null then
      raise exception 'aps letters: an internal transfer has no counterparty'
        using errcode = '23514';
    end if;
    new.counterparty_code := null;
    new.counterparty_name := null;
  end if;

  if new.letter_type <> 'settlement' and new.reconciliation_session_id is not null then
    raise exception 'aps letters: only a settlement points at a reconciliation session'
      using errcode = '23514';
  end if;

  -- The accounting date must belong to the letter's own fiscal year; otherwise
  -- every monthly total silently lands in the wrong bucket.
  select year.start_date, year.end_date
    into v_year
    from public.fiscal_years as year
   where year.id = new.fiscal_year_id;
  if not found then
    raise exception 'aps letters: unknown fiscal year %', new.fiscal_year_id
      using errcode = '23503';
  end if;
  if new.letter_date < v_year.start_date or new.letter_date > v_year.end_date then
    raise exception 'aps letters: % is outside the fiscal year (% to %)',
      new.letter_date, v_year.start_date, v_year.end_date
      using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function public.aps_letters_before_write()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 12) Letter consistency, extended for settlements
-- ---------------------------------------------------------------------------
create or replace function public.aps_assert_letter_consistent(p_letter_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_type text;
  v_lines integer;
  v_in_total numeric(18, 2);
  v_out_total numeric(18, 2);
  v_directions integer;
begin
  select letter.letter_type into v_type
    from public.letters as letter
   where letter.id = p_letter_id;
  if v_type is null then
    return;
  end if;

  select count(*)::integer,
         coalesce(sum(line.amount) filter (where line.direction = 'in'), 0),
         coalesce(sum(line.amount) filter (where line.direction = 'out'), 0),
         count(distinct line.direction)::integer
    into v_lines, v_in_total, v_out_total, v_directions
    from public.letter_lines as line
   where line.letter_id = p_letter_id;

  if v_lines = 0 then
    return;
  end if;

  if v_type = 'inbound' and exists (
    select 1 from public.letter_lines as line
     where line.letter_id = p_letter_id and line.direction <> 'in'
  ) then
    raise exception 'aps letters: an inbound letter only has `in` lines' using errcode = '23514';
  end if;
  if v_type = 'outbound' and exists (
    select 1 from public.letter_lines as line
     where line.letter_id = p_letter_id and line.direction <> 'out'
  ) then
    raise exception 'aps letters: an outbound letter only has `out` lines' using errcode = '23514';
  end if;
  -- An intercompany movement goes one way. Netting both directions inside one
  -- letter would hide two unrelated movements behind a single total.
  if v_type = 'external_transfer' and v_directions <> 1 then
    raise exception 'aps letters: an external transfer moves stock in one direction only'
      using errcode = '23514';
  end if;

  if v_type <> 'internal_transfer' then
    if exists (
      select 1 from public.letter_lines as line
       where line.letter_id = p_letter_id and line.paired_line_id is not null
    ) then
      raise exception 'aps letters: only an internal transfer pairs lines'
        using errcode = '23514';
    end if;
    return;
  end if;

  if v_in_total <> v_out_total then
    raise exception 'aps letters: the transfer does not balance (% in vs % out)',
      v_in_total, v_out_total using errcode = '23514';
  end if;

  if exists (
    select 1 from public.letter_lines as line
     where line.letter_id = p_letter_id and line.direction = 'in' and line.paired_line_id is null
  ) then
    raise exception 'aps letters: every destination line must name the source line it settles'
      using errcode = '23514';
  end if;

  if exists (
    select 1
      from public.letter_lines as line
      join public.letter_lines as paired on paired.id = line.paired_line_id
     where line.letter_id = p_letter_id
       and line.direction = 'in'
       and (
         paired.letter_id <> line.letter_id
         or paired.direction <> 'out'
         or paired.amount <> line.amount
       )
  ) then
    raise exception 'aps letters: a paired line must be an equal `out` line of the same letter'
      using errcode = '23514';
  end if;

  if exists (
    select 1
      from public.letter_lines as line
     where line.letter_id = p_letter_id
       and line.direction = 'out'
       and (
         select count(*)
           from public.letter_lines as settled
          where settled.paired_line_id = line.id
       ) <> 1
  ) then
    raise exception 'aps letters: every source line must be settled by exactly one destination line'
      using errcode = '23514';
  end if;

  -- A pair that crosses classifications is a reclassification, not a plain
  -- move: it must be declared and justified on the header, otherwise the same
  -- balance change hides behind an ordinary transfer.
  if exists (
    select 1
      from public.letter_lines as line
      join public.letter_lines as paired on paired.id = line.paired_line_id
     where line.letter_id = p_letter_id
       and line.direction = 'in'
       and line.classification_id <> paired.classification_id
  ) and not coalesce(
    (
      select letter.has_reclassification
        from public.letters as letter
       where letter.id = p_letter_id
    ),
    false
  ) then
    raise exception 'aps letters: a transfer into a different classification must be flagged as a reclassification with a reason'
      using errcode = '23514';
  end if;
end;
$$;

revoke all on function public.aps_assert_letter_consistent(uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 13) RLS
-- ---------------------------------------------------------------------------
alter table public.aps_reconciliation_sessions enable row level security;
alter table public.aps_reconciliation_sessions force row level security;
alter table public.aps_reconciliation_items enable row level security;
alter table public.aps_reconciliation_items force row level security;

-- A reconciliation manager may read a session-linked settlement draft and its
-- lines, even without letter-creation rights. Ordinary drafts remain visible
-- only to their author; the existing INSERT/UPDATE/DELETE policies are unchanged.
drop policy if exists letters_read on public.letters;
create policy letters_read
  on public.letters
  for select
  to authenticated
  using (
    (status <> 'draft' and public.aps_can_read_letters())
    or (status = 'draft' and created_by = auth.uid() and public.aps_can_create_letters())
    or (
      status = 'draft'
      and letter_type = 'settlement'
      and reconciliation_session_id is not null
      and public.aps_can_manage_reconciliation()
    )
  );

-- Read only for API callers. Every write goes through the SECURITY DEFINER
-- functions above, because the computed numbers and the lifecycle stamps must
-- not be reachable by a direct table call.
grant select on public.aps_reconciliation_sessions to authenticated;
grant select on public.aps_reconciliation_items to authenticated;

drop policy if exists aps_reconciliation_sessions_read on public.aps_reconciliation_sessions;
create policy aps_reconciliation_sessions_read
  on public.aps_reconciliation_sessions
  for select
  to authenticated
  using (
    public.aps_can_manage_reconciliation()
    or public.aps_can_approve_reconciliation()
  );

drop policy if exists aps_reconciliation_items_read on public.aps_reconciliation_items;
create policy aps_reconciliation_items_read
  on public.aps_reconciliation_items
  for select
  to authenticated
  using (
    exists (
      select 1
        from public.aps_reconciliation_sessions as session
       where session.id = aps_reconciliation_items.session_id
    )
  );

-- ---------------------------------------------------------------------------
-- 14) Preconditions
-- ---------------------------------------------------------------------------
do $verify_aps_reconciliation$
begin
  if not exists (select 1 from public.permissions where slug = 'aps.reconciliation:manage') then
    raise exception 'aps.reconciliation:manage is missing';
  end if;
  if not exists (select 1 from public.permissions where slug = 'aps.reconciliation:approve') then
    raise exception 'aps.reconciliation:approve is missing';
  end if;
  if not exists (select 1 from public.permissions where slug = 'aps.letters:approve') then
    raise exception 'aps.letters:approve is missing';
  end if;
  if exists (
    select 1
      from public.permissions
     where slug in (
       'aps.reconciliation:manage', 'aps.reconciliation:approve', 'aps.letters:approve'
     )
       and module <> 'aps'
  ) then
    raise exception 'the reconciliation and settlement approval permissions must live in the aps module';
  end if;

  if (
    select count(*)
      from public.role_permissions as grant_row
      join public.roles as role on role.id = grant_row.role_id
      join public.permissions as permission on permission.id = grant_row.permission_id
     where role.slug in ('owner', 'super_admin')
       and permission.slug in ('aps.reconciliation:manage', 'aps.reconciliation:approve')
  ) <> 4 then
    raise exception 'owner and super_admin must hold both reconciliation permissions';
  end if;
  if (
    select count(*)
      from public.role_permissions as grant_row
      join public.roles as role on role.id = grant_row.role_id
      join public.permissions as permission on permission.id = grant_row.permission_id
     where role.slug in ('owner', 'super_admin')
       and permission.slug = 'aps.letters:approve'
  ) <> 2 then
    raise exception 'owner and super_admin must hold settlement-letter approval';
  end if;

  if to_regclass('public.aps_reconciliation_sessions') is null
     or to_regclass('public.aps_reconciliation_items') is null then
    raise exception 'the reconciliation tables are missing';
  end if;

  if not exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'letters'
       and column_name = 'reconciliation_session_id'
  ) then
    raise exception 'letters.reconciliation_session_id is missing';
  end if;

  if not exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'letters'
       and column_name = 'settlement_reason'
  ) then
    raise exception 'letters.settlement_reason is missing';
  end if;

  if (
    select count(*)
      from pg_catalog.pg_constraint
     where conrelid = 'public.letters'::regclass
       and conname in ('letters_settlement_session_check', 'letters_settlement_reason_check')
       and contype = 'c'
  ) <> 2 then
    raise exception 'settlement session/reason constraints are missing';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_indexes
     where schemaname = 'public'
       and tablename = 'aps_reconciliation_sessions'
       and indexname = 'aps_reconciliation_sessions_open_key'
  ) then
    raise exception 'the one-open-session index is missing';
  end if;

  if (
    select count(*)
      from pg_catalog.pg_enum as enum
      join pg_catalog.pg_type as type on type.oid = enum.enumtypid
     where type.typname = 'audit_action'
       and enumlabel in (
         'aps.reconciliation_opened',
         'aps.reconciliation_item_recorded',
         'aps.reconciliation_settlement_created',
         'aps.reconciliation_approved',
         'aps.reconciliation_cancelled'
       )
  ) <> 5 then
    raise exception 'audit_action is missing the reconciliation actions';
  end if;

  if (
    select count(*)
      from pg_catalog.pg_policies
     where schemaname = 'public'
       and tablename in ('aps_reconciliation_sessions', 'aps_reconciliation_items')
       and policyname in ('aps_reconciliation_sessions_read', 'aps_reconciliation_items_read')
  ) <> 2 then
    raise exception 'the reconciliation RLS policies are incomplete';
  end if;

  if has_table_privilege('authenticated', 'public.aps_reconciliation_items', 'INSERT')
     or has_table_privilege('authenticated', 'public.aps_reconciliation_items', 'UPDATE')
     or has_table_privilege('authenticated', 'public.aps_reconciliation_items', 'DELETE') then
    raise exception 'API callers must not write reconciliation items directly';
  end if;

  if to_regprocedure('public.aps_open_reconciliation(uuid, uuid)') is null
     or to_regprocedure('public.aps_refresh_reconciliation(uuid)') is null
     or to_regprocedure('public.aps_record_reconciliation_item(uuid, uuid, numeric, numeric)') is null
     or to_regprocedure('public.aps_fill_reconciliation_zeros(uuid)') is null
     or to_regprocedure('public.aps_trim_settlement_reason(text)') is null
     or to_regprocedure('public.aps_create_reconciliation_settlement(uuid, uuid, text)') is null
     or to_regprocedure('public.aps_approve_reconciliation(uuid)') is null
     or to_regprocedure('public.aps_cancel_reconciliation(uuid, text)') is null then
    raise exception 'the reconciliation functions are incomplete';
  end if;
  if to_regprocedure('public.aps_create_reconciliation_settlement(uuid, uuid)') is not null then
    raise exception 'the settlement function without a reason must not exist';
  end if;
end
$verify_aps_reconciliation$;

notify pgrst, 'reload schema';
