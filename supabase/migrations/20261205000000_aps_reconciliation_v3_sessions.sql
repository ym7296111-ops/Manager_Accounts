-- Scoped sessions; older sessions keep their IDs and their frozen revisions.
create index aps_reconciliation_v3_recorded_session_audit_idx on public.audit_logs ((metadata->>'session_id'))
  where action='aps.reconciliation_v2_recorded'::public.audit_action;
drop index public.aps_reconciliation_v2_canonical_idx;
create unique index aps_reconciliation_v3_canonical_idx
  on public.aps_reconciliation_sessions(fiscal_month_id,scope_id)
  where flow_type='screen_v2' and status in ('open','closed');
alter table public.aps_reconciliation_sessions add column scope_name_snapshot text;
alter table public.aps_reconciliation_sessions disable trigger aps_reconciliation_sessions_set_updated_at;
update public.aps_reconciliation_sessions s set scope_name_snapshot=scope.name
  from public.aps_reconciliation_scopes scope where s.scope_id=scope.id and s.flow_type='screen_v2';
alter table public.aps_reconciliation_sessions enable trigger aps_reconciliation_sessions_set_updated_at;

-- A successful settings sync preserves the complete prior system snapshot and
-- its immutable revision. No direct client privileges are granted.
create table public.aps_reconciliation_sync_history (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.aps_reconciliation_sessions(id) on delete restrict,
  scope_id uuid not null references public.aps_reconciliation_scopes(id) on delete restrict,
  old_revision_id uuid not null,
  old_source_config_revision_id uuid,
  new_revision_id uuid not null,
  new_source_config_revision_id uuid not null,
  old_generation bigint not null,
  lines jsonb not null,
  actor_id uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  foreign key (old_revision_id,scope_id) references public.aps_reconciliation_settings_revisions(id,scope_id) on delete restrict,
  foreign key (old_source_config_revision_id,scope_id) references public.aps_reconciliation_settings_revisions(id,scope_id) on delete restrict,
  foreign key (new_revision_id,scope_id) references public.aps_reconciliation_settings_revisions(id,scope_id) on delete restrict,
  foreign key (new_source_config_revision_id,scope_id) references public.aps_reconciliation_settings_revisions(id,scope_id) on delete restrict
);
alter table public.aps_reconciliation_sync_history enable row level security;
alter table public.aps_reconciliation_sync_history force row level security;
revoke all on public.aps_reconciliation_sync_history from public,anon,authenticated,service_role;

-- Fail closed if a deployment role inherits privileges via an unexpected role.
do $private_grants$
declare v_table text; v_role text; v_privilege text;
begin
  foreach v_table in array array['public.aps_reconciliation_sync_history'] loop
    foreach v_role in array array['anon','authenticated','service_role'] loop
      foreach v_privilege in array array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'] loop
        if v_privilege = 'MAINTAIN' and current_setting('server_version_num')::integer < 170000 then
          continue; -- MAINTAIN was introduced in PostgreSQL 17.
        end if;
        if has_table_privilege(v_role,v_table,v_privilege) then
          raise exception 'unexpected % privilege on % for %',v_privilege,v_table,v_role using errcode='42501';
        end if;
      end loop;
    end loop;
  end loop;
end $private_grants$;

create function public.aps_reconciliation_v3_capture_settings(p_actor uuid,p_scope_id uuid)
returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_config uuid; v_revision uuid;
begin
  lock table public.classifications in share mode;
  select revision_id into v_config from public.aps_reconciliation_v3_configs() where scope_id=p_scope_id;
  if v_config is null then raise exception 'reconciliation settings are empty' using errcode='22023'; end if;
  insert into public.aps_reconciliation_settings_revisions(created_by,scope_id) values(p_actor,p_scope_id) returning id into v_revision;
  insert into public.aps_reconciliation_settings(revision_id,classification_id,classification_name)
    select v_revision,c.id,c.name from public.aps_reconciliation_settings cfg
    join public.classifications c on c.id=cfg.classification_id where cfg.revision_id=v_config;
  if not found then raise exception 'reconciliation settings are empty' using errcode='22023'; end if;
  begin
    insert into public.aps_reconciliation_settings_members(revision_id,classification_id,leaf_id)
    with recursive tree(root,id) as (
      select classification_id,classification_id from public.aps_reconciliation_settings where revision_id=v_revision
      union all select t.root,c.id from tree t join public.classifications c on c.parent_id=t.id
    ) select v_revision,t.root,c.id from tree t join public.classifications c on c.id=t.id where c.is_leaf;
  exception when unique_violation then raise exception 'configured classifications now overlap; update settings' using errcode='22023'; end;
  if exists(select 1 from public.aps_reconciliation_settings s where s.revision_id=v_revision and not exists
      (select 1 from public.aps_reconciliation_settings_members m where m.revision_id=v_revision and m.classification_id=s.classification_id)) then
    raise exception 'configured classification has no leaves' using errcode='22023'; end if;
  return v_revision;
