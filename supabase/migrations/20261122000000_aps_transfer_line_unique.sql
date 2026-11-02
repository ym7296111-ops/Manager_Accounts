-- A.4 follow-up: one transfer line per (direction, warehouse, classification).
--
-- PR #46 made internal transfers free lines, but the screen and the database
-- still accepted the same source/destination triple twice. The product decision
-- is that a repeated triple on the same side is one line typed twice: the client
-- paints both rows red and refuses the save, and the server enforces the same
-- rule for every writer (RPC, direct draft insert, or a future client).
--
-- This is a guard in the existing SECURITY DEFINER line trigger, not a unique
-- index over all letter_lines: approved history may already contain repeats,
-- and inbound/outbound letters have their own (party, warehouse, classification)
-- rule. The named P0001 token is what the entry screen translates; 23505 stays
-- reserved for "letter number already used".

create or replace function public.aps_letter_lines_before_write()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_letter record;
  v_party record;
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

  if v_letter.letter_type in ('inbound', 'outbound') then
    if new.party_id is null then
      raise exception 'aps letters: a % line needs a party', v_letter.letter_type
        using errcode = '23514';
    end if;
    select party.branch, party.code, party.name
      into v_party
      from public.parties as party
     where party.id = new.party_id;
    if not found then
      raise exception 'aps letters: unknown party %', new.party_id using errcode = '23503';
    end if;
    if v_party.branch <> v_letter.letter_type then
      raise exception 'aps letters: a % line needs a % party, % is %',
        v_letter.letter_type, v_letter.letter_type, v_party.code, v_party.branch
        using errcode = '23514';
    end if;
    new.party_code := v_party.code;
    new.party_name := v_party.name;

    if exists (
      select 1 from public.letter_lines as other
       where other.letter_id = new.letter_id
         and other.id <> new.id
         and other.party_id = new.party_id
         and other.warehouse_id is not distinct from new.warehouse_id
         and other.classification_id = new.classification_id
    ) then
      raise exception 'aps_entry_duplicate_party_line' using errcode = 'P0001';
    end if;
  else
    if new.party_id is not null then
      raise exception 'aps letters: a % line carries no party', v_letter.letter_type
        using errcode = '23514';
    end if;
    new.party_code := null;
    new.party_name := null;

    -- An internal transfer is two independent sets of free lines. Within one
    -- side, (direction, warehouse, classification) is unique; the opposite side
    -- may name the same warehouse and classification. External transfers keep
    -- their existing one-direction rules and are not given a new uniqueness rule.
    if v_letter.letter_type = 'internal_transfer' then
      if new.direction not in ('in', 'out') then
        raise exception 'aps letters: a transfer line needs direction in or out'
          using errcode = '23514';
      end if;
      if exists (
        select 1 from public.letter_lines as other
         where other.letter_id = new.letter_id
           and other.id <> new.id
           and other.direction = new.direction
           and other.warehouse_id is not distinct from new.warehouse_id
           and other.classification_id = new.classification_id
      ) then
        raise exception 'aps_entry_duplicate_transfer_line' using errcode = 'P0001';
      end if;
    end if;
  end if;

  if new.line_number is null then
    select coalesce(max(line.line_number), 0) + 1
      into new.line_number
      from public.letter_lines as line
     where line.letter_id = new.letter_id;
  end if;

  return new;
end;
$$;

revoke all on function public.aps_letter_lines_before_write()
  from public, anon, authenticated, service_role;

-- Self-check: the replacement must carry the named transfer duplicate token.
do $$
begin
  if position('aps_entry_duplicate_transfer_line' in pg_get_functiondef('public.aps_letter_lines_before_write()'::regprocedure)) = 0 then
    raise exception 'aps transfer line unique: the line guard was not replaced as expected';
  end if;
end;
$$;
