-- APS workspace, phase 1: letters and letter lines (database only).
--
-- This migration is the data model approved in
-- `docs/consultations/2026-10-26-aps-workspace-design-study.md`, restricted to
-- the letters themselves. It deliberately ships **no** UI, **no** balance
-- table, **no** reconciliation tables and **no** quantity columns.
--
-- Decisions implemented here (numbering follows §10 of the study):
--
--   * D1(a)  `unique (fiscal_year_id, letter_number)`. Issuance is central, so a
--            number is unique inside a fiscal year and nowhere else. The number
--            is stored **normalised** — Arabic-Indic digits folded to ASCII,
--            whitespace collapsed, upper-cased, leading zeros stripped from
--            numeric strings — so «٠٠٧», «007» and «7» are one letter, not
--            three. The value as typed is kept in `letter_number_raw` for the
--            printed register; it is never part of the key.
--   * D2(b)  The counterparty is a dual reference: `party_id` (an IN-/OUT-
--            party) **or** `sister_company_id` (a SIS- company), exactly one of
--            them, and neither for an internal transfer. A CHECK enforces the
--            exclusivity and the type pairing; the branch match (inbound party
--            for an inbound letter, outbound party for an outbound one) needs a
--            cross-table read and is enforced by the write trigger. The code
--            and name are **snapshotted** on the letter, so a renamed party
--            never rewrites history.
--   * D3(a)  An external transfer is an intercompany movement, hence always a
--            sister company. Direction is never stored on the letter: every
--            line carries `direction in ('in','out')`, which is also what the
--            future balance layer aggregates.
--   * D4(b)  An internal transfer must balance **and** be paired line by line:
--            each `in` line points (`paired_line_id`) at the `out` line it
--            settles, with an equal amount. A different classification across a
--            pair is allowed only when the letter is flagged as a
--            reclassification with a written reason.
--   * D5(a)  Amounts only: `amount numeric(18,2) > 0`. No quantity, no unit.
--   * D7(b)  Server-side drafts. A draft is visible/editable/deletable by its
--            author only; it never touches a balance. Approval and cancellation
--            are the only transitions, and both are audited. After approval a
--            letter is frozen; cancellation may set its status once, with a
--            reason, and nothing else may change.
--   * D8(a+b) A letter is approved only when its fiscal month is open. A closed
--            month (or a closed year) is reopened through the existing
--            `fiscal_years.supplements_open` flag, not through a new switch.
--   * D9(a)  `letter_date` is the accounting date and the filter axis; drafts
--            may be prepared for a closed period, they simply cannot post.
--   * D11(a) Four permissions — read / create / cancel / reconcile — and no
--            per-warehouse scoping.
--
-- Deliberately **not** here, so the review can stay focused:
--
--   * `warehouse_classification_balances` and every aggregation query. The
--     approved reconciliation is a **monthly aggregate per classification**
--     (not per letter), and its table grain is the subject of the next design
--     step.
--   * The `settlement` letter type. It is meaningless without a reconciliation
--     session to point at, and an enum value with no counterpart invites
--     orphan settlements. It arrives with the reconciliation migration, where
--     the FK can be enforced in the same transaction.
--   * An `approve` permission. Approval currently reuses `aps.letters:create`
--     (the author finalises their own draft); a dedicated approver capability
--     can be added later without touching these tables.

-- ---------------------------------------------------------------------------
-- 1) Permissions
-- ---------------------------------------------------------------------------
insert into public.permissions (slug, module, name_ar, name_en, description)
values
  (
    'aps.letters:read',
    'aps',
    'قراءة الخطابات',
    'Read letters',
    'عرض الخطابات المعتمدة وسطورها في مساحة الخطابات'
  ),
  (
    'aps.letters:create',
    'aps',
    'إنشاء الخطابات',
    'Create letters',
    'إنشاء مسودة خطاب وتحريرها واعتمادها'
  ),
  (
    'aps.letters:cancel',
    'aps',
    'إلغاء الخطابات',
    'Cancel letters',
    'إلغاء خطاب بسبب مكتوب، مع بقاء الرقم محجوزاً'
  ),
  (
    'aps.reconciliation:manage',
    'aps',
    'إدارة المطابقات',
    'Manage reconciliations',
    'فتح جلسات المطابقة الشهرية وإدخال الأرقام الدفترية والاعتماد'
  )