end $$;
revoke all on function public.aps_reconciliation_v3_capture_settings(uuid,uuid) from public,anon,authenticated,service_role;

-- Historical snapshots in another scope for the same month also block reuse,
-- even when the current configurations are disjoint or the other is archived.
create function public.aps_reconciliation_v3_check_history(p_month uuid,p_scope uuid,p_revision uuid)
returns void language plpgsql stable security definer set search_path=pg_catalog,public as $$
begin
  if exists(select 1 from public.aps_reconciliation_settings_members n
    join public.aps_reconciliation_settings_members o on o.leaf_id=n.leaf_id
    join public.aps_reconciliation_sessions s on s.settings_revision_id=o.revision_id
    where n.revision_id=p_revision and s.fiscal_month_id=p_month and s.scope_id<>p_scope
      and s.flow_type='screen_v2' and s.status in ('open','closed')) then
    raise exception 'historical reconciliation scope overlap for month' using errcode='22023'; end if;
end $$;
revoke all on function public.aps_reconciliation_v3_check_history(uuid,uuid,uuid) from public,anon,authenticated,service_role;

create function public.aps_open_reconciliation_v3(p_month_id uuid,p_scope_id uuid)
returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_actor uuid:=auth.uid(); v_month record; v_revision uuid; v_session uuid; v_config uuid; v_name text;
begin
  if v_actor is null or not coalesce(public.aps_can_manage_reconciliation(),false) then
    raise exception 'reconciliation manage permission required' using errcode='42501'; end if;
  perform public.aps_reconciliation_v2_lock();
  select * into v_month from public.fiscal_months where id=p_month_id;
  if not found then raise exception 'unknown month' using errcode='P0002'; end if;
  select name into v_name from public.aps_reconciliation_scopes where id=p_scope_id and is_active;
  if not found then raise exception 'active scope not found' using errcode='P0002'; end if;
  if exists(select 1 from public.aps_reconciliation_sessions where fiscal_month_id=p_month_id and status='open' and flow_type='screen') then
    raise exception 'close existing v1 screen sessions first' using errcode='22023'; end if;
  if exists(select 1 from public.aps_reconciliation_sessions where fiscal_month_id=p_month_id and scope_id=p_scope_id and status in ('open','closed') and flow_type='screen_v2') then
    raise exception 'session already exists; reopen it instead' using errcode='22023'; end if;
  select revision_id into v_config from public.aps_reconciliation_v3_configs() where scope_id=p_scope_id;
  v_revision:=public.aps_reconciliation_v3_capture_settings(v_actor,p_scope_id);
  perform public.aps_reconciliation_v3_check_history(p_month_id,p_scope_id,v_revision);
  insert into public.aps_reconciliation_sessions(fiscal_year_id,fiscal_month_id,station_id,sequence_number,status,opened_by,created_by,flow_type,settings_revision_id,scope_id,source_config_revision_id,scope_name_snapshot)
    values(v_month.fiscal_year_id,p_month_id,null,1,'open',v_actor,v_actor,'screen_v2',v_revision,p_scope_id,v_config,v_name) returning id into v_session;
  insert into public.aps_reconciliation_lines(session_id,classification_id)
    select v_session,classification_id from public.aps_reconciliation_settings where revision_id=v_revision;
  perform public.aps_reconciliation_v2_snapshot(v_session);
  insert into public.audit_logs(actor_id,action,entity,entity_id,metadata)
    values(v_actor,'aps.reconciliation_opened','aps_reconciliation_sessions',v_session::text,
      jsonb_build_object('scope_id',p_scope_id,'scope_name',v_name,'fiscal_month_id',p_month_id,'settings_revision_id',v_revision,'source_config_revision_id',v_config,'version',3));
  return v_session;
end $$;

