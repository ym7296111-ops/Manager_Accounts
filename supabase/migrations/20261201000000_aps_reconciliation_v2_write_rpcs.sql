-- All v2 writes and source invalidations use the same transaction lock. In
-- particular a concurrent letter approval/cancellation cannot silently race
-- with close: either close sees it, or its trigger marks the closed snapshot.
create function public.aps_reconciliation_v2_lock()
returns void language sql volatile security definer set search_path = pg_catalog, public
as $$ select pg_advisory_xact_lock(hashtextextended('aps.reconciliation.v2', 0)) $$;
revoke all on function public.aps_reconciliation_v2_lock() from public, anon, authenticated, service_role;

create function public.aps_set_reconciliation_settings_v2(p_classifications uuid[])
returns uuid language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_actor uuid := auth.uid(); v_revision uuid; v_n integer;
begin
  if v_actor is null or not coalesce(public.is_active_user(), false)
     or not coalesce(public.has_permission('aps.reconciliation:settings'), false) then
    raise exception 'reconciliation settings permission required' using errcode = '42501';
  end if;
  perform public.aps_reconciliation_v2_lock();
  -- Freeze hierarchy and names for the entire validation/snapshot transaction.
  lock table public.classifications in share mode;
  if p_classifications is null or array_position(p_classifications, null) is not null
     or cardinality(p_classifications) = 0
     or cardinality(p_classifications) <> (select count(distinct x.id) from unnest(p_classifications) as x(id))
     or exists (select 1 from unnest(p_classifications) as x(id)
       left join public.classifications c on c.id = x.id where c.id is null or not c.is_active) then
    raise exception 'invalid or empty reconciliation classifications' using errcode = '22023';
  end if;
  insert into public.aps_reconciliation_settings_revisions(created_by) values (v_actor) returning id into v_revision;
  insert into public.aps_reconciliation_settings(revision_id, classification_id, classification_name)
    select v_revision, c.id, c.name from public.classifications c where c.id = any(p_classifications);
  -- Walk all descendants, including inactive historical leaves: their existing
  -- openings and approved movements still belong to the selected branch. The
  -- unique leaf constraint rejects overlapping roots rather than double-counting them.
  begin
    insert into public.aps_reconciliation_settings_members(revision_id, classification_id, leaf_id)
    with recursive tree(root, id) as (
      select x.id, x.id from unnest(p_classifications) as x(id)
      union all
      select t.root, c.id from tree t join public.classifications c on c.parent_id = t.id
    )
    select v_revision, t.root, c.id from tree t join public.classifications c on c.id = t.id
     where c.is_leaf;
  exception when unique_violation then
    raise exception 'overlapping reconciliation classifications' using errcode = '22023';
  end;
  select count(*) into v_n from public.aps_reconciliation_settings s
  where s.revision_id = v_revision and not exists (
    select 1 from public.aps_reconciliation_settings_members m
     where m.revision_id = s.revision_id and m.classification_id = s.classification_id
  );
  if v_n > 0 then raise exception 'classification has no leaves' using errcode = '22023'; end if;
  insert into public.aps_reconciliation_settings_current(singleton, revision_id) values (true, v_revision)
    on conflict (singleton) do update set revision_id = excluded.revision_id;
  insert into public.audit_logs(actor_id, action, entity, entity_id, metadata)
  values (v_actor, 'aps.reconciliation_settings_changed'::public.audit_action,
    'aps_reconciliation_settings_revisions', v_revision::text,
    jsonb_build_object('classifications', p_classifications));
  return v_revision;
end $$;
revoke all on function public.aps_set_reconciliation_settings_v2(uuid[]) from public, anon, authenticated, service_role;
grant execute on function public.aps_set_reconciliation_settings_v2(uuid[]) to authenticated;

