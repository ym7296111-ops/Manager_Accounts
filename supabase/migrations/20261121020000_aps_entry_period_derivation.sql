-- Entry derives its date from the active period (phase A.3).
--
-- Design: docs/consultations/2026-11-01-aps-active-accounting-period-design-study.md
-- Plan:   docs/consultations/2026-11-01-aps-active-accounting-period-implementation-plan.md
--
-- Why this migration exists
--   A.1 made the posting month an explicit, audited decision and A.2 gave every
--   letter a stored month. This is the step that makes the entry path use it:
--   the letter date stops coming from the clock and comes from the active
--   period, and the period the screen was showing is checked against the period
--   still active when the save actually lands.
--
-- The four rules this file installs
--   1. A new letter is dated the first day of the active month. `p_letter_date`
--      stays in the signature for the pre-A.3 client but its value is not used
--      to date anything.
--   2. The client may declare the month it was showing
--      (`p_expected_fiscal_month_id`). If the period moved in between, the save
--      fails with `aps_period_changed` instead of silently writing into a
--      period the user never saw.
--   3. No active period is a state, not an error to guess around: a new letter
--      is refused with `aps_no_active_period`.
--   4. An existing draft keeps the period it was written in (D6). Its month,
--      date and year are read from the row, never from the request — this is
--      what stops a reopened draft from drifting to the day it was reopened
--      (study §1.3), the defect this work started from.
--
-- `document_date` is the one date the client still controls: it describes the
-- paper letter, not the posting period, so it is written as sent (D14).
--
-- `aps_letter_balances()` stops defaulting its cutoff to the clock; with no
-- argument it reports the position at the start of the active month, and with
-- no active period it returns nothing rather than inventing a date.

-- ---------------------------------------------------------------------------
-- 1) The save: the period decides the date
-- ---------------------------------------------------------------------------
-- Parameter changes cannot be renamed or added in place, so the old signature
-- is dropped and the new one created, as 20261118000000 does. Only three
-- parameters change: `p_letter_date` loses its `current_date` default, and
-- `p_document_date` / `p_expected_fiscal_month_id` are appended. On a new
-- letter the active month supplies the year as well as the date, so a stale
-- `p_fiscal_year_id` is advisory exactly like `p_letter_date`; the only refusal
-- is the month the screen explicitly declared (`p_expected_fiscal_month_id`).
drop function public.aps_save_letter_draft(
  uuid, timestamptz, uuid, text, text, uuid, uuid, text, text, jsonb, text, date
);

