-- A.2 measurements (plan §5.1) — run BEFORE and AFTER applying
-- 20261121010000_aps_letter_period_columns.sql, and keep both outputs as the
-- evidence the plan asks for.
--
-- Safe in both states: the month-specific numbers report "n/a" until the
-- column exists, so the same file produces the before and the after picture.
-- Read-only: it creates a session-local function and drops it again.

create or replace function pg_temp.aps_letter_period_measurements()
returns table (measure text, value text)
language plpgsql
as $$
declare
  v_has_month boolean;
  v_total integer;
  v_with_month integer;
  v_disagree integer;
  v_month_total integer;
  v_duplicate integer;
begin
  select exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'letters'
       and column_name = 'fiscal_month_id'
  )
    into v_has_month;

  return query
    select 'letters_total', count(*)::text from public.letters;

  return query
    select 'source_total_sum', coalesce(sum(source_total), 0)::text from public.letters;

  return query
    select 'destination_total_sum', coalesce(sum(destination_total), 0)::text
      from public.letters;

  -- Identical before and after: the backfill must not touch a single date.
  return query
    select 'letter_date_fingerprint', coalesce(
             md5(string_agg(letter_date::text, '|' order by letter_number)), '(none)'
           )
      from public.letters;

  return query
    select 'letters_by_status_' || status, count(*)::text
      from public.letters group by status order by status;

  return query
    select 'reconciliation_sessions_total', count(*)::text
      from public.aps_reconciliation_sessions;

  -- The distribution by month, computed from the date rather than the new
  -- column, so the same numbers exist in both runs and can be compared.
  return query
    select 'month_' || to_char(month.start_date, 'YYYY-MM'),
           count(letter.id)::text
      from public.fiscal_months as month
      left join public.letters as letter
        on letter.fiscal_year_id = month.fiscal_year_id
       and month.start_date <= letter.letter_date
       and letter.letter_date <= month.end_date
     group by month.start_date
     having count(letter.id) > 0
     order by month.start_date;

  if not v_has_month then
    return query select 'letters_without_month', 'n/a (A.2 not applied)';
    return query select 'letter_month_disagreements', 'n/a (A.2 not applied)';
    return query select 'months_with_letters_sum', 'n/a (A.2 not applied)';
    return;
  end if;

  select count(*), count(fiscal_month_id)
    into v_total, v_with_month
    from public.letters;
  return query select 'letters_without_month', (v_total - v_with_month)::text;

  -- Stored month vs stored date: must be zero, forever.
  select count(*)
    into v_disagree
    from public.letters as letter
    join public.fiscal_months as month on month.id = letter.fiscal_month_id
   where not (month.start_date <= letter.letter_date
              and letter.letter_date <= month.end_date);
  return query select 'letter_month_disagreements', v_disagree::text;

  -- The periods must add up to the whole: no letter counted twice, none lost.
  select coalesce(sum(grouped.letters), 0)
    into v_month_total
    from (
      select count(*)::int as letters
        from public.letters
       group by fiscal_month_id
    ) as grouped;
  return query select 'months_with_letters_sum', v_month_total::text;

  select count(*)
    into v_duplicate
    from (
      select letter.id
        from public.letters as letter
        join public.fiscal_months as month
          on month.start_date <= letter.letter_date
         and letter.letter_date <= month.end_date
       group by letter.id
      having count(*) > 1
    ) as overlapping;
  return query select 'letters_in_more_than_one_month', v_duplicate::text;
end;
$$;

select measure, value from pg_temp.aps_letter_period_measurements();
drop function pg_temp.aps_letter_period_measurements();
