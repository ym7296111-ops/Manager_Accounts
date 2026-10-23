-- Harden first-admin preflight and audit-log integrity without rewriting history.
--
-- The readiness RPC is read-only and is callable only by service_role. Audit
-- writes remain available to database-owned SECURITY DEFINER workflows, while
-- API roles cannot forge audit rows or mutate existing ones. Metadata is
-- recursively minimized on every write and existing email-bearing metadata is
-- scrubbed once as part of this forward-only migration.

create or replace function public.check_bootstrap_readiness()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_super_admin_seeded boolean := false;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Operation not permitted'
      using errcode = '42501';
  end if;

  if to_regclass('auth.users') is null
     or to_regclass('public.profiles') is null
     or to_regclass('public.roles') is null
     or to_regclass('public.permissions') is null
     or to_regclass('public.role_permissions') is null
     or to_regclass('public.user_roles') is null
     or to_regclass('public.audit_logs') is null then
    return jsonb_build_object(
      'ready', false,
      'message', 'Required bootstrap tables are missing.'
    );
  end if;

  if exists (
    select 1
      from (values
        ('auth.users', 'id'),
        ('auth.users', 'email'),
        ('auth.users', 'email_confirmed_at'),
        ('public.profiles', 'id'),
        ('public.profiles', 'status'),
        ('public.roles', 'id'),
        ('public.roles', 'slug'),
        ('public.roles', 'is_super_admin'),
        ('public.permissions', 'id'),
        ('public.permissions', 'slug'),
        ('public.role_permissions', 'role_id'),
        ('public.role_permissions', 'permission_id'),
        ('public.user_roles', 'user_id'),
        ('public.user_roles', 'role_id'),
        ('public.audit_logs', 'action'),
        ('public.audit_logs', 'entity'),
        ('public.audit_logs', 'entity_id'),
        ('public.audit_logs', 'metadata'),
        ('public.audit_logs', 'actor_type'),
        ('public.audit_logs', 'actor_ref')
      ) as required(relation_name, column_name)
     where not exists (
       select 1
         from pg_catalog.pg_attribute as a
        where a.attrelid = to_regclass(required.relation_name)
          and a.attname = required.column_name
          and a.attnum > 0
          and not a.attisdropped
     )
  ) then
    return jsonb_build_object(
      'ready', false,
      'message', 'Required bootstrap columns are missing.'
    );
  end if;

  if to_regprocedure('public.bootstrap_first_super_admin(text)') is null then
    return jsonb_build_object(
      'ready', false,
      'message', 'The first-admin bootstrap RPC is not installed.'
    );
  end if;

  select exists (
    select 1
      from public.roles as r
      join public.role_permissions as rp on rp.role_id = r.id
      join public.permissions as p on p.id = rp.permission_id
     where r.slug = 'super_admin'
       and r.is_super_admin is true
       and p.slug = '*'
  ) into v_super_admin_seeded;

  if not v_super_admin_seeded then
    return jsonb_build_object(
      'ready', false,
      'message', 'The super_admin role and wildcard permission are not seeded.'
    );
  end if;

  if exists (
    select 1
      from public.user_roles as ur
      join public.roles as r on r.id = ur.role_id
     where r.slug = 'super_admin'
        or r.is_super_admin
  ) then
    return jsonb_build_object(
      'ready', false,
      'message', 'A super_admin assignment already exists.'
    );
  end if;

  if exists (
    select 1
      from public.audit_logs as al
     where al.action = 'role.granted'::public.audit_action
       and al.entity = 'user_roles'
       and al.metadata ->> 'bootstrap_method' in (
         'scripts/sql/grant-first-super-admin.sql',
         'scripts/bootstrap-admin.ts'
       )
  ) then
    return jsonb_build_object(
      'ready', false,
      'message', 'The first-admin bootstrap has already been used.'
    );
  end if;

  return jsonb_build_object(
    'ready', true,
    'message', 'Bootstrap readiness checks passed.'
  );
end;
$$;

revoke all on function public.check_bootstrap_readiness()
  from public, anon, authenticated, service_role;
grant execute on function public.check_bootstrap_readiness()
  to service_role;

