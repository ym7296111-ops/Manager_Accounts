-- Opening-balance data freeze («قفل أرصدة أول المدة»).
--
-- Until now `public.opening_balances` was writable by every caller holding
-- `project.settings:manage`, forever. Once a year's opening balances have been
-- agreed, that is a liability: the figures the rest of the ledger starts from
-- could still change, silently, months later. This migration adds an explicit
-- per-year freeze that the project-settings screen can switch on and off:
--
--   * `fiscal_years.opening_balances_locked` is the single source of truth;
--   * the RLS policies on `opening_balances` refuse INSERT / UPDATE / DELETE
--     while the year is locked — the browser is never the authority;
--   * every lock and unlock is written to `audit_logs`, because "who opened
--     the books again, and when" is exactly the question asked afterwards.
--
-- Deliberate choices:
--
--   * The lock is a plain column on `fiscal_years`, not a separate table: a
--     year has exactly one freeze state, and putting it next to `is_closed`
--     keeps the two "this period is settled" flags in one row.
--   * RLS, not a trigger, is the enforcement point. It is the layer that also
--     holds when a caller bypasses the screen, and it composes with the
--     existing `can_manage_project_settings()` predicate instead of replacing
--     it. INSERT raises 42501 (the new row violates the WITH CHECK), UPDATE and
--     DELETE are filtered to zero rows — the same semantics as every other
--     capability-denied write in this schema, which the client already reports
--     as `notFound` rather than as a successful deletion.
--   * SELECT is untouched: a frozen year is still readable. Hiding the figures
--     would make the screen lie about what is on the books, and the freeze is
--     about immutability, not confidentiality.
--   * Toggling the lock is an ordinary `fiscal_years` UPDATE, so it is already
--     gated by `fiscal_years_project_settings_update` and by
--     `project.settings:manage`. No new permission is introduced.

-- ---------------------------------------------------------------------------
-- 1) Fiscal-year column
-- ---------------------------------------------------------------------------
alter table public.fiscal_years
  add column if not exists opening_balances_locked boolean not null default false;

comment on column public.fiscal_years.opening_balances_locked is
  'When true, row-level security refuses INSERT/UPDATE/DELETE on public.opening_balances for this fiscal year.';

-- ---------------------------------------------------------------------------
-- 2) Audit actions for the freeze transitions
-- ---------------------------------------------------------------------------
-- `ALTER TYPE ... ADD VALUE` is transactional from PostgreSQL 12 onwards. Both
-- values are only *used* inside a function body here, and PL/pgSQL parses that
-- body at call time — after this transaction commits — so the "cannot use a new
-- enum value in the same transaction" rule is never reached.
alter type public.audit_action
  add value if not exists 'fiscal_year.opening_balances_locked';
alter type public.audit_action
  add value if not exists 'fiscal_year.opening_balances_unlocked';

-- ---------------------------------------------------------------------------
-- 3) RLS helper
-- ---------------------------------------------------------------------------
-- Policy predicates run with the invoker's privileges, and `fiscal_years`
-- carries ENABLE + FORCE ROW LEVEL SECURITY. A plain subquery inside the
-- `opening_balances` policies would therefore be evaluated through the *caller's*
-- `fiscal_years` policy, and a caller who cannot read the year would silently
-- see "not locked". SECURITY DEFINER (same shape as
-- `can_manage_project_settings()`) makes the answer depend on the row, not on
-- who is asking. A missing year reads as "not locked" so that the foreign key,
-- not this helper, reports an unknown year.
--
-- The helper is callable by `authenticated` because a policy predicate runs as
-- the caller. That exposes one boolean per known fiscal-year id, which is the
-- same fact the year row itself carries for anyone allowed to read it.
create or replace function public.is_opening_balances_locked(p_fiscal_year_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce(
    (
      select year.opening_balances_locked
        from public.fiscal_years as year
       where year.id = p_fiscal_year_id
    ),
    false
  );
$$;

revoke all on function public.is_opening_balances_locked(uuid) from public, anon;
grant execute on function public.is_opening_balances_locked(uuid)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4) Opening-balance policies: capability *and* an open year
-- ---------------------------------------------------------------------------
-- The policy names are deliberately unchanged: they are asserted by
-- `scripts/audit/database.mjs` and referenced in the design notes, and the
-- change is a narrower predicate on the same policy, not a new one.
-- SELECT is intentionally left as it is (see the header).
drop policy if exists opening_balances_project_settings_insert on public.opening_balances;
create policy opening_balances_project_settings_insert
  on public.opening_balances
  for insert
  to authenticated
  with check (
    public.can_manage_project_settings()
    and not public.is_opening_balances_locked(fiscal_year_id)
  );