create or replace function public.aps_open_reconciliation_v2(p_month_id uuid)
returns uuid language sql security definer set search_path=pg_catalog,public as $$
  select public.aps_open_reconciliation_v3(p_month_id,public.aps_reconciliation_default_scope_id())
$$;

create function public.aps_sync_empty_reconciliation_v3(p_session_id uuid,p_scope_id uuid,p_expected_snapshot_version bigint,p_expected_generation bigint,p_expected_config_revision uuid)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare s public.aps_reconciliation_sessions%rowtype; v_config uuid; v_revision uuid; v_lines jsonb;
begin
  if auth.uid() is null or not coalesce(public.aps_can_manage_reconciliation(),false) then
    raise exception 'reconciliation manage permission required' using errcode='42501'; end if;
  perform public.aps_reconciliation_v2_lock();
  lock table public.classifications in share mode;
  select * into s from public.aps_reconciliation_sessions where id=p_session_id and scope_id=p_scope_id and flow_type='screen_v2' for update;
  if not found then raise exception 'session not found' using errcode='P0002'; end if;
  if s.status<>'open' then raise exception 'session must be open' using errcode='22023'; end if;
  if not exists(select 1 from public.aps_reconciliation_scopes where id=p_scope_id and is_active) then
    raise exception 'scope is archived' using errcode='22023'; end if;
  select revision_id into v_config from public.aps_reconciliation_v3_configs() where scope_id=p_scope_id;
  if p_expected_snapshot_version is null or p_expected_snapshot_version<>s.snapshot_version or
     p_expected_generation is null or p_expected_generation<>s.config_generation or
     p_expected_config_revision is distinct from v_config then
    raise exception 'session or settings changed concurrently' using errcode='40001'; end if;
  if exists(select 1 from public.aps_reconciliation_lines l where l.session_id=s.id and
    (l.accountant_inbound is not null or l.accountant_outbound is not null or l.accountant_year_opening is not null or
     l.accountant_ytd_inbound is not null or l.accountant_ytd_outbound is not null or l.v2_recorded_at is not null or l.v2_recorded_by is not null))
     or exists(select 1 from public.audit_logs a where a.action='aps.reconciliation_v2_recorded' and a.metadata->>'session_id'=s.id::text) then
    raise exception 'session contains or previously contained accountant entries' using errcode='22023'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',l.id,'classification_id',l.classification_id,
    'book_inbound',l.book_inbound::text,'book_outbound',l.book_outbound::text,'book_year_opening',l.book_year_opening::text,
    'book_ytd_inbound',l.book_ytd_inbound::text,'book_ytd_outbound',l.book_ytd_outbound::text,'version',l.v2_version::text) order by l.id),'[]'::jsonb)
    into v_lines from public.aps_reconciliation_lines l where l.session_id=s.id;
  v_revision:=public.aps_reconciliation_v3_capture_settings(auth.uid(),p_scope_id);
  perform public.aps_reconciliation_v3_check_history(s.fiscal_month_id,p_scope_id,v_revision);
  insert into public.aps_reconciliation_sync_history(session_id,scope_id,old_revision_id,old_source_config_revision_id,new_revision_id,new_source_config_revision_id,old_generation,lines,actor_id)
    values(s.id,p_scope_id,s.settings_revision_id,s.source_config_revision_id,v_revision,v_config,s.config_generation,v_lines,auth.uid());
  delete from public.aps_reconciliation_lines where session_id=s.id;
  update public.aps_reconciliation_sessions set settings_revision_id=v_revision,source_config_revision_id=v_config,config_generation=config_generation+1 where id=s.id;
  insert into public.aps_reconciliation_lines(session_id,classification_id)
    select s.id,classification_id from public.aps_reconciliation_settings where revision_id=v_revision;
  perform public.aps_reconciliation_v2_snapshot(s.id);
  insert into public.audit_logs(actor_id,action,entity,entity_id,metadata)
    values(auth.uid(),'aps.reconciliation_v2_refreshed','aps_reconciliation_sessions',s.id::text,
      jsonb_build_object('operation','sync_empty_from_settings','scope_id',p_scope_id,'old_revision_id',s.settings_revision_id,
       'new_revision_id',v_revision,'old_source_config_revision_id',s.source_config_revision_id,'new_source_config_revision_id',v_config,'old_generation',s.config_generation));
end $$;

-- Retain the old validator/writer privately; both public entry points serialize
-- and validate scope/identity before invoking it, so v2 cannot cause ABA writes.
alter function public.aps_record_reconciliation_v2(uuid,uuid,numeric,numeric,numeric,numeric,numeric,bigint)
  rename to aps_record_reconciliation_v3_internal;
