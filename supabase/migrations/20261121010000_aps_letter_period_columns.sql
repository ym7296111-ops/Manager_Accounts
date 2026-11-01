-- Letter period (phase A.2): every letter belongs to one fiscal month.
--
-- Design: docs/consultations/2026-11-01-aps-active-accounting-period-design-study.md
-- Plan:   docs/consultations/2026-11-01-aps-active-accounting-period-implementation-plan.md
--
-- Why this migration exists
--   A letter carried only `fiscal_year_id` and a free `letter_date`, so the
--   system could say "this letter is in 2026-2027" but not "this letter is in
--   October" without recomputing a date range on every read. Reports, period
--   totals and the entry screen all need the month as a stored fact. This adds
--   it, fills it from the date each letter already has, and makes the pair
--   (month, date) impossible to disagree: the trigger now validates the date
--   against the month instead of the year alone.
--
-- Boundary with A.3 (deliberate)
--   This phase does NOT change any signature and does NOT read the active
--   period. The month is derived from `letter_date` — the value the current
--   client already sends — so the database can ship before the client and the
--   old entry screen keeps working unchanged. A.3 makes the active period
--   authoritative and stops deriving anything from a client-supplied date.
--
-- What it deliberately does not do
--   * No rewrite of `letter_date` (D10): the backfill only fills the new column.
--   * No guessing: a date outside every month of its year stops the migration
--     and stops the write, with the count in the message.
--   * No new active period, no change to `aps_save_letter_draft`'s signature.

-- ---------------------------------------------------------------------------
-- 1) The two columns
-- ---------------------------------------------------------------------------
alter table public.letters
  add column if not exists fiscal_month_id uuid
    references public.fiscal_months (id) on delete restrict;

alter table public.letters
  add column if not exists document_date date;

comment on column public.letters.fiscal_month_id is
  'The accounting month the letter posts to. Derived from letter_date during A.2 and chosen from the active period from A.3 on; the trigger keeps the two consistent.';

comment on column public.letters.document_date is
  'The paper letter date when it differs from the accounting date. Display and matching only: it enters no filter, no grouping and no balance calculation (D14).';

-- ---------------------------------------------------------------------------
-- 2) Pre-flight: the data must already be unambiguous
-- ---------------------------------------------------------------------------
-- Runs before any write so a broken premise stops the migration instead of
-- producing a half-filled column. Both counters must be zero; the second one
-- covers overlapping months, which the calendar should never contain but which
-- would make the choice arbitrary.
do $$
declare
  v_uncovered integer;
  v_ambiguous integer;
begin
  select count(*)::integer
    into v_uncovered
    from public.letters as letter
   where not exists (
     select 1
       from public.fiscal_months as month
      where month.fiscal_year_id = letter.fiscal_year_id
        and month.start_date <= letter.letter_date
        and letter.letter_date <= month.end_date
   );
  if v_uncovered > 0 then
    raise exception 'aps letter period: % letter(s) fall outside every fiscal month of their year; fix the calendar before backfilling', v_uncovered;
  end if;

  select count(*)::integer
    into v_ambiguous
    from (
      select letter.id
        from public.letters as letter
        join public.fiscal_months as month
          on month.fiscal_year_id = letter.fiscal_year_id
         and month.start_date <= letter.letter_date
         and letter.letter_date <= month.end_date
       group by letter.id
      having count(*) > 1
    ) as overlapping;
  if v_ambiguous > 0 then
    raise exception 'aps letter period: % letter(s) fall inside more than one fiscal month; refuse to choose arbitrarily', v_ambiguous;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3) Backfill
-- ---------------------------------------------------------------------------
-- Deterministic: the month whose bounds contain the stored date, restricted to
-- the letter's own year so a misfiled date cannot jump years.
update public.letters as letter
   set fiscal_month_id = month.id
  from public.fiscal_months as month
 where letter.fiscal_month_id is null
   and month.fiscal_year_id = letter.fiscal_year_id
   and month.start_date <= letter.letter_date
   and letter.letter_date <= month.end_date;

do $$
declare
  v_remaining integer;
begin
  select count(*)::integer
    into v_remaining
    from public.letters
   where fiscal_month_id is null;
  if v_remaining > 0 then
    raise exception 'aps letter period: % letter(s) still have no fiscal month after the backfill', v_remaining;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4) Make it a fact, then index the read the period screen needs