on conflict (slug) do nothing;

-- Explicit grants for the two protected roles, mirroring
-- `project.settings:manage`. The owner's automatic all-permissions trigger is
-- one source of this grant; this idempotent insert also repairs a missing row
-- and covers super_admin, which has no such trigger.
insert into public.role_permissions (role_id, permission_id)
select role.id, permission.id
  from public.roles as role
 cross join public.permissions as permission
 where role.slug in ('owner', 'super_admin')
   and permission.slug in (
     'aps.letters:read',
     'aps.letters:create',
     'aps.letters:cancel',
     'aps.reconciliation:manage'
   )
on conflict (role_id, permission_id) do nothing;

-- Capability predicates. Same shape as `can_manage_project_settings()`: the
-- active-user check is part of the predicate so a suspended account with a
-- still-granted role cannot read financial documents.
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
     );
$$;

revoke all on function public.aps_can_read_letters() from public, anon;
grant execute on function public.aps_can_read_letters() to authenticated, service_role;

create or replace function public.aps_can_create_letters()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce(public.is_active_user(), false)
     and coalesce(public.has_permission('aps.letters:create'), false);
$$;

revoke all on function public.aps_can_create_letters() from public, anon;
grant execute on function public.aps_can_create_letters() to authenticated, service_role;

create or replace function public.aps_can_cancel_letters()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce(public.is_active_user(), false)
     and coalesce(public.has_permission('aps.letters:cancel'), false);
$$;

revoke all on function public.aps_can_cancel_letters() from public, anon;
grant execute on function public.aps_can_cancel_letters() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2) Letter number normalisation
-- ---------------------------------------------------------------------------
-- Duplicate detection is only as good as the key it compares. Free-form manual
-- numbers arrive in Arabic-Indic digits, with stray spaces and inconsistent
-- case; without folding them first, every one of those variants would pass a
-- `unique` index and create a second letter for the same paper document.
create or replace function public.aps_normalize_letter_number(p_value text)
returns text
language sql
immutable
set search_path = pg_catalog, public
as $$
  select case
    when p_value is null then null
    else (
      with folded as (
        select btrim(
                 regexp_replace(
                   upper(
                     translate(
                       p_value,
                       '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹',
                       '01234567890123456789'
                     )
                   ),
                   '[[:space:]]+',
                   ' ',
                   'g'
                 )
               ) as value
      )
      select case
               -- A purely numeric number loses its padding: 007 is 7. A string
               -- of zeros keeps one digit so it is rejected as blank rather
               -- than silently collapsing into the empty string.
               when value ~ '^0+$' then '0'
               when value ~ '^[0-9]+$' then ltrim(value, '0')
               else value
             end
        from folded
    )
  end;
$$;

comment on function public.aps_normalize_letter_number(text) is
  'Canonical form of a manual letter number: ASCII digits, collapsed spaces, upper case, no numeric padding. Empty strings collapse to the empty string and are rejected by the table CHECK.';

