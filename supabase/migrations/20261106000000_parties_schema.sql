-- Project Settings -> Parties (Phase 1: schema only).
--
-- Deliberately flat and minimal by design. Expected volume does not exceed a
-- few dozen counterparties (suppliers, customers, sister companies, internal
-- departments), so there is no pagination scaffolding, no history/soft-delete
-- table, and no complex query layer: one plain table (`public.parties`) read
-- in full in a single request and filtered client-side when needed.
--
-- Code strategy (approved Option B — per-type sequence):
--   * supplier        -> SUP-001, SUP-002, ...
--   * customer        -> CUS-001, CUS-002, ...
--   * sister_company  -> SIS-001, SIS-002, ...
--   * internal        -> INT-001, INT-002, ...
--
-- Why a BEFORE INSERT trigger instead of a column DEFAULT:
--   PostgreSQL column DEFAULT expressions cannot reference sibling columns of
--   the row being inserted (`type`). `public.parties_before_write()` therefore
--   mints `new.code` from the matching sequence on INSERT (overwriting anything
--   a client sends) and refuses any UPDATE that changes `type` or `code`
--   (SQLSTATE 22023), keeping report prefixes permanently truthful.
--
-- Note on padding: lpad() TRUNCATES on the right when the input is wider than
-- the target width (`lpad('1000', 3, '0')` -> `'100'`). Zero-padding to three
-- digits is applied only while `v_next < 1000`; from 1000 upward the full
-- digits are preserved (`SUP-1000`).
--
-- Access is gated by `project.settings:manage` via
-- `public.can_manage_project_settings()`, with explicit table grants for
-- `authenticated` and nothing granted to `anon`. No UI ships in this phase.

-- ---------------------------------------------------------------------------
-- 1) Per-type code sequences
-- ---------------------------------------------------------------------------
create sequence if not exists public.party_supplier_code_seq
  start with 1
  increment by 1
  minvalue 1
  no cycle;

create sequence if not exists public.party_customer_code_seq
  start with 1
  increment by 1
  minvalue 1
  no cycle;

create sequence if not exists public.party_sister_company_code_seq
  start with 1
  increment by 1
  minvalue 1
  no cycle;

create sequence if not exists public.party_internal_code_seq
  start with 1
  increment by 1
  minvalue 1
  no cycle;

-- Callers never advance sequences directly; the SECURITY DEFINER trigger below
-- is the sole consumer so API roles cannot burn codes with nextval().
revoke all on sequence
  public.party_supplier_code_seq,
  public.party_customer_code_seq,
  public.party_sister_company_code_seq,
  public.party_internal_code_seq
from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2) Table
-- ---------------------------------------------------------------------------
create table if not exists public.parties (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  name text not null,
  code text not null unique,
  tax_number text,
  commercial_register text,
  address text,
  contact_person text,
  phone text,
  email text,
  credit_limit numeric(18, 2),
  payment_terms integer,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint parties_type_check check (
    type in ('supplier', 'customer', 'sister_company', 'internal')
  ),
  constraint parties_name_not_blank check (
    char_length(btrim(name)) >= 1 and name ~ '\S'
  ),
  constraint parties_code_matches_type check (
    (type = 'supplier' and code ~ '^SUP-[0-9]{3,}$')
    or (type = 'customer' and code ~ '^CUS-[0-9]{3,}$')
    or (type = 'sister_company' and code ~ '^SIS-[0-9]{3,}$')
    or (type = 'internal' and code ~ '^INT-[0-9]{3,}$')
  ),
  constraint parties_email_check check (
    email is null
    or email ~* '^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$'
  ),
  constraint parties_credit_limit_non_negative check (
    credit_limit is null or credit_limit >= 0
  ),
  constraint parties_payment_terms_check check (
    payment_terms is null or payment_terms in (0, 15, 30, 60, 90)
  )
);

-- ---------------------------------------------------------------------------
-- 3) Triggers: per-type code minting, type/code immutability, and updated_at
-- ---------------------------------------------------------------------------
create or replace function public.parties_before_write()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_prefix text;
  v_next bigint;
