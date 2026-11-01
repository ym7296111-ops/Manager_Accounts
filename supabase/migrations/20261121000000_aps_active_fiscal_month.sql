-- Active accounting period (phase A.1): one posting month for the whole project.
-- Design: docs/consultations/2026-11-01-aps-active-accounting-period-design-study.md
-- Plan:   docs/consultations/2026-11-01-aps-active-accounting-period-implementation-plan.md
--
-- Why this migration exists
--   The entry screen used to decide the accounting period by asking the clock
--   ("which month contains today"). A manager who wants to post an October
--   letter in November therefore got a November letter. The period becomes an
--   explicit, audited decision instead:
--     * exactly one fiscal month is active at a time (partial unique index),
--     * it must belong to the active fiscal year,
--     * only aps_activate_fiscal_month() may set it, so the exception for a
--       closed period (owner / super admin + a written reason) cannot be
--       bypassed by a plain PostgREST update,
--     * every transition is audited, even one written by a role that bypasses
--       the column grants (the AFTER trigger is unconditional).
--
-- Deliberately NOT in this migration
--   `letters` is untouched: no period column, no date derivation, and
--   aps_save_letter_draft() keeps its current signature. Those belong to
--   phases A.2/A.3 so this one can ship with zero visible change.
--   The single edit outside the period feature is fiscal_years_before_write()
--   (§6): a period must not survive the year it belongs to, and that clearing
--   has to be audited.
--
-- Security model
--   * aps_project_today()        — definer: reads a setting only settings
--                                  managers may read; used for a suggestion.
--   * aps_active_period()        — definer: fiscal_months SELECT is restricted
--                                  to project-settings managers, while letter
--                                  creators and the (invoker) save function
--                                  still need to resolve the active period.
--   * aps_activate_fiscal_month() — definer: the only writer of is_active.
--   * triggers                    — definer, matching aps_letters_before_write.

-- ---------------------------------------------------------------------------
-- 0) Audit vocabulary
-- ---------------------------------------------------------------------------
-- Three labels rather than one: "how often did we post into a closed period?"
-- and "did the period ever vanish?" must stay plain queries, not JSON
-- inspections. They are only referenced inside trigger bodies, which run after
-- this transaction commits.
alter type public.audit_action
  add value if not exists 'fiscal_month.activated';
alter type public.audit_action
  add value if not exists 'fiscal_month.activated_closed';
alter type public.audit_action
  add value if not exists 'fiscal_month.deactivated';

-- ---------------------------------------------------------------------------
-- 1) The column and its single-active invariant
-- ---------------------------------------------------------------------------
alter table public.fiscal_months
  add column if not exists is_active boolean not null default false;

comment on column public.fiscal_months.is_active is
  'The project posting period. At most one fiscal month is active across the whole project (fiscal_months_one_active_idx), it must belong to the active fiscal year, and only aps_activate_fiscal_month() may set it.';

-- The final invariant, independent of the trigger and of any client path.
create unique index if not exists fiscal_months_one_active_idx
  on public.fiscal_months (is_active)
  where is_active;

-- ---------------------------------------------------------------------------
-- 2) Protected-role helper (owner + super_admin)
-- ---------------------------------------------------------------------------
-- `roles.is_super_admin` is the repository's existing marker for the two
-- protected roles, so this helper needs no role list of its own.
create or replace function public.is_protected_role_holder()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce(public.is_active_user(), false)
     and exists (
       select 1
         from public.user_roles as assignment
         join public.roles as role on role.id = assignment.role_id
        where assignment.user_id = auth.uid()
          and role.is_super_admin
     );
$$;

revoke all on function public.is_protected_role_holder() from public, anon;
grant execute on function public.is_protected_role_holder() to authenticated, service_role;
comment on function public.is_protected_role_holder() is
  'True for an active user holding owner or super_admin. Used for the two documented exceptions (activating a closed period) and never as a general permission.';

