-- Delete only unused scopes and genuinely empty v3 sessions. Existing actions
-- are reused with an explicit operation to avoid changing the audit enum.
-- All writers share the existing reconciliation advisory lock.

-- Existing lines must survive accidental parent deletion; only explicit,
-- authorized deletion can remove them after a durable audit snapshot.
alter table public.aps_reconciliation_lines
  drop constraint aps_reconciliation_lines_session_id_fkey;
alter table public.aps_reconciliation_lines
  add constraint aps_reconciliation_lines_session_id_fkey
  foreign key (session_id) references public.aps_reconciliation_sessions(id) on delete restrict;

create index aps_reconciliation_v3_scope_session_audit_idx
  on public.audit_logs ((metadata->>'scope_id'))
  where entity='aps_reconciliation_sessions' and action in
    ('aps.reconciliation_opened'::public.audit_action,'aps.reconciliation_cancelled'::public.audit_action);

create function public.aps_reconciliation_v3_session_is_deletable(p_session_id uuid)
returns boolean language sql stable security definer set search_path=pg_catalog,public as $$
  select exists (
    select 1 from public.aps_reconciliation_sessions s
    where s.id=p_session_id and s.flow_type='screen_v2' and s.status='open'
      and not exists (
        select 1 from public.aps_reconciliation_lines l where l.session_id=s.id and (
          l.accountant_inbound is not null or l.accountant_outbound is not null or
          l.accountant_ytd_inbound is not null or l.accountant_ytd_outbound is not null or
          l.accountant_year_opening is not null or l.v2_recorded_at is not null or l.v2_recorded_by is not null
        )
      )
      and not exists (
        select 1 from public.audit_logs a
        where a.action='aps.reconciliation_v2_recorded' and a.metadata->>'session_id'=s.id::text
      )
  )
$$;
revoke all on function public.aps_reconciliation_v3_session_is_deletable(uuid) from public,anon,authenticated,service_role;

-- The UI must not infer emptiness from one page of a paginated response.
create function public.aps_can_delete_reconciliation_session_v3(p_session_id uuid)
returns boolean language plpgsql stable security definer set search_path=pg_catalog,public as $$
begin
  if auth.uid() is null or not coalesce(public.aps_can_manage_reconciliation(),false) then
    raise exception 'reconciliation manage permission required' using errcode='42501';
  end if;
  return public.aps_reconciliation_v3_session_is_deletable(p_session_id);
end $$;
revoke all on function public.aps_can_delete_reconciliation_session_v3(uuid) from public,anon,authenticated,service_role;
grant execute on function public.aps_can_delete_reconciliation_session_v3(uuid) to authenticated;

create function public.aps_delete_reconciliation_session_v3(p_session_id uuid)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare s public.aps_reconciliation_sessions%rowtype; v_lines jsonb; v_history jsonb;
begin
  if auth.uid() is null or not coalesce(public.aps_can_manage_reconciliation(),false) then
    raise exception 'reconciliation manage permission required' using errcode='42501';
  end if;
  perform public.aps_reconciliation_v2_lock();
  select * into s from public.aps_reconciliation_sessions
    where id=p_session_id and flow_type='screen_v2' for update;
  if not found then raise exception 'v3 session not found' using errcode='P0002'; end if;
  if not public.aps_reconciliation_v3_session_is_deletable(s.id) then
    raise exception 'session is not open and empty or has accountant entry history' using errcode='22023';
  end if;
  select coalesce(jsonb_agg(to_jsonb(l) order by l.id),'[]'::jsonb) into v_lines
    from public.aps_reconciliation_lines l where l.session_id=s.id;
  select coalesce(jsonb_agg(to_jsonb(h) order by h.created_at,h.id),'[]'::jsonb) into v_history
    from public.aps_reconciliation_sync_history h where h.session_id=s.id;
  -- Preserve the entire sync history and current line snapshot before removing
  -- their RESTRICT references. Audit insert and deletes are one transaction.
  insert into public.audit_logs(actor_id,action,entity,entity_id,metadata)
    values(auth.uid(),'aps.reconciliation_cancelled','aps_reconciliation_sessions',s.id::text,
      jsonb_build_object('operation','delete_empty_session','scope_id',s.scope_id,
        'fiscal_month_id',s.fiscal_month_id,'session',to_jsonb(s),'lines',v_lines,'sync_history',v_history));
  delete from public.aps_reconciliation_sync_history where session_id=s.id;
  delete from public.aps_reconciliation_lines where session_id=s.id;
  delete from public.aps_reconciliation_sessions where id=s.id;
