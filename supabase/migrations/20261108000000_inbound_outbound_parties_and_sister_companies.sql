-- Project Settings -> Parties, restructured around the company's real shape.
--
-- The directory built in 20261106000000 modelled four flat types
-- (`supplier`, `customer`, `sister_company`, `internal`). Operations does not
-- work that way: inbound counterparties are suppliers (local or foreign),
-- outbound counterparties are customers only, and sister companies are a
-- hierarchy (a parent company and its branches), not a badge on a flat row.
--
-- What this migration changes:
--
--   1. `parties.type` becomes exactly three values:
--        local_supplier  -> LOC-001
--        foreign_supplier-> FRN-001
--        customer        -> CUS-001
--      `supplier` is split in two, and `internal` is retired outright.
--   2. Existing `supplier` rows are re-keyed from SUP-### to LOC-### in their
--      original numeric order; their type moves to `local_supplier`. Nothing
--      is renumbered by hand, and the sequence is advanced past the highest
--      migrated code so the next UI insert can never collide.
--   3. Existing `sister_company` rows move to the new `sister_companies` table
--      as level-1 parents, keeping their SIS-### code, name and active flag.
--      Their credit columns are dropped with the move: the new table carries
--      identity and hierarchy only (currency and pricing belong to letters).
--   4. `internal` rows are deleted. An internal department was never a
--      counterparty — it had no invoice and nobody to settle with — and the
--      new model has no place to hold one. This is the only destructive step
--      in the migration and it is deliberate.
--   5. `public.sister_companies` is created: a two-level tree (parent company
--      -> branches) whose `level` and `code` are derived server-side, exactly
--      like classifications. Codes are SIS-001 for a parent and SIS-001-01 for
--      its first branch. `parent_id` and `code` are write-once.
--   6. Credit terms (`credit_limit`, `payment_terms`) stay allowed on every
--      remaining type — local suppliers, foreign suppliers and customers —
--      which is what the old `parties_internal_no_credit_terms` guard was
--      protecting, now enforced by a CHECK that names the allowed types.
--
-- Currency / exchange-rate columns are deliberately NOT added here: they
-- belong to the letters phase, where a document actually has a currency.
--
-- Forward-only: the migration reshapes data in place and is safe to replay
-- (every destructive statement is guarded by a predicate that matches nothing
-- the second time, and every object is created `if not exists` / re-declared).

-- ---------------------------------------------------------------------------
-- 1) Retire the old write path before reshaping rows
--
-- A supplier's type has to change from `supplier` to `local_supplier`, and the
-- old trigger refuses any type or code change (22023). The trigger is
-- re-created at the end of this migration with the new vocabulary.
-- ---------------------------------------------------------------------------
drop trigger if exists parties_before_write on public.parties;
drop trigger if exists parties_set_updated_at on public.parties;
drop function if exists public.parties_before_write();

alter table public.parties
  drop constraint if exists parties_type_check;
alter table public.parties
  drop constraint if exists parties_code_matches_type;
alter table public.parties
  drop constraint if exists parties_internal_no_credit_terms;

-- ---------------------------------------------------------------------------
-- 2) Sister companies: a two-level tree in its own table
-- ---------------------------------------------------------------------------
create sequence if not exists public.sister_company_root_code_seq
  start with 1
  increment by 1
  minvalue 1
  no cycle;

-- Callers never advance sequences directly; the SECURITY DEFINER trigger below
-- is the sole consumer so API roles cannot burn codes with nextval().
revoke all on sequence public.sister_company_root_code_seq
  from public, anon, authenticated;

create table if not exists public.sister_companies (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid references public.sister_companies (id) on delete restrict,
  level integer not null,
  name text not null,
  code text not null unique,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sister_companies_name_not_blank check (
    char_length(btrim(name)) >= 1 and name ~ '\S'
  ),
  constraint sister_companies_level_check check (level between 1 and 2),
  constraint sister_companies_code_matches_level check (
    (parent_id is null and level = 1 and code ~ '^SIS-[0-9]{3,}$')
    or (
      parent_id is not null
      and level = 2
      and code ~ '^SIS-[0-9]{3,}-[0-9]{2,}$'
    )
  )
);

create index if not exists sister_companies_parent_id_idx
  on public.sister_companies (parent_id);

-- Carry the sister companies the directory already holds into the tree as
-- level-1 parents. The codes are preserved verbatim (they are already SIS-###),
-- so nothing on a printed report changes meaning. The insert runs before the
-- triggers exist, which is what allows an explicit code here.
insert into public.sister_companies
  (parent_id, level, name, code, is_active, created_at, updated_at)
select
  null,
  1,
  p.name,
  p.code,
  p.is_active,
  p.created_at,
  p.updated_at
from public.parties as p
where p.type = 'sister_company'
  and p.code ~ '^SIS-[0-9]{3,}$'
  and not exists (
    select 1 from public.sister_companies as s where s.code = p.code
  );

-- The root sequence must continue after the highest migrated SIS-###. It is
-- only aligned while it has never been used, so a replay cannot move it
-- backwards (or forwards) over codes already issued.
do $sync_sister_company_sequence$
declare
  v_is_called boolean;
  v_max bigint;
begin
  select is_called into v_is_called
    from public.sister_company_root_code_seq;

  if v_is_called then
    return;
  end if;

  select coalesce(
           max(substring(s.code from '^SIS-([0-9]{3,})$')::bigint),
           1
         )
    into v_max
    from public.sister_companies as s
   where s.parent_id is null
     and s.code ~ '^SIS-[0-9]{3,}$';

  if v_max > 1 then
    perform setval('public.sister_company_root_code_seq', v_max, true);
  end if;
end;
$sync_sister_company_sequence$;

-- ---------------------------------------------------------------------------
-- 3) Reshape `parties` data
-- ---------------------------------------------------------------------------

