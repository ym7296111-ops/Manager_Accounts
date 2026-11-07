-- Read-only v2 contracts; amounts cross the JSON boundary as decimal strings.
create function public.aps_get_reconciliation_settings_v2()
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare v_revision uuid;
begin
  if auth.uid() is null or not coalesce(public.is_active_user(), false)
     or not coalesce(public.has_permission('aps.reconciliation:settings'), false) then
    raise exception 'reconciliation settings permission required' using errcode = '42501'; end if;
  select revision_id into v_revision from public.aps_reconciliation_settings_current where singleton;
  return jsonb_build_object('revision_id', v_revision,
    'classifications', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name,
      'parent_id', c.parent_id, 'is_leaf', c.is_leaf, 'is_active', c.is_active) order by c.name,c.id)
      from public.classifications c), '[]'::jsonb),
    'selected', coalesce((select jsonb_agg(s.classification_id order by s.classification_id)
      from public.aps_reconciliation_settings s where s.revision_id = v_revision), '[]'::jsonb));
end $$;
revoke all on function public.aps_get_reconciliation_settings_v2() from public, anon, authenticated, service_role;
grant execute on function public.aps_get_reconciliation_settings_v2() to authenticated;

create function public.aps_get_reconciliation_state_v2(p_month_id uuid,
  p_offset integer default 0, p_limit integer default 50)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare v_result jsonb; v_block text;
begin
  if auth.uid() is null or not coalesce(public.is_active_user(), false) or not (
    coalesce(public.has_permission('aps.reconciliation:manage'),false)
    or coalesce(public.has_permission('aps.reconciliation:close_month'),false)
    or coalesce(public.has_permission('aps.reconciliation:reopen_month'),false)) then
    raise exception 'reconciliation permission required' using errcode = '42501'; end if;
  if p_month_id is null or p_offset is null or p_limit is null
     or p_offset < 0 or p_limit < 1 or p_limit > 100 then
    raise exception 'invalid read arguments' using errcode = '22023'; end if;
  if not exists(select 1 from public.fiscal_months where id = p_month_id) then
    raise exception 'unknown month' using errcode = 'P0002'; end if;
  v_block := public.aps_reconciliation_v2_close_reason(p_month_id);
  with selected as materialized (
    select s.* from public.aps_reconciliation_sessions s
    where s.fiscal_month_id = p_month_id and s.flow_type = 'screen_v2'
      and s.status in ('open','closed') order by (s.status = 'open') desc, s.sequence_number desc, s.id desc limit 1
  ), page as materialized (
    select l.*, cfg.classification_name from selected s
    join public.aps_reconciliation_lines l on l.session_id = s.id
    join public.aps_reconciliation_settings cfg on cfg.revision_id = s.settings_revision_id
      and cfg.classification_id = l.classification_id
    order by l.classification_id, l.id offset p_offset limit p_limit + 1
  )
  select jsonb_build_object(
    'fiscal_month', (select jsonb_build_object('id', fm.id, 'is_active', fm.is_active, 'is_fiscal_closed', fm.is_closed)
      from public.fiscal_months fm where fm.id = p_month_id),
    'selected_session', (select jsonb_build_object('id',s.id,'status',s.status,'flow_type',s.flow_type,
      'settings_revision_id',s.settings_revision_id,'needs_review',s.needs_review,'review_reason',s.review_reason,
      'sequence_number',s.sequence_number,'snapshot_version',s.snapshot_version::text) from selected s),
    'selected_lines', coalesce((select jsonb_agg(jsonb_build_object(
      'id',id, 'classification_id',classification_id, 'classification_name',classification_name,
      'version',v2_version::text,
      'monthly', jsonb_build_object(
        'book_inbound',book_inbound::text,'book_outbound',book_outbound::text,
        'accountant_inbound',accountant_inbound::text,'accountant_outbound',accountant_outbound::text,
        'book_balance',(book_inbound-book_outbound)::text,
        'accountant_balance',(accountant_inbound-accountant_outbound)::text,
        'inbound_difference',(accountant_inbound-book_inbound)::text,
        'outbound_difference',(accountant_outbound-book_outbound)::text,
        'balance_difference',(accountant_inbound-accountant_outbound-book_inbound+book_outbound)::text),
      'ytd', jsonb_build_object(
        'book_opening',book_year_opening::text,
        'accountant_opening',coalesce(accountant_year_opening,book_year_opening)::text,
        'accountant_opening_source',case when accountant_year_opening is not null then 'manual' when book_year_opening is not null then 'trusted_system' else 'missing' end,
        'book_inbound',book_ytd_inbound::text,'book_outbound',book_ytd_outbound::text,
        'accountant_inbound',accountant_ytd_inbound::text,'accountant_outbound',accountant_ytd_outbound::text,
        'book_balance',(book_year_opening+book_ytd_inbound-book_ytd_outbound)::text,
        'accountant_balance',(coalesce(accountant_year_opening,book_year_opening)+accountant_ytd_inbound-accountant_ytd_outbound)::text,
        'inbound_difference',(accountant_ytd_inbound-book_ytd_inbound)::text,
        'outbound_difference',(accountant_ytd_outbound-book_ytd_outbound)::text,
        'balance_difference',(coalesce(accountant_year_opening,book_year_opening)+accountant_ytd_inbound-accountant_ytd_outbound-book_year_opening-book_ytd_inbound+book_ytd_outbound)::text)
      ) order by classification_id,id) from (select * from page order by classification_id,id limit p_limit) visible), '[]'::jsonb),
    'month_summary', jsonb_build_object(
      'open_sessions_count',(select count(*) from public.aps_reconciliation_sessions where fiscal_month_id=p_month_id and status='open' and flow_type='screen_v2'),
      'closed_sessions_count',(select count(*) from public.aps_reconciliation_sessions where fiscal_month_id=p_month_id and status='closed' and flow_type='screen_v2'),
      'missing_system_opening_count',(select count(*) from selected s join public.aps_reconciliation_lines l on l.session_id=s.id where l.book_year_opening is null)),
    'pagination',jsonb_build_object('offset',p_offset,'limit',p_limit,'has_more',(select count(*) > p_limit from page)),
    'flags',jsonb_build_object('can_close_now',v_block is null,'close_blocked_reason',v_block)
  ) into v_result;
  return v_result;
