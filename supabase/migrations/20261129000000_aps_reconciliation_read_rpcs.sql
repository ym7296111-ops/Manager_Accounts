-- Reconciliation screen read model. The four existing write RPCs remain unchanged.
-- Both readers require an active approved caller with at least one reconciliation
-- permission. In particular, an owner without any of those permissions cannot
-- read this model even though the existing reopen RPC checks the owner role.

create or replace function public.aps_get_reconciliation_options()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_manage boolean := coalesce(public.has_permission('aps.reconciliation:manage'), false);
  v_close boolean := coalesce(public.has_permission('aps.reconciliation:close_month'), false);
  v_reopen boolean := coalesce(public.has_permission('aps.reconciliation:reopen_month'), false);
begin
  if v_actor is null or not coalesce(public.is_active_user(), false)
     or not (v_manage or v_close or v_reopen) then
    raise exception 'aps_get_reconciliation_options: reconciliation permission required'
      using errcode = '42501';
  end if;

  -- These narrowly projected directories are needed by reconciliation users
  -- who do not have project.settings:manage. The explicit gate above, rather
  -- than the broader project-settings permission, authorizes this read model.
  return jsonb_build_object(
    'months', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', m.id, 'label', m.name || ' - ' || y.name,
        'is_active', m.is_active, 'is_fiscal_closed', m.is_closed
      ) order by m.start_date desc, m.id)
      from public.fiscal_months m
      join public.fiscal_years y on y.id = m.fiscal_year_id
    ), '[]'::jsonb),
    'stations', coalesce((
      select jsonb_agg(jsonb_build_object('id', s.id, 'label', s.name)
                       order by s.name, s.id)
      from public.stations s
    ), '[]'::jsonb),
    'can_reopen_as_owner', exists (
      select 1 from public.user_roles ur
      join public.roles r on r.id = ur.role_id
      where ur.user_id = v_actor and r.slug = 'owner'
    ),
    'can_manage', v_manage,
    'can_close', v_close
  );
end;
$$;

revoke all on function public.aps_get_reconciliation_options() from public, anon, authenticated, service_role;
grant execute on function public.aps_get_reconciliation_options() to authenticated;

-- STABLE gives each call a consistent statement snapshot. Separate pages are
-- separate requests and do not share a snapshot. The write RPC remains the
-- final authority, since session state can change after this reader returns.
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
     where s.fiscal_month_id = p_month_id
  ), selected as materialized (
    select * from month_sessions
     where station_id = p_station_id
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

revoke all on function public.aps_get_reconciliation_state(uuid, uuid, integer, integer) from public, anon, authenticated, service_role;
grant execute on function public.aps_get_reconciliation_state(uuid, uuid, integer, integer) to authenticated;

notify pgrst, 'reload schema';
