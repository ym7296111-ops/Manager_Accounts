-- v3 scope configuration. The existing singleton remains the default scope's
-- pointer so that unmodified v2 readers keep their original contract.
create table public.aps_reconciliation_scope_current (
  scope_id uuid primary key references public.aps_reconciliation_scopes(id) on delete restrict,
  revision_id uuid not null,
  foreign key (revision_id, scope_id) references public.aps_reconciliation_settings_revisions(id, scope_id) on delete restrict
);
create table public.aps_reconciliation_scope_leaves (
  leaf_id uuid primary key references public.classifications(id) on delete restrict,
  scope_id uuid not null,
  revision_id uuid not null,
  foreign key (revision_id, scope_id) references public.aps_reconciliation_settings_revisions(id, scope_id) on delete cascade
);
alter table public.aps_reconciliation_scope_current enable row level security;
alter table public.aps_reconciliation_scope_current force row level security;
alter table public.aps_reconciliation_scope_leaves enable row level security;
alter table public.aps_reconciliation_scope_leaves force row level security;
revoke all on public.aps_reconciliation_scope_current, public.aps_reconciliation_scope_leaves
  from public, anon, authenticated, service_role;

-- Fail closed if a deployment role inherits privileges via an unexpected role.
do $private_grants$
declare v_table text; v_role text; v_privilege text;
begin
  foreach v_table in array array['public.aps_reconciliation_scope_current','public.aps_reconciliation_scope_leaves'] loop
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

-- The legacy singleton pointer is physically restricted to the default scope.
create function public.aps_reconciliation_v3_default_pointer_guard()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if not exists(select 1 from public.aps_reconciliation_settings_revisions r
    where r.id=new.revision_id and r.scope_id=public.aps_reconciliation_default_scope_id()) then
    raise exception 'default settings must refer to the default scope' using errcode='23514';
  end if;
  return new;
end $$;
revoke all on function public.aps_reconciliation_v3_default_pointer_guard() from public,anon,authenticated,service_role;
create trigger aps_reconciliation_v3_default_pointer_guard before insert or update on public.aps_reconciliation_settings_current
  for each row execute function public.aps_reconciliation_v3_default_pointer_guard();

create function public.aps_reconciliation_v3_configs()
returns table(scope_id uuid, revision_id uuid) language sql stable security definer
set search_path = pg_catalog, public as $$
  select public.aps_reconciliation_default_scope_id(), c.revision_id
    from public.aps_reconciliation_settings_current c where c.singleton
  union all
  select c.scope_id, c.revision_id from public.aps_reconciliation_scope_current c
    join public.aps_reconciliation_scopes s on s.id=c.scope_id where not s.is_default
$$;
revoke all on function public.aps_reconciliation_v3_configs() from public, anon, authenticated, service_role;

-- Re-resolve the live hierarchy; the unique leaf key is the physical invariant.
-- All callers serialize with v2 writes. Rebuilding is transactional: on a
-- duplicate or failed hierarchy edit both the source and ownership roll back.
create function public.aps_reconciliation_v3_rebuild_ownership()
returns void language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  delete from public.aps_reconciliation_scope_leaves;
  begin
    insert into public.aps_reconciliation_scope_leaves(leaf_id,scope_id,revision_id)
    with recursive tree(scope_id, revision_id, root, id) as (
      select cfg.scope_id, cfg.revision_id, s.classification_id, s.classification_id
      from public.aps_reconciliation_v3_configs() cfg
      join public.aps_reconciliation_scopes scope on scope.id=cfg.scope_id and scope.is_active
      join public.aps_reconciliation_settings s on s.revision_id=cfg.revision_id
      union all
      select t.scope_id,t.revision_id,t.root,c.id from tree t
      join public.classifications c on c.parent_id=t.id
    )
    select distinct c.id,t.scope_id,t.revision_id from tree t
    join public.classifications c on c.id=t.id where c.is_leaf;
  exception when unique_violation then
    raise exception 'reconciliation classifications overlap between scopes' using errcode='22023';
  end;
end $$;
revoke all on function public.aps_reconciliation_v3_rebuild_ownership() from public, anon, authenticated, service_role;
select public.aps_reconciliation_v3_rebuild_ownership();

create function public.aps_reconciliation_v3_hierarchy_changed()
returns trigger language plpgsql security definer set search_path=pg_catalog, public as $$
begin
  perform public.aps_reconciliation_v2_lock();
  perform public.aps_reconciliation_v3_rebuild_ownership();
  return null;
end $$;
revoke all on function public.aps_reconciliation_v3_hierarchy_changed() from public, anon, authenticated, service_role;
create trigger aps_reconciliation_v3_hierarchy_changed
  after insert or update or delete on public.classifications
  for each statement execute function public.aps_reconciliation_v3_hierarchy_changed();