comment on function public.check_bootstrap_readiness() is
  'Read-only first-admin preflight. Returns a fixed readiness result and never changes Auth, RBAC, or audit state.';

-- Remove direct API access to the fake-write helper. Approved audit-producing
-- RPCs are SECURITY DEFINER and continue to write atomically as their owner.
revoke all on function public.write_audit_log(public.audit_action, text, text, jsonb)
  from public, anon, authenticated, service_role;

-- Existing migrations granted broad table DML to API roles. Remove every
-- non-owner DML/trigger/reference grant while preserving SELECT grants.
revoke insert, update, delete, truncate, references, trigger
  on table public.audit_logs
  from public, anon, authenticated, service_role;

do $audit_acl_lockdown$
declare
  v_table_oid oid := 'public.audit_logs'::regclass;
  v_role record;
begin
  for v_role in
    select distinct grantee.rolname
      from pg_catalog.pg_class as c
      cross join lateral pg_catalog.aclexplode(
        coalesce(c.relacl, pg_catalog.acldefault('r', c.relowner))
      ) as acl
      join pg_catalog.pg_roles as grantee on grantee.oid = acl.grantee
     where c.oid = v_table_oid
       and acl.grantee <> c.relowner
       and not grantee.rolsuper
       and acl.privilege_type in (
         'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
       )
  loop
    execute format(
      'revoke insert, update, delete, truncate, references, trigger on table public.audit_logs from %I',
      v_role.rolname
    );
  end loop;
end
$audit_acl_lockdown$;

-- Recursively remove sensitive metadata fields and mask email addresses that
-- appear in otherwise innocuous string values. Keep UUIDs and operational
-- fields useful for audit correlation.
create or replace function public.audit_metadata_without_sensitive_fields(p_metadata jsonb)
returns jsonb
language plpgsql
immutable
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_result jsonb;
  v_entry record;
  v_text text;
begin
  if p_metadata is null then
    return '{}'::jsonb;
  end if;

  case jsonb_typeof(p_metadata)
    when 'object' then
      v_result := '{}'::jsonb;
      for v_entry in
        select e.key, e.value
          from jsonb_each(p_metadata) as e
      loop
        if lower(v_entry.key) like '%email%'
           or lower(v_entry.key) like '%phone%'
           or lower(v_entry.key) = any (array[
             'password', 'passwd', 'secret', 'api_key', 'service_role_key',
             'access_token', 'refresh_token', 'token', 'authorization',
             'smtp_password', 'ip_address', 'user_agent', 'subject', 'body',
             'message', 'content', 'html', 'text'
           ]::text[])
           or v_entry.key ~* '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' then
          continue;
        end if;

        v_result := v_result || jsonb_build_object(
          v_entry.key,
          public.audit_metadata_without_sensitive_fields(v_entry.value)
        );
      end loop;
      return v_result;

    when 'array' then
      select coalesce(
        jsonb_agg(
          public.audit_metadata_without_sensitive_fields(e.value)
          order by e.ordinality
        ),
        '[]'::jsonb
      )
        into v_result
        from jsonb_array_elements(p_metadata) with ordinality as e(value, ordinality);
      return v_result;

    when 'string' then
      v_text := p_metadata #>> '{}';
      v_text := regexp_replace(
        v_text,
        '([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*(@[A-Za-z0-9.-]+\.[A-Za-z]{2,})',
        '\1***\2',
        'gi'
      );
      return to_jsonb(v_text);

    else
      return p_metadata;
  end case;
end;
$$;

revoke all on function public.audit_metadata_without_sensitive_fields(jsonb)
  from public, anon, authenticated, service_role;

create or replace function public.audit_logs_sanitize_metadata()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  new.metadata := public.audit_metadata_without_sensitive_fields(
    coalesce(new.metadata, '{}'::jsonb)
  );
  return new;
end;
$$;

revoke all on function public.audit_logs_sanitize_metadata()
  from public, anon, authenticated, service_role;

drop trigger if exists audit_logs_sanitize_metadata on public.audit_logs;
create trigger audit_logs_sanitize_metadata
  before insert or update on public.audit_logs
  for each row
  execute function public.audit_logs_sanitize_metadata();