-- ---------------------------------------------------------------------------
alter table public.letters
  alter column fiscal_month_id set not null;

create index if not exists letters_fiscal_month_date_idx
  on public.letters (fiscal_month_id, letter_date desc, id desc);

-- ---------------------------------------------------------------------------
-- 5) The trigger: the month is validated, and the year follows from it
-- ---------------------------------------------------------------------------
-- This is 20261120000000's aps_letters_before_write() with four changes:
--   a. the month is resolved and validated (date inside month, year from month);
--   b. the year/date check becomes a month/date check (the year one is implied);
--   c. `fiscal_month_id` and `document_date` join the post-approval freeze;
--   d. a draft whose date moves keeps following it, so the pre-A.3 client —
--      which edits a date and knows nothing about months — keeps working.
create or replace function public.aps_letters_before_write()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_party record;
  v_sister record;
  v_month record;
  v_typed text;
  v_expected_branch text;
  v_session public.aps_reconciliation_sessions%rowtype;
begin
  -- Apply the same whitespace normalization to RPC and direct writes so the
  -- length constraint cannot be satisfied with surrounding whitespace alone.
  if new.settlement_reason is not null then
    new.settlement_reason := public.aps_trim_settlement_reason(new.settlement_reason);
  end if;

  -- The transfer note is a statement, not a flag: blank is no note at all.
  if new.reclassification_note is not null then
    new.reclassification_note := nullif(btrim(new.reclassification_note), '');
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
    -- single content column. The accounting month and the paper date join the
    -- list here: without them a letter could be moved between periods after
    -- approval, and every period total would be a moving target (D7).
    if old.status in ('approved', 'cancelled') then
      if new.status is distinct from old.status
         and not (old.status = 'approved' and new.status = 'cancelled') then
        raise exception 'aps letters: % letters cannot change status to %', old.status, new.status
          using errcode = '23514';
      end if;
      if new.letter_number is distinct from old.letter_number
         or new.letter_number_raw is distinct from old.letter_number_raw
         or new.letter_date is distinct from old.letter_date
         or new.fiscal_month_id is distinct from old.fiscal_month_id
         or new.document_date is distinct from old.document_date
         or new.letter_type is distinct from old.letter_type
         or new.fiscal_year_id is distinct from old.fiscal_year_id
         or new.party_id is distinct from old.party_id
         or new.sister_company_id is distinct from old.sister_company_id
         or new.counterparty_code is distinct from old.counterparty_code
         or new.counterparty_name is distinct from old.counterparty_name
         or new.source_total is distinct from old.source_total
         or new.destination_total is distinct from old.destination_total
         or new.reclassification_note is distinct from old.reclassification_note
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

  -- The accounting period is a month; the year follows from it. While A.2 is
  -- live and A.3 is not, the month is derived from the date the client already
  -- sends — nothing here reads the active period yet.
  if new.fiscal_month_id is not null then
    select month.id, month.name, month.start_date, month.end_date, month.fiscal_year_id
      into v_month
      from public.fiscal_months as month
     where month.id = new.fiscal_month_id;
    if not found then
      raise exception 'aps letters: unknown fiscal month %', new.fiscal_month_id
        using errcode = '23503';
    end if;

    if new.letter_date < v_month.start_date or new.letter_date > v_month.end_date then
      -- A draft whose month the caller did not choose keeps following its own
      -- date, so the pre-A.3 entry screen (which edits a date and knows nothing
      -- about months) still works. Any other combination is a real
      -- inconsistency and is refused rather than repaired silently.
      if tg_op = 'UPDATE'
         and new.status = 'draft'
         and new.fiscal_month_id is not distinct from old.fiscal_month_id
      then
        new.fiscal_month_id := null;
      else
        raise exception 'aps letters: % is outside fiscal month % (% to %)',
          new.letter_date, v_month.name, v_month.start_date, v_month.end_date
          using errcode = '23514';
      end if;
    end if;
  end if;

  if new.fiscal_month_id is null then
    select month.id, month.name, month.start_date, month.end_date, month.fiscal_year_id
      into v_month
      from public.fiscal_months as month
     where month.fiscal_year_id = new.fiscal_year_id
       and month.start_date <= new.letter_date
       and new.letter_date <= month.end_date;
    if not found then
      raise exception 'aps letters: % is not inside any month of fiscal year %; the calendar for that year is incomplete',
        new.letter_date, coalesce(new.fiscal_year_id::text, '(none)')
        using errcode = '23514';
    end if;
    new.fiscal_month_id := v_month.id;
  end if;

  -- One source of truth: the month decides the year, never the other way round.
  if new.fiscal_year_id is null then
    new.fiscal_year_id := v_month.fiscal_year_id;
  elsif new.fiscal_year_id <> v_month.fiscal_year_id then
    raise exception 'aps letters: fiscal year % does not match fiscal month %',
      new.fiscal_year_id, v_month.name
      using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function public.aps_letters_before_write()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6) The settlement creates a letter, so it must name the month too