-- ---------------------------------------------------------------------------
-- 3) Project "today" (suggestion only)
-- ---------------------------------------------------------------------------
-- The accounting path never reads a clock after this work. The only remaining
-- use is labelling the month that contains "today" in the periodic settings as
-- a suggestion, so the manager still decides. The zone comes from
-- appearance.default_timezone (the same key the executive dashboard reads) and
-- falls back to UTC instead of failing the screen.
create or replace function public.aps_project_today()
returns date
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_timezone text;
begin
  begin
    select nullif(btrim(coalesce(s.value #>> '{}', '')), '')
      into v_timezone
      from public.app_settings as s
     where s.key = 'appearance.default_timezone';

    if v_timezone is null then
      v_timezone := 'UTC';
    else
      -- Engine-level validity probe: an unknown zone raises and is caught below.
      perform (now() at time zone v_timezone);
    end if;
  exception when others then
    v_timezone := 'UTC';
  end;

  return (now() at time zone v_timezone)::date;
end;
$$;

revoke all on function public.aps_project_today() from public, anon;
grant execute on function public.aps_project_today() to authenticated, service_role;
comment on function public.aps_project_today() is
  'Today in the project time zone (appearance.default_timezone, UTC fallback). Display and suggestion only: no accounting date is ever derived from it.';

-- ---------------------------------------------------------------------------
-- 4) Rotation guard
-- ---------------------------------------------------------------------------
-- Runs before the partial unique index, exactly like fiscal_years_before_write.
-- Also the guard against a month being born active, or being deleted while it
-- is the posting period: a period only ever ends by activating another one.
-- The previous month is switched off in the same statement, so the index never
-- sees two active rows and a concurrent writer still cannot create a second one.
create or replace function public.fiscal_months_before_write()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_excluded_id uuid;
  v_previous_id uuid;
  v_year_is_active boolean;
begin
  -- The posting period must not disappear by deletion either: a month is
  -- deleted only after the period has been moved away from it, so the loss of
  -- a period is always a recorded activation of another one.
  if tg_op = 'DELETE' then
    if old.is_active then
      raise exception 'fiscal months: move the period to another month before deleting this one'
        using errcode = '23514';
    end if;
    return old;
  end if;

  -- A month is never born active: activation is an explicit, audited act.
  if tg_op = 'INSERT' and new.is_active then
    raise exception 'fiscal months: a month cannot be created active; activate it explicitly'
      using errcode = '23514';
  end if;

  if not new.is_active then
    return new;
  end if;

  -- Only a month of the active fiscal year may be posted to; otherwise the
  -- project could carry an active period in a year nobody is working in.
  select year.is_active
    into v_year_is_active
    from public.fiscal_years as year
   where year.id = new.fiscal_year_id;
  if not found then
    raise exception 'fiscal months: unknown fiscal year %', new.fiscal_year_id
      using errcode = '23503';
  end if;
  if not v_year_is_active then
    raise exception 'fiscal months: activate the fiscal year before activating one of its months'
      using errcode = '23514';
  end if;

  v_excluded_id := case when tg_op = 'UPDATE' then old.id else new.id end;

  -- Remember the month being left: by the time the AFTER trigger runs, the
  -- previous month is already deactivated and could not be named there.
  select month.id
    into v_previous_id
    from public.fiscal_months as month
   where month.is_active
     and month.id is distinct from v_excluded_id
   limit 1;
  perform set_config(
    'aps.previous_active_month',
    coalesce(v_previous_id::text, ''),
    true
  );

  -- The nested rows enter this trigger with is_active = false and stop there.
  update public.fiscal_months
     set is_active = false
   where is_active
     and id is distinct from v_excluded_id;

  return new;
end;
$$;

revoke all on function public.fiscal_months_before_write()
  from public, anon, authenticated, service_role;

drop trigger if exists fiscal_months_before_write on public.fiscal_months;
create trigger fiscal_months_before_write
  before insert or update or delete on public.fiscal_months
  for each row execute function public.fiscal_months_before_write();

-- ---------------------------------------------------------------------------
-- 5) Unconditional audit of every transition
-- ---------------------------------------------------------------------------
-- The RPC is the intended writer, but the audit trail must not depend on the
-- caller taking that door: a service_role write, or a future maintenance
-- script, still lands here with via = 'direct' and actor = the JWT subject.
create or replace function public.audit_fiscal_month_activation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_previous_id uuid;
  v_previous_name text;
  v_reason text;
  v_via text;
  v_year_name text;
  v_year_closed boolean;
  v_action public.audit_action;
begin
  if not new.is_active then
    return null;
  end if;
  if tg_op = 'UPDATE' and old.is_active is not distinct from new.is_active then
    return null;
  end if;

  v_previous_id := nullif(current_setting('aps.previous_active_month', true), '')::uuid;
  v_reason := nullif(btrim(coalesce(current_setting('aps.activation_reason', true), '')), '');
  v_via := coalesce(nullif(current_setting('aps.activation_via', true), ''), 'direct');

  select year.name, year.is_closed
    into v_year_name, v_year_closed
    from public.fiscal_years as year
   where year.id = new.fiscal_year_id;

  if v_previous_id is not null then
    select month.name
      into v_previous_name
      from public.fiscal_months as month
     where month.id = v_previous_id;
  end if;

  v_action := case
    when new.is_closed or coalesce(v_year_closed, false)
      then 'fiscal_month.activated_closed'::public.audit_action
    else 'fiscal_month.activated'::public.audit_action
  end;

  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
  values (
    auth.uid(),
    v_action,
    'fiscal_months',
    new.id::text,
    jsonb_build_object(
      'fiscal_month_id', new.id,
      'month_name', new.name,
      'month_number', new.month_number,
      'fiscal_year_id', new.fiscal_year_id,
      'fiscal_year_name', v_year_name,
      'previous_fiscal_month_id', v_previous_id,
      'previous_month_name', v_previous_name,
      'month_is_closed', new.is_closed,
      'year_is_closed', coalesce(v_year_closed, false),
      'reason', v_reason,
      'via', v_via
    )
  );

  return null;
end;
$$;

revoke all on function public.audit_fiscal_month_activation()
  from public, anon, authenticated, service_role;

drop trigger if exists fiscal_months_audit_activation on public.fiscal_months;
create trigger fiscal_months_audit_activation
  after insert or update on public.fiscal_months
  for each row execute function public.audit_fiscal_month_activation();

-- ---------------------------------------------------------------------------
-- 6) A period cannot outlive its year
-- ---------------------------------------------------------------------------
-- Activating a year rotates the project into it. If the posting month belonged
-- to the year being left, that month is now outside the active year, so the
-- period is cleared and the manager must choose again explicitly — never by
-- guessing "the month that contains today". Clearing is a period change with
-- no replacement, so it gets its own audit row (`fiscal_month.deactivated`);
-- a normal switch does not, because the activation row already names the month
-- it replaced.
--
-- This is the existing fiscal_years_before_write() with one addition, kept in
-- place so the year-label derivation and the rotation stay together. It is now
-- SECURITY DEFINER because the audit insert must not depend on the caller
-- holding INSERT on audit_logs.
create or replace function public.fiscal_years_before_write()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_cleared record;
  v_excluded_id uuid;
  -- A plain copy: inside an UPDATE ... RETURNING, `new` is the RETURNING alias
  -- rather than the trigger row, so `new.id` there would not resolve.
  v_year_id uuid := new.id;