create function public.aps_save_letter_draft(
  p_letter_id uuid,
  p_expected_updated_at timestamptz,
  p_fiscal_year_id uuid,
  p_letter_type text,
  p_letter_number text,
  p_party_id uuid,
  p_sister_company_id uuid,
  p_direction text,
  p_reclassification_note text,
  p_lines jsonb,
  p_issuer_reference text,
  p_letter_date date default null,
  p_document_date date default null,
  p_expected_fiscal_month_id uuid default null
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_previous record;
  v_period jsonb;
  v_active_month_id uuid;
  v_period_year_id uuid;
  v_period_start date;
  v_period_number integer;
  v_period_month_id uuid;
  v_line jsonb;
  v_amount_text text;
  v_amount numeric(18,2);
  v_direction text;
  v_note text;
  v_issuer_reference text;
  v_letter_date date;
  v_document_date date := p_document_date;
  v_updated_at timestamptz;
  v_constraint text;
  v_primary_party uuid;
  v_current_period integer;
begin
  if v_actor is null or not public.aps_can_create_letters() then
    raise exception 'aps entry: aps.letters:create is required' using errcode = '42501';
  end if;
  if p_letter_id is null
     or p_letter_type is null or p_letter_type not in ('inbound','outbound','internal_transfer','external_transfer') then
    raise exception 'aps entry: invalid letter header' using errcode = '22023';
  end if;
  if p_letter_type = 'external_transfer' and (p_direction is null or p_direction not in ('in','out')) then
    raise exception 'aps entry: external direction must be in or out' using errcode = '22023';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array'
     or jsonb_array_length(p_lines) < 1
     or jsonb_array_length(p_lines) > 500 then
    raise exception 'aps entry: invalid number of lines' using errcode = '22023';
  end if;

  -- The letter code is optional on a draft. Whatever is supplied must be the
  -- documented shape, and its issuer must exist in the controlled list: the
  -- registry is what makes `YM` a person and not a typo.
  v_issuer_reference := nullif(upper(btrim(coalesce(p_issuer_reference, ''))), '');
  if v_issuer_reference is not null then
    if v_issuer_reference !~ '^[A-Z]{2}:[0-9]+$' then
      raise exception 'aps entry: the letter code must look like YM:63' using errcode = '22023';
    end if;
    if not exists (
      select 1 from public.issuers as issuer
       where issuer.code = left(v_issuer_reference, 2) and issuer.is_active
    ) then
      raise exception 'aps entry: unknown or inactive issuer %', left(v_issuer_reference, 2)
        using errcode = '22023';
    end if;
  end if;

  -- Validate before writing; never round user input or accept negative values.
  for v_line in select value from jsonb_array_elements(p_lines) loop
    if jsonb_typeof(v_line) <> 'object' then
      raise exception 'aps entry: invalid line' using errcode = '22023';
    end if;
    v_amount_text := v_line->>'amount';
    if v_amount_text is null or v_amount_text !~ '^[0-9]{1,16}(\.[0-9]{1,2})?$'
       or v_amount_text::numeric <= 0 then
      raise exception 'aps entry: each amount must be positive with at most two decimals' using errcode = '22023';
    end if;
    if p_letter_type = 'internal_transfer' then
      -- The two sides are independent lists: every stored line names its own
      -- direction, and nothing here pairs it with another line. Whether the
      -- sides settle is a letter-level question, answered at approval by
      -- aps_assert_letter_consistent() — a half-typed transfer stays a
      -- saveable draft until then.
      if v_line->>'warehouse_id' is null or v_line->>'classification_id' is null
         or coalesce(v_line->>'direction', '') not in ('in', 'out') then
        raise exception 'aps entry: each transfer line needs a direction, a warehouse and a classification' using errcode = '22023';
      end if;
    elsif v_line->>'warehouse_id' is null or v_line->>'classification_id' is null then
      raise exception 'aps entry: each line needs a warehouse and classification' using errcode = '22023';
    elsif p_letter_type in ('inbound', 'outbound')
       and coalesce((v_line->>'party_id')::uuid, p_party_id) is null then
      raise exception 'aps entry: each line needs a party' using errcode = '22023';
    end if;
  end loop;

  -- The note is the transfer's optional statement on the header, never a
  -- per-line obligation. Off a transfer it means nothing and is stored null.
  v_note := case
    when p_letter_type = 'internal_transfer'
      then nullif(btrim(coalesce(p_reclassification_note, '')), '')
  end;

  -- The header keeps exactly one party: the primary, which is the party of the
  -- first line. An older client sends one party in `p_party_id` and none on the
  -- lines; the tree client sends one per line. Both write the same header, and
  -- the totals trigger re-derives it from the lines after every write, so the
  -- header can never drift from the body of the letter.
  v_primary_party := case
    when p_letter_type in ('inbound', 'outbound')
      then coalesce((p_lines->0->>'party_id')::uuid, p_party_id)
    else p_party_id
  end;

  -- The posting period is resolved before anything is written, so a refusal
  -- cannot leave a half-saved letter behind. Everything is read from the
  -- definer payload: `fiscal_months` is readable only by project-settings
  -- managers, and this function is an invoker.
  v_period := public.aps_active_period();
  if v_period is null then
    raise exception 'aps_no_active_period' using errcode = 'P0001';
  end if;
  v_active_month_id := (v_period->>'fiscal_month_id')::uuid;
  v_period_year_id := (v_period->>'fiscal_year_id')::uuid;
  v_period_start := (v_period->>'start_date')::date;
  v_period_number := (v_period->>'period_number')::integer;
  v_period_month_id := v_active_month_id;

  if p_expected_updated_at is null then
    -- The screen declared the period it was showing; the clock is irrelevant.
    -- A mismatch means the period moved between opening the screen and saving,
    -- and the caller translates this into "the period changed" instead of
    -- writing into a period the user never saw.
    if p_expected_fiscal_month_id is not null
       and p_expected_fiscal_month_id <> v_active_month_id then
      raise exception 'aps_period_changed' using errcode = 'P0001';
    end if;
    v_letter_date := v_period_start;
    v_current_period := v_period_number;

    insert into public.letters (
      id, fiscal_year_id, fiscal_month_id, letter_type, letter_number, letter_date,
      party_id, sister_company_id, reclassification_note, document_date,
      issuer_reference
    ) values (
      p_letter_id, v_period_year_id, v_period_month_id, p_letter_type,
      p_letter_number, v_letter_date, v_primary_party, p_sister_company_id, v_note,
      v_document_date, v_issuer_reference
    );
  else
    select letter.created_by, letter.status, letter.letter_type, letter.updated_at,
           letter.letter_date, letter.fiscal_month_id, letter.fiscal_year_id
      into v_previous
      from public.letters as letter
     where letter.id = p_letter_id
     for update;
    if not found or v_previous.created_by <> v_actor or v_previous.status <> 'draft'
       or v_previous.letter_type = 'settlement' then
      raise exception 'aps entry: draft is unavailable' using errcode = '42501';
    end if;
    if v_previous.updated_at is distinct from p_expected_updated_at then
      raise exception 'aps_entry_stale_draft' using errcode = 'P0001';
    end if;

    -- An existing draft keeps the period it was written in, whatever the
    -- caller sends: the month, the date and the year come from the row (D6).
    -- This is the fix for the defect this work started from — a draft reopened
    -- after a period switch used to be re-dated as if it were new.
    v_letter_date := v_previous.letter_date;
    v_period_month_id := v_previous.fiscal_month_id;
    -- The sub-period is only live for the active month; a draft left in an
    -- older month reports none, and the screen reads its month from the list.
    v_current_period := case
      when v_period_month_id = v_active_month_id then v_period_number
    end;

    delete from public.letter_lines where letter_id = p_letter_id;
    update public.letters
       set letter_type = p_letter_type,
           letter_number = p_letter_number,
           letter_date = v_letter_date,
           party_id = v_primary_party,
           sister_company_id = p_sister_company_id,
           reclassification_note = v_note,
           document_date = v_document_date,
           issuer_reference = v_issuer_reference
     where id = p_letter_id;
  end if;

  v_direction := case p_letter_type
    when 'inbound' then 'in'
    when 'outbound' then 'out'
    else p_direction
  end;
  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_amount := (v_line->>'amount')::numeric(18,2);
    if p_letter_type = 'internal_transfer' then
      insert into public.letter_lines (letter_id, direction, warehouse_id, classification_id, amount)
      values (p_letter_id, v_line->>'direction', (v_line->>'warehouse_id')::uuid,
              (v_line->>'classification_id')::uuid, v_amount);
    else
      -- The line's own party wins; the header argument is the fallback that
      -- keeps a pre-tree client working unchanged. An external transfer takes
      -- null: its counterparty is the sister company on the header.
      insert into public.letter_lines (letter_id, direction, warehouse_id, classification_id, amount, party_id)
      values (p_letter_id, v_direction, (v_line->>'warehouse_id')::uuid,
              (v_line->>'classification_id')::uuid, v_amount,
              case when p_letter_type in ('inbound', 'outbound')
                then coalesce((v_line->>'party_id')::uuid, p_party_id)
              end);
    end if;
  end loop;

  select letter.updated_at into v_updated_at from public.letters as letter where letter.id = p_letter_id;

  -- Report the period that was actually written: the screen paints its bar from
  -- this, not from what it hoped to write.
  return jsonb_build_object(
    'id', p_letter_id,
    'updated_at', v_updated_at,
    'fiscal_month_id', v_period_month_id,
    'letter_date', v_letter_date,
    'document_date', v_document_date,
    'current_period', v_current_period
  );
exception when unique_violation then
  get stacked diagnostics v_constraint = constraint_name;
  if v_constraint = 'letters_pkey' then
    raise exception 'aps_entry_id_exists' using errcode = 'P0001';
  end if;
  if v_constraint = 'letters_year_issuer_reference_key' then
    raise exception 'aps_entry_duplicate_letter_code' using errcode = 'P0001';
  end if;
  raise;
end;
$$;

revoke all on function public.aps_save_letter_draft(
  uuid, timestamptz, uuid, text, text, uuid, uuid, text, text, jsonb, text, date, date, uuid
) from public, anon;
grant execute on function public.aps_save_letter_draft(
  uuid, timestamptz, uuid, text, text, uuid, uuid, text, text, jsonb, text, date, date, uuid
) to authenticated, service_role;
comment on function public.aps_save_letter_draft(
  uuid, timestamptz, uuid, text, text, uuid, uuid, text, text, jsonb, text, date, date, uuid
) is
  'Atomically create or replace an owned ordinary draft under RLS. A new draft is dated the first day of the active posting month and fails with aps_no_active_period when there is none, or aps_period_changed when the period moved since the screen was opened; an existing draft keeps the period it was written in. document_date is paper-only content and is written as sent. Approval remains aps_approve_letter().';

-- ---------------------------------------------------------------------------
-- 2) The balance badge stops reading the clock
-- ---------------------------------------------------------------------------
create or replace function public.aps_letter_balances(
  p_fiscal_year_id uuid,
  p_as_of_date date default null,
  p_warehouse_ids uuid[] default null
)
returns table (
  warehouse_id uuid,
  classification_id uuid,
  balance text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_as_of date;
begin
  if auth.uid() is null or not public.aps_can_create_letters() then
    raise exception 'aps_letter_balances: aps.letters:create is required' using errcode = '42501';
  end if;

  -- No cutoff asked for and no period open: report nothing rather than pick a
  -- date the project never chose.
  v_as_of := coalesce(
    p_as_of_date,
    (select month.start_date from public.fiscal_months as month where month.is_active limit 1)
  );
  if v_as_of is null then
    return;
  end if;

  return query
  with year_bounds as (
    select year.start_date
      from public.fiscal_years as year
     where year.id = p_fiscal_year_id
  ),
  opening as (
    select opening.warehouse_id, opening.classification_id, sum(opening.amount) as amount
      from public.opening_balances as opening
     where opening.fiscal_year_id = p_fiscal_year_id
       and (p_warehouse_ids is null or opening.warehouse_id = any (p_warehouse_ids))
     group by opening.warehouse_id, opening.classification_id
  ),
  movement as (
    select line.warehouse_id, line.classification_id,
           coalesce(
             sum(case when line.direction = 'in' then line.amount else -line.amount end),
             0
           ) as amount
      from public.letter_lines as line
      join public.letters as letter on letter.id = line.letter_id
      join public.warehouses as warehouse on warehouse.id = line.warehouse_id
      cross join year_bounds as bounds
     where letter.status = 'approved'
       and letter.letter_date >= bounds.start_date
       and letter.letter_date <= v_as_of
       and (p_warehouse_ids is null or line.warehouse_id = any (p_warehouse_ids))
     group by line.warehouse_id, line.classification_id
  )
  select coalesce(opening.warehouse_id, movement.warehouse_id),
         coalesce(opening.classification_id, movement.classification_id),
         (coalesce(opening.amount, 0) + coalesce(movement.amount, 0))::numeric(18, 2)::text
    from opening
    full join movement
      on movement.warehouse_id = opening.warehouse_id
     and movement.classification_id = opening.classification_id;
end;
$$;

revoke all on function public.aps_letter_balances(uuid, date, uuid[]) from public, anon;
grant execute on function public.aps_letter_balances(uuid, date, uuid[]) to authenticated, service_role;
comment on function public.aps_letter_balances(uuid, date, uuid[]) is
  'Physical balance per (warehouse, classification): opening balance plus approved movement from the fiscal year start to the given date, defaulting to the start of the active posting month. Returns no rows when no date is asked for and no period is open. Powers the entry-screen balance badges.';

-- ---------------------------------------------------------------------------
-- 3) One options call also carries the period
-- ---------------------------------------------------------------------------
-- The screen already fetches this payload on mount; adding the period here
-- keeps that a single round trip and makes the bar impossible to render from a
-- stale second request. `contains_today` is a suggestion, computed in the
-- project time zone — the manager still chooses.
create or replace function public.aps_letter_entry_options()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_today date;
begin
  if auth.uid() is null or not public.aps_can_create_letters() then
    raise exception 'aps entry: aps.letters:create is required' using errcode = '42501';
  end if;

  v_today := public.aps_project_today();

  return jsonb_build_object(
    'active_period', public.aps_active_period(),
    'fiscal_years', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', year.id, 'name', year.name, 'start_date', year.start_date,
        'end_date', year.end_date, 'is_closed', year.is_closed,
        'supplements_open', year.supplements_open
      ) order by year.start_date desc, year.id)
      from public.fiscal_years as year
    ), '[]'::jsonb),
    'fiscal_months', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', month.id, 'fiscal_year_id', month.fiscal_year_id,
        'month_number', month.month_number, 'name', month.name,
        'start_date', month.start_date, 'end_date', month.end_date,
        'current_period', month.current_period, 'is_closed', month.is_closed,
        'contains_today', v_today between month.start_date and month.end_date
      ) order by month.start_date, month.month_number)
      from public.fiscal_months as month
    ), '[]'::jsonb),
    'warehouses', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', warehouse.id, 'name', warehouse.name, 'code', warehouse.code,
        'station_name', station.name, 'station_code', station.code
      ) order by warehouse.name, warehouse.code)
      from public.warehouses as warehouse
      left join public.stations as station on station.id = warehouse.station_id
      where warehouse.is_active
    ), '[]'::jsonb),
    'classifications', coalesce((
      select jsonb_agg(jsonb_build_object('id', class.id, 'name', class.name, 'code', class.code)
        order by class.name, class.code)
      from public.classifications as class
      where class.is_active and class.is_leaf
    ), '[]'::jsonb),
    'parties', coalesce((
      select jsonb_agg(jsonb_build_object('id', party.id, 'name', party.name, 'code', party.code, 'branch', party.branch)
        order by party.name, party.code)
      from public.parties as party
      where party.is_active
    ), '[]'::jsonb),
    'sister_companies', coalesce((
      select jsonb_agg(jsonb_build_object('id', company.id, 'name', company.name, 'code', company.code)
        order by company.name, company.code)
      from public.sister_companies as company
      where company.is_active
    ), '[]'::jsonb),
    'issuers', coalesce((
      select jsonb_agg(jsonb_build_object('id', issuer.id, 'code', issuer.code, 'name', issuer.name)
        order by issuer.code)
      from public.issuers as issuer
      where issuer.is_active
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.aps_letter_entry_options() from public, anon;
grant execute on function public.aps_letter_entry_options() to authenticated, service_role;
comment on function public.aps_letter_entry_options() is
  'Everything the entry screen needs in one payload: the active posting period, the calendar with a contains_today suggestion, warehouse/classification/party/issuer lists.';

-- ---------------------------------------------------------------------------
-- 4) Approval records the period it approved into
-- ---------------------------------------------------------------------------
-- 20261119020000's aps_approve_letter() with three added audit fields and no
-- change to its logic: the month, the sub-period snapshot and the paper date
-- are facts about the moment of approval, and the audit row is their home (R1
-- keeps them off the letter row).
create or replace function public.aps_approve_letter(p_letter_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_letter public.letters%rowtype;
  v_year record;
  v_month_closed boolean;
  v_current_period integer;
  v_line_count integer;
begin
  if v_actor is null or not public.aps_can_create_letters() then
    raise exception 'aps_approve_letter: aps.letters:create is required' using errcode = '42501';
  end if;

  select * into v_letter from public.letters where id = p_letter_id for update;
  if not found then
    raise exception 'aps_approve_letter: letter % not found', p_letter_id using errcode = 'P0002';
  end if;

  -- Drafts are author-scoped; a project-settings manager can finalise a draft
  -- left behind by a colleague who lost access.
  if v_letter.created_by <> v_actor and not public.can_manage_project_settings() then
    raise exception 'aps_approve_letter: only the author can approve this draft'
      using errcode = '42501';
  end if;

  if v_letter.status <> 'draft' then
    raise exception 'aps_approve_letter: only a draft can be approved, this letter is %',
      v_letter.status using errcode = '22023';
  end if;

  select count(*)::integer into v_line_count
    from public.letter_lines as line
   where line.letter_id = p_letter_id;
  if v_line_count = 0 then
    raise exception 'aps_approve_letter: a letter needs at least one line' using errcode = '22023';
  end if;

  select year.start_date, year.end_date, year.is_closed, year.supplements_open
    into v_year
    from public.fiscal_years as year
   where year.id = v_letter.fiscal_year_id;
  if not found then
    raise exception 'aps_approve_letter: unknown fiscal year' using errcode = '23503';
  end if;

  if v_year.is_closed and not v_year.supplements_open then
    raise exception 'aps_approve_letter: the fiscal year is closed' using errcode = '22023';
  end if;

  select month.is_closed into v_month_closed
    from public.fiscal_months as month
   where month.fiscal_year_id = v_letter.fiscal_year_id
     and v_letter.letter_date between month.start_date and month.end_date
   limit 1;
  if v_month_closed is null then
    raise exception 'aps_approve_letter: % is outside the fiscal year', v_letter.letter_date
      using errcode = '22023';
  end if;
  if v_month_closed and not v_year.supplements_open then
    raise exception 'aps_approve_letter: the fiscal month containing % is closed',
      v_letter.letter_date using errcode = '22023';
  end if;

  -- A.3 snapshot only: the sub-period the letter was approved inside (D13). A
  -- row with no month — impossible after the A.2 backfill — records a null
  -- instead of adding a new reason to refuse an otherwise valid approval.
  select month.current_period into v_current_period
    from public.fiscal_months as month
   where month.id = v_letter.fiscal_month_id;

  perform public.aps_assert_letter_consistent(p_letter_id);

  update public.letters
     set status = 'approved',
         approved_at = now(),
         approved_by = v_actor
   where id = p_letter_id;

  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
  values (
    v_actor,
    'aps.letter_approved'::public.audit_action,
    'letters',
    p_letter_id::text,
    jsonb_build_object(
      'letter_number', v_letter.letter_number,
      'letter_type', v_letter.letter_type,
      'fiscal_year_id', v_letter.fiscal_year_id,
      'fiscal_month_id', v_letter.fiscal_month_id,
      'current_period', v_current_period,
      'document_date', v_letter.document_date,
      'letter_date', v_letter.letter_date,
      'counterparty_code', v_letter.counterparty_code,
      'party_count', v_letter.party_count,
      'party_codes', (
        select coalesce(jsonb_agg(distinct line.party_code), '[]'::jsonb)
          from public.letter_lines as line
         where line.letter_id = p_letter_id and line.party_code is not null
      ),
      -- A negative physical balance warns on the entry screen but never blocks
      -- the save; approval is where the warning becomes part of the record.
      -- The figure is opening + approved movement up to this letter's date
      -- (this letter excluded, then its own net added) — the same arithmetic
      -- the reconciliation book amounts and aps_letter_balances() report.
      'negative_balance_pairs', (
        select coalesce(
          jsonb_agg(
            jsonb_build_object(
              'warehouse_code', warehouse.code,
              'classification_code', classification.code,
              'balance_after', pair.balance_after
            )
            order by warehouse.code, classification.code
          ),
          '[]'::jsonb
        )
          from (
            select line.warehouse_id, line.classification_id,
                   coalesce((
                     select sum(opening.amount)
                       from public.opening_balances as opening
                      where opening.fiscal_year_id = v_letter.fiscal_year_id
                        and opening.warehouse_id = line.warehouse_id
                        and opening.classification_id = line.classification_id
                   ), 0)
                   + coalesce((
                     select sum(case when other.direction = 'in' then other.amount else -other.amount end)
                       from public.letter_lines as other
                       join public.letters as other_letter on other_letter.id = other.letter_id
                      where other_letter.status = 'approved'
                        and other_letter.id <> p_letter_id
                        and other_letter.letter_date >= v_year.start_date
                        and other_letter.letter_date <= v_letter.letter_date
                        and other.warehouse_id = line.warehouse_id
                        and other.classification_id = line.classification_id
                   ), 0)
                   + sum(case when line.direction = 'in' then line.amount else -line.amount end) as balance_after
              from public.letter_lines as line
             where line.letter_id = p_letter_id
             group by line.warehouse_id, line.classification_id
          ) as pair
          join public.warehouses as warehouse on warehouse.id = pair.warehouse_id
          join public.classifications as classification on classification.id = pair.classification_id
         where pair.balance_after < 0
      ),
      'source_total', v_letter.source_total,
      'destination_total', v_letter.destination_total,
      'line_count', v_line_count
    )
  );
end;
$$;

revoke all on function public.aps_approve_letter(uuid) from public, anon;
grant execute on function public.aps_approve_letter(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5) Verification: fail loudly if any guarantee above is missing
-- ---------------------------------------------------------------------------
do $$
declare
  v_save oid := to_regprocedure(
    'public.aps_save_letter_draft(uuid,timestamptz,uuid,text,text,uuid,uuid,text,text,jsonb,text,date,date,uuid)'
  );
  v_defaults integer;
  v_balances_defaults integer;
  v_source text;
begin
  if v_save is null then
    raise exception 'aps entry period: the new save signature is missing';
  end if;
  if to_regprocedure(
       'public.aps_save_letter_draft(uuid,timestamptz,uuid,text,text,uuid,uuid,text,text,jsonb,text,date)'
     ) is not null then
    raise exception 'aps entry period: the old save signature still exists';
  end if;

  select pronargdefaults into v_defaults from pg_proc where oid = v_save;
  if v_defaults <> 3 then
    raise exception 'aps entry period: the last three parameters must all default (found %)', v_defaults;
  end if;

  select pronargdefaults into v_balances_defaults
    from pg_proc
   where oid = 'public.aps_letter_balances(uuid,date,uuid[])'::regprocedure;
  if v_balances_defaults <> 2 then
    raise exception 'aps entry period: aps_letter_balances must default its cutoff and warehouse list';
  end if;

  -- No accounting date may come from the clock any more.
  for v_source in
    select pg_get_functiondef(oid)
      from pg_proc
     where oid in (
       v_save,
       'public.aps_letter_balances(uuid,date,uuid[])'::regprocedure,
       'public.aps_letter_entry_options()'::regprocedure,
       'public.aps_approve_letter(uuid)'::regprocedure
     )
  loop
    if position('current_date' in lower(v_source)) > 0 then
      raise exception 'aps entry period: a rewritten function still reads current_date';
    end if;
  end loop;

  select pg_get_functiondef('public.aps_letter_entry_options()'::regprocedure) into v_source;
  if position('''active_period''' in v_source) = 0
     or position('''contains_today''' in v_source) = 0 then
    raise exception 'aps entry period: the entry options do not carry the period or the today flag';
  end if;

  select pg_get_functiondef('public.aps_approve_letter(uuid)'::regprocedure) into v_source;
  if position('''current_period''' in v_source) = 0
     or position('''fiscal_month_id''' in v_source) = 0
     or position('''document_date''' in v_source) = 0 then
    raise exception 'aps entry period: the approval audit does not record the period';
  end if;
end;
$$;