revoke all on function public.aps_normalize_letter_number(text) from public, anon;
grant execute on function public.aps_normalize_letter_number(text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3) Tables
-- ---------------------------------------------------------------------------
create table if not exists public.letters (
  id uuid primary key default gen_random_uuid(),
  fiscal_year_id uuid not null references public.fiscal_years (id) on delete restrict,
  letter_type text not null,
  letter_number text not null,
  letter_number_raw text,
  letter_date date not null,
  status text not null default 'draft',
  party_id uuid references public.parties (id) on delete restrict,
  sister_company_id uuid references public.sister_companies (id) on delete restrict,
  counterparty_code text,
  counterparty_name text,
  has_reclassification boolean not null default false,
  reclassification_reason text,
  source_total numeric(18, 2) not null default 0,
  destination_total numeric(18, 2) not null default 0,
  created_by uuid not null default auth.uid() references public.profiles (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  approved_at timestamptz,
  approved_by uuid references public.profiles (id) on delete restrict,
  cancelled_at timestamptz,
  cancelled_by uuid references public.profiles (id) on delete restrict,
  cancel_reason text,
  constraint letters_type_check check (
    letter_type in ('inbound', 'outbound', 'internal_transfer', 'external_transfer')
  ),
  constraint letters_status_check check (status in ('draft', 'approved', 'cancelled')),
  constraint letters_number_not_blank check (
    char_length(letter_number) between 1 and 64
    and letter_number !~ '[[:cntrl:]]'
  ),
  constraint letters_counterparty_exclusive check (num_nonnulls(party_id, sister_company_id) <= 1),
  constraint letters_counterparty_matches_type check (
    (letter_type in ('inbound', 'outbound') and party_id is not null and sister_company_id is null)
    or (letter_type = 'external_transfer'
        and sister_company_id is not null
        and party_id is null)
    or (letter_type = 'internal_transfer' and party_id is null and sister_company_id is null)
  ),
  constraint letters_reclassification_check check (
    (
      has_reclassification
      and letter_type = 'internal_transfer'
      and reclassification_reason is not null
      and char_length(btrim(reclassification_reason)) >= 3
    )
    or (not has_reclassification and reclassification_reason is null)
  ),
  constraint letters_totals_non_negative check (source_total >= 0 and destination_total >= 0),
  constraint letters_internal_balance_check check (
    status <> 'approved'
    or letter_type <> 'internal_transfer'
    or source_total = destination_total
  ),
  constraint letters_approved_has_value_check check (
    status <> 'approved' or source_total + destination_total > 0
  ),
  constraint letters_lifecycle_check check (
    (
      status = 'draft'
      and approved_at is null
      and approved_by is null
      and cancelled_at is null
      and cancelled_by is null
      and cancel_reason is null
    )
    or (
      status = 'approved'
      and approved_at is not null
      and approved_by is not null
      and cancelled_at is null
      and cancelled_by is null
      and cancel_reason is null
    )
    or (
      status = 'cancelled'
      and cancelled_at is not null
      and cancelled_by is not null
      and cancel_reason is not null
      and char_length(btrim(cancel_reason)) >= 3
    )
  ),
  -- D1(a): one issuance series per fiscal year, and nowhere else.
  constraint letters_year_number_key unique (fiscal_year_id, letter_number)
);

comment on column public.letters.letter_number is
  'Canonical number (see aps_normalize_letter_number). Part of the (fiscal_year_id, letter_number) uniqueness key; a cancelled number is never reused.';
comment on column public.letters.letter_number_raw is
  'The number exactly as typed, kept for the printed register. Never part of any key.';
comment on column public.letters.source_total is
  'Sum of the `out` lines, maintained by trigger. For an inbound letter it stays 0; the document value is destination_total.';
comment on column public.letters.destination_total is
  'Sum of the `in` lines, maintained by trigger. For an outbound/external letter it stays 0; the document value is source_total.';

create table if not exists public.letter_lines (
  id uuid primary key default gen_random_uuid(),
  letter_id uuid not null references public.letters (id) on delete cascade,
  line_number integer not null,
  -- The real effect on a balance, on every letter type. A "source" side is an
  -- `out` line and a "destination" side is an `in` line; single-sided letters
  -- simply use one of the two.
  direction text not null,
  warehouse_id uuid not null references public.warehouses (id) on delete restrict,
  classification_id uuid not null references public.classifications (id) on delete restrict,
  amount numeric(18, 2) not null,
  -- D4(b): recorded on the `in` line and pointing at the `out` line it settles.
  -- The partial unique index below turns that into a one-to-one matching.
  paired_line_id uuid references public.letter_lines (id) on delete restrict,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint letter_lines_direction_check check (direction in ('in', 'out')),
  constraint letter_lines_amount_positive check (amount > 0),
  constraint letter_lines_line_number_range check (line_number between 1 and 500),
  constraint letter_lines_no_self_pair check (paired_line_id is null or paired_line_id <> id),
  constraint letter_lines_letter_line_key unique (letter_id, line_number)
);

comment on column public.letter_lines.paired_line_id is
  'For internal transfers only: the `out` line this `in` line settles. Equal amount, same letter, opposite direction — enforced by aps_assert_letter_consistent().';

-- Browse indexes (study D2). The first one is the default screen: a fiscal year
-- ordered by accounting date, newest first, with `id` as the keyset tiebreak.
create index if not exists letters_year_date_idx
  on public.letters (fiscal_year_id, letter_date desc, id desc);
create index if not exists letters_type_date_idx
  on public.letters (letter_type, letter_date desc, id desc);
create index if not exists letters_party_idx
  on public.letters (party_id, letter_date desc);
create index if not exists letters_sister_company_idx
  on public.letters (sister_company_id, letter_date desc);
create index if not exists letters_status_author_idx
  on public.letters (status, created_by);
create index if not exists letters_letter_date_idx on public.letters (letter_date desc);

-- Postgres does not index foreign keys implicitly; loading a letter's lines and
-- filtering by warehouse/classification are the three read paths.
create index if not exists letter_lines_letter_idx on public.letter_lines (letter_id);
create index if not exists letter_lines_warehouse_idx
  on public.letter_lines (warehouse_id, letter_id);
create index if not exists letter_lines_classification_idx
  on public.letter_lines (classification_id, letter_id);
-- An `out` line can be settled by at most one `in` line.
create unique index if not exists letter_lines_pair_unique
  on public.letter_lines (paired_line_id)
  where paired_line_id is not null;

create trigger letters_set_updated_at
  before update on public.letters
  for each row execute function public.set_updated_at();

create trigger letter_lines_set_updated_at
  before update on public.letter_lines
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 4) Letter write guard
-- ---------------------------------------------------------------------------
-- Everything a CHECK cannot see: the cross-table branch match, the fiscal-year
-- date window, the snapshot columns, the lifecycle columns and the freeze that
-- starts at approval.
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
begin
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
  else
    if new.party_id is not null or new.sister_company_id is not null then
      raise exception 'aps letters: an internal transfer has no counterparty'
        using errcode = '23514';
    end if;
    new.counterparty_code := null;
    new.counterparty_name := null;
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