-- Prevent v1 write entry points from changing a v2 record or creating an
-- incompatible v1 session for a month already being reconciled in v2.
create function public.aps_reconciliation_v2_compat_guard()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if tg_table_name = 'aps_reconciliation_sessions' then
    if tg_op = 'UPDATE' and old.flow_type = 'screen_v2' and new.status not in ('open','closed') then
      raise exception 'legacy status transition is forbidden for a v2 session' using errcode = '22023';
    end if;
    if new.flow_type = 'screen' and (tg_op = 'INSERT' or (new.status = 'open' and old.status <> 'open')) then
      perform public.aps_reconciliation_v2_lock();
      if exists (select 1 from public.aps_reconciliation_sessions s
          where s.fiscal_month_id = new.fiscal_month_id and s.flow_type = 'screen_v2'
            and s.status in ('open','closed')) then
        raise exception 'month uses reconciliation v2' using errcode = '22023';
      end if;
    end if;
  else
    if exists (select 1 from public.aps_reconciliation_sessions s
       where s.id = coalesce(new.session_id, old.session_id) and s.flow_type = 'screen_v2') then
      raise exception 'v1 amount cannot be written to a v2 session' using errcode = '22023';
    end if;
  end if;
  return new;
end $$;
revoke all on function public.aps_reconciliation_v2_compat_guard() from public, anon, authenticated, service_role;
create trigger aps_reconciliation_v2_session_compat_guard before insert or update of status on public.aps_reconciliation_sessions
  for each row execute function public.aps_reconciliation_v2_compat_guard();
create trigger aps_reconciliation_v2_line_compat_guard before update of book_amount, accountant_amount on public.aps_reconciliation_lines
  for each row execute function public.aps_reconciliation_v2_compat_guard();
create trigger aps_reconciliation_v2_item_compat_guard before insert or update on public.aps_reconciliation_items
  for each row execute function public.aps_reconciliation_v2_compat_guard();

-- The legacy refresher would otherwise accept a stationless v2 session and
-- report success while doing nothing. Preserve its old contract for old rows.
alter function public.aps_refresh_reconciliation(uuid) rename to aps_refresh_legacy_reconciliation_v2_internal;
revoke all on function public.aps_refresh_legacy_reconciliation_v2_internal(uuid) from public, anon, authenticated, service_role;
create function public.aps_refresh_reconciliation(p_session_id uuid)
returns integer language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if exists (select 1 from public.aps_reconciliation_sessions where id=p_session_id and flow_type='screen_v2') then
    raise exception 'legacy refresh cannot be used for a v2 session' using errcode='22023';
  end if;
  return public.aps_refresh_legacy_reconciliation_v2_internal(p_session_id);
end $$;
revoke all on function public.aps_refresh_reconciliation(uuid) from public, anon;
grant execute on function public.aps_refresh_reconciliation(uuid) to authenticated, service_role;

-- Resolve the configured roots again at session creation, not merely when the
-- administrator last saved settings. Later hierarchy edits cannot reinterpret
-- this session. The current configuration pointer is deliberately unchanged.
create function public.aps_reconciliation_v2_capture_settings(p_actor uuid)
returns uuid language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_config uuid; v_revision uuid;
begin
  lock table public.classifications in share mode;
  select revision_id into v_config from public.aps_reconciliation_settings_current where singleton;
  if v_config is null then raise exception 'reconciliation settings are empty' using errcode = '22023'; end if;
  insert into public.aps_reconciliation_settings_revisions(created_by) values (p_actor) returning id into v_revision;
  insert into public.aps_reconciliation_settings(revision_id, classification_id, classification_name)
    select v_revision, c.id, c.name from public.aps_reconciliation_settings cfg
      join public.classifications c on c.id = cfg.classification_id where cfg.revision_id = v_config;
  if not found then raise exception 'reconciliation settings are empty' using errcode = '22023'; end if;
  begin
    insert into public.aps_reconciliation_settings_members(revision_id, classification_id, leaf_id)
    with recursive tree(root, id) as (
      select cfg.classification_id, cfg.classification_id from public.aps_reconciliation_settings cfg
        where cfg.revision_id = v_revision
      union all
      select t.root, c.id from tree t join public.classifications c on c.parent_id = t.id
    )
    select v_revision, t.root, c.id from tree t join public.classifications c on c.id = t.id where c.is_leaf;
  exception when unique_violation then
    raise exception 'configured classifications now overlap; update reconciliation settings' using errcode = '22023';
  end;
  if exists (select 1 from public.aps_reconciliation_settings s where s.revision_id = v_revision
      and not exists (select 1 from public.aps_reconciliation_settings_members m
        where m.revision_id = v_revision and m.classification_id = s.classification_id)) then
    raise exception 'configured classification has no leaves' using errcode = '22023';
  end if;
  return v_revision;
