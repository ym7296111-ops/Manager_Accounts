-- Opening-balance deletions are audited like every other write to the table.
--
-- Before this migration the audit trigger listened to INSERT and UPDATE only
-- (`20261110000000_fiscal_years_and_opening_balances.sql`). `authenticated`
-- already holds DELETE on `public.opening_balances`, so a row could be removed
-- with no trace in `audit_logs` — the one gap in an otherwise append-only audit
-- trail. The editor gains an explicit delete action (design study:
-- docs/consultations/2026-10-26-opening-balances-ux-design-study.md), and every
-- removal must leave the amount that was removed, not just the fact that the
-- row is gone.
--
-- No table, column, constraint, grant or policy changes here: the delete
-- privilege and the `opening_balances_project_settings_delete` policy already
-- exist. This migration only widens the audit event.

-- ---------------------------------------------------------------------------
-- 1) New audit action
-- ---------------------------------------------------------------------------
-- `ALTER TYPE ... ADD VALUE` is transactional from PostgreSQL 12 onwards. The
-- value is added here and only *used* inside a function body, which PL/pgSQL
-- parses at call time — i.e. after this transaction commits — so the usual
-- "cannot use a new enum value in the same transaction" rule is not reached.
alter type public.audit_action
  add value if not exists 'opening_balance.deleted';

-- ---------------------------------------------------------------------------
-- 2) Audit function: INSERT and UPDATE unchanged, DELETE records OLD
-- ---------------------------------------------------------------------------
create or replace function public.audit_opening_balance_write()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_old_amount numeric(18,2);
begin
  if tg_op = 'DELETE' then
    insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
    values (
      auth.uid(),
      'opening_balance.deleted'::public.audit_action,
      'opening_balances',
      old.id::text,
      jsonb_build_object(
        'fiscal_year_id', old.fiscal_year_id,
        'warehouse_id', old.warehouse_id,
        'classification_id', old.classification_id,
        'old_amount', old.amount,
        'new_amount', null
      )
    );

    return old;
  end if;

  -- OLD is unassigned on INSERT: it may only be read inside this guard, never
  -- as an argument to jsonb_build_object, which would bind it eagerly.
  if tg_op = 'UPDATE' then
    v_old_amount := old.amount;
  else
    v_old_amount := null;
  end if;

  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
  values (
    auth.uid(),
    'opening_balance.updated'::public.audit_action,
    'opening_balances',
    new.id::text,
    jsonb_build_object(
      'fiscal_year_id', new.fiscal_year_id,
      'warehouse_id', new.warehouse_id,
      'classification_id', new.classification_id,
      'old_amount', v_old_amount,
      'new_amount', new.amount
    )
  );

  return new;
end;
$$;

-- CREATE OR REPLACE keeps the existing ACL, but the revoke is restated so this
-- file remains self-describing: API roles never call the function directly,
-- they only fire it through the trigger.
revoke all on function public.audit_opening_balance_write()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3) Trigger: add DELETE to the listened events
-- ---------------------------------------------------------------------------
drop trigger if exists opening_balances_audit_write on public.opening_balances;
create trigger opening_balances_audit_write
  after insert or update or delete on public.opening_balances
  for each row execute function public.audit_opening_balance_write();

-- ---------------------------------------------------------------------------
-- 4) Migration preconditions
-- ---------------------------------------------------------------------------
do $verify_opening_balance_delete_audit$
begin
  if to_regclass('public.opening_balances') is null then
    raise exception 'public.opening_balances is missing';
  end if;

  if to_regprocedure('public.audit_opening_balance_write()') is null then
    raise exception 'audit_opening_balance_write() is missing';
  end if;

  if not exists (
    select 1
      from pg_catalog.pg_enum as enum
      join pg_catalog.pg_type as type on type.oid = enum.enumtypid
     where type.typname = 'audit_action'
       and enum.enumlabel = 'opening_balance.deleted'
  ) then
    raise exception 'audit_action is missing opening_balance.deleted';
  end if;

  if not exists (
    select 1
      from pg_catalog.pg_trigger
     where tgrelid = 'public.opening_balances'::regclass
       and tgname = 'opening_balances_audit_write'
       and (tgtype & 8) = 8   -- TRIGGER_TYPE_DELETE
       and (tgtype & 1) = 1   -- TRIGGER_TYPE_ROW
       and (tgtype & 2) = 0   -- TRIGGER_TYPE_BEFORE is clear
  ) then
    raise exception 'opening_balances_audit_write does not listen to DELETE';
  end if;
end
$verify_opening_balance_delete_audit$;

notify pgrst, 'reload schema';
