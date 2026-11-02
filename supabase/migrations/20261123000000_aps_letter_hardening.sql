-- A.4 — letter validation hardening and durable refusal audit.
--
-- PR #48 closed the duplicate transfer-line hole. This migration closes the
-- remaining header holes and makes every refusal by these guards survive the
-- rollback of the failed write:
--
--   1. `fiscal_month_id` is mandatory on every letter write; the pre-A.3
--      silent "derive a month from the date" fallback is retired.
--   2. A draft cannot be saved into a closed month or a closed fiscal year,
--      even through a direct table write that bypasses the entry RPC.
--   3. `letter_date` must lie inside the stored fiscal month. A disagreement
--      is refused, never silently repaired by moving the month.
--   4. `reclassification_note` belongs to internal transfers only.
--   5. `document_date` (paper date) may not be in the project's future.
--   6. The entry RPC's `aps_no_active_period` / `aps_period_changed` refusals
--      are audited as well.
--
-- Durable audit design
--   A plain INSERT into audit_logs inside a raising trigger is rolled back
--   with the statement that caused it, so it cannot record a refusal. This
--   migration therefore installs `dblink` and writes refusal rows through a
--   loopback connection opened by a SECURITY DEFINER helper. The loopback
--   insert runs in its own transaction and commits even though the caller's
--   transaction aborts. No remote host, password, or application connection
--   string is used: the helper connects over the server's own Unix socket to
--   current_database() as the function owner, with connect_timeout=2. Direct
--   dblink execution is revoked from the API roles; only the definer helpers
--   can use it. If the extension or the loopback connection is unavailable,
--   the helper raises a WARNING containing the original refusal reason and
--   returns; aps_reject_letter() then raises the original P0001 refusal. An
--   audit transport failure can never turn a refusal into a save, and it can
--   never replace the original refusal with a dblink error.
--
-- No UI change is included here. A.5 owns translating the named P0001 tokens.

-- ---------------------------------------------------------------------------
-- 1) Audit action and the loopback extension
-- ---------------------------------------------------------------------------
alter type public.audit_action
  add value if not exists 'aps.letter_rejected';

-- Supabase keeps extensions in the `extensions` schema. This is the
-- schema-qualified form of CREATE EXTENSION IF NOT EXISTS dblink, and keeps
-- the definer helper's `extensions.dblink_exec` reference valid.
create schema if not exists extensions;
create extension if not exists dblink with schema extensions;

-- The extension ships with PUBLIC execute. Remove that default so an API
-- caller cannot open loopback connections itself; the definer helpers below
-- retain execute as their owner.
do $revoke_dblink$
declare
  v_function regprocedure;
begin
  for v_function in
    select p.oid::regprocedure
      from pg_catalog.pg_proc as p
     where p.pronamespace = 'extensions'::regnamespace
       and p.proname like 'dblink%'
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', v_function);
  end loop;
end
$revoke_dblink$;