end $$;
revoke all on function public.aps_reconciliation_v2_capture_settings(uuid) from public, anon, authenticated, service_role;

-- Internal helper: freeze the system values for the selected revision and financial-year window. All approved letter types are included by line
-- direction, including transfers and settlements. Caller holds the v2 lock.
create function public.aps_reconciliation_v2_snapshot(p_session_id uuid)
returns void language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_session record;
begin
  select s.*, m.start_date as month_start, m.end_date as month_end, y.start_date as year_start
    into v_session from public.aps_reconciliation_sessions s
    join public.fiscal_months m on m.id = s.fiscal_month_id
    join public.fiscal_years y on y.id = s.fiscal_year_id
    where s.id = p_session_id and s.flow_type = 'screen_v2' and s.status = 'open' for update of s;
  if not found then raise exception 'open v2 session not found' using errcode = 'P0002'; end if;
  update public.aps_reconciliation_lines l set
    book_year_opening = (
      select sum(b.amount) from public.opening_balances b
      join public.aps_reconciliation_settings_members m on m.leaf_id = b.classification_id
       and m.revision_id = v_session.settings_revision_id and m.classification_id = l.classification_id
      where b.fiscal_year_id = v_session.fiscal_year_id),
    book_inbound = coalesce((
      select sum(ll.amount) from public.letter_lines ll
      join public.letters h on h.id = ll.letter_id
      join public.aps_reconciliation_settings_members m on m.leaf_id = ll.classification_id
       and m.revision_id = v_session.settings_revision_id and m.classification_id = l.classification_id
      where h.fiscal_year_id = v_session.fiscal_year_id
        and h.status = 'approved' and ll.direction = 'in'
        and h.letter_date between v_session.month_start and v_session.month_end), 0),
    book_outbound = coalesce((
      select sum(ll.amount) from public.letter_lines ll
      join public.letters h on h.id = ll.letter_id
      join public.aps_reconciliation_settings_members m on m.leaf_id = ll.classification_id
       and m.revision_id = v_session.settings_revision_id and m.classification_id = l.classification_id
      where h.fiscal_year_id = v_session.fiscal_year_id
        and h.status = 'approved' and ll.direction = 'out'
        and h.letter_date between v_session.month_start and v_session.month_end), 0),
    book_ytd_inbound = coalesce((
      select sum(ll.amount) from public.letter_lines ll
      join public.letters h on h.id = ll.letter_id
      join public.aps_reconciliation_settings_members m on m.leaf_id = ll.classification_id
       and m.revision_id = v_session.settings_revision_id and m.classification_id = l.classification_id
      where h.fiscal_year_id = v_session.fiscal_year_id
        and h.status = 'approved' and ll.direction = 'in'
        and h.letter_date between v_session.year_start and v_session.month_end), 0),
    book_ytd_outbound = coalesce((
      select sum(ll.amount) from public.letter_lines ll
      join public.letters h on h.id = ll.letter_id
      join public.aps_reconciliation_settings_members m on m.leaf_id = ll.classification_id
       and m.revision_id = v_session.settings_revision_id and m.classification_id = l.classification_id
      where h.fiscal_year_id = v_session.fiscal_year_id
        and h.status = 'approved' and ll.direction = 'out'
        and h.letter_date between v_session.year_start and v_session.month_end), 0),
    v2_version = l.v2_version + 1
  where l.session_id = p_session_id;
  update public.aps_reconciliation_sessions set needs_review = false, review_reason = null,
    review_required_at = null, snapshot_version = snapshot_version + 1 where id = p_session_id;
end $$;
revoke all on function public.aps_reconciliation_v2_snapshot(uuid) from public, anon, authenticated, service_role;