create function public.aps_reconciliation_v3_require_settings()
returns void language plpgsql stable security definer set search_path=pg_catalog,public as $$
begin
  if auth.uid() is null or not coalesce(public.is_active_user(),false)
    or not coalesce(public.has_permission('aps.reconciliation:settings'),false) then
    raise exception 'reconciliation settings permission required' using errcode='42501';
  end if;
end $$;
revoke all on function public.aps_reconciliation_v3_require_settings() from public, anon, authenticated, service_role;

create function public.aps_create_reconciliation_scope_v3(p_name text)
returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_id uuid; v_name text := btrim(coalesce(p_name,''));
begin
  perform public.aps_reconciliation_v3_require_settings();
  if char_length(v_name) not between 1 and 200 then raise exception 'invalid scope name' using errcode='22023'; end if;
  perform public.aps_reconciliation_v2_lock();
  insert into public.aps_reconciliation_scopes(name,created_by) values(v_name,auth.uid()) returning id into v_id;
  insert into public.audit_logs(actor_id,action,entity,entity_id,metadata)
    values(auth.uid(),'aps.reconciliation_settings_changed','aps_reconciliation_scopes',v_id::text,jsonb_build_object('operation','create','name',v_name));
  return v_id;
end $$;

create function public.aps_rename_reconciliation_scope_v3(p_scope_id uuid,p_name text)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_name text := btrim(coalesce(p_name,'')); v_old text;
begin
  perform public.aps_reconciliation_v3_require_settings();
  if char_length(v_name) not between 1 and 200 then raise exception 'invalid scope name' using errcode='22023'; end if;
  perform public.aps_reconciliation_v2_lock();
  select name into v_old from public.aps_reconciliation_scopes where id=p_scope_id for update;
  if not found then raise exception 'scope not found' using errcode='P0002'; end if;
  update public.aps_reconciliation_scopes set name=v_name,updated_at=now() where id=p_scope_id;
  insert into public.audit_logs(actor_id,action,entity,entity_id,metadata)
    values(auth.uid(),'aps.reconciliation_settings_changed','aps_reconciliation_scopes',p_scope_id::text,jsonb_build_object('operation','rename','old_name',v_old,'name',v_name));
end $$;

create function public.aps_archive_reconciliation_scope_v3(p_scope_id uuid)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_scope public.aps_reconciliation_scopes%rowtype;
begin
  perform public.aps_reconciliation_v3_require_settings();
  perform public.aps_reconciliation_v2_lock();
  lock table public.classifications in share mode;
  select * into v_scope from public.aps_reconciliation_scopes where id=p_scope_id for update;
  if not found then raise exception 'scope not found' using errcode='P0002'; end if;
  if v_scope.is_default then raise exception 'default scope cannot be archived' using errcode='22023'; end if;
  if not v_scope.is_active then raise exception 'scope already archived' using errcode='22023'; end if;
  update public.aps_reconciliation_scopes set is_active=false,updated_at=now() where id=p_scope_id;
  perform public.aps_reconciliation_v3_rebuild_ownership();
  insert into public.audit_logs(actor_id,action,entity,entity_id,metadata)
    values(auth.uid(),'aps.reconciliation_settings_changed','aps_reconciliation_scopes',p_scope_id::text,jsonb_build_object('operation','archive','name',v_scope.name));
end $$;

create function public.aps_get_reconciliation_scopes_v3()
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
begin
  if auth.uid() is null or not coalesce(public.is_active_user(),false) or not (
     coalesce(public.has_permission('aps.reconciliation:settings'),false) or
     coalesce(public.has_permission('aps.reconciliation:manage'),false) or
     coalesce(public.has_permission('aps.reconciliation:close_month'),false) or
     coalesce(public.has_permission('aps.reconciliation:reopen_month'),false)) then
    raise exception 'reconciliation permission required' using errcode='42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'is_active',is_active,'is_default',is_default) order by is_default desc,name,id) from public.aps_reconciliation_scopes),'[]'::jsonb);
end $$;