-- Keep the SECURITY DEFINER audit helper useful only to its trusted caller.
-- The only current caller is admin_set_role_permissions, which writes this
-- fixed action/entity pair after validating the requested role diff. Requiring
-- both values also protects the helper if a future definer RPC accidentally
-- exposes it with caller-controlled parameters.
create or replace function public.write_audit_log(
  p_action public.audit_action,
  p_entity text default null,
  p_entity_id text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_action is distinct from 'role.permissions_updated'::public.audit_action
     or p_entity is distinct from 'role_permissions' then
    raise exception 'write_audit_log: action/entity pair is not allowed'
      using errcode = '22023';
  end if;

  if auth.uid() is null or not public.is_active_user() then
    raise exception 'write_audit_log: caller is not an active authenticated user'
      using errcode = '42501';
  end if;

  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
  values (auth.uid(), p_action, p_entity, p_entity_id, coalesce(p_metadata, '{}'::jsonb));
end;
$$;

revoke all on function public.write_audit_log(public.audit_action, text, text, jsonb)
  from public, anon, authenticated, service_role;

-- Sanitize pre-existing rows as well as future writes.
update public.audit_logs
   set metadata = public.audit_metadata_without_sensitive_fields(metadata)
 where metadata is distinct from public.audit_metadata_without_sensitive_fields(metadata);

-- Fail migration if any API role retained a direct audit-table mutation path.
do $audit_acl_verify$
declare
  v_role text;
  v_privilege text;
begin
  foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
    foreach v_privilege in array array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] loop
      if has_table_privilege(v_role, 'public.audit_logs', v_privilege) then
        raise exception 'API role % still has % privilege on public.audit_logs',
          v_role, v_privilege;
      end if;
    end loop;
  end loop;

  if has_function_privilege(
       'authenticated',
       'public.write_audit_log(public.audit_action,text,text,jsonb)',
       'EXECUTE'
     )
     or has_function_privilege(
       'service_role',
       'public.write_audit_log(public.audit_action,text,text,jsonb)',
       'EXECUTE'
     ) then
    raise exception 'An API role can still execute public.write_audit_log';
  end if;
end
$audit_acl_verify$;

-- Redefinition lives in this forward migration; historical migrations remain
-- untouched. Only a UUID is persisted as target identity in audit metadata.


