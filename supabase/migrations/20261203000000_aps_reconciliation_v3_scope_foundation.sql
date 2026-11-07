-- Foundation only: existing v2 remains a single-default-scope workflow until
-- the scoped RPCs and their compatibility guards are installed. Do not enable
-- additional scopes through clients using this migration alone.
create table public.aps_reconciliation_scopes (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 200),
  is_default boolean not null default false,
  is_active boolean not null default true,
  created_by uuid references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (not is_default or is_active)
);
create unique index aps_reconciliation_one_default_scope
  on public.aps_reconciliation_scopes (is_default) where is_default;
insert into public.aps_reconciliation_scopes(name, is_default)
values ('النطاق الافتراضي', true);

alter table public.aps_reconciliation_scopes enable row level security;
alter table public.aps_reconciliation_scopes force row level security;
revoke all on public.aps_reconciliation_scopes from public, anon, authenticated, service_role;

-- Fail closed if a deployment role inherits privileges via an unexpected role.
do $private_grants$
declare v_table text; v_role text; v_privilege text;
begin
  foreach v_table in array array['public.aps_reconciliation_scopes'] loop
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

create function public.aps_reconciliation_default_scope_id()
returns uuid language sql stable security definer set search_path = pg_catalog, public
as $$ select id from public.aps_reconciliation_scopes where is_default $$;
revoke all on function public.aps_reconciliation_default_scope_id() from public, anon, authenticated, service_role;

-- Every existing revision belongs to the default scope, but its source config
-- cannot be reconstructed reliably from the independently captured snapshot.
alter table public.aps_reconciliation_settings_revisions
  add column scope_id uuid references public.aps_reconciliation_scopes(id) on delete restrict;
update public.aps_reconciliation_settings_revisions
  set scope_id = public.aps_reconciliation_default_scope_id();
alter table public.aps_reconciliation_settings_revisions
  alter column scope_id set default public.aps_reconciliation_default_scope_id(),
  alter column scope_id set not null,
  add constraint aps_reconciliation_revision_scope_key unique (id, scope_id);

alter table public.aps_reconciliation_sessions
  add column scope_id uuid references public.aps_reconciliation_scopes(id) on delete restrict,
  add column source_config_revision_id uuid,
  add column config_generation bigint not null default 1 check (config_generation > 0);
alter table public.aps_reconciliation_sessions disable trigger aps_reconciliation_sessions_set_updated_at;
update public.aps_reconciliation_sessions
  set scope_id = public.aps_reconciliation_default_scope_id()
  where flow_type = 'screen_v2';
alter table public.aps_reconciliation_sessions enable trigger aps_reconciliation_sessions_set_updated_at;
alter table public.aps_reconciliation_sessions
  add constraint aps_reconciliation_session_scope_check
    check ((flow_type = 'screen_v2') = (scope_id is not null)),
  add constraint aps_reconciliation_session_revision_scope_fk
    foreign key (settings_revision_id, scope_id)
    references public.aps_reconciliation_settings_revisions(id, scope_id) on delete restrict,
  add constraint aps_reconciliation_session_source_scope_fk
    foreign key (source_config_revision_id, scope_id)
    references public.aps_reconciliation_settings_revisions(id, scope_id) on delete restrict,
  add constraint aps_reconciliation_session_legacy_source_check
    check (flow_type = 'screen_v2' or source_config_revision_id is null);

-- Preserve the v2 open RPC, which knows nothing about scopes. Scope identity is
-- never allowed to change on an existing session, including through old RPCs.
create function public.aps_reconciliation_scope_before_write()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if tg_op = 'INSERT' and new.flow_type = 'screen_v2' and new.scope_id is null then
    new.scope_id := public.aps_reconciliation_default_scope_id();
  end if;
  if tg_op = 'UPDATE' and new.scope_id is distinct from old.scope_id then
    raise exception 'reconciliation session scope cannot change' using errcode = '23514';
  end if;
  return new;
end $$;
revoke all on function public.aps_reconciliation_scope_before_write() from public, anon, authenticated, service_role;
create trigger aps_reconciliation_scope_before_write
  before insert or update on public.aps_reconciliation_sessions
  for each row execute function public.aps_reconciliation_scope_before_write();

notify pgrst, 'reload schema';
