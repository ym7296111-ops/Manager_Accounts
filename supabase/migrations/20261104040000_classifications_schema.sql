-- Project Settings -> Classifications (Phase 1: schema only).
--
-- A single table in the Adjacency List pattern: every row knows its parent
-- (`parent_id`) and carries its depth in `level` (1 category, 2 group,
-- 3 item). The expected volume is a few dozen rows, so there is no
-- partitioning, no history/soft-delete table, no pagination and no performance
-- tuning — one plain table, a sequence-minted code, and an RLS gate.
--
-- Codes (CLS-001 …) are minted server-side from a sequence; the client never
-- supplies them and the UI must not send a `code` value.
--
-- `is_leaf` and `level` are both derived, never taken from the client. A row
-- is a leaf exactly when it has no children; a row's level is 1 for a root and
-- its parent's level + 1 otherwise. Triggers keep both in step: a new child
-- flips its parent to non-leaf, moving a row re-derives its whole subtree's
-- levels, and removing the last child flips the parent back to a leaf. Because
-- a level can only grow going down, a cycle would require it to repeat or fall.
--
-- Access is gated by the existing `project.settings:manage` capability through
-- public.can_manage_project_settings(), created in
-- 20261104020000_project_settings_access.sql. No UI ships with this migration.

-- ---------------------------------------------------------------------------
-- 1) Code sequence
-- ---------------------------------------------------------------------------
create sequence if not exists public.classification_code_seq
  start with 1
  increment by 1
  minvalue 1
  no cycle;

-- ---------------------------------------------------------------------------
-- 2) Code minting function
--
-- SECURITY DEFINER so the inserting role never needs USAGE on the sequence, and
-- so a caller cannot burn sequence values by calling nextval() directly.
--
-- Note on padding: lpad() TRUNCATES on the right when the input is already
-- wider than the requested width, so lpad('1000', 3, '0') yields '100' —
-- classification 1000 would silently mint 'CLS-100' and collide with the
-- unique index. Padding is applied only while the value fits in three digits;
-- beyond that the full digits are kept (CLS-1000).
-- ---------------------------------------------------------------------------
create or replace function public.next_classification_code()
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_next bigint := nextval('public.classification_code_seq');
begin
  return 'CLS-' || case
    when v_next < 1000 then lpad(v_next::text, 3, '0')
    else v_next::text
  end;
end;
$$;

revoke all on function public.next_classification_code() from public, anon;
grant execute on function public.next_classification_code() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3) Table
-- ---------------------------------------------------------------------------
create table if not exists public.classifications (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid references public.classifications (id) on delete restrict,
  name text not null,
  code text not null unique default public.next_classification_code(),
  level integer not null,
  is_leaf boolean not null default true,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint classifications_name_not_blank check (char_length(btrim(name)) >= 1),
  constraint classifications_level_between_1_and_3 check (level between 1 and 3)
);

-- Postgres does not index foreign keys implicitly. The only read path the UI
-- will have is "children of X", so the index avoids a seq scan over the tiny
-- table; it costs nothing.
create index if not exists classifications_parent_id_idx on public.classifications (parent_id);

-- ---------------------------------------------------------------------------
-- 4) updated_at trigger (reuses the shared helper from the core schema)
-- ---------------------------------------------------------------------------
drop trigger if exists classifications_set_updated_at on public.classifications;
create trigger classifications_set_updated_at
  before update on public.classifications
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 5) Triggers: derived level + derived is_leaf
--
-- `level` and `is_leaf` are both derived from the tree structure and never
-- taken from the client. Deriving `level` from `parent_id` is what keeps the
-- hierarchy sound under "move node": a re-parented row takes its level from its
-- new parent, and the AFTER trigger walks its subtree so every descendant
-- follows.
-- ---------------------------------------------------------------------------

