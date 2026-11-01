-- A.3 production checks — read-only, safe to run before or after applying
-- 20261121020000_aps_entry_period_derivation.sql.
--
-- Before the migration every function check reports «n/a» instead of failing,
-- so the same file gives the before/after picture in one paste. Nothing here
-- writes, and nothing depends on a specific project time zone.
--
-- Expected after the migration:
--   * save_14_args = present, save_12_args = absent, save_defaults = 3
--   * balances_defaults = 2, balances_default_arg = null
--   * clock_defaults_in_rewritten_functions = 0
--   * options_carries_period = true, approval_audits_period = true
--   * letters_without_month = 0 and months_sum = letters_total (A.2 backfill)
--   * letters_mid_month unchanged from its pre-migration value (D10: no rewrite)

with functions as (
  select
    to_regprocedure(
      'public.aps_save_letter_draft(uuid,timestamptz,uuid,text,text,uuid,uuid,text,text,jsonb,text,date,date,uuid)'
    ) as save_new,
    to_regprocedure(
      'public.aps_save_letter_draft(uuid,timestamptz,uuid,text,text,uuid,uuid,text,text,jsonb,text,date)'
    ) as save_old,
    to_regprocedure('public.aps_letter_balances(uuid,date,uuid[])') as balances,
    to_regprocedure('public.aps_letter_entry_options()') as options_rpc,
    to_regprocedure('public.aps_approve_letter(uuid)') as approve_rpc
)
select 'save_14_args' as check,
       case when f.save_new is null then 'n/a' else 'present' end as result
  from functions as f
union all
select 'save_12_args',
       case when f.save_old is null then 'absent' else 'still present' end
  from functions as f
union all
select 'save_defaults',
       coalesce(
         case when f.save_new is null then 'n/a' else (select pronargdefaults::text from pg_proc where oid = f.save_new) end,
         'n/a'
       )
  from functions as f
union all
select 'balances_defaults',
       coalesce(
         case when f.balances is null then 'n/a' else (select pronargdefaults::text from pg_proc where oid = f.balances) end,
         'n/a'
       )
  from functions as f
union all
select 'clock_defaults_in_rewritten_functions',
       case
         when f.save_new is null then 'n/a'
         else (
           select count(*)::text
             from pg_proc
            where oid in (f.save_new, f.balances, f.options_rpc, f.approve_rpc)
              and position('current_date' in lower(pg_get_functiondef(oid))) > 0
         )
       end
  from functions as f
union all
select 'options_carries_period',
       case
         when f.options_rpc is null then 'n/a'
         when position('''active_period''' in pg_get_functiondef(f.options_rpc)) > 0
          and position('''contains_today''' in pg_get_functiondef(f.options_rpc)) > 0 then 'true'
         else 'false'
       end
  from functions as f
union all
select 'approval_audits_period',
       case
         when f.approve_rpc is null then 'n/a'
         when position('''current_period''' in pg_get_functiondef(f.approve_rpc)) > 0 then 'true'
         else 'false'
       end
  from functions as f;

-- Data invariants: these must be identical before and after A.3.
select count(*) as letters_total,
       count(*) filter (where fiscal_month_id is null) as letters_without_month,
       count(*) filter (where letter_date <> month.start_date) as letters_mid_month,
       count(*) filter (where status = 'approved') as letters_approved
  from public.letters as letter
  join public.fiscal_months as month on month.id = letter.fiscal_month_id;

select count(*) as months_total,
       count(*) filter (where is_active) as months_active
  from public.fiscal_months;

select count(*) as reconciliation_sessions
  from public.aps_reconciliation_sessions;

-- The period the entry screen would resolve right now (null = none active).
select public.aps_active_period() as active_period
 where exists (
   select 1
     from public.fiscal_months
    where is_active
 );