revoke all on function public.aps_record_reconciliation_v3_internal(uuid,uuid,numeric,numeric,numeric,numeric,numeric,bigint) from public,anon,authenticated,service_role;
create function public.aps_record_reconciliation_v2(p_session_id uuid,p_classification_id uuid,p_accountant_inbound numeric,p_accountant_outbound numeric,p_accountant_ytd_inbound numeric,p_accountant_ytd_outbound numeric,p_accountant_year_opening numeric,p_expected_version bigint)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if auth.uid() is null or not coalesce(public.aps_can_manage_reconciliation(),false) then raise exception 'reconciliation manage permission required' using errcode='42501'; end if;
  perform public.aps_reconciliation_v2_lock();
  if not exists(select 1 from public.aps_reconciliation_sessions where id=p_session_id and scope_id=public.aps_reconciliation_default_scope_id() and flow_type='screen_v2' and config_generation=1) then
    raise exception 'v2 client cannot write this session or a reconfigured session' using errcode='40001'; end if;
  perform public.aps_record_reconciliation_v3_internal(p_session_id,p_classification_id,p_accountant_inbound,p_accountant_outbound,p_accountant_ytd_inbound,p_accountant_ytd_outbound,p_accountant_year_opening,p_expected_version);
end $$;
create function public.aps_record_reconciliation_v3(p_session_id uuid,p_scope_id uuid,p_line_id uuid,p_classification_id uuid,p_expected_generation bigint,p_expected_version bigint,p_accountant_inbound numeric,p_accountant_outbound numeric,p_accountant_ytd_inbound numeric,p_accountant_ytd_outbound numeric,p_accountant_year_opening numeric)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if auth.uid() is null or not coalesce(public.aps_can_manage_reconciliation(),false) then raise exception 'reconciliation manage permission required' using errcode='42501'; end if;
  perform public.aps_reconciliation_v2_lock();
  if p_expected_generation is null or not exists(select 1 from public.aps_reconciliation_sessions s join public.aps_reconciliation_lines l on l.session_id=s.id
    where s.id=p_session_id and s.scope_id=p_scope_id and s.flow_type='screen_v2' and s.config_generation=p_expected_generation and l.id=p_line_id and l.classification_id=p_classification_id) then
    raise exception 'session or line changed concurrently' using errcode='40001'; end if;
  perform public.aps_record_reconciliation_v3_internal(p_session_id,p_classification_id,p_accountant_inbound,p_accountant_outbound,p_accountant_ytd_inbound,p_accountant_ytd_outbound,p_accountant_year_opening,p_expected_version);
end $$;

create or replace function public.aps_refresh_reconciliation_v2(p_session_id uuid)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if auth.uid() is null or not coalesce(public.aps_can_manage_reconciliation(),false) then raise exception 'reconciliation manage permission required' using errcode='42501'; end if;
  perform public.aps_reconciliation_v2_lock();
  if not exists(select 1 from public.aps_reconciliation_sessions where id=p_session_id and scope_id=public.aps_reconciliation_default_scope_id() and flow_type='screen_v2' and config_generation=1) then raise exception 'v2 client cannot refresh this session' using errcode='22023'; end if;
  perform public.aps_reconciliation_v2_snapshot(p_session_id);
  insert into public.audit_logs(actor_id,action,entity,entity_id,metadata) values(auth.uid(),'aps.reconciliation_v2_refreshed','aps_reconciliation_sessions',p_session_id::text,jsonb_build_object('version',2));
end $$;
create function public.aps_refresh_reconciliation_v3(p_session_id uuid,p_scope_id uuid)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if auth.uid() is null or not coalesce(public.aps_can_manage_reconciliation(),false) then raise exception 'reconciliation manage permission required' using errcode='42501'; end if;
  perform public.aps_reconciliation_v2_lock();
  if not exists(select 1 from public.aps_reconciliation_sessions where id=p_session_id and scope_id=p_scope_id and flow_type='screen_v2') then raise exception 'session not found' using errcode='P0002'; end if;
  perform public.aps_reconciliation_v2_snapshot(p_session_id);
  insert into public.audit_logs(actor_id,action,entity,entity_id,metadata) values(auth.uid(),'aps.reconciliation_v2_refreshed','aps_reconciliation_sessions',p_session_id::text,jsonb_build_object('version',3,'scope_id',p_scope_id));