begin
  if tg_op = 'INSERT' then
    if new.type is null then
      -- Leave `new.code` unset so column 2 (`type NOT NULL`) fires first with
      -- a standard 23502 on `type`, without touching any sequence.
      return new;
    end if;

    case new.type
      when 'supplier' then
        v_prefix := 'SUP-';
        v_next := nextval('public.party_supplier_code_seq');
      when 'customer' then
        v_prefix := 'CUS-';
        v_next := nextval('public.party_customer_code_seq');
      when 'sister_company' then
        v_prefix := 'SIS-';
        v_next := nextval('public.party_sister_company_code_seq');
      when 'internal' then
        v_prefix := 'INT-';
        v_next := nextval('public.party_internal_code_seq');
      else
        -- Fail before `code NOT NULL` (column 4) could mask an invalid `type`
        -- with 23502, and without advancing any sequence.
        raise exception 'parties: invalid party type'
          using errcode = '23514', constraint = 'parties_type_check';
    end case;

    new.code := v_prefix || case
      when v_next < 1000 then lpad(v_next::text, 3, '0')
      else v_next::text
    end;

    return new;
  end if;

  if tg_op = 'UPDATE' then
    if new.type is distinct from old.type then
      raise exception 'parties: party type cannot be changed after creation'
        using errcode = '22023';
    end if;

    if new.code is distinct from old.code then
      raise exception 'parties: party code cannot be changed after creation'
        using errcode = '22023';
    end if;

    return new;
  end if;

  return new;
end;
$$;

revoke all on function public.parties_before_write()
  from public, anon, authenticated, service_role;

drop trigger if exists parties_before_write on public.parties;
create trigger parties_before_write
  before insert or update on public.parties
  for each row execute function public.parties_before_write();

drop trigger if exists parties_set_updated_at on public.parties;
create trigger parties_set_updated_at
  before update on public.parties
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 4) Row Level Security - both read and write require project.settings:manage
-- ---------------------------------------------------------------------------
alter table public.parties enable row level security;
alter table public.parties force row level security;

-- Explicit table privileges (see the note in 20261104030000_stations_and_warehouses.sql:
-- `authenticated` receives no default privilege on newly created tables, and
-- `anon` is deliberately granted nothing).
grant select, insert, update, delete on public.parties to authenticated;

drop policy if exists parties_project_settings_select on public.parties;
create policy parties_project_settings_select
  on public.parties
  for select
  to authenticated
  using (public.can_manage_project_settings());

drop policy if exists parties_project_settings_insert on public.parties;
create policy parties_project_settings_insert
  on public.parties
  for insert
  to authenticated
  with check (public.can_manage_project_settings());

drop policy if exists parties_project_settings_update on public.parties;
create policy parties_project_settings_update
  on public.parties
  for update
  to authenticated
  using (public.can_manage_project_settings())
  with check (public.can_manage_project_settings());

drop policy if exists parties_project_settings_delete on public.parties;
create policy parties_project_settings_delete
  on public.parties
  for delete
  to authenticated
  using (public.can_manage_project_settings());

-- ---------------------------------------------------------------------------
-- 5) Preconditions
-- ---------------------------------------------------------------------------
do $verify_parties_schema$
begin
  if not exists (
    select 1 from public.permissions where slug = 'project.settings:manage'
  ) then
    raise exception 'Project settings permission is missing';
  end if;

  if not exists (
    select 1
      from pg_proc as proc
      join pg_namespace as namespace on namespace.oid = proc.pronamespace
     where namespace.nspname = 'public'
       and proc.proname = 'can_manage_project_settings'
  ) then
    raise exception 'can_manage_project_settings() is missing';
  end if;

  if not exists (
    select 1
      from pg_proc as proc
      join pg_namespace as namespace on namespace.oid = proc.pronamespace
     where namespace.nspname = 'public'
       and proc.proname = 'set_updated_at'
  ) then
    raise exception 'set_updated_at() is missing';
  end if;
end;
$verify_parties_schema$;

notify pgrst, 'reload schema';