create trigger letters_aps_before_write
  before insert or update on public.letters
  for each row execute function public.aps_letters_before_write();

-- ---------------------------------------------------------------------------
-- 5) Letter line guard
-- ---------------------------------------------------------------------------
create or replace function public.aps_letter_lines_before_write()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_letter record;
  v_paired record;
begin
  select letter.letter_type, letter.status, letter.created_by
    into v_letter
    from public.letters as letter
   where letter.id = new.letter_id;
  if not found then
    raise exception 'aps letters: unknown letter %', new.letter_id using errcode = '23503';
  end if;
  if v_letter.status <> 'draft' then
    raise exception 'aps letters: the lines of a % letter are immutable', v_letter.status
      using errcode = '23514';
  end if;

  -- A classification must be a leaf: posting to a parent would double-count
  -- once the tree totals are rolled up from the leaves.
  if not exists (
    select 1
      from public.classifications as classification
     where classification.id = new.classification_id
       and classification.is_leaf
  ) then
    raise exception 'aps letters: classification % is not a leaf', new.classification_id
      using errcode = '23514';
  end if;

  if new.line_number is null then
    select coalesce(max(line.line_number), 0) + 1
      into new.line_number
      from public.letter_lines as line
     where line.letter_id = new.letter_id;
  end if;

  -- Pairing exists only inside an internal transfer. Completeness is checked at
  -- approval; the shape of a single pair is checked here, where the mistake is
  -- made.
  if new.paired_line_id is not null then
    if v_letter.letter_type <> 'internal_transfer' then
      raise exception 'aps letters: only an internal transfer pairs lines'
        using errcode = '23514';
    end if;
    if new.direction <> 'in' then
      raise exception 'aps letters: only an `in` line records a pair' using errcode = '23514';
    end if;
    select paired.direction, paired.amount, paired.letter_id
      into v_paired
      from public.letter_lines as paired
     where paired.id = new.paired_line_id;
    if not found then
      raise exception 'aps letters: unknown paired line %', new.paired_line_id
        using errcode = '23503';
    end if;
    if v_paired.letter_id <> new.letter_id then
      raise exception 'aps letters: a pair must belong to the same letter'
        using errcode = '23514';
    end if;
    if v_paired.direction <> 'out' then
      raise exception 'aps letters: a line pairs with an `out` line, not with another `in` line'
        using errcode = '23514';
    end if;
    if v_paired.amount <> new.amount then
      raise exception 'aps letters: a paired line must have the same amount (% vs %)',
        v_paired.amount, new.amount using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.aps_letter_lines_before_write()
  from public, anon, authenticated, service_role;

create trigger letter_lines_aps_before_write
  before insert or update on public.letter_lines
  for each row execute function public.aps_letter_lines_before_write();