-- ---------------------------------------------------------------------------
-- 2) Durable refusal writer
-- ---------------------------------------------------------------------------
create or replace function public.aps_audit_letter_rejection(
  p_letter_id uuid,
  p_reason text,
  p_metadata jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_socket text;
  v_connection text;
  v_metadata jsonb;
  v_sql text;
begin
  v_metadata := jsonb_build_object('reason', p_reason, 'letter_id', p_letter_id)
                || coalesce(p_metadata, '{}'::jsonb);

  v_socket := coalesce(
    nullif(btrim(split_part(current_setting('unix_socket_directories', true), ',', 1)), ''),
    '/var/run/postgresql'
  );
  v_connection := format(
    'host=%L port=%L dbname=%L user=%L application_name=%L connect_timeout=2',
    v_socket,
    current_setting('port'),
    current_database(),
    current_user,
    'aps_letter_rejection_audit'
  );
  v_sql := format(
    'insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
     values (%L::uuid, %L::public.audit_action, %L, %L, %L::jsonb)',
    auth.uid(),
    'aps.letter_rejected',
    'letters',
    p_letter_id::text,
    v_metadata::text
  );

  begin
    perform extensions.dblink_exec(v_connection, v_sql);
  exception when others then
    -- Never let an audit transport failure turn a refusal into a save, and
    -- never let it mask the original refusal. The warning carries the original
    -- reason so the server log still identifies what was refused.
    raise warning 'aps letter rejection audit could not be made durable: reason=%, letter_id=%, transport_error=%',
      p_reason, p_letter_id, sqlerrm;
  end;
exception when others then
  -- Belt-and-braces: even an unexpected failure while preparing the audit
  -- payload must not replace the caller's original P0001 refusal.
  raise warning 'aps letter rejection audit failed before transport: reason=%, letter_id=%, error=%',
    p_reason, p_letter_id, sqlerrm;
end;
$$;

revoke all on function public.aps_audit_letter_rejection(uuid, text, jsonb)
  from public, anon, authenticated, service_role;

create or replace function public.aps_reject_letter(
  p_letter_id uuid,
  p_reason text,
  p_metadata jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  perform public.aps_audit_letter_rejection(p_letter_id, p_reason, p_metadata);
  raise exception '%', p_reason using errcode = 'P0001';
end;
$$;

revoke all on function public.aps_reject_letter(uuid, text, jsonb)
  from public, anon;
grant execute on function public.aps_reject_letter(uuid, text, jsonb)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3) One header rule book for saves and approvals
-- ---------------------------------------------------------------------------
create or replace function public.aps_assert_letter_header_consistent(
  p_letter_id uuid,
  p_fiscal_month_id uuid,
  p_letter_date date,
  p_document_date date,
  p_letter_type text,
  p_reclassification_note text,
  p_via text,
  p_allow_supplements boolean default false
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_month record;
  v_today date;
  v_metadata jsonb;
begin
  v_metadata := jsonb_build_object(
    'via', p_via,
    'letter_type', p_letter_type,
    'fiscal_month_id', p_fiscal_month_id,
    'letter_date', p_letter_date,
    'document_date', p_document_date
  );

  if p_fiscal_month_id is null then
    perform public.aps_reject_letter(p_letter_id, 'aps_missing_fiscal_month', v_metadata);
  end if;

  select month.id, month.name, month.start_date, month.end_date, month.is_closed,
         month.fiscal_year_id, year.is_closed as year_is_closed, year.supplements_open
    into v_month
    from public.fiscal_months as month
    join public.fiscal_years as year on year.id = month.fiscal_year_id
   where month.id = p_fiscal_month_id;
  if not found then
    perform public.aps_reject_letter(p_letter_id, 'aps_unknown_fiscal_month', v_metadata);
  end if;

  v_metadata := v_metadata || jsonb_build_object(
    'month_name', v_month.name,
    'month_start', v_month.start_date,
    'month_end', v_month.end_date,
    'month_is_closed', v_month.is_closed,
    'fiscal_year_id', v_month.fiscal_year_id,
    'year_is_closed', v_month.year_is_closed,
    'supplements_open', v_month.supplements_open
  );

  if p_letter_date < v_month.start_date or p_letter_date > v_month.end_date then
    perform public.aps_reject_letter(p_letter_id, 'aps_letter_date_mismatch', v_metadata);
  end if;

  if p_reclassification_note is not null and p_letter_type <> 'internal_transfer' then
    perform public.aps_reject_letter(p_letter_id, 'aps_reclassification_note_type', v_metadata);
  end if;

  if p_document_date is not null then
    v_today := public.aps_project_today();
    if p_document_date > v_today then
      perform public.aps_reject_letter(
        p_letter_id, 'aps_document_date_future',
        v_metadata || jsonb_build_object('project_today', v_today)
      );
    end if;
  end if;

  -- A closed period is final for a draft save. Approval keeps the documented
  -- supplements_open exception; the entry RPC and direct approval both pass
  -- through this same rule book.
  if (v_month.is_closed or v_month.year_is_closed)
     and not (p_allow_supplements and v_month.supplements_open) then
    perform public.aps_reject_letter(p_letter_id, 'aps_closed_period', v_metadata);
  end if;
end;
$$;

revoke all on function public.aps_assert_letter_header_consistent(
  uuid, uuid, date, date, text, text, text, boolean
) from public, anon, authenticated, service_role;

comment on function public.aps_assert_letter_header_consistent(
  uuid, uuid, date, date, text, text, text, boolean
) is
  'A.4 header invariants: mandatory month, date inside month, transfer-only note, no future paper date, and no closed-period save. p_allow_supplements is true only for approval, never for a draft save.';

-- ---------------------------------------------------------------------------
-- 4) The letter guard: mandatory month, no silent date/month repair
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
  v_month_year uuid;
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

  -- A.4: the stored month is mandatory, and the header is re-proved on every
  -- draft save (and on any direct approval). The month decides the year; a
  -- date/month disagreement is refused, never silently repaired.
  if new.fiscal_month_id is null then
    perform public.aps_reject_letter(
      new.id, 'aps_missing_fiscal_month',
      jsonb_build_object('via', 'trigger', 'operation', tg_op, 'letter_type', new.letter_type)
    );
  end if;

  select month.fiscal_year_id
    into v_month_year
    from public.fiscal_months as month
   where month.id = new.fiscal_month_id;
  if not found then
    perform public.aps_reject_letter(
      new.id, 'aps_unknown_fiscal_month',
      jsonb_build_object('via', 'trigger', 'operation', tg_op, 'fiscal_month_id', new.fiscal_month_id)
    );
  end if;

  if new.status in ('draft', 'approved') then
    perform public.aps_assert_letter_header_consistent(
      new.id, new.fiscal_month_id, new.letter_date, new.document_date,
      new.letter_type, new.reclassification_note,
      'trigger', new.status = 'approved'
    );
  end if;

  -- One source of truth: the month decides the year, never the other way round.
  if new.fiscal_year_id is null then
    new.fiscal_year_id := v_month_year;
  elsif new.fiscal_year_id <> v_month_year then
    raise exception 'aps letters: fiscal year % does not match fiscal month %',
      new.fiscal_year_id, new.fiscal_month_id
      using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function public.aps_letters_before_write()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5) Approval consistency now re-proves the header first