begin
  new.name := extract(year from new.start_date)::integer::text
              || '-'
              || extract(year from new.end_date)::integer::text;
  v_excluded_id := case when tg_op = 'UPDATE' then old.id else new.id end;

  -- This BEFORE trigger runs before the partial unique index is checked, so a
  -- new active year can replace the previous one without a transient conflict.
  -- The nested updates enter this trigger with is_active=false and do not recurse.
  if new.is_active then
    update public.fiscal_years
       set is_active = false
     where is_active
       and id is distinct from v_excluded_id;

    for v_cleared in
      update public.fiscal_months
         set is_active = false
       where is_active
         and fiscal_year_id is distinct from v_year_id
      returning id, name, month_number, current_period, fiscal_year_id
    loop
      insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
      values (
        auth.uid(),
        'fiscal_month.deactivated',
        'fiscal_months',
        v_cleared.id::text,
        jsonb_build_object(
          'fiscal_month_id', v_cleared.id,
          'month_name', v_cleared.name,
          'month_number', v_cleared.month_number,
          'period_number', v_cleared.current_period,
          'previous_fiscal_year_id', v_cleared.fiscal_year_id,
          'fiscal_year_id', v_year_id,
          'fiscal_year_name', new.name,
          'reason', 'fiscal_year_rotation',
          'via', 'year_rotation'
        )
      );
    end loop;
  end if;

  return new;
end;
$$;