end $$;

create function public.aps_reconciliation_v3_close_reason(p_month_id uuid, p_scope_id uuid)
returns text language plpgsql stable security definer set search_path = pg_catalog, public as $$
begin
  if not exists(select 1 from public.aps_reconciliation_sessions s where s.fiscal_month_id = p_month_id and s.scope_id = p_scope_id
    and s.status = 'open' and s.flow_type = 'screen_v2') then return 'no_eligible_open_sessions'; end if;
  if exists(select 1 from public.aps_reconciliation_sessions s where s.fiscal_month_id = p_month_id and s.status = 'open' and s.flow_type = 'screen') then return 'other_open_sessions'; end if;
  if exists(select 1 from public.aps_reconciliation_sessions s where s.fiscal_month_id = p_month_id and s.scope_id = p_scope_id
    and s.status = 'open' and s.flow_type = 'screen_v2' and s.needs_review) then return 'needs_review'; end if;
  if exists(select 1 from public.aps_reconciliation_sessions s where s.fiscal_month_id = p_month_id and s.scope_id = p_scope_id
    and s.status = 'open' and s.flow_type = 'screen_v2'
    and not exists(select 1 from public.aps_reconciliation_lines l where l.session_id = s.id)) then return 'incomplete'; end if;
  if exists(select 1 from public.aps_reconciliation_sessions s join public.aps_reconciliation_lines l on l.session_id = s.id
    where s.fiscal_month_id = p_month_id and s.scope_id = p_scope_id and s.status = 'open' and s.flow_type = 'screen_v2' and l.book_year_opening is null) then return 'missing_system_opening'; end if;
  if exists(select 1 from public.aps_reconciliation_sessions s join public.aps_reconciliation_lines l on l.session_id = s.id
    where s.fiscal_month_id = p_month_id and s.scope_id = p_scope_id and s.status = 'open' and s.flow_type = 'screen_v2'
      and (l.book_inbound is null or l.book_outbound is null or l.book_year_opening is null
        or l.book_ytd_inbound is null or l.book_ytd_outbound is null
        or l.accountant_inbound is null or l.accountant_outbound is null
        or l.accountant_ytd_inbound is null or l.accountant_ytd_outbound is null)) then return 'incomplete'; end if;
  if exists(select 1 from public.aps_reconciliation_sessions s join public.aps_reconciliation_lines l on l.session_id = s.id
    where s.fiscal_month_id = p_month_id and s.scope_id = p_scope_id and s.status = 'open' and s.flow_type = 'screen_v2' and (
      l.book_inbound <> l.accountant_inbound or l.book_outbound <> l.accountant_outbound
      or l.book_inbound - l.book_outbound <> l.accountant_inbound - l.accountant_outbound
      or l.book_ytd_inbound <> l.accountant_ytd_inbound or l.book_ytd_outbound <> l.accountant_ytd_outbound
      or l.book_year_opening + l.book_ytd_inbound - l.book_ytd_outbound <>
         coalesce(l.accountant_year_opening, l.book_year_opening) + l.accountant_ytd_inbound - l.accountant_ytd_outbound
    )) then return 'nonzero_differences'; end if;
  return null;
end $$;
revoke all on function public.aps_reconciliation_v3_close_reason(uuid,uuid) from public, anon, authenticated, service_role;