-- ---------------------------------------------------------------------------
-- 20261114000000's aps_create_reconciliation_settlement() with one added
-- column: `fiscal_month_id` from the session, which already stores it. Without
-- this, creating a settlement fails at runtime the moment the column is
-- NOT NULL (study §1.16) — the reason this change ships inside A.2 and not later.
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
    (fiscal_year_id, fiscal_month_id, letter_type, letter_number, letter_date, status,
     created_by, reconciliation_session_id, settlement_reason)
  values
    (v_session.fiscal_year_id, v_session.fiscal_month_id, 'settlement',
     coalesce(v_number, 1)::text, v_month.end_date, 'draft', v_actor, p_session_id, v_reason)
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
-- 7) Verification: fail loudly if any guarantee above is missing
-- ---------------------------------------------------------------------------
do $$
declare
  v_columns integer;
  v_nullable text;
  v_fk_restrict boolean;
  v_index boolean;
  v_unfilled integer;
  v_trigger text;
  v_settlement text;
begin
  select count(*)::integer,
         max(is_nullable) filter (where column_name = 'document_date')
    into v_columns, v_nullable
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'letters'
     and column_name in ('fiscal_month_id', 'document_date');
  if v_columns <> 2 then
    raise exception 'aps letter period: the letters columns were not created (found %)', v_columns;
  end if;
  if v_nullable <> 'YES' then
    raise exception 'aps letter period: document_date must stay optional';
  end if;
  if exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'letters'
       and column_name = 'fiscal_month_id'
       and is_nullable = 'YES'
  ) then
    raise exception 'aps letter period: fiscal_month_id is still nullable';
  end if;

  select exists (
    select 1
      from pg_constraint as fk
     where fk.contype = 'f'
       and fk.conrelid = 'public.letters'::regclass
       and fk.confrelid = 'public.fiscal_months'::regclass
       and fk.confdeltype = 'r'
  )
    into v_fk_restrict;
  if not v_fk_restrict then
    raise exception 'aps letter period: the fiscal month foreign key is missing or does not restrict deletes';
  end if;

  select exists (
    select 1
      from pg_indexes
     where schemaname = 'public'
       and indexname = 'letters_fiscal_month_date_idx'
  )
    into v_index;
  if not v_index then
    raise exception 'aps letter period: letters_fiscal_month_date_idx is missing';
  end if;

  select count(*)::integer into v_unfilled from public.letters where fiscal_month_id is null;
  if v_unfilled <> 0 then
    raise exception 'aps letter period: % letter(s) have no fiscal month', v_unfilled;
  end if;

  -- The two new columns must actually be frozen after approval, and the
  -- settlement must name the month: a trigger that lost those lines would still
  -- compile and still pass every count above.
  select pg_get_functiondef('public.aps_letters_before_write()'::regprocedure) into v_trigger;
  if position('new.fiscal_month_id is distinct from old.fiscal_month_id' in v_trigger) = 0
     or position('new.document_date is distinct from old.document_date' in v_trigger) = 0
  then
    raise exception 'aps letter period: the post-approval freeze does not cover the new columns';
  end if;

  select pg_get_functiondef(
           'public.aps_create_reconciliation_settlement(uuid, uuid, text)'::regprocedure
         )
    into v_settlement;
  if position('fiscal_month_id' in v_settlement) = 0 then
    raise exception 'aps letter period: the settlement does not write fiscal_month_id';
  end if;
end;
$$;