create function public.aps_open_reconciliation_v2(p_month_id uuid)
returns uuid language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_actor uuid := auth.uid(); v_month record; v_revision uuid; v_session uuid;
begin
  if v_actor is null or not coalesce(public.aps_can_manage_reconciliation(), false) then
    raise exception 'reconciliation manage permission required' using errcode = '42501'; end if;
  perform public.aps_reconciliation_v2_lock();
  select * into v_month from public.fiscal_months where id = p_month_id;
  if not found then raise exception 'unknown month' using errcode = 'P0002'; end if;
  if exists(select 1 from public.aps_reconciliation_sessions where fiscal_month_id = p_month_id
     and status = 'open' and flow_type = 'screen') then
    raise exception 'close existing v1 screen sessions first' using errcode = '22023'; end if;
  if exists(select 1 from public.aps_reconciliation_sessions where fiscal_month_id = p_month_id
     and status in ('open','closed') and flow_type = 'screen_v2') then
    raise exception 'v2 session already exists; reopen it instead' using errcode = '22023'; end if;
  v_revision := public.aps_reconciliation_v2_capture_settings(v_actor);
  insert into public.aps_reconciliation_sessions(fiscal_year_id, fiscal_month_id, station_id, sequence_number,
    status, opened_by, created_by, flow_type, settings_revision_id)
    values (v_month.fiscal_year_id, p_month_id, null, 1, 'open', v_actor, v_actor, 'screen_v2', v_revision)
    returning id into v_session;
  insert into public.aps_reconciliation_lines(session_id, classification_id)
    select v_session, classification_id from public.aps_reconciliation_settings where revision_id = v_revision;
  if not found then raise exception 'reconciliation settings are empty' using errcode = '22023'; end if;
  perform public.aps_reconciliation_v2_snapshot(v_session);
  insert into public.audit_logs(actor_id, action, entity, entity_id, metadata)
    values (v_actor, 'aps.reconciliation_opened'::public.audit_action, 'aps_reconciliation_sessions', v_session::text,
      jsonb_build_object('fiscal_month_id', p_month_id, 'settings_revision_id', v_revision, 'version', 2));
  return v_session;
end $$;
revoke all on function public.aps_open_reconciliation_v2(uuid) from public, anon, authenticated, service_role;
grant execute on function public.aps_open_reconciliation_v2(uuid) to authenticated;

create function public.aps_refresh_reconciliation_v2(p_session_id uuid)
returns void language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if auth.uid() is null or not coalesce(public.aps_can_manage_reconciliation(), false) then
    raise exception 'reconciliation manage permission required' using errcode = '42501'; end if;
  perform public.aps_reconciliation_v2_lock();
  perform public.aps_reconciliation_v2_snapshot(p_session_id);
  insert into public.audit_logs(actor_id, action, entity, entity_id, metadata)
    values (auth.uid(), 'aps.reconciliation_v2_refreshed'::public.audit_action, 'aps_reconciliation_sessions', p_session_id::text,
      jsonb_build_object('version', 2));
end $$;
revoke all on function public.aps_refresh_reconciliation_v2(uuid) from public, anon, authenticated, service_role;
grant execute on function public.aps_refresh_reconciliation_v2(uuid) to authenticated;

create function public.aps_record_reconciliation_v2(p_session_id uuid, p_classification_id uuid,
  p_accountant_inbound numeric, p_accountant_outbound numeric, p_accountant_ytd_inbound numeric,
  p_accountant_ytd_outbound numeric, p_accountant_year_opening numeric, p_expected_version bigint)