end $$;
revoke all on function public.aps_delete_reconciliation_session_v3(uuid) from public,anon,authenticated,service_role;
grant execute on function public.aps_delete_reconciliation_session_v3(uuid) to authenticated;

create function public.aps_delete_reconciliation_scope_v3(p_scope_id uuid)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare s public.aps_reconciliation_scopes%rowtype; v_revisions jsonb;
begin
  perform public.aps_reconciliation_v3_require_settings();
  perform public.aps_reconciliation_v2_lock();
  lock table public.classifications in share mode;
  select * into s from public.aps_reconciliation_scopes where id=p_scope_id for update;
  if not found then raise exception 'scope not found' using errcode='P0002'; end if;
  if s.is_default then raise exception 'default scope cannot be deleted' using errcode='22023'; end if;
  -- A deleted empty session remains history: its audit record blocks deletion
  -- of the scope even after the physical session row has gone.
  if exists(select 1 from public.aps_reconciliation_sessions where scope_id=s.id)
     or exists(select 1 from public.audit_logs a where a.entity='aps_reconciliation_sessions'
       and a.action in ('aps.reconciliation_opened','aps.reconciliation_cancelled')
       and a.metadata->>'scope_id'=s.id::text) then
    raise exception 'scope has session history; archive it instead' using errcode='23503';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('revision',to_jsonb(r),
    'classifications',coalesce((select jsonb_agg(to_jsonb(c) order by c.classification_id)
      from public.aps_reconciliation_settings c where c.revision_id=r.id),'[]'::jsonb),
    'members',coalesce((select jsonb_agg(to_jsonb(m) order by m.classification_id,m.leaf_id)
      from public.aps_reconciliation_settings_members m where m.revision_id=r.id),'[]'::jsonb))
    order by r.created_at,r.id),'[]'::jsonb) into v_revisions
    from public.aps_reconciliation_settings_revisions r where r.scope_id=s.id;
  insert into public.audit_logs(actor_id,action,entity,entity_id,metadata)
    values(auth.uid(),'aps.reconciliation_settings_changed','aps_reconciliation_scopes',s.id::text,
      jsonb_build_object('operation','delete_scope','scope',to_jsonb(s),'revisions',v_revisions));
  delete from public.aps_reconciliation_scope_leaves where scope_id=s.id;
  delete from public.aps_reconciliation_scope_current where scope_id=s.id;
  delete from public.aps_reconciliation_settings_members where revision_id in
    (select id from public.aps_reconciliation_settings_revisions where scope_id=s.id);
  delete from public.aps_reconciliation_settings where revision_id in
    (select id from public.aps_reconciliation_settings_revisions where scope_id=s.id);
  delete from public.aps_reconciliation_settings_revisions where scope_id=s.id;
  delete from public.aps_reconciliation_scopes where id=s.id;
end $$;
revoke all on function public.aps_delete_reconciliation_scope_v3(uuid) from public,anon,authenticated,service_role;
grant execute on function public.aps_delete_reconciliation_scope_v3(uuid) to authenticated;

-- Fail closed on inherited execute privileges, not just explicit grants.
do $verify_grants$
declare v_fn text; v_role text;
begin
  foreach v_fn in array array[
    'public.aps_reconciliation_v3_session_is_deletable(uuid)',
    'public.aps_can_delete_reconciliation_session_v3(uuid)',
    'public.aps_delete_reconciliation_session_v3(uuid)',
    'public.aps_delete_reconciliation_scope_v3(uuid)'
  ] loop
    foreach v_role in array array['anon','service_role'] loop
      if has_function_privilege(v_role,v_fn,'EXECUTE') then
        raise exception 'unexpected execute privilege on % for %',v_fn,v_role using errcode='42501';
      end if;
    end loop;
  end loop;
  if has_function_privilege('authenticated','public.aps_reconciliation_v3_session_is_deletable(uuid)','EXECUTE') then
    raise exception 'internal deletion helper exposed' using errcode='42501';
  end if;
end $verify_grants$;

notify pgrst, 'reload schema';
