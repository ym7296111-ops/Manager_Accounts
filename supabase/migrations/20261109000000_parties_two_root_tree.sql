-- Project Settings -> «جهات الوارد وأغراض الصرف», simplified to a two-root tree.
--
-- The directory built in 20261106000000 and reshaped in 20261108000000 carried
-- a commercial profile per counterparty: type, tax number, commercial register,
-- address, contact person, phone, email, credit limit and payment terms. The
-- architecture review retired that whole surface. The screen is now a tree with
-- exactly two roots — inbound («جهات الوارد») and outbound («أغراض الصرف») —
-- and one level of parties under each. A party is a name and a code, nothing
-- else; every other attribute belongs to a letter, where it actually has a
-- meaning.
--
-- What this migration does:
--
--   1. Replaces `parties.type` with `parties.branch` (`inbound` | `outbound`)
--      and drops the eight profile columns. The row keeps its id, name, code,
--      active flag and timestamps — nothing else.
--   2. Re-keys the rows that exist onto the two new code namespaces:
--
--        inbound  -> IN-001, IN-002, …
--        outbound -> OUT-001, OUT-002, …
--
--      Each branch has its own sequence, exactly like the retired per-type
--      ones. Rows are re-keyed inside their branch in (created_at, code) order
--      so a printed report keeps reading the same way it used to; nothing is
--      renumbered by hand.
--   3. Replaces the write trigger: the branch selects the sequence on INSERT,
--      `code` is never taken from the client, and changing `branch` or `code`
--      afterwards is refused with 22023.
--   4. Leaves `public.sister_companies` completely untouched: sister companies
--      remain their own two-level table, mounted by their own tab.
--
-- Deletion: `parties` has no child table yet. The letters phase will add
-- `letters.party_id uuid references public.parties (id) on delete restrict`,
-- which is what makes a party that a document refers to undeletable. Until that
-- table exists there is nothing to restrict, and the delete policy below stays
-- as it is; no cascade is ever declared from this side.
--
-- Forward-only and replay-safe: every destructive statement is guarded by a
-- predicate that matches nothing the second time, the re-key runs through a
-- staging namespace that cannot collide, and every object is created
-- `if not exists` / re-declared.

-- ---------------------------------------------------------------------------
-- 1) Retire the old write path and the old constraint family
-- ---------------------------------------------------------------------------
drop trigger if exists parties_before_write on public.parties;
drop trigger if exists parties_set_updated_at on public.parties;
drop function if exists public.parties_before_write();

alter table public.parties
  drop constraint if exists parties_type_check;
alter table public.parties
  drop constraint if exists parties_code_matches_type;
alter table public.parties
  drop constraint if exists parties_credit_terms_external_only;
alter table public.parties
  drop constraint if exists parties_email_check;
alter table public.parties
  drop constraint if exists parties_credit_limit_non_negative;
alter table public.parties
  drop constraint if exists parties_payment_terms_check;

-- ---------------------------------------------------------------------------
-- 2) `branch` replaces `type`, and the codes move to the two new namespaces
--
-- Everything here is guarded by the presence of the retired `type` column, so a
-- replay is a no-op: re-keying twice would renumber live rows, and a code that
-- moved once must never move again. The whole step also runs inside a PL/pgSQL
-- block, which keeps the `type` reference legal only while the column exists.
--
-- Rows are re-keyed inside their branch in the order the old screen showed
-- them (local suppliers, foreign suppliers, then customers; code order within
-- each), so a printed report keeps reading the way it used to. Nothing is
-- renumbered by hand.
-- ---------------------------------------------------------------------------
alter table public.parties
  add column if not exists branch text;

do $reshape_parties$
declare
  v_has_type boolean;
begin
  select exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'parties'
       and column_name = 'type'
  )
    into v_has_type;

  if not v_has_type then
    return;
  end if;

  -- Both supplier kinds are inbound counterparts; a customer is outbound.
  update public.parties
     set branch = case
       when type = 'customer' then 'outbound'
       else 'inbound'
     end
   where branch is null;

  -- UNIQUE(code) is checked per row, so the rewrite goes through a staging
  -- namespace first (`REKEYING-<uuid>` cannot collide with anything), then
  -- lands on the final codes in one statement.
  create temporary table parties_rekey on commit drop as
  select
    p.id,
    p.branch,
    row_number() over (
      partition by p.branch
      order by
        case p.type
          when 'local_supplier' then 0
          when 'foreign_supplier' then 1
          else 2
        end,
        p.code
    ) as ordinal
  from public.parties as p;

  update public.parties as p
     set code = 'REKEYING-' || p.id::text;

  update public.parties as p
     set code = case
       when r.branch = 'inbound' then 'IN-'
       else 'OUT-'
     end || case
       when r.ordinal < 1000 then lpad(r.ordinal::text, 3, '0')
       else r.ordinal::text
     end
    from parties_rekey as r
   where r.id = p.id;
end;
$reshape_parties$;

-- ---------------------------------------------------------------------------
-- 3) Drop the retired profile columns and make `branch` mandatory
-- ---------------------------------------------------------------------------
alter table public.parties
  drop column if exists type,
  drop column if exists tax_number,
  drop column if exists commercial_register,
  drop column if exists address,
  drop column if exists contact_person,
  drop column if exists phone,
  drop column if exists email,
  drop column if exists credit_limit,
  drop column if exists payment_terms;

alter table public.parties
  alter column branch set not null;