create function public.aps_close_reconciliation_month_v3(p_month_id uuid, p_scope_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_actor uuid := auth.uid(); v_reason text := btrim(coalesce(p_reason,'')); v_block text;
begin
  if v_actor is null or not coalesce(public.is_active_user(), false)
     or not coalesce(public.has_permission('aps.reconciliation:close_month'), false) then
    raise exception 'reconciliation close permission required' using errcode = '42501'; end if;
  if char_length(v_reason) < 3 or char_length(v_reason) > 500 then
    raise exception 'invalid close reason' using errcode = '22023'; end if;
  perform public.aps_reconciliation_v2_lock();
  perform id from public.aps_reconciliation_sessions where fiscal_month_id = p_month_id and scope_id = p_scope_id
    and flow_type = 'screen_v2' and status = 'open' order by id for update;
  v_block := public.aps_reconciliation_v3_close_reason(p_month_id,p_scope_id);
  if v_block is not null then raise exception 'cannot close reconciliation month: %', v_block using errcode = '22023'; end if;
  with closed as (
    update public.aps_reconciliation_sessions set status = 'closed', closed_at = now(),
      closed_by = v_actor, close_reason = v_reason, snapshot_version = snapshot_version + 1
    where fiscal_month_id = p_month_id and scope_id = p_scope_id and flow_type = 'screen_v2' and status = 'open'
    returning id
  ) insert into public.audit_logs(actor_id, action, entity, entity_id, metadata)
  select v_actor, 'aps.reconciliation_closed'::public.audit_action, 'aps_reconciliation_sessions', id::text,
    jsonb_build_object('fiscal_month_id', p_month_id, 'reason', v_reason, 'scope_id', p_scope_id, 'version', 3) from closed;
end $$;
revoke all on function public.aps_close_reconciliation_month_v3(uuid,uuid,text) from public, anon, authenticated, service_role;
grant execute on function public.aps_close_reconciliation_month_v3(uuid,uuid,text) to authenticated;

create function public.aps_reopen_reconciliation_month_v3(p_month_id uuid, p_scope_id uuid, p_reason text)
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
  if exists(select 1 from public.aps_reconciliation_sessions o where o.fiscal_month_id = p_month_id and o.status = 'open' and (o.flow_type='screen' or (o.flow_type='screen_v2' and o.scope_id=p_scope_id))) then
    raise exception 'month has conflicting open sessions' using errcode = '22023'; end if;
  if not exists(select 1 from public.aps_reconciliation_sessions where fiscal_month_id = p_month_id and scope_id = p_scope_id
    and flow_type = 'screen_v2' and status = 'closed') then
    raise exception 'no closed v2 sessions' using errcode = 'P0002'; end if;
  with reopened as (
    update public.aps_reconciliation_sessions set status = 'open', closed_at = null, closed_by = null, close_reason = null,
      needs_review = true, review_reason = 'reopened', review_required_at = now(), snapshot_version = snapshot_version + 1
    where fiscal_month_id = p_month_id and scope_id = p_scope_id and flow_type = 'screen_v2' and status = 'closed'
    returning id
  ) insert into public.audit_logs(actor_id, action, entity, entity_id, metadata)
  select v_actor, 'aps.reconciliation_reopened'::public.audit_action, 'aps_reconciliation_sessions', id::text,
    jsonb_build_object('fiscal_month_id', p_month_id, 'reason', v_reason, 'scope_id', p_scope_id, 'version', 3) from reopened;
end $$;
revoke all on function public.aps_reopen_reconciliation_month_v3(uuid,uuid,text) from public, anon, authenticated, service_role;
grant execute on function public.aps_reopen_reconciliation_month_v3(uuid,uuid,text) to authenticated;



create or replace function public.aps_reconciliation_v2_close_reason(p_month_id uuid)
returns text language sql stable security definer set search_path=pg_catalog,public as $$
  select public.aps_reconciliation_v3_close_reason(p_month_id,public.aps_reconciliation_default_scope_id())
$$;
create or replace function public.aps_close_reconciliation_month_v2(p_month_id uuid,p_reason text)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if auth.uid() is null or not coalesce(public.is_active_user(),false) or not coalesce(public.has_permission('aps.reconciliation:close_month'),false) then raise exception 'reconciliation close permission required' using errcode='42501'; end if;
  perform public.aps_reconciliation_v2_lock();
  if exists(select 1 from public.aps_reconciliation_sessions where fiscal_month_id=p_month_id and scope_id=public.aps_reconciliation_default_scope_id() and flow_type='screen_v2' and config_generation<>1) then
    raise exception 'v2 client cannot change reconfigured session' using errcode='40001'; end if;
  perform public.aps_close_reconciliation_month_v3(p_month_id,public.aps_reconciliation_default_scope_id(),p_reason);
end $$;
create or replace function public.aps_reopen_reconciliation_month_v2(p_month_id uuid,p_reason text)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if auth.uid() is null or not coalesce(public.is_active_user(),false) or not exists(select 1 from public.user_roles ur join public.roles r on r.id=ur.role_id where ur.user_id=auth.uid() and r.slug='owner') then raise exception 'owner role required' using errcode='42501'; end if;
  perform public.aps_reconciliation_v2_lock();
  if exists(select 1 from public.aps_reconciliation_sessions where fiscal_month_id=p_month_id and scope_id=public.aps_reconciliation_default_scope_id() and flow_type='screen_v2' and config_generation<>1) then
    raise exception 'v2 client cannot change reconfigured session' using errcode='40001'; end if;
  perform public.aps_reopen_reconciliation_month_v3(p_month_id,public.aps_reconciliation_default_scope_id(),p_reason);
end $$;

create function public.aps_get_reconciliation_state_v3(p_month_id uuid, p_scope_id uuid,
  p_offset integer default 0, p_limit integer default 50)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare v_result jsonb; v_block text;
begin
  if auth.uid() is null or not coalesce(public.is_active_user(), false) or not (
    coalesce(public.has_permission('aps.reconciliation:manage'),false)
    or coalesce(public.has_permission('aps.reconciliation:close_month'),false)
    or coalesce(public.has_permission('aps.reconciliation:reopen_month'),false)) then
    raise exception 'reconciliation permission required' using errcode = '42501'; end if;
  if p_month_id is null or p_scope_id is null or p_offset is null or p_limit is null
     or p_offset < 0 or p_limit < 1 or p_limit > 100 then
    raise exception 'invalid read arguments' using errcode = '22023'; end if;
  if not exists(select 1 from public.fiscal_months where id = p_month_id) then
    raise exception 'unknown month' using errcode = 'P0002'; end if;
  if not exists(select 1 from public.aps_reconciliation_scopes where id=p_scope_id) then raise exception 'scope not found' using errcode='P0002'; end if;
  v_block := public.aps_reconciliation_v3_close_reason(p_month_id,p_scope_id);
  with selected as materialized (
    select s.* from public.aps_reconciliation_sessions s
    where s.fiscal_month_id = p_month_id and s.scope_id=p_scope_id and s.flow_type = 'screen_v2'
      and s.status in ('open','closed') order by (s.status = 'open') desc, s.sequence_number desc, s.id desc limit 1
  ), page as materialized (
    select l.*, cfg.classification_name from selected s
    join public.aps_reconciliation_lines l on l.session_id = s.id
    join public.aps_reconciliation_settings cfg on cfg.revision_id = s.settings_revision_id
      and cfg.classification_id = l.classification_id
    order by l.classification_id, l.id offset p_offset limit p_limit + 1
  )
  select jsonb_build_object(
    'current_config_revision_id',(select revision_id from public.aps_reconciliation_v3_configs() where scope_id=p_scope_id),
    'fiscal_month', (select jsonb_build_object('id', fm.id, 'is_active', fm.is_active, 'is_fiscal_closed', fm.is_closed)
      from public.fiscal_months fm where fm.id = p_month_id),
    'selected_session', (select jsonb_build_object('id',s.id,'status',s.status,'flow_type',s.flow_type,
      'scope_id',s.scope_id,'scope_name_snapshot',s.scope_name_snapshot,'settings_revision_id',s.settings_revision_id,'source_config_revision_id',s.source_config_revision_id,'config_generation',s.config_generation::text,'needs_review',s.needs_review,'review_reason',s.review_reason,
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
      'open_sessions_count',(select count(*) from public.aps_reconciliation_sessions where fiscal_month_id=p_month_id and scope_id=p_scope_id and status='open' and flow_type='screen_v2'),
      'closed_sessions_count',(select count(*) from public.aps_reconciliation_sessions where fiscal_month_id=p_month_id and scope_id=p_scope_id and status='closed' and flow_type='screen_v2'),
      'missing_system_opening_count',(select count(*) from selected s join public.aps_reconciliation_lines l on l.session_id=s.id where l.book_year_opening is null)),
    'pagination',jsonb_build_object('offset',p_offset,'limit',p_limit,'has_more',(select count(*) > p_limit from page)),
    'historical_overlap', exists(select 1 from selected chosen join public.aps_reconciliation_settings_members a on a.revision_id=chosen.settings_revision_id join public.aps_reconciliation_settings_members b on b.leaf_id=a.leaf_id join public.aps_reconciliation_sessions other on other.settings_revision_id=b.revision_id where other.fiscal_month_id=p_month_id and other.scope_id<>p_scope_id and other.flow_type='screen_v2' and other.status in ('open','closed')),
    'flags',jsonb_build_object('can_close_now',v_block is null,'close_blocked_reason',v_block,
      'settings_changed',(select case when s.source_config_revision_id is null then null
        else s.source_config_revision_id is distinct from (select cfg.revision_id from public.aps_reconciliation_v3_configs() cfg where cfg.scope_id=p_scope_id) end from selected s),
      'can_sync_from_settings',coalesce(public.aps_can_manage_reconciliation(),false) and exists(select 1 from selected s
        join public.aps_reconciliation_scopes sc on sc.id=s.scope_id and sc.is_active
        where s.status='open' and exists(select 1 from public.aps_reconciliation_v3_configs() cfg where cfg.scope_id=p_scope_id)
        and not exists(select 1 from public.aps_reconciliation_lines l where l.session_id=s.id and
          (l.accountant_inbound is not null or l.accountant_outbound is not null or l.accountant_year_opening is not null or
           l.accountant_ytd_inbound is not null or l.accountant_ytd_outbound is not null or l.v2_recorded_at is not null or l.v2_recorded_by is not null))
        and not exists(select 1 from public.audit_logs a where a.action='aps.reconciliation_v2_recorded' and a.metadata->>'session_id'=s.id::text)))
  ) into v_result;
  return v_result;
end $$;
revoke all on function public.aps_get_reconciliation_state_v3(uuid,uuid,integer,integer) from public, anon, authenticated, service_role;
grant execute on function public.aps_get_reconciliation_state_v3(uuid,uuid,integer,integer) to authenticated;


create or replace function public.aps_get_reconciliation_state_v2(p_month_id uuid,p_offset integer default 0,p_limit integer default 50)
returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
  select public.aps_get_reconciliation_state_v3(p_month_id,public.aps_reconciliation_default_scope_id(),p_offset,p_limit)
$$;
create function public.aps_get_reconciliation_sync_history_v3(p_session_id uuid,p_scope_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
begin
  if auth.uid() is null or not coalesce(public.is_active_user(),false) or not (
    coalesce(public.has_permission('aps.reconciliation:manage'),false) or
    coalesce(public.has_permission('aps.reconciliation:close_month'),false) or
    coalesce(public.has_permission('aps.reconciliation:reopen_month'),false)) then
    raise exception 'reconciliation permission required' using errcode='42501'; end if;
  if not exists(select 1 from public.aps_reconciliation_sessions where id=p_session_id and scope_id=p_scope_id and flow_type='screen_v2') then
    raise exception 'session not found' using errcode='P0002'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id',h.id,'old_revision_id',h.old_revision_id,
    'old_source_config_revision_id',h.old_source_config_revision_id,'new_revision_id',h.new_revision_id,
    'new_source_config_revision_id',h.new_source_config_revision_id,'old_generation',h.old_generation::text,
    'lines',h.lines,'actor_id',h.actor_id,'created_at',h.created_at,
    'classifications',coalesce((select jsonb_agg(jsonb_build_object('id',c.classification_id,'name',c.classification_name,
      'leaf_ids',coalesce((select jsonb_agg(m.leaf_id order by m.leaf_id) from public.aps_reconciliation_settings_members m
        where m.revision_id=c.revision_id and m.classification_id=c.classification_id),'[]'::jsonb)) order by c.classification_id)
      from public.aps_reconciliation_settings c where c.revision_id=h.old_revision_id),'[]'::jsonb)) order by h.created_at,h.id)
    from public.aps_reconciliation_sync_history h where h.session_id=p_session_id and h.scope_id=p_scope_id),'[]'::jsonb);
end $$;
revoke all on function public.aps_get_reconciliation_sync_history_v3(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.aps_get_reconciliation_sync_history_v3(uuid,uuid) to authenticated;

revoke all on function public.aps_open_reconciliation_v3(uuid,uuid),public.aps_sync_empty_reconciliation_v3(uuid,uuid,bigint,bigint,uuid),
 public.aps_record_reconciliation_v2(uuid,uuid,numeric,numeric,numeric,numeric,numeric,bigint),
 public.aps_record_reconciliation_v3(uuid,uuid,uuid,uuid,bigint,bigint,numeric,numeric,numeric,numeric,numeric),
 public.aps_refresh_reconciliation_v3(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.aps_open_reconciliation_v3(uuid,uuid),public.aps_sync_empty_reconciliation_v3(uuid,uuid,bigint,bigint,uuid),
 public.aps_record_reconciliation_v2(uuid,uuid,numeric,numeric,numeric,numeric,numeric,bigint),
 public.aps_record_reconciliation_v3(uuid,uuid,uuid,uuid,bigint,bigint,numeric,numeric,numeric,numeric,numeric),
 public.aps_refresh_reconciliation_v3(uuid,uuid) to authenticated;
notify pgrst, 'reload schema';