returns void language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_actor uuid := auth.uid(); v_session record; v_line record; v_amount numeric;
begin
  if v_actor is null or not coalesce(public.aps_can_manage_reconciliation(), false) then
    raise exception 'reconciliation manage permission required' using errcode = '42501'; end if;
  foreach v_amount in array array[p_accountant_inbound, p_accountant_outbound, p_accountant_ytd_inbound, p_accountant_ytd_outbound] loop
    if v_amount is null or v_amount < 0 or v_amount in ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric)
       or scale(v_amount) > 2 or v_amount > 9999999999999999.99 then
      raise exception 'invalid accountant amount' using errcode = '22023'; end if;
  end loop;
  if p_accountant_year_opening is not null and (p_accountant_year_opening < 0
     or p_accountant_year_opening in ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric)
     or scale(p_accountant_year_opening) > 2 or p_accountant_year_opening > 9999999999999999.99) then
    raise exception 'invalid optional accountant opening' using errcode = '22023'; end if;
  perform public.aps_reconciliation_v2_lock();
  select * into v_session from public.aps_reconciliation_sessions where id = p_session_id for update;
  if not found then raise exception 'session not found' using errcode = 'P0002'; end if;
  if v_session.flow_type <> 'screen_v2' or v_session.status <> 'open' or v_session.needs_review then
    raise exception 'session is not editable or needs refresh' using errcode = '22023'; end if;
  select * into v_line from public.aps_reconciliation_lines
    where session_id = p_session_id and classification_id = p_classification_id for update;
  if not found then raise exception 'classification not in session' using errcode = 'P0002'; end if;
  if p_expected_version is null or p_expected_version <> v_line.v2_version then
    raise exception 'line changed concurrently' using errcode = '40001'; end if;
  update public.aps_reconciliation_lines set
    accountant_inbound = p_accountant_inbound, accountant_outbound = p_accountant_outbound,
    accountant_ytd_inbound = p_accountant_ytd_inbound, accountant_ytd_outbound = p_accountant_ytd_outbound,
    accountant_year_opening = p_accountant_year_opening, v2_version = v2_version + 1,
    v2_recorded_by = v_actor, v2_recorded_at = now()
  where id = v_line.id;
  update public.aps_reconciliation_sessions set snapshot_version = snapshot_version + 1 where id = p_session_id;
  insert into public.audit_logs(actor_id, action, entity, entity_id, metadata)
    values (v_actor, 'aps.reconciliation_v2_recorded'::public.audit_action, 'aps_reconciliation_lines', v_line.id::text,
      jsonb_build_object('session_id', p_session_id, 'classification_id', p_classification_id,
        'accountant_inbound', p_accountant_inbound::text, 'accountant_outbound', p_accountant_outbound::text,
        'accountant_ytd_inbound', p_accountant_ytd_inbound::text, 'accountant_ytd_outbound', p_accountant_ytd_outbound::text,
        'accountant_year_opening', p_accountant_year_opening::text));
end $$;
revoke all on function public.aps_record_reconciliation_v2(uuid,uuid,numeric,numeric,numeric,numeric,numeric,bigint) from public, anon, authenticated, service_role;
grant execute on function public.aps_record_reconciliation_v2(uuid,uuid,numeric,numeric,numeric,numeric,numeric,bigint) to authenticated;