revoke all on function public.fiscal_years_before_write()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7) Reader
-- ---------------------------------------------------------------------------
-- aps_save_letter_draft() runs as the caller (security invoker) and the direct
-- SELECT policy on fiscal_months is limited to project-settings managers, so
-- this definer reader is the only correct way to resolve the period.
create or replace function public.aps_active_period()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_month record;
  v_today date;
begin
  if v_actor is null
     or (
       not public.aps_can_create_letters()
       and not public.can_manage_project_settings()
     ) then
    raise exception 'aps_active_period: aps.letters:create or project.settings:manage is required'
      using errcode = '42501';
  end if;

  select month.id,
         month.fiscal_year_id,
         month.month_number,
         month.name,
         month.start_date,
         month.end_date,
         month.current_period,
         month.is_closed,
         year.name as year_name,
         year.is_active as year_is_active,
         year.is_closed as year_is_closed,
         year.supplements_open
    into v_month
    from public.fiscal_months as month
    join public.fiscal_years as year on year.id = month.fiscal_year_id
   where month.is_active
   limit 1;

  -- No active period is a correct, reportable state: the caller shows it and
  -- refuses the save instead of inventing a month.
  if not found then
    return null;
  end if;

  v_today := public.aps_project_today();

  return jsonb_build_object(
    'fiscal_month_id', v_month.id,
    'fiscal_year_id', v_month.fiscal_year_id,
    'month_number', v_month.month_number,
    'name', v_month.name,
    'period_number', v_month.current_period,
    'start_date', v_month.start_date,
    'end_date', v_month.end_date,
    'is_closed', v_month.is_closed,
    'fiscal_year_name', v_month.year_name,
    'fiscal_year_is_active', v_month.year_is_active,
    'fiscal_year_is_closed', v_month.year_is_closed,
    'supplements_open', v_month.supplements_open,
    'project_today', v_today,
    'contains_today', v_today is not null and v_today between v_month.start_date and v_month.end_date
  );
end;
$$;

revoke all on function public.aps_active_period() from public, anon;
grant execute on function public.aps_active_period() to authenticated, service_role;
comment on function public.aps_active_period() is
  'The single active fiscal month as JSON, or null when the project has none. Definer reader for letter creators and project-settings managers; never widens SELECT on fiscal_months.';

-- ---------------------------------------------------------------------------
-- 8) The only write path
-- ---------------------------------------------------------------------------
create or replace function public.aps_activate_fiscal_month(
  p_fiscal_month_id uuid,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_month public.fiscal_months%rowtype;
  v_year record;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_closed boolean;
begin
  if v_actor is null or not public.can_manage_project_settings() then
    raise exception 'aps_activate_fiscal_month: project.settings:manage is required'
      using errcode = '42501';
  end if;

  select *
    into v_month
    from public.fiscal_months
   where id = p_fiscal_month_id
   for update;
  if not found then
    raise exception 'aps_activate_fiscal_month: unknown fiscal month %', p_fiscal_month_id
      using errcode = 'P0002';
  end if;

  select year.name, year.is_active, year.is_closed, year.supplements_open
    into v_year
    from public.fiscal_years as year
   where year.id = v_month.fiscal_year_id;
  if not found then
    raise exception 'aps_activate_fiscal_month: unknown fiscal year %', v_month.fiscal_year_id
      using errcode = '23503';
  end if;

  -- Idempotent: a repeated click changes nothing and writes no audit row.
  if v_month.is_active then
    return jsonb_build_object(
      'fiscal_month_id', v_month.id,
      'fiscal_year_id', v_month.fiscal_year_id,
      'changed', false,
      'was_closed', v_month.is_closed or v_year.is_closed
    );
  end if;

  if not v_year.is_active then
    raise exception 'aps_activate_fiscal_month: the fiscal year % is not active', v_year.name
      using errcode = '22023';
  end if;

  v_closed := v_month.is_closed or v_year.is_closed;

  -- The documented exception (approved 2026-11-01): posting into a closed
  -- period is allowed for the owner / super admin only, and only with a written
  -- reason. supplements_open still governs approval, not activation.
  if v_closed then
    if not public.is_protected_role_holder() then
      raise exception 'aps_activate_fiscal_month: only the owner or a super admin may post into a closed period'
        using errcode = '42501';
    end if;
    if v_reason is null or char_length(v_reason) < 10 then
      raise exception 'aps_activate_fiscal_month: a closed period needs a written reason of at least 10 characters'
        using errcode = '22023';
    end if;
  end if;

  perform set_config('aps.activation_via', 'rpc', true);
  perform set_config('aps.activation_reason', coalesce(v_reason, ''), true);

  update public.fiscal_months
     set is_active = true
   where id = p_fiscal_month_id;

  return jsonb_build_object(
    'fiscal_month_id', v_month.id,
    'fiscal_year_id', v_month.fiscal_year_id,
    'changed', true,
    'was_closed', v_closed,
    'reason', v_reason
  );
end;
$$;

revoke all on function public.aps_activate_fiscal_month(uuid, text) from public, anon;
grant execute on function public.aps_activate_fiscal_month(uuid, text) to authenticated, service_role;
comment on function public.aps_activate_fiscal_month(uuid, text) is
  'Sets the project posting month. Require project.settings:manage; refuses a month of an inactive year; a closed month needs owner/super_admin and a reason of at least 10 characters. Audited by the table trigger, not by this function.';

-- ---------------------------------------------------------------------------
-- 9) Privileges: a column REVOKE alone would be a no-op
-- ---------------------------------------------------------------------------
-- In PostgreSQL a table-level UPDATE grant covers every column, so revoking
-- UPDATE(is_active) while `grant update on fiscal_months` stands changes
-- nothing. The table grant is replaced by per-column grants that omit
-- is_active; current_period stays writable because the periodic-settings screen
-- updates it directly today (and its e2e contract depends on that).
revoke update on public.fiscal_months from authenticated;
grant update (
  fiscal_year_id,
  month_number,
  name,
  start_date,
  end_date,
  current_period,
  is_closed,
  created_at,
  updated_at
) on public.fiscal_months to authenticated;