drop policy if exists opening_balances_project_settings_update on public.opening_balances;
create policy opening_balances_project_settings_update
  on public.opening_balances
  for update
  to authenticated
  using (
    public.can_manage_project_settings()
    and not public.is_opening_balances_locked(fiscal_year_id)
  )
  with check (
    -- The WITH CHECK reads the *new* row: a balance cannot be moved into a
    -- locked year either, even from an unlocked one.
    public.can_manage_project_settings()
    and not public.is_opening_balances_locked(fiscal_year_id)
  );

drop policy if exists opening_balances_project_settings_delete on public.opening_balances;
create policy opening_balances_project_settings_delete
  on public.opening_balances
  for delete
  to authenticated
  using (
    public.can_manage_project_settings()
    and not public.is_opening_balances_locked(fiscal_year_id)
  );

-- ---------------------------------------------------------------------------
-- 5) Audit trail for lock / unlock
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER for the same reason as the balance trigger: API roles hold
-- no INSERT grant on `audit_logs`. The actor still comes from the caller's JWT
-- via auth.uid(); the metadata carries the transition, not just the new state.
create or replace function public.audit_opening_balances_lock_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
  values (
    auth.uid(),
    case
      when new.opening_balances_locked
        then 'fiscal_year.opening_balances_locked'::public.audit_action
      else 'fiscal_year.opening_balances_unlocked'::public.audit_action
    end,
    'fiscal_years',
    new.id::text,
    jsonb_build_object(
      'fiscal_year_id', new.id,
      'old_value', old.opening_balances_locked,
      'new_value', new.opening_balances_locked
    )
  );

  return new;
end;
$$;

revoke all on function public.audit_opening_balances_lock_change()
  from public, anon, authenticated, service_role;

-- Column-scoped UPDATE OF plus the distinct guard: writing any other column
-- (is_active, is_closed, a corrected date range) must never look like a freeze
-- event, and a no-op write must not either.
drop trigger if exists fiscal_years_audit_opening_balances_lock on public.fiscal_years;
create trigger fiscal_years_audit_opening_balances_lock
  after update of opening_balances_locked on public.fiscal_years
  for each row
  when (old.opening_balances_locked is distinct from new.opening_balances_locked)
  execute function public.audit_opening_balances_lock_change();

-- ---------------------------------------------------------------------------
-- 6) Migration preconditions
-- ---------------------------------------------------------------------------
do $verify_opening_balances_freeze$
begin
  if not exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'fiscal_years'
       and column_name = 'opening_balances_locked'
       and data_type = 'boolean'
       and is_nullable = 'NO'
       and column_default like 'false%'
  ) then
    raise exception 'fiscal_years.opening_balances_locked is missing or malformed';
  end if;

  if (
    select count(*)
      from pg_catalog.pg_enum as enum
      join pg_catalog.pg_type as type on type.oid = enum.enumtypid
     where type.typname = 'audit_action'
       and enumlabel in (
         'fiscal_year.opening_balances_locked',
         'fiscal_year.opening_balances_unlocked'
       )
  ) <> 2 then
    raise exception 'audit_action is missing the opening-balance freeze actions';
  end if;

  if to_regprocedure('public.is_opening_balances_locked(uuid)') is null then
    raise exception 'is_opening_balances_locked(uuid) is missing';
  end if;

  if not has_function_privilege(
    'authenticated',
    'public.is_opening_balances_locked(uuid)',
    'EXECUTE'
  ) then
    raise exception 'authenticated cannot execute is_opening_balances_locked(uuid)';
  end if;

  if has_function_privilege('anon', 'public.is_opening_balances_locked(uuid)', 'EXECUTE') then
    raise exception 'anon must not execute is_opening_balances_locked(uuid)';
  end if;

  if (
    select count(*)
      from pg_catalog.pg_policies
     where schemaname = 'public'
       and tablename = 'opening_balances'
       and (
         (policyname = 'opening_balances_project_settings_insert'
          and with_check like '%is_opening_balances_locked%')
         or (policyname = 'opening_balances_project_settings_update'
             and qual like '%is_opening_balances_locked%'
             and with_check like '%is_opening_balances_locked%')
         or (policyname = 'opening_balances_project_settings_delete'
             and qual like '%is_opening_balances_locked%')
       )
  ) <> 3 then
    raise exception 'opening_balances write policies do not enforce the freeze';
  end if;

  if not exists (
    select 1
      from pg_catalog.pg_trigger
     where tgrelid = 'public.fiscal_years'::regclass
       and tgname = 'fiscal_years_audit_opening_balances_lock'
       and (tgtype & 1) = 1    -- TRIGGER_TYPE_ROW
       and (tgtype & 2) = 0    -- TRIGGER_TYPE_BEFORE is clear (AFTER)
       and (tgtype & 16) = 16  -- TRIGGER_TYPE_UPDATE
       and (tgtype & 8) = 0    -- not a DELETE trigger
  ) then
    raise exception 'fiscal_years_audit_opening_balances_lock is missing';
  end if;
end
$verify_opening_balances_freeze$;

notify pgrst, 'reload schema';