create function public.aps_set_reconciliation_settings_v3(p_scope_id uuid,p_classifications uuid[],p_expected_revision uuid)
returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_revision uuid; v_current uuid; v_default boolean;
begin
  perform public.aps_reconciliation_v3_require_settings();
  perform public.aps_reconciliation_v2_lock();
  lock table public.classifications in share mode;
  select is_default into v_default from public.aps_reconciliation_scopes where id=p_scope_id and is_active for update;
  if not found then raise exception 'active scope not found' using errcode='P0002'; end if;
  select revision_id into v_current from public.aps_reconciliation_v3_configs() where scope_id=p_scope_id;
  if v_current is distinct from p_expected_revision then raise exception 'settings changed concurrently' using errcode='40001'; end if;
  if p_classifications is null or array_position(p_classifications,null) is not null or cardinality(p_classifications)=0
     or cardinality(p_classifications)<>(select count(distinct x.id) from unnest(p_classifications) x(id))
     or exists(select 1 from unnest(p_classifications) x(id) left join public.classifications c on c.id=x.id where c.id is null or not c.is_active) then
    raise exception 'invalid or empty reconciliation classifications' using errcode='22023'; end if;
  insert into public.aps_reconciliation_settings_revisions(created_by,scope_id) values(auth.uid(),p_scope_id) returning id into v_revision;
  insert into public.aps_reconciliation_settings(revision_id,classification_id,classification_name)
    select v_revision,id,name from public.classifications where id=any(p_classifications);
  begin
    insert into public.aps_reconciliation_settings_members(revision_id,classification_id,leaf_id)
    with recursive tree(root,id) as (
      select x.id,x.id from unnest(p_classifications) x(id)
      union all select t.root,c.id from tree t join public.classifications c on c.parent_id=t.id
    ) select v_revision,t.root,c.id from tree t join public.classifications c on c.id=t.id where c.is_leaf;
  exception when unique_violation then raise exception 'overlapping reconciliation classifications' using errcode='22023'; end;
  if exists(select 1 from public.aps_reconciliation_settings s where s.revision_id=v_revision
    and not exists(select 1 from public.aps_reconciliation_settings_members m where m.revision_id=v_revision and m.classification_id=s.classification_id)) then
    raise exception 'classification has no leaves' using errcode='22023'; end if;
  if v_default then
    insert into public.aps_reconciliation_settings_current(singleton,revision_id) values(true,v_revision)
      on conflict(singleton) do update set revision_id=excluded.revision_id;
  else
    insert into public.aps_reconciliation_scope_current(scope_id,revision_id) values(p_scope_id,v_revision)
      on conflict(scope_id) do update set revision_id=excluded.revision_id;
  end if;
  perform public.aps_reconciliation_v3_rebuild_ownership();
  insert into public.audit_logs(actor_id,action,entity,entity_id,metadata)
    values(auth.uid(),'aps.reconciliation_settings_changed','aps_reconciliation_settings_revisions',v_revision::text,
      jsonb_build_object('scope_id',p_scope_id,'previous_revision_id',v_current,'classifications',p_classifications));
  return v_revision;
end $$;

create function public.aps_get_reconciliation_settings_v3(p_scope_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare v_revision uuid;
begin
  perform public.aps_reconciliation_v3_require_settings();
  if not exists(select 1 from public.aps_reconciliation_scopes where id=p_scope_id) then raise exception 'scope not found' using errcode='P0002'; end if;
  select revision_id into v_revision from public.aps_reconciliation_v3_configs() where scope_id=p_scope_id;
  return jsonb_build_object('scope_id',p_scope_id,'revision_id',v_revision,
    'classifications',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'name',c.name,'parent_id',c.parent_id,'is_leaf',c.is_leaf,'is_active',c.is_active) order by c.name,c.id) from public.classifications c),'[]'::jsonb),
    'selected',coalesce((select jsonb_agg(s.classification_id order by s.classification_id) from public.aps_reconciliation_settings s where s.revision_id=v_revision),'[]'::jsonb));
end $$;

-- Keep the v2 setter as a default-scope wrapper, including ownership checks.
create or replace function public.aps_set_reconciliation_settings_v2(p_classifications uuid[])
returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_current uuid;
begin
  perform public.aps_reconciliation_v3_require_settings();
  perform public.aps_reconciliation_v2_lock();
  select revision_id into v_current from public.aps_reconciliation_settings_current where singleton;
  return public.aps_set_reconciliation_settings_v3(public.aps_reconciliation_default_scope_id(),p_classifications,v_current);
end $$;

revoke all on function public.aps_create_reconciliation_scope_v3(text), public.aps_rename_reconciliation_scope_v3(uuid,text),
  public.aps_archive_reconciliation_scope_v3(uuid), public.aps_get_reconciliation_scopes_v3(),
  public.aps_set_reconciliation_settings_v3(uuid,uuid[],uuid), public.aps_get_reconciliation_settings_v3(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.aps_create_reconciliation_scope_v3(text), public.aps_rename_reconciliation_scope_v3(uuid,text),
  public.aps_archive_reconciliation_scope_v3(uuid), public.aps_get_reconciliation_scopes_v3(),
  public.aps_set_reconciliation_settings_v3(uuid,uuid[],uuid), public.aps_get_reconciliation_settings_v3(uuid) to authenticated;
notify pgrst, 'reload schema';