-- The same predicate is used by both the read model and the close RPC. Never
-- add signed differences across lines, metrics or stations: offsets can hide errors.
create function public.aps_reconciliation_v2_close_reason(p_month_id uuid)
returns text language plpgsql stable security definer set search_path = pg_catalog, public as $$
begin
  if not exists(select 1 from public.aps_reconciliation_sessions s where s.fiscal_month_id = p_month_id
    and s.status = 'open' and s.flow_type = 'screen_v2') then return 'no_eligible_open_sessions'; end if;
  if exists(select 1 from public.aps_reconciliation_sessions s where s.fiscal_month_id = p_month_id
    and s.status = 'open' and s.flow_type = 'screen') then return 'other_open_sessions'; end if;
  if exists(select 1 from public.aps_reconciliation_sessions s where s.fiscal_month_id = p_month_id
    and s.status = 'open' and s.flow_type = 'screen_v2' and s.needs_review) then return 'needs_review'; end if;
  if exists(select 1 from public.aps_reconciliation_sessions s where s.fiscal_month_id = p_month_id
    and s.status = 'open' and s.flow_type = 'screen_v2'
    and not exists(select 1 from public.aps_reconciliation_lines l where l.session_id = s.id)) then return 'incomplete'; end if;
  if exists(select 1 from public.aps_reconciliation_sessions s join public.aps_reconciliation_lines l on l.session_id = s.id
    where s.fiscal_month_id = p_month_id and s.status = 'open' and s.flow_type = 'screen_v2' and l.book_year_opening is null) then return 'missing_system_opening'; end if;
  if exists(select 1 from public.aps_reconciliation_sessions s join public.aps_reconciliation_lines l on l.session_id = s.id
    where s.fiscal_month_id = p_month_id and s.status = 'open' and s.flow_type = 'screen_v2'
      and (l.book_inbound is null or l.book_outbound is null or l.book_year_opening is null
        or l.book_ytd_inbound is null or l.book_ytd_outbound is null
        or l.accountant_inbound is null or l.accountant_outbound is null
        or l.accountant_ytd_inbound is null or l.accountant_ytd_outbound is null)) then return 'incomplete'; end if;
  if exists(select 1 from public.aps_reconciliation_sessions s join public.aps_reconciliation_lines l on l.session_id = s.id
    where s.fiscal_month_id = p_month_id and s.status = 'open' and s.flow_type = 'screen_v2' and (
      l.book_inbound <> l.accountant_inbound or l.book_outbound <> l.accountant_outbound
      or l.book_inbound - l.book_outbound <> l.accountant_inbound - l.accountant_outbound
      or l.book_ytd_inbound <> l.accountant_ytd_inbound or l.book_ytd_outbound <> l.accountant_ytd_outbound
      or l.book_year_opening + l.book_ytd_inbound - l.book_ytd_outbound <>
         coalesce(l.accountant_year_opening, l.book_year_opening) + l.accountant_ytd_inbound - l.accountant_ytd_outbound
    )) then return 'nonzero_differences'; end if;
  return null;
end $$;
revoke all on function public.aps_reconciliation_v2_close_reason(uuid) from public, anon, authenticated, service_role;

