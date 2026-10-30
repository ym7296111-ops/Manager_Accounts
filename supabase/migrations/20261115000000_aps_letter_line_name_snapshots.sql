-- APS line-name snapshots: a read-only letter includes the warehouse and
-- classification names as they were when its draft line was last saved.
--
-- This forward-only migration is intentionally valid only for an EMPTY
-- letter_lines table. NOT NULL columns have no default and no backfill; if a
-- different environment already has lines, ALTER TABLE fails atomically rather
-- than silently inventing historical names. Existing deployments must resolve
-- that case explicitly before applying this migration.
--
-- The ordinary ALTER TABLE takes its PostgreSQL table lock; no triggers or RLS
-- policies are disabled. Apply the schema before deploying the new reader.

alter table public.letter_lines
  add column warehouse_name text not null,
  add column classification_name text not null;

comment on column public.letter_lines.warehouse_name is
  'Warehouse name captured by the line write guard when the draft was last saved.';
comment on column public.letter_lines.classification_name is
  'Classification name captured by the line write guard when the draft was last saved.';

-- Replace only the existing guard function. Its trigger, privileges, draft
-- immutability, pairing checks and RLS policies remain unchanged. Both direct
-- draft writes and reconciliation settlement inserts pass through this guard.
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
  -- The snapshots are assigned by the server, never trusted from the client.
  -- The SECURITY DEFINER context is the existing narrow line-write guard: it
  -- does not grant callers direct access to the protected reference tables.
  select classification.name
    into new.classification_name
    from public.classifications as classification
   where classification.id = new.classification_id
     and classification.is_leaf;
  if not found then
    raise exception 'aps letters: classification % is not a leaf', new.classification_id
      using errcode = '23514';
  end if;

  select warehouse.name
    into new.warehouse_name
    from public.warehouses as warehouse
   where warehouse.id = new.warehouse_id;
  if not found and new.warehouse_id is not null then
    raise exception 'aps letters: unknown warehouse %', new.warehouse_id using errcode = '23503';
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