-- ---------------------------------------------------------------------------
-- 6) Header totals, maintained inside the writing transaction
-- ---------------------------------------------------------------------------
create or replace function public.aps_letter_lines_recalc_totals()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_letter_id uuid;
begin
  for v_letter_id in
    select distinct candidate
      from (
        values (coalesce(new.letter_id, old.letter_id)), (old.letter_id), (new.letter_id)
      ) as moved(candidate)
     where candidate is not null
  loop
    update public.letters as letter
       set source_total = coalesce(
             (
               select sum(line.amount)
                 from public.letter_lines as line
                where line.letter_id = v_letter_id
                  and line.direction = 'out'
             ),
             0
           ),
           destination_total = coalesce(
             (
               select sum(line.amount)
                 from public.letter_lines as line
                where line.letter_id = v_letter_id
                  and line.direction = 'in'
             ),
             0
           )
     where letter.id = v_letter_id;
  end loop;

  return null;
end;
$$;

revoke all on function public.aps_letter_lines_recalc_totals()
  from public, anon, authenticated, service_role;

create trigger letter_lines_aps_recalc_totals
  after insert or update or delete on public.letter_lines
  for each row execute function public.aps_letter_lines_recalc_totals();

-- ---------------------------------------------------------------------------
-- 7) Whole-letter consistency (balance + one-to-one pairing)
-- ---------------------------------------------------------------------------
-- Checked at approval, not by a deferred constraint trigger: a draft is filled
-- in across several transactions (a line is added now, its pair a minute
-- later), so any check that demands a complete matching at every commit would
-- make ordinary drafting impossible. Drafts are explicitly allowed to be
-- inconsistent — they never reach a total — and the transition to `approved`
-- is the single point where the document becomes authoritative.
--
-- The cheap per-row pair rules (same letter, opposite direction, equal amount)
-- still run on every line write, so a mistake is reported where it is made
-- rather than minutes later at approval.
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
-- 8) RLS
-- ---------------------------------------------------------------------------
alter table public.letters enable row level security;
alter table public.letters force row level security;
alter table public.letter_lines enable row level security;
alter table public.letter_lines force row level security;

grant select, insert, update, delete on public.letters to authenticated;
grant select, insert, update, delete on public.letter_lines to authenticated;

-- Reading: the read capability, or the author's own drafts. A draft is never
-- visible to anyone else, no matter how many capabilities they hold — the read
-- capability is deliberately *not* enough, or `aps.letters:read` would leak
-- every half-written transfer in the company.
drop policy if exists letters_read on public.letters;
create policy letters_read
  on public.letters
  for select
  to authenticated
  using (
    (
      status <> 'draft'
      and public.aps_can_read_letters()
    )
    or (
      status = 'draft'
      and created_by = auth.uid()
      and public.aps_can_create_letters()
    )
  );

drop policy if exists letters_create on public.letters;
create policy letters_create
  on public.letters
  for insert
  to authenticated
  with check (
    public.aps_can_create_letters()
    and status = 'draft'
    and created_by = auth.uid()
  );

drop policy if exists letters_update on public.letters;
create policy letters_update
  on public.letters
  for update
  to authenticated
  using (
    public.aps_can_create_letters()
    and status = 'draft'
    and created_by = auth.uid()
  )
  with check (
    public.aps_can_create_letters()
    and status = 'draft'
    and created_by = auth.uid()
  );

drop policy if exists letters_delete on public.letters;
create policy letters_delete
  on public.letters
  for delete
  to authenticated
  using (
    public.aps_can_create_letters()
    and status = 'draft'
    and created_by = auth.uid()
  );

-- Line policies delegate to the letter policy through an EXISTS subquery: the
-- `letters` policy above is evaluated with the caller's identity, so a line is
-- exactly as visible as its letter and writable only while that letter is the
-- caller's draft.
drop policy if exists letter_lines_read on public.letter_lines;
create policy letter_lines_read
  on public.letter_lines
  for select
  to authenticated
  using (exists (select 1 from public.letters as letter where letter.id = letter_id));

drop policy if exists letter_lines_create on public.letter_lines;
create policy letter_lines_create
  on public.letter_lines
  for insert
  to authenticated
  with check (
    public.aps_can_create_letters()
    and exists (
      select 1
        from public.letters as letter
       where letter.id = letter_id
         and letter.status = 'draft'
         and letter.created_by = auth.uid()
    )
  );