-- 3a) Sister companies now live in their own table; internal departments have
-- no successor in the new model (see the header).
delete from public.parties
 where type in ('sister_company', 'internal');

-- 3b) Suppliers become local suppliers and are re-keyed SUP-### -> LOC-### in
-- their original numeric order. The intermediate namespace is what makes this
-- safe in one pass: the table's UNIQUE(code) is checked per row, so writing
-- LOC-001 while a different row still holds it would fail — but a temporary
-- name cannot collide with anything, because the CHECK that would reject it
-- was dropped above and is only re-added at the end.
update public.parties
   set code = 'REKEYING-' || substring(code from 5)
 where type = 'supplier'
   and code ~ '^SUP-[0-9]{3,}$';

update public.parties
   set type = 'local_supplier',
       code = 'LOC-' || substring(code from 10)
 where code ~ '^REKEYING-[0-9]{3,}$';

-- 3c) Sequences: two new namespaces, one unchanged, three retired.
create sequence if not exists public.party_local_supplier_code_seq
  start with 1
  increment by 1
  minvalue 1
  no cycle;

create sequence if not exists public.party_foreign_supplier_code_seq
  start with 1
  increment by 1
  minvalue 1
  no cycle;

drop sequence if exists public.party_supplier_code_seq;
drop sequence if exists public.party_sister_company_code_seq;
drop sequence if exists public.party_internal_code_seq;

revoke all on sequence
  public.party_local_supplier_code_seq,
  public.party_foreign_supplier_code_seq,
  public.party_customer_code_seq
from public, anon, authenticated;

-- Align the local-supplier sequence with the rows just migrated, but only
-- while it has never issued a value: a replay must not rewind it.
do $sync_party_sequences$
declare
  v_is_called boolean;
  v_max bigint;
begin
  select is_called into v_is_called
    from public.party_local_supplier_code_seq;

  if not v_is_called then
    select coalesce(
             max(substring(p.code from '^LOC-([0-9]{3,})$')::bigint),
             1
           )
      into v_max
      from public.parties as p
     where p.type = 'local_supplier';

    if v_max > 1 then
      perform setval('public.party_local_supplier_code_seq', v_max, true);
    end if;
  end if;
end;
$sync_party_sequences$;

-- 3d) The new vocabulary, enforced.
alter table public.parties
  add constraint parties_type_check check (
    type in ('local_supplier', 'foreign_supplier', 'customer')
  );

alter table public.parties
  add constraint parties_code_matches_type check (
    (type = 'local_supplier' and code ~ '^LOC-[0-9]{3,}$')
    or (type = 'foreign_supplier' and code ~ '^FRN-[0-9]{3,}$')
    or (type = 'customer' and code ~ '^CUS-[0-9]{3,}$')
  );

-- Credit terms belong to a commercial relationship with another legal entity.
-- Every type the table can hold now is exactly that, so this CHECK is
-- redundant with `parties_type_check` today — on purpose. It names the rule,
-- so a later widening of the type set cannot silently inherit a credit limit.
alter table public.parties
  drop constraint if exists parties_credit_terms_external_only;
alter table public.parties
  add constraint parties_credit_terms_external_only check (
    (credit_limit is null and payment_terms is null)
    or type in ('local_supplier', 'foreign_supplier', 'customer')
  );

-- ---------------------------------------------------------------------------
-- 4) Parties write trigger: per-type code minting and write-once identity
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
      when 'local_supplier' then
        v_prefix := 'LOC-';
        v_next := nextval('public.party_local_supplier_code_seq');
      when 'foreign_supplier' then
        v_prefix := 'FRN-';
        v_next := nextval('public.party_foreign_supplier_code_seq');
      when 'customer' then
        v_prefix := 'CUS-';
        v_next := nextval('public.party_customer_code_seq');
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
-- 5) Sister companies write trigger: derived level and code, write-once tree
--
-- `level` and `code` are never taken from the client:
--   * a row with no parent is a parent company (level 1) and mints SIS-###;
--   * a row with a parent is a branch (level 2) and mints
--     `<parent code>-<ordinal>` (SIS-001-01), ordinal = highest sibling
--     ordinal + 1, so a deleted branch never hands its number to the next one;
--   * a third level is refused with 22023, matching
--     `sister_companies_level_check` — the tree is exactly two levels.
--
-- On UPDATE, changing `parent_id` or `code` is refused with 22023. Moving a
-- branch would silently move its code and its meaning on every report, so the
-- tree is written once and only the name and the active flag may move.
-- ---------------------------------------------------------------------------
create or replace function public.sister_companies_before_write()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_parent public.sister_companies%rowtype;
  v_root bigint;
  v_next integer;