end $$;
revoke all on function public.aps_get_reconciliation_state_v2(uuid,integer,integer) from public, anon, authenticated, service_role;
grant execute on function public.aps_get_reconciliation_state_v2(uuid,integer,integer) to authenticated;

-- Keep the v1 JSON contract readable if a v2 session exists. The v1 page must
-- not interpret the v2 session as a v1 session; v1 writes are separately guarded.
create or replace function public.aps_get_reconciliation_state(
  p_month_id uuid,
  p_station_id uuid,
  p_offset integer default 0,
  p_limit integer default 50
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_result jsonb;
begin
  if v_actor is null or not coalesce(public.is_active_user(), false)
     or not (
       coalesce(public.has_permission('aps.reconciliation:manage'), false)
       or coalesce(public.has_permission('aps.reconciliation:close_month'), false)
       or coalesce(public.has_permission('aps.reconciliation:reopen_month'), false)
     ) then
    raise exception 'aps_get_reconciliation_state: reconciliation permission required'
      using errcode = '42501';
  end if;
  if p_month_id is null or p_station_id is null or p_offset is null or p_limit is null
     or p_offset < 0 or p_limit < 1 or p_limit > 100 then
    raise exception 'aps_get_reconciliation_state: invalid arguments'
      using errcode = '22023';
  end if;
  if not exists (select 1 from public.fiscal_months where id = p_month_id) then
    raise exception 'aps_get_reconciliation_state: unknown fiscal month'
      using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.stations where id = p_station_id) then
    raise exception 'aps_get_reconciliation_state: unknown station'
      using errcode = 'P0002';
  end if;

  with month_sessions as materialized (
    select s.id, s.station_id, s.status, s.flow_type, s.sequence_number,
           exists (select 1 from public.aps_reconciliation_items i where i.session_id = s.id)
             as has_legacy_items
      from public.aps_reconciliation_sessions s
     where s.fiscal_month_id = p_month_id and s.flow_type <> 'screen_v2'
  ), selected as materialized (
    select * from month_sessions
     where station_id = p_station_id and flow_type <> 'screen_v2'
     order by (status = 'open') desc, sequence_number desc, id desc
     limit 1
  ), eligible_open as materialized (
    select * from month_sessions
     where status = 'open' and flow_type = 'screen' and not has_legacy_items
  ), station_differences as materialized (
    select eo.station_id, st.name as station_name, sum(l.difference) as total_difference,
           bool_or(l.difference <> 0) as has_difference
      from eligible_open eo
      join public.aps_reconciliation_lines l on l.session_id = eo.id
      join public.stations st on st.id = eo.station_id
     group by eo.station_id, st.name
  ), page as materialized (
    select l.id, l.classification_id, c.name as classification_name,
           l.book_amount, l.accountant_amount, l.difference
      from selected s
      join public.aps_reconciliation_lines l on l.session_id = s.id
      join public.classifications c on c.id = l.classification_id
     where s.flow_type = 'screen' and not s.has_legacy_items
     order by l.classification_id, l.id
     offset p_offset limit (p_limit + 1)
  ), summary as (
    select
      (select count(*) from month_sessions where status = 'open') as open_count,
      (select count(*) from eligible_open) as eligible_open_count,
      (select count(distinct station_id) from eligible_open) as eligible_station_count,
      (select count(*) from month_sessions where status = 'closed'
         and flow_type = 'screen' and not has_legacy_items) as eligible_closed_count,
      (select count(distinct station_id) from month_sessions) as station_count,
      coalesce((select jsonb_agg(jsonb_build_object(
        'station_id', station_id, 'station_name', station_name,
        'total_difference', total_difference::text
      ) order by station_name, station_id)
        from station_differences where has_difference), '[]'::jsonb) as unbalanced,
      coalesce((select sum(total_difference) from station_differences), 0.00::numeric)::text
        as total_difference,
      exists (select 1 from station_differences where has_difference) as has_difference
  )
  select jsonb_build_object(
    'fiscal_month', (select jsonb_build_object('id', m.id, 'is_fiscal_closed', m.is_closed,
                                              'is_active', m.is_active)
                       from public.fiscal_months m where m.id = p_month_id),
    'selected_session', (select jsonb_build_object('id', id, 'status', status,
        'flow_type', flow_type, 'has_legacy_items', has_legacy_items,
        'sequence_number', sequence_number) from selected),
    'selected_lines', coalesce((select jsonb_agg(jsonb_build_object(
        'id', id, 'classification_id', classification_id,
        'classification_name', classification_name, 'book_amount', book_amount::text,
        'accountant_amount', accountant_amount::text, 'difference', difference::text
      ) order by classification_id, id)
      from (select * from page order by classification_id, id limit p_limit) visible), '[]'::jsonb),
    'month_summary', jsonb_build_object(
      'open_sessions_count', summary.open_count,
      'eligible_open_screen_sessions', summary.eligible_open_count,
      'eligible_open_stations_count', summary.eligible_station_count,
      'eligible_closed_screen_sessions', summary.eligible_closed_count,
      'total_stations_with_sessions', summary.station_count,
      'stations_with_nonzero_difference', summary.unbalanced,
      'total_month_difference', summary.total_difference
    ),
    'pagination', jsonb_build_object('offset', p_offset, 'limit', p_limit,
                                    'has_more', (select count(*) > p_limit from page)),
    'flags', jsonb_build_object(
      'can_close_now', summary.eligible_open_count > 0 and not summary.has_difference,
      'close_blocked_reason', case
        when summary.eligible_open_count = 0 then 'no_eligible_open_sessions'
        when summary.has_difference then 'nonzero_differences'
        else null end
    )
  ) into v_result from summary;
  return v_result;
end;
$$;


notify pgrst, 'reload schema';