drop policy if exists letter_lines_update on public.letter_lines;
create policy letter_lines_update
  on public.letter_lines
  for update
  to authenticated
  using (
    public.aps_can_create_letters()
    and exists (
      select 1
        from public.letters as letter
       where letter.id = letter_id
         and letter.status = 'draft'
         and letter.created_by = auth.uid()
    )
  )
  with check (
    public.aps_can_create_letters()
    and exists (
      select 1
        from public.letters as letter
       where letter.id = letter_id
         and letter.status = 'draft'
         and letter.created_by = auth.uid()
    )
  );

drop policy if exists letter_lines_delete on public.letter_lines;
create policy letter_lines_delete
  on public.letter_lines
  for delete
  to authenticated
  using (
    public.aps_can_create_letters()
    and exists (
      select 1
        from public.letters as letter
       where letter.id = letter_id
         and letter.status = 'draft'
         and letter.created_by = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- 9) Transitions
-- ---------------------------------------------------------------------------
-- Approval is the only path from draft to approved. It is the point where the
-- document becomes authoritative, so every rule that a draft was allowed to
-- violate temporarily is re-checked here: at least one line, a consistent
-- pairing, and an open accounting period.
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
      'letter_date', v_letter.letter_date,
      'counterparty_code', v_letter.counterparty_code,
      'source_total', v_letter.source_total,
      'destination_total', v_letter.destination_total,
      'line_count', v_line_count
    )
  );
end;
$$;

revoke all on function public.aps_approve_letter(uuid) from public, anon;
grant execute on function public.aps_approve_letter(uuid) to authenticated, service_role;