-- ---------------------------------------------------------------------------
create or replace function public.aps_assert_letter_consistent(p_letter_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_letter public.letters%rowtype;
  v_type text;
  v_party_id uuid;
  v_party_count integer;
  v_lines integer;
  v_in_total numeric(18, 2);
  v_out_total numeric(18, 2);
  v_directions integer;
begin
  select * into v_letter
    from public.letters as letter
   where letter.id = p_letter_id;
  if not found then
    return;
  end if;

  -- A.4: approval re-proves the header against the calendar as it stands now.
  -- A closed period is still final for a draft save; approval keeps the
  -- documented supplements_open exception already enforced by aps_approve_letter().
  perform public.aps_assert_letter_header_consistent(
    v_letter.id, v_letter.fiscal_month_id, v_letter.letter_date, v_letter.document_date,
    v_letter.letter_type, v_letter.reclassification_note,
    'approval', true
  );

  v_type := v_letter.letter_type;
  v_party_id := v_letter.party_id;
  v_party_count := v_letter.party_count;

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

  -- The party tree, restated at the moment the letter becomes a reference
  -- document. The line guard enforces all of this on every write; approval
  -- re-proves it because an approved letter can no longer be repaired, and a
  -- derived header (primary party, party_count) that disagreed with the lines
  -- would misname the letter in the register forever.
  if v_type in ('inbound', 'outbound') then
    if exists (
      select 1 from public.letter_lines as line
       where line.letter_id = p_letter_id
         and (line.party_id is null or line.party_code is null or line.party_name is null)
    ) then
      raise exception 'aps letters: every % line needs a party', v_type using errcode = '23514';
    end if;
    if exists (
      select 1 from public.letter_lines as line
        join public.parties as party on party.id = line.party_id
       where line.letter_id = p_letter_id and party.branch <> v_type
    ) then
      raise exception 'aps letters: a % letter only carries % parties', v_type, v_type
        using errcode = '23514';
    end if;
    if v_party_id is distinct from (
      select line.party_id from public.letter_lines as line
       where line.letter_id = p_letter_id
       order by line.line_number
       limit 1
    ) then
      raise exception 'aps letters: the header party is not the party of the first line'
        using errcode = '23514';
    end if;
    if v_party_count is distinct from (
      select count(distinct line.party_id)::integer
        from public.letter_lines as line
       where line.letter_id = p_letter_id
    ) then
      raise exception 'aps letters: party_count does not match the lines' using errcode = '23514';
    end if;
  elsif exists (
    select 1 from public.letter_lines as line
     where line.letter_id = p_letter_id and line.party_id is not null
  ) then
    raise exception 'aps letters: a % line carries no party', v_type using errcode = '23514';
  end if;

  if v_type <> 'internal_transfer' then
    return;
  end if;

  -- The whole letter settles, or it does not: one source may feed several
  -- destinations and several sources one destination, as long as the two
  -- independent sides add up to the same figure.
  if v_in_total <> v_out_total then
    raise exception 'aps letters: the transfer does not balance (% in vs % out)',
      v_in_total, v_out_total using errcode = '23514';
  end if;

  -- Nothing else is owed. The two sides are independent lists: lines are
  -- not paired, a destination need not name the source it settles, and
  -- movement between classifications demands no flag and no per-line reason
  -- — the header carries an optional statement (`reclassification_note`).
end;
$$;

revoke all on function public.aps_assert_letter_consistent(uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6) The entry RPC audits its period refusals
-- ---------------------------------------------------------------------------
create or replace function public.aps_save_letter_draft(
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
    perform public.aps_reject_letter(
      p_letter_id, 'aps_no_active_period',
      jsonb_build_object('via', 'rpc', 'letter_type', p_letter_type,
                         'expected_fiscal_month_id', p_expected_fiscal_month_id)
    );
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
      perform public.aps_reject_letter(
        p_letter_id, 'aps_period_changed',
        jsonb_build_object('via', 'rpc', 'letter_type', p_letter_type,
                           'expected_fiscal_month_id', p_expected_fiscal_month_id,
                           'active_fiscal_month_id', v_active_month_id)
      );
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

-- ---------------------------------------------------------------------------
-- 7) Verification
-- ---------------------------------------------------------------------------
do $verify_aps_letter_hardening$
declare
  v_count integer;
begin
  select count(*) into v_count
    from pg_catalog.pg_enum as e
    join pg_catalog.pg_type as t on t.oid = e.enumtypid
   where t.typname = 'audit_action'
     and e.enumlabel = 'aps.letter_rejected';
  if v_count <> 1 then
    raise exception 'aps letter hardening: audit_action is missing aps.letter_rejected';
  end if;

  if to_regprocedure('public.aps_audit_letter_rejection(uuid,text,jsonb)') is null
     or to_regprocedure('public.aps_reject_letter(uuid,text,jsonb)') is null
     or to_regprocedure('public.aps_assert_letter_header_consistent(uuid,uuid,date,date,text,text,text,boolean)') is null then
    raise exception 'aps letter hardening: a refusal helper is missing';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_extension where extname = 'dblink'
  ) then
    raise exception 'aps letter hardening: dblink is missing';
  end if;

  if position('connect_timeout=2' in pg_get_functiondef('public.aps_audit_letter_rejection(uuid,text,jsonb)'::regprocedure)) = 0 then
    raise exception 'aps letter hardening: the refusal audit connection is missing connect_timeout=2';
  end if;

  if position('reason=%' in pg_get_functiondef('public.aps_audit_letter_rejection(uuid,text,jsonb)'::regprocedure)) = 0 then
    raise exception 'aps letter hardening: the audit failure warning does not carry the original reason';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_trigger
     where tgrelid = 'public.letters'::regclass
       and tgname = 'letters_aps_before_write'
       and tgenabled = 'O'
  ) then
    raise exception 'aps letter hardening: letters_aps_before_write is missing or disabled';
  end if;

  if exists (
    select 1 from pg_catalog.pg_proc
     where oid in (
       'public.aps_letters_before_write()'::regprocedure,
       'public.aps_assert_letter_consistent(uuid)'::regprocedure,
       'public.aps_save_letter_draft(uuid,timestamptz,uuid,text,text,uuid,uuid,text,text,jsonb,text,date,date,uuid)'::regprocedure
     )
     and position('current_date' in lower(pg_get_functiondef(oid))) > 0
  ) then
    raise exception 'aps letter hardening: a rewritten accounting function reads current_date';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint
     where conrelid = 'public.letters'::regclass
       and conname = 'letters_reclassification_note_check'
  ) then
    raise exception 'aps letter hardening: the transfer-note constraint is missing';
  end if;
end
$verify_aps_letter_hardening$;