create or replace function public.bootstrap_first_super_admin(p_target_email text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_target_email text;
  v_target_user_count bigint;
  v_target_user_id uuid;
  v_email_confirmed_at timestamptz;
  v_profile_status public.user_status;
  v_super_admin_role_id uuid;
  v_audit_available boolean;
  v_bootstrap_already_used boolean := false;
  v_rows_inserted integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Operation not permitted'
      using errcode = '42501';
  end if;

  v_target_email := lower(btrim(coalesce(p_target_email, '')));

  if v_target_email = ''
     or length(v_target_email) > 320
     or position('@' in v_target_email) < 2
     or position('@' in v_target_email) = length(v_target_email) then
    raise exception 'Bootstrap refused: a valid target email is required.';
  end if;

  if v_target_email = 'admin@example.com' then
    raise exception 'Bootstrap refused: admin@example.com is reserved by the demo seed.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('admin_authority_invariant', 0));
  lock table public.profiles,
             public.user_roles,
             public.roles,
             public.role_permissions
    in share row exclusive mode;

  select count(*)
    into v_target_user_count
    from auth.users as u
   where lower(btrim(u.email)) = v_target_email;

  if v_target_user_count = 0 then
    raise exception 'Bootstrap refused: no auth.users account exists for %.', v_target_email;
  elsif v_target_user_count > 1 then
    raise exception 'Bootstrap refused: more than one Auth account matches %.', v_target_email;
  end if;

  select u.id, u.email_confirmed_at
    into v_target_user_id, v_email_confirmed_at
    from auth.users as u
   where lower(btrim(u.email)) = v_target_email
   for update;

  if not found then
    raise exception 'Bootstrap refused: the Auth account for % disappeared before it could be locked.',
      v_target_email;
  end if;

  if v_email_confirmed_at is null then
    raise exception 'Bootstrap refused: email % has not been confirmed.', v_target_email;
  end if;

  select p.status
    into v_profile_status
    from public.profiles as p
   where p.id = v_target_user_id
   for update;

  if not found then
    raise exception 'Bootstrap refused: profile for % (%) does not exist.',
      v_target_email, v_target_user_id;
  elsif v_profile_status is distinct from 'active'::public.user_status then
    raise exception 'Bootstrap refused: profile for % (%) is not active (status=%).',
      v_target_email, v_target_user_id, v_profile_status;
  end if;

  select r.id
    into v_super_admin_role_id
    from public.roles as r
    join public.role_permissions as rp on rp.role_id = r.id
    join public.permissions as p on p.id = rp.permission_id
   where r.slug = 'super_admin'
     and r.is_super_admin is true
     and p.slug = '*';

  if not found then
    raise exception 'Bootstrap refused: the flagged super_admin role and its * permission must be seeded first.';
  end if;

  if exists (
    select 1
      from public.user_roles as ur
      join public.roles as r on r.id = ur.role_id
     where r.slug = 'super_admin'
        or r.is_super_admin
  ) then
    raise exception 'Bootstrap refused: a super_admin assignment already exists; use the existing admin process.';
  end if;

  v_audit_available := to_regclass('public.audit_logs') is not null;
  if not v_audit_available then
    raise exception 'Bootstrap refused: public.audit_logs is unavailable; apply the core migrations first.';
  end if;

  if not exists (
       select 1 from information_schema.columns
        where table_schema = 'public'
          and table_name = 'audit_logs'
          and column_name = 'actor_type'
     )
     or not exists (
       select 1 from information_schema.columns
        where table_schema = 'public'
          and table_name = 'audit_logs'
          and column_name = 'actor_ref'
     ) then
    raise exception 'Bootstrap refused: audit_logs actor attribution columns are unavailable; apply the hardening migration first.';
  end if;

  select exists (
    select 1
      from public.audit_logs as al
     where al.action = 'role.granted'::public.audit_action
       and al.entity = 'user_roles'
       and al.metadata ->> 'bootstrap_method' in (
         'scripts/sql/grant-first-super-admin.sql',
         'scripts/bootstrap-admin.ts'
       )
  ) into v_bootstrap_already_used;

  if v_bootstrap_already_used then
    raise exception 'Bootstrap refused: first-admin setup has already been used for this project.';
  end if;

  insert into public.user_roles (user_id, role_id, granted_by)
  values (v_target_user_id, v_super_admin_role_id, null)
  on conflict (user_id, role_id) do nothing;

  get diagnostics v_rows_inserted = row_count;
  if v_rows_inserted <> 1 then
    raise exception 'Bootstrap refused: the super_admin role was not newly assigned; no audit event was written.';
  end if;

  insert into public.audit_logs (
    actor_id,
    actor_type,
    actor_ref,
    action,
    entity,
    entity_id,
    metadata
  )
  values (
    null,
    'automated_bootstrap',
    coalesce(nullif(auth.role(), ''), 'service_role'),
    'role.granted'::public.audit_action,
    'user_roles',
    v_target_user_id::text,
    jsonb_build_object(
      'role_slugs', jsonb_build_array('super_admin'),
      'target_user_id', v_target_user_id,
      'bootstrap_method', 'scripts/bootstrap-admin.ts',
      'timestamp', CURRENT_TIMESTAMP,
      'database_session_user', session_user,
      'database_definer_user', current_user
    )
  );

  return jsonb_build_object(
    'status', 'success',
    'message', 'Bootstrap completed successfully'
  );
exception
  when others then
    if sqlerrm like 'Bootstrap refused:%'
       or sqlerrm = 'Operation not permitted' then
      raise;
    end if;
    raise warning 'bootstrap_first_super_admin unexpected error: % %', sqlstate, sqlerrm;
    raise exception 'Bootstrap refused: Internal processing error (%).', sqlstate
      using errcode = 'P0001';
end;
$$;

revoke all on function public.bootstrap_first_super_admin(text)
  from public, anon, authenticated, service_role;
grant execute on function public.bootstrap_first_super_admin(text)
  to service_role;

notify pgrst, 'reload schema';