-- ---------------------------------------------------------------------------
-- 4) One sequence per branch
-- ---------------------------------------------------------------------------
create sequence if not exists public.party_inbound_code_seq
  start with 1
  increment by 1
  minvalue 1
  no cycle;

create sequence if not exists public.party_outbound_code_seq
  start with 1
  increment by 1
  minvalue 1
  no cycle;

-- The per-type sequences of the retired model are gone.
drop sequence if exists public.party_local_supplier_code_seq;
drop sequence if exists public.party_foreign_supplier_code_seq;
drop sequence if exists public.party_customer_code_seq;

-- Callers never advance sequences directly; the SECURITY DEFINER trigger below
-- is the sole consumer so API roles cannot burn codes with nextval().
revoke all on sequence
  public.party_inbound_code_seq,
  public.party_outbound_code_seq
from public, anon, authenticated;

-- Align each sequence with the rows just migrated, but only while it has never
-- issued a value: a replay must not rewind (or rewind past) live codes.
do $sync_party_sequences$
declare
  v_is_called boolean;
  v_max bigint;
begin
  select is_called into v_is_called from public.party_inbound_code_seq;
  if not v_is_called then
    select max(substring(p.code from '^IN-([0-9]{3,})$')::bigint)
      into v_max
      from public.parties as p
     where p.branch = 'inbound';
    if v_max is not null then
      perform setval('public.party_inbound_code_seq', v_max, true);
    end if;
  end if;

  select is_called into v_is_called from public.party_outbound_code_seq;
  if not v_is_called then
    select max(substring(p.code from '^OUT-([0-9]{3,})$')::bigint)
      into v_max
      from public.parties as p
     where p.branch = 'outbound';
    if v_max is not null then
      perform setval('public.party_outbound_code_seq', v_max, true);
    end if;
  end if;
end;
$sync_party_sequences$;

-- ---------------------------------------------------------------------------
-- 5) The new vocabulary, enforced
-- ---------------------------------------------------------------------------
alter table public.parties
  drop constraint if exists parties_branch_check;
alter table public.parties
  add constraint parties_branch_check check (branch in ('inbound', 'outbound'));

alter table public.parties
  drop constraint if exists parties_code_matches_branch;
alter table public.parties
  add constraint parties_code_matches_branch check (
    (branch = 'inbound' and code ~ '^IN-[0-9]{3,}$')
    or (branch = 'outbound' and code ~ '^OUT-[0-9]{3,}$')
  );

-- ---------------------------------------------------------------------------
-- 6) Write trigger: per-branch code minting, write-once branch and code
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
    if new.branch is null then
      -- Leave `new.code` unset so `branch NOT NULL` fires first with a standard
      -- 23502, without touching any sequence.
      return new;
    end if;

    case new.branch
      when 'inbound' then
        v_prefix := 'IN-';
        v_next := nextval('public.party_inbound_code_seq');
      when 'outbound' then
        v_prefix := 'OUT-';
        v_next := nextval('public.party_outbound_code_seq');
      else
        -- Fail before `code NOT NULL` could mask an invalid branch with 23502,
        -- and without advancing any sequence.
        raise exception 'parties: invalid branch'
          using errcode = '23514', constraint = 'parties_branch_check';
    end case;

    new.code := v_prefix || case
      when v_next < 1000 then lpad(v_next::text, 3, '0')
      else v_next::text
    end;

    return new;
  end if;

  if tg_op = 'UPDATE' then
    if new.branch is distinct from old.branch then
      raise exception 'parties: branch cannot be changed after creation'
        using errcode = '22023';
    end if;

    if new.code is distinct from old.code then
      raise exception 'parties: code cannot be changed after creation'
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
-- 7) Preconditions
-- ---------------------------------------------------------------------------
do $verify_two_root_parties$
declare
  v_columns text[];
  v_branch_check text;
  v_code_check text;
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

  select array_agg(column_name::text order by ordinal_position)
    into v_columns
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'parties';

  if v_columns is distinct from array[
    'id', 'name', 'code', 'is_active', 'created_at', 'updated_at', 'branch'
  ] then
    raise exception 'public.parties must hold exactly id, branch, name, code, is_active, created_at, updated_at (got %)',
      v_columns;
  end if;

  select pg_get_constraintdef(oid) into v_branch_check
    from pg_constraint
   where conrelid = 'public.parties'::regclass
     and conname = 'parties_branch_check';
  if v_branch_check is null
     or v_branch_check not like '%inbound%'
     or v_branch_check not like '%outbound%' then
    raise exception 'parties_branch_check is missing or does not name both branches';
  end if;

  select pg_get_constraintdef(oid) into v_code_check
    from pg_constraint
   where conrelid = 'public.parties'::regclass
     and conname = 'parties_code_matches_branch';
  if v_code_check is null
     or v_code_check not like '%IN-%'
     or v_code_check not like '%OUT-%' then
    raise exception 'parties_code_matches_branch is missing or does not name both prefixes';
  end if;

  if exists (
    select 1 from public.parties as p where p.branch not in ('inbound', 'outbound')
  ) then
    raise exception 'parties holds a branch outside the two-root vocabulary';
  end if;

  if exists (
    select 1
      from public.parties as p
     where (p.branch = 'inbound' and p.code !~ '^IN-[0-9]{3,}$')
        or (p.branch = 'outbound' and p.code !~ '^OUT-[0-9]{3,}$')
  ) then
    raise exception 'parties holds a code that does not match its branch';
  end if;

  if to_regclass('public.sister_companies') is null then
    raise exception 'public.sister_companies is missing';
  end if;
end;
$verify_two_root_parties$;

notify pgrst, 'reload schema';
