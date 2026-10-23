-- One-time, fail-closed first-admin bootstrap RPC for the protected GitHub Actions workflow.
--
-- The service_role key is NOT allowed to write protected user_roles rows directly; the
-- existing SECURITY INVOKER trigger still rejects those writes. This narrowly scoped
-- SECURITY DEFINER RPC is the only API exception: service_role can call it, but it can
-- bootstrap only one confirmed, active user, only when the protected role and wildcard
-- permission are correctly seeded, and only when neither the manual nor automated
-- first-admin bootstrap has already been used. The role assignment and audit event are
-- atomic. Keep the service_role key in a protected GitHub Environment secret only.

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
  -- This RPC is not an alternative for authenticated application users or SQL callers.
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

  -- This address is reserved by supabase/seed.sql for a legacy/demo assignment.
  if v_target_email = 'admin@example.com' then
    raise exception 'Bootstrap refused: admin@example.com is reserved by the demo seed.';
  end if;

  -- Serialize with the regular RBAC mutation path and either bootstrap path.
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

  -- Require the protected flag AND the actual wildcard grant, not just the role slug.
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

  -- Match the manual script's fail-closed rule: even a suspended holder blocks bootstrap.
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

  -- Treat both supported first-admin procedures as one project-wide, one-time action.
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

  -- There is no authenticated human JWT on this machine-to-machine request.
  -- actor_id is NULL by design; the API role and workflow method are recorded honestly.
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
      'target_email', v_target_email,
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
    -- The failed PL/pgSQL block is rolled back before this handler runs, so the
    -- role cannot persist alone. Re-raise intentional refusals so the GitHub
    -- workflow can show the real reason; wrap only unexpected SQL errors.
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

comment on function public.bootstrap_first_super_admin(text) is
  'One-time first super_admin bootstrap. SECURITY DEFINER and executable through the API only by service_role; direct service_role writes remain blocked by guard triggers. The assignment and automated_bootstrap audit record commit atomically.';

comment on column public.audit_logs.actor_type is
  'How the actor was identified: user, db_role, manual, or automated_bootstrap. NULL on legacy rows.';
comment on column public.audit_logs.actor_ref is
  'Non-user actor identity, such as a database/API role or workflow actor. NULL when auth actor_id is used.';

notify pgrst, 'reload schema';
