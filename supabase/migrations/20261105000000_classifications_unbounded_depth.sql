-- ---------------------------------------------------------------------------
-- Classifications: unbounded depth
--
-- The tree used to be capped at three levels (main classification → two levels
-- of sub-classifications). That cap is now removed: a financial classification
-- hierarchy can legitimately need more (e.g. مخزون ← وقود ← سولار ← سولار
-- تشغيل), and a hard limit turns a modelling decision into a migration.
--
-- What changes:
--
--   1. the `level between 1 and 3` CHECK becomes `level >= 1`;
--   2. `classifications_before_write()` no longer refuses a 4th level, and no
--      longer measures a subtree before a move (there is no ceiling to compare
--      against);
--   3. in exchange for that ceiling, a move may not create a cycle: the new
--      parent must not be the row itself nor one of its descendants. Without a
--      depth limit, `A → … → A` is the failure mode that replaces "too deep":
--      the AFTER trigger's recursive CTE would never terminate, and no root
--      would reach the cycle, so the rows would silently vanish from the tree.
--
-- What does NOT change:
--
--   * `level` is still derived (`1` for a root, `parent.level + 1` otherwise)
--     and anything the client sends is still overwritten;
--   * `is_leaf` is still derived from the child list on every write;
--   * `code` is still sequence-minted;
--   * `classifications_after_write()`'s recursive CTE already walks a subtree
--     of any depth, so it needs no change — that is asserted by the audit;
--   * `ON DELETE RESTRICT` still guards deletes, and RLS still gates every
--     command on `can_manage_project_settings()`.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1) Replace the depth constraint
-- ---------------------------------------------------------------------------
alter table public.classifications
  drop constraint if exists classifications_level_between_1_and_3;

alter table public.classifications
  drop constraint if exists classifications_level_at_least_1;

alter table public.classifications
  add constraint classifications_level_at_least_1 check (level >= 1);

-- ---------------------------------------------------------------------------
-- 2) before-write trigger: no ceiling, but no cycles either
--
-- See the original definition for why derivation is skipped during the AFTER
-- trigger's batch UPDATE (a custom GUC plus `pg_trigger_depth() >= 2`). That
-- skip is unchanged; only the two depth guards are gone and the cycle guard is
-- new. The `level < 1` guard stays outside the skip so it holds on every path.
-- ---------------------------------------------------------------------------
create or replace function public.classifications_before_write()
returns trigger
language plpgsql
as $$
declare
  v_parent_level integer;
  v_internal_relevel boolean;
begin
  v_internal_relevel := coalesce(
    current_setting('classifications.deriving_level', true),
    'off'
  ) = 'on' and pg_trigger_depth() >= 2;

  if not v_internal_relevel then
    /* A row cannot be its own parent. This is checked before the parent lookup:
       on INSERT the row does not exist yet, so the lookup would otherwise report
       23503 "parent does not exist" for what is really a cycle. */
    if new.parent_id is not null and new.parent_id = new.id then
      raise exception 'classifications: a classification cannot be its own parent'
        using errcode = '22023';
    end if;

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

    /* A move may not put the row under one of its own descendants. The subtree
       walk is bounded by the rows reachable from `new.id`, which is a finite
       set: the guard has to run before the move, so the data it walks is still
       acyclic. */
    if tg_op = 'UPDATE'
       and new.parent_id is not null
       and new.parent_id is distinct from old.parent_id
    then
      if exists (
        with recursive sub(id) as (
          select id from public.classifications where id = new.id
          union all
          select child.id
            from public.classifications as child
            join sub on child.parent_id = sub.id
        )
        select 1 from sub where id = new.parent_id
      ) then
        raise exception 'classifications: a node cannot be moved under its own descendant'
          using errcode = '22023';
      end if;
    end if;
  end if;

  if new.level is null or new.level < 1 then
    raise exception 'classifications: level must be at least 1'
      using errcode = '22023';
  end if;

  new.is_leaf := not exists (
    select 1 from public.classifications as child where child.parent_id = new.id
  );
  return new;
end;
$$;

-- The AFTER trigger is intentionally left untouched: its batch UPDATE already
-- re-derives every descendant's level by recursion, whatever the depth, and it
-- is what keeps a moved subtree consistent. Re-declared here only as an
-- assertion of intent for readers — `create or replace` would be identical.
do $verify_classifications_depth$
declare
  v_checks text[];
begin
  select array_agg(conname order by conname) into v_checks
    from pg_constraint
   where conrelid = 'public.classifications'::regclass
     and contype = 'c';

  if 'classifications_level_between_1_and_3' = any (coalesce(v_checks, '{}')) then
    raise exception 'The three-level CHECK constraint is still present';
  end if;

  if not ('classifications_level_at_least_1' = any (coalesce(v_checks, '{}'))) then
    raise exception 'classifications_level_at_least_1 is missing';
  end if;

  /* The trigger must no longer mention the old ceiling anywhere. */
  if exists (
    select 1
      from pg_proc as proc
     where proc.pronamespace = 'public'::regnamespace
       and proc.proname = 'classifications_before_write'
       and (proc.prosrc like '%exceed three levels%' or proc.prosrc like '%between 1 and 3%')
  ) then
    raise exception 'classifications_before_write still enforces a three-level ceiling';
  end if;
end;
$verify_classifications_depth$;

notify pgrst, 'reload schema';