begin
  if tg_op = 'INSERT' then
    if new.parent_id is not null and new.parent_id = new.id then
      raise exception 'sister_companies: a company cannot be its own parent'
        using errcode = '22023';
    end if;

    if new.parent_id is null then
      new.level := 1;
      v_root := nextval('public.sister_company_root_code_seq');
      new.code := 'SIS-' || case
        when v_root < 1000 then lpad(v_root::text, 3, '0')
        else v_root::text
      end;
    else
      select * into v_parent
        from public.sister_companies as s
       where s.id = new.parent_id;
      if not found then
        raise exception 'sister_companies: parent does not exist'
          using errcode = '23503';
      end if;
      if v_parent.level <> 1 then
        raise exception 'sister_companies: a branch cannot have branches'
          using errcode = '22023';
      end if;

      new.level := 2;

      select coalesce(
               max(
                 (regexp_match(sibling.code, '-([0-9]{2,})$'))[1]::integer
               ),
               0
             ) + 1
        into v_next
        from public.sister_companies as sibling
       where sibling.parent_id = new.parent_id;

      new.code := v_parent.code || '-' || case
        when v_next < 100 then lpad(v_next::text, 2, '0')
        else v_next::text
      end;
    end if;

    return new;
  end if;

  if tg_op = 'UPDATE' then
    if new.parent_id is distinct from old.parent_id then
      raise exception 'sister_companies: parent cannot be changed after creation'
        using errcode = '22023';
    end if;

    if new.code is distinct from old.code then
      raise exception 'sister_companies: code cannot be changed after creation'
        using errcode = '22023';
    end if;

    if new.level is distinct from old.level then
      raise exception 'sister_companies: level cannot be changed after creation'
        using errcode = '22023';
    end if;

    return new;
  end if;

  return new;
end;
$$;

revoke all on function public.sister_companies_before_write()
  from public, anon, authenticated, service_role;

drop trigger if exists sister_companies_before_write on public.sister_companies;
create trigger sister_companies_before_write
  before insert or update on public.sister_companies
  for each row execute function public.sister_companies_before_write();

drop trigger if exists sister_companies_set_updated_at on public.sister_companies;
create trigger sister_companies_set_updated_at
  before update on public.sister_companies
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 6) Row Level Security - project.settings:manage, exactly like parties
-- ---------------------------------------------------------------------------
alter table public.sister_companies enable row level security;
alter table public.sister_companies force row level security;

grant select, insert, update, delete on public.sister_companies to authenticated;

drop policy if exists sister_companies_project_settings_select on public.sister_companies;
create policy sister_companies_project_settings_select
  on public.sister_companies
  for select
  to authenticated
  using (public.can_manage_project_settings());

drop policy if exists sister_companies_project_settings_insert on public.sister_companies;
create policy sister_companies_project_settings_insert
  on public.sister_companies
  for insert
  to authenticated
  with check (public.can_manage_project_settings());

drop policy if exists sister_companies_project_settings_update on public.sister_companies;
create policy sister_companies_project_settings_update
  on public.sister_companies
  for update
  to authenticated
  using (public.can_manage_project_settings())
  with check (public.can_manage_project_settings());

drop policy if exists sister_companies_project_settings_delete on public.sister_companies;
create policy sister_companies_project_settings_delete
  on public.sister_companies
  for delete
  to authenticated
  using (public.can_manage_project_settings());

-- ---------------------------------------------------------------------------
-- 7) Preconditions
-- ---------------------------------------------------------------------------
do $verify_inbound_outbound_parties$
declare
  v_type_check text;
  v_types text[];
begin
  if not exists (
    select 1 from public.permissions where slug = 'project.settings:manage'
  ) then
    raise exception 'Project settings permission is missing';
  end if;

  if to_regprocedure('public.can_manage_project_settings()') is null then
    raise exception 'can_manage_project_settings() is missing';
  end if;

  if to_regprocedure('public.set_updated_at()') is null then
    raise exception 'set_updated_at() is missing';
  end if;

  select pg_get_constraintdef(oid) into v_type_check
    from pg_constraint
   where conrelid = 'public.parties'::regclass
     and conname = 'parties_type_check';

  if v_type_check is null then
    raise exception 'parties_type_check is missing';
  end if;
  if v_type_check like '%internal%' or v_type_check like '%sister_company%' then
    raise exception 'parties_type_check still mentions a retired type';
  end if;

  select array_agg(distinct p.type order by p.type) into v_types
    from public.parties as p;
  if v_types is not null
     and not (v_types <@ array['local_supplier', 'foreign_supplier', 'customer']) then
    raise exception 'parties holds a type outside the new vocabulary: %', v_types;
  end if;

  if to_regclass('public.sister_companies') is null then
    raise exception 'public.sister_companies is missing';
  end if;
end;
$verify_inbound_outbound_parties$;

notify pgrst, 'reload schema';