create function public.aps_close_reconciliation_month_v2(p_month_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_actor uuid := auth.uid(); v_reason text := btrim(coalesce(p_reason,'')); v_block text;
begin
  if v_actor is null or not coalesce(public.is_active_user(), false)
     or not coalesce(public.has_permission('aps.reconciliation:close_month'), false) then
    raise exception 'reconciliation close permission required' using errcode = '42501'; end if;
  if char_length(v_reason) < 3 or char_length(v_reason) > 500 then
    raise exception 'invalid close reason' using errcode = '22023'; end if;
  perform public.aps_reconciliation_v2_lock();
  perform id from public.aps_reconciliation_sessions where fiscal_month_id = p_month_id
    and flow_type = 'screen_v2' and status = 'open' order by id for update;
  v_block := public.aps_reconciliation_v2_close_reason(p_month_id);
  if v_block is not null then raise exception 'cannot close reconciliation month: %', v_block using errcode = '22023'; end if;
  with closed as (
    update public.aps_reconciliation_sessions set status = 'closed', closed_at = now(),
      closed_by = v_actor, close_reason = v_reason, snapshot_version = snapshot_version + 1
    where fiscal_month_id = p_month_id and flow_type = 'screen_v2' and status = 'open'
    returning id
  ) insert into public.audit_logs(actor_id, action, entity, entity_id, metadata)
  select v_actor, 'aps.reconciliation_closed'::public.audit_action, 'aps_reconciliation_sessions', id::text,
    jsonb_build_object('fiscal_month_id', p_month_id, 'reason', v_reason, 'version', 2) from closed;
end $$;
revoke all on function public.aps_close_reconciliation_month_v2(uuid,text) from public, anon, authenticated, service_role;
grant execute on function public.aps_close_reconciliation_month_v2(uuid,text) to authenticated;

create function public.aps_reopen_reconciliation_month_v2(p_month_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_actor uuid := auth.uid(); v_reason text := btrim(coalesce(p_reason,''));
begin
  if v_actor is null or not coalesce(public.is_active_user(), false) or not exists (
    select 1 from public.user_roles ur join public.roles r on r.id = ur.role_id
      where ur.user_id = v_actor and r.slug = 'owner') then
    raise exception 'owner role required' using errcode = '42501'; end if;
  if char_length(v_reason) < 3 or char_length(v_reason) > 500 then
    raise exception 'invalid reopen reason' using errcode = '22023'; end if;
  perform public.aps_reconciliation_v2_lock();
  if exists(select 1 from public.aps_reconciliation_sessions o where o.fiscal_month_id = p_month_id and o.status = 'open' and o.flow_type in ('screen','screen_v2')) then
    raise exception 'month has conflicting open sessions' using errcode = '22023'; end if;
  if not exists(select 1 from public.aps_reconciliation_sessions where fiscal_month_id = p_month_id
    and flow_type = 'screen_v2' and status = 'closed') then
    raise exception 'no closed v2 sessions' using errcode = 'P0002'; end if;
  with reopened as (
    update public.aps_reconciliation_sessions set status = 'open', closed_at = null, closed_by = null, close_reason = null,
      needs_review = true, review_reason = 'reopened', review_required_at = now(), snapshot_version = snapshot_version + 1
    where fiscal_month_id = p_month_id and flow_type = 'screen_v2' and status = 'closed'
    returning id
  ) insert into public.audit_logs(actor_id, action, entity, entity_id, metadata)
  select v_actor, 'aps.reconciliation_reopened'::public.audit_action, 'aps_reconciliation_sessions', id::text,
    jsonb_build_object('fiscal_month_id', p_month_id, 'reason', v_reason, 'version', 2) from reopened;
end $$;
revoke all on function public.aps_reopen_reconciliation_month_v2(uuid,text) from public, anon, authenticated, service_role;
grant execute on function public.aps_reopen_reconciliation_month_v2(uuid,text) to authenticated;

-- A letter approval/cancellation changes book figures. Preserve all snapshots
-- and explicitly mark the affected closed AND open sessions from that date
-- through year end, including the affected month itself.
create function public.aps_reconciliation_v2_letter_changed()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if old.status = new.status or (old.status <> 'approved' and new.status <> 'approved') then return new; end if;
  perform public.aps_reconciliation_v2_lock();
  with affected as (
    update public.aps_reconciliation_sessions s set needs_review = true,
      review_reason = 'approved_letter_changed', review_required_at = now(), snapshot_version = s.snapshot_version + 1
    from public.fiscal_months fm
    where s.fiscal_month_id = fm.id and s.fiscal_year_id = new.fiscal_year_id
      and s.flow_type = 'screen_v2' and s.status in ('open','closed') and fm.end_date >= new.letter_date
      and exists(select 1 from public.letter_lines ll
          join public.aps_reconciliation_settings_members m on m.leaf_id = ll.classification_id
          and m.revision_id = s.settings_revision_id
        where ll.letter_id = new.id)
    returning s.id
  ) insert into public.audit_logs(actor_id, action, entity, entity_id, metadata)
    select auth.uid(), 'aps.reconciliation_review_required'::public.audit_action, 'aps_reconciliation_sessions', id::text,
      jsonb_build_object('letter_id', new.id, 'reason', 'approved_letter_changed') from affected;
  return new;
end $$;
revoke all on function public.aps_reconciliation_v2_letter_changed() from public, anon, authenticated, service_role;
create trigger aps_reconciliation_v2_letter_changed after update of status on public.letters
  for each row execute function public.aps_reconciliation_v2_letter_changed();

create function public.aps_reconciliation_v2_opening_changed()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_old_year uuid; v_old_warehouse uuid; v_old_class uuid;
        v_new_year uuid; v_new_warehouse uuid; v_new_class uuid;
begin
  if tg_op = 'UPDATE' and old.fiscal_year_id is not distinct from new.fiscal_year_id
     and old.warehouse_id is not distinct from new.warehouse_id
     and old.classification_id is not distinct from new.classification_id
     and old.amount is not distinct from new.amount then return new; end if;
  if tg_op <> 'INSERT' then
    v_old_year := old.fiscal_year_id; v_old_warehouse := old.warehouse_id; v_old_class := old.classification_id;
  end if;
  if tg_op <> 'DELETE' then
    v_new_year := new.fiscal_year_id; v_new_warehouse := new.warehouse_id; v_new_class := new.classification_id;
  end if;
  perform public.aps_reconciliation_v2_lock();
  with affected as (
    update public.aps_reconciliation_sessions s set needs_review = true,
      review_reason = 'system_opening_changed', review_required_at = now(), snapshot_version = s.snapshot_version + 1
    where s.flow_type = 'screen_v2' and s.status in ('open','closed')
      and exists(select 1 from (values (v_old_year,v_old_warehouse,v_old_class),
                                        (v_new_year,v_new_warehouse,v_new_class)) changes(year_id,warehouse_id,classification_id)
        join public.aps_reconciliation_settings_members m on m.leaf_id = changes.classification_id
          and m.revision_id = s.settings_revision_id
        where changes.year_id = s.fiscal_year_id)
    returning s.id
  ) insert into public.audit_logs(actor_id, action, entity, entity_id, metadata)
    select auth.uid(), 'aps.reconciliation_review_required'::public.audit_action, 'aps_reconciliation_sessions', id::text,
      jsonb_build_object('reason', 'system_opening_changed') from affected;
  if tg_op = 'DELETE' then return old; else return new; end if;
end $$;
revoke all on function public.aps_reconciliation_v2_opening_changed() from public, anon, authenticated, service_role;
create trigger aps_reconciliation_v2_opening_changed after insert or update or delete on public.opening_balances
  for each row execute function public.aps_reconciliation_v2_opening_changed();

-- Period edits must not silently reinterpret a stored snapshot. Reparenting a
-- month that already has sessions would also violate their year/month pairing.
create function public.aps_reconciliation_v2_period_changed()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_old_year uuid; v_new_year uuid;
begin
  if tg_table_name = 'fiscal_years' then
    if old.start_date is not distinct from new.start_date and old.end_date is not distinct from new.end_date then return new; end if;
    v_old_year := old.id; v_new_year := new.id;
  else
    if old.fiscal_year_id is not distinct from new.fiscal_year_id
       and old.start_date is not distinct from new.start_date and old.end_date is not distinct from new.end_date then return new; end if;
    v_old_year := old.fiscal_year_id; v_new_year := new.fiscal_year_id;
  end if;
  perform public.aps_reconciliation_v2_lock();
  with affected as (
    update public.aps_reconciliation_sessions s set needs_review = true,
      review_reason = 'fiscal_period_changed', review_required_at = now(), snapshot_version = s.snapshot_version + 1
    where s.flow_type = 'screen_v2' and s.status in ('open','closed')
      and s.fiscal_year_id in (v_old_year,v_new_year)
    returning s.id
  ) insert into public.audit_logs(actor_id, action, entity, entity_id, metadata)
    select auth.uid(), 'aps.reconciliation_review_required'::public.audit_action, 'aps_reconciliation_sessions', id::text,
      jsonb_build_object('reason', 'fiscal_period_changed') from affected;
  return new;
end $$;
revoke all on function public.aps_reconciliation_v2_period_changed() from public, anon, authenticated, service_role;
create trigger aps_reconciliation_v2_year_changed after update of start_date, end_date on public.fiscal_years
  for each row execute function public.aps_reconciliation_v2_period_changed();
create trigger aps_reconciliation_v2_month_changed after update of fiscal_year_id, start_date, end_date on public.fiscal_months
  for each row execute function public.aps_reconciliation_v2_period_changed();

create function public.aps_reconciliation_v2_month_year_guard()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if new.fiscal_year_id is distinct from old.fiscal_year_id and exists
    (select 1 from public.aps_reconciliation_sessions where fiscal_month_id = old.id and flow_type = 'screen_v2') then
    raise exception 'cannot move a fiscal month with reconciliation history to another year' using errcode = '23514';
  end if;
  return new;
end $$;
revoke all on function public.aps_reconciliation_v2_month_year_guard() from public, anon, authenticated, service_role;
create trigger aps_reconciliation_v2_month_year_guard before update of fiscal_year_id on public.fiscal_months
  for each row execute function public.aps_reconciliation_v2_month_year_guard();

notify pgrst, 'reload schema';