-- Cancellation is a documentary status change with a written reason. Until the
-- balance layer exists there is nothing to reverse; when it arrives it MUST
-- exclude cancelled letters from every aggregate (or the opposite pass — a
-- reversing letter — has to be issued), and that requirement belongs to that
-- migration, not this one.
create or replace function public.aps_cancel_letter(p_letter_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_letter public.letters%rowtype;
  v_reason text;
begin
  if v_actor is null or not public.aps_can_cancel_letters() then
    raise exception 'aps_cancel_letter: aps.letters:cancel is required' using errcode = '42501';
  end if;

  v_reason := btrim(coalesce(p_reason, ''));
  if char_length(v_reason) < 3 or char_length(v_reason) > 500 then
    raise exception 'aps_cancel_letter: a written reason between 3 and 500 characters is required'
      using errcode = '22023';
  end if;

  select * into v_letter from public.letters where id = p_letter_id for update;
  if not found then
    raise exception 'aps_cancel_letter: letter % not found', p_letter_id using errcode = 'P0002';
  end if;
  if v_letter.status = 'cancelled' then
    raise exception 'aps_cancel_letter: the letter is already cancelled' using errcode = '22023';
  end if;

  update public.letters
     set status = 'cancelled',
         cancelled_at = now(),
         cancelled_by = v_actor,
         cancel_reason = v_reason
   where id = p_letter_id;

  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
  values (
    v_actor,
    'aps.letter_cancelled'::public.audit_action,
    'letters',
    p_letter_id::text,
    jsonb_build_object(
      'letter_number', v_letter.letter_number,
      'letter_type', v_letter.letter_type,
      'previous_status', v_letter.status,
      'fiscal_year_id', v_letter.fiscal_year_id,
      'letter_date', v_letter.letter_date,
      'reason', v_reason
    )
  );
end;
$$;

revoke all on function public.aps_cancel_letter(uuid, text) from public, anon;
grant execute on function public.aps_cancel_letter(uuid, text) to authenticated, service_role;

-- Suggested next number. It is a read-only convenience for the entry screen:
-- numbers are still typed by a human, and the unique index stays the authority.
-- Cancelled numbers count, because the approved policy is that a number is
-- never reused.
create or replace function public.aps_suggest_letter_number(p_fiscal_year_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_next numeric;
begin
  if not public.aps_can_create_letters() then
    raise exception 'aps_suggest_letter_number: aps.letters:create is required'
      using errcode = '42501';
  end if;

  select max(number.value) + 1
    into v_next
    from (
      select letter.letter_number::numeric as value
        from public.letters as letter
       where letter.fiscal_year_id = p_fiscal_year_id
         and letter.letter_number ~ '^[0-9]+$'
    ) as number;

  return coalesce(v_next, 1)::text;
end;
$$;

revoke all on function public.aps_suggest_letter_number(uuid) from public, anon;
grant execute on function public.aps_suggest_letter_number(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 10) Audit vocabulary
-- ---------------------------------------------------------------------------
-- Only the two transitions are recorded. Authorship of a draft is already a
-- column (`created_by`), and logging every draft keystroke would bury the
-- events that matter. As in the opening-balance freeze, the enum values are
-- only *used* inside function bodies, so the same-transaction restriction on
-- new enum values is never reached.
alter type public.audit_action
  add value if not exists 'aps.letter_approved';
alter type public.audit_action
  add value if not exists 'aps.letter_cancelled';

-- ---------------------------------------------------------------------------
-- 11) Preconditions
-- ---------------------------------------------------------------------------
do $verify_aps_letters$
begin
  if (
    select count(*)
      from public.permissions
     where slug in (
       'aps.letters:read',
       'aps.letters:create',
       'aps.letters:cancel',
       'aps.reconciliation:manage'
     )
  ) <> 4 then
    raise exception 'the four APS permissions are missing';
  end if;

  if not exists (
    select 1
      from pg_catalog.pg_constraint
     where conrelid = 'public.letters'::regclass
       and conname = 'letters_year_number_key'
       and contype = 'u'
  ) then
    raise exception 'letters_year_number_key is missing';
  end if;

  if exists (
    select 1
      from public.permissions
     where slug in (
       'aps.letters:read',
       'aps.letters:create',
       'aps.letters:cancel',
       'aps.reconciliation:manage'
     )
       and module <> 'aps'
  ) then
    raise exception 'the APS permissions must live in the aps module';
  end if;

  if not exists (
    select 1
      from public.role_permissions as grant_row
      join public.roles as role on role.id = grant_row.role_id
      join public.permissions as permission on permission.id = grant_row.permission_id
     where role.slug = 'super_admin'
       and permission.slug = 'aps.letters:create'
  ) then
    raise exception 'super_admin cannot create letters';
  end if;

  if (
    select count(*)
      from pg_catalog.pg_policies
     where schemaname = 'public'
       and tablename = 'letters'
       and policyname in ('letters_read', 'letters_create', 'letters_update', 'letters_delete')
  ) <> 4 then
    raise exception 'letters RLS policies are incomplete';
  end if;

  if (
    select count(*)
      from pg_catalog.pg_policies
     where schemaname = 'public'
       and tablename = 'letter_lines'
       and policyname in (
         'letter_lines_read',
         'letter_lines_create',
         'letter_lines_update',
         'letter_lines_delete'
       )
  ) <> 4 then
    raise exception 'letter_lines RLS policies are incomplete';
  end if;

  if to_regprocedure('public.aps_approve_letter(uuid)') is null
     or to_regprocedure('public.aps_cancel_letter(uuid, text)') is null
     or to_regprocedure('public.aps_assert_letter_consistent(uuid)') is null then
    raise exception 'the APS transition functions are missing';
  end if;

  if not exists (
    select 1
      from pg_catalog.pg_constraint
     where conrelid = 'public.letters'::regclass
       and conname = 'letters_internal_balance_check'
       and contype = 'c'
  ) then
    raise exception 'letters_internal_balance_check is missing';
  end if;

  if not exists (
    select 1
      from pg_catalog.pg_trigger
     where tgrelid = 'public.letters'::regclass
       and tgname = 'letters_aps_before_write'
  ) then
    raise exception 'letters_aps_before_write is missing';
  end if;

  if (
    select count(*)
      from pg_catalog.pg_enum as enum
      join pg_catalog.pg_type as type on type.oid = enum.enumtypid
     where type.typname = 'audit_action'
       and enumlabel in ('aps.letter_approved', 'aps.letter_cancelled')
  ) <> 2 then
    raise exception 'audit_action is missing the APS letter actions';
  end if;

  if public.aps_normalize_letter_number('٠٠٧') <> '7'
     or public.aps_normalize_letter_number(' 007 ') <> '7'
     or public.aps_normalize_letter_number('in-12') <> 'IN-12' then
    raise exception 'aps_normalize_letter_number is not canonical';
  end if;
end
$verify_aps_letters$;

notify pgrst, 'reload schema';