-- A client never supplies `level`; the server derives it (roots are level 1,
-- a child is its parent's level + 1) and overwrites anything the client sends.
-- A move may not push any descendant past level 3, so the deepest descendant is
-- measured before the move is allowed.
--
-- `classifications.deriving_level` lets the AFTER trigger's batch subtree
-- re-derivation supply the level itself; it is set for exactly that one
-- statement and is never visible to a client.
create or replace function public.classifications_before_write()
returns trigger
language plpgsql
as $$
declare
  v_parent_level integer;
  v_subtree_depth integer;
begin
  if coalesce(current_setting('classifications.deriving_level', true), 'off') <> 'on' then
    if new.parent_id is null then
      new.level := 1;
    else
      select c.level into v_parent_level
        from public.classifications as c
       where c.id = new.parent_id;
      if not found then
        raise exception 'classifications: parent does not exist'
          using errcode = '23503';
      end if;
      new.level := v_parent_level + 1;
    end if;

    -- A move must keep the whole subtree within the three allowed levels.
    if tg_op = 'UPDATE' and new.parent_id is distinct from old.parent_id then
      select coalesce(max(d), 0) into v_subtree_depth
        from (
          with recursive sub(id, d) as (
            select id, 0 from public.classifications where id = new.id
            union all
            select child.id, sub.d + 1
              from public.classifications as child
              join sub on child.parent_id = sub.id
          )
          select d from sub
        ) depths;
      if new.level + v_subtree_depth > 3 then
        raise exception 'classifications: move would exceed three levels'
          using errcode = '22023';
      end if;
    end if;

    if new.level > 3 then
      raise exception 'classifications: maximum depth is three levels'
        using errcode = '22023';
    end if;
  end if;

  new.is_leaf := not exists (
    select 1 from public.classifications as child where child.parent_id = new.id
  );
  return new;
end;
$$;

-- AFTER: a re-parented row shifts its whole subtree, so re-derive the levels
-- from the row's new level; and the parents that gained or lost a child may
-- have flipped leaf status.
create or replace function public.classifications_after_write()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' and old.parent_id is distinct from new.parent_id then
    perform set_config('classifications.deriving_level', 'on', true);
    update public.classifications as node
       set level = sub.lvl
      from (
        with recursive sub(id, lvl) as (
          select id, new.level
            from public.classifications
           where id = new.id
          union all
          select child.id, sub.lvl + 1
            from public.classifications as child
            join sub on child.parent_id = sub.id
        )
        select id, lvl from sub
      ) as sub
     where node.id = sub.id;
    perform set_config('classifications.deriving_level', 'off', true);
  end if;

  if old.parent_id is not null then
    update public.classifications as parent
       set is_leaf = not exists (
             select 1 from public.classifications as child
              where child.parent_id = parent.id
           )
      where parent.id = old.parent_id;
  end if;
  if new is not null and new.parent_id is not null then
    update public.classifications as parent
       set is_leaf = not exists (
             select 1 from public.classifications as child
              where child.parent_id = parent.id
           )
      where parent.id = new.parent_id;
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists classifications_validate on public.classifications;
create trigger classifications_validate
  before insert or update on public.classifications
  for each row execute function public.classifications_before_write();

drop trigger if exists classifications_maintain_leaf on public.classifications;
create trigger classifications_maintain_leaf
  after insert or update or delete on public.classifications
  for each row execute function public.classifications_after_write();

-- ---------------------------------------------------------------------------
-- 6) Row Level Security - read and write require project.settings:manage
-- ---------------------------------------------------------------------------
alter table public.classifications enable row level security;
alter table public.classifications force row level security;

-- Table privileges must be granted explicitly (see the note in the stations
-- migration). `anon` is deliberately granted nothing.
grant select, insert, update, delete on public.classifications to authenticated;

drop policy if exists classifications_project_settings_select on public.classifications;
create policy classifications_project_settings_select
  on public.classifications
  for select
  to authenticated
  using (public.can_manage_project_settings());

drop policy if exists classifications_project_settings_insert on public.classifications;
create policy classifications_project_settings_insert
  on public.classifications
  for insert
  to authenticated
  with check (public.can_manage_project_settings());

drop policy if exists classifications_project_settings_update on public.classifications;
create policy classifications_project_settings_update
  on public.classifications
  for update
  to authenticated
  using (public.can_manage_project_settings())
  with check (public.can_manage_project_settings());

drop policy if exists classifications_project_settings_delete on public.classifications;
create policy classifications_project_settings_delete
  on public.classifications
  for delete
  to authenticated
  using (public.can_manage_project_settings());

-- ---------------------------------------------------------------------------
-- 7) Preconditions
-- ---------------------------------------------------------------------------
do $verify_classifications_schema$
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
$verify_classifications_schema$;

notify pgrst, 'reload schema';