-- ---------------------------------------------------------------------------
-- 10) Verification: fail loudly if any guarantee above is missing
-- ---------------------------------------------------------------------------
do $$
declare
  v_labels integer;
  v_active integer;
begin
  if not exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'fiscal_months'
       and column_name = 'is_active'
       and is_nullable = 'NO'
  ) then
    raise exception 'aps active period: fiscal_months.is_active is missing or nullable';
  end if;

  if not exists (
    select 1
      from pg_indexes
     where schemaname = 'public'
       and indexname = 'fiscal_months_one_active_idx'
  ) then
    raise exception 'aps active period: fiscal_months_one_active_idx is missing';
  end if;

  -- Guards the one edit this migration makes outside the period feature: the
  -- year trigger must have been replaced by the version that clears the period.
  if not exists (
    select 1
      from pg_proc as procedure
      join pg_namespace as namespace on namespace.oid = procedure.pronamespace
     where namespace.nspname = 'public'
       and procedure.proname = 'fiscal_years_before_write'
       and procedure.prosecdef
  ) then
    raise exception 'aps active period: fiscal_years_before_write was not replaced';
  end if;

  select count(*)::integer
    into v_labels
    from pg_enum as label
    join pg_type as type on type.oid = label.enumtypid
   where type.typname = 'audit_action'
     and label.enumlabel in (
       'fiscal_month.activated',
       'fiscal_month.activated_closed',
       'fiscal_month.deactivated'
     );
  if v_labels <> 3 then
    raise exception 'aps active period: audit actions were not added (found %)', v_labels;
  end if;

  -- column_privileges also reports table-level grants, so this single probe
  -- covers both ways of holding UPDATE on the column.
  if exists (
    select 1
      from information_schema.column_privileges
     where table_schema = 'public'
       and table_name = 'fiscal_months'
       and grantee = 'authenticated'
       and privilege_type = 'UPDATE'
       and column_name = 'is_active'
  ) then
    raise exception 'aps active period: authenticated can still update is_active directly';
  end if;

  if not exists (
    select 1
      from information_schema.column_privileges
     where table_schema = 'public'
       and table_name = 'fiscal_months'
       and grantee = 'authenticated'
       and privilege_type = 'UPDATE'
       and column_name = 'current_period'
  ) then
    raise exception 'aps active period: the periodic-settings screen lost current_period';
  end if;

  select count(*)::integer into v_active
    from public.fiscal_months
   where is_active;
  if v_active > 1 then
    raise exception 'aps active period: % fiscal months are active', v_active;
  end if;
end;
$$;
