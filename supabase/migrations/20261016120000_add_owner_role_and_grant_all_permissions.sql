-- Add the protected owner role, explicitly grant the full permission catalog,
-- migrate the existing first super_admin assignment, and make first Auth signup
-- receive owner. The existing super_admin role and its wildcard grant remain.

-- The previous invariant allowed exactly one protected role row. Keep both
-- existing protected roles protected, while limiting the flag to these two
-- canonical system roles (the slug itself remains unique).
drop index if exists public.idx_one_super_admin;

do $owner_protected_role_constraint$
begin
  if not exists (
    select 1
      from pg_catalog.pg_constraint
     where conrelid = 'public.roles'::regclass
       and conname = 'roles_protected_slug_check'
  ) then
    alter table public.roles
      add constraint roles_protected_slug_check
      check (not is_super_admin or slug in ('owner', 'super_admin'));
  end if;
end;
$owner_protected_role_constraint$;

comment on column public.roles.is_super_admin is
  'Marks a protected system role (owner or super_admin). Only postgres/supabase_admin may manage protected role rows or assignments; API surfaces must never create, flip, or delete this flag.';

insert into public.roles (slug, name_ar, name_en, is_super_admin, description, is_system)
values (
  'owner',
  'المالك الأصلي',
  'System Owner',
  true,
  'المالك الأصلي للنظام - يملك جميع الصلاحيات',
  true
)
on conflict (slug) do update
   set name_ar = excluded.name_ar,
       name_en = excluded.name_en,
       is_super_admin = excluded.is_super_admin,
       description = excluded.description,
       is_system = excluded.is_system
 where public.roles.name_ar is distinct from excluded.name_ar
    or public.roles.name_en is distinct from excluded.name_en
    or public.roles.is_super_admin is distinct from excluded.is_super_admin
    or public.roles.description is distinct from excluded.description
    or public.roles.is_system is distinct from excluded.is_system;

-- Give owner every permission currently in the catalog, including the existing
-- wildcard permission and each individual capability row.
insert into public.role_permissions (role_id, permission_id)
select owner_role.id, permission.id
  from public.roles as owner_role
  cross join public.permissions as permission
 where owner_role.slug = 'owner'
on conflict (role_id, permission_id) do nothing;

-- Keep the explicit-all-permissions invariant true as new catalog entries are
-- added by later migrations. This trigger is database-owned and is not an API.
create or replace function public.grant_owner_permission_after_permission_insert()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  insert into public.role_permissions (role_id, permission_id)
  select r.id, new.id
    from public.roles as r
   where r.slug = 'owner'
     and r.is_super_admin is true
  on conflict (role_id, permission_id) do nothing;

  return new;
end;
$$;

revoke all on function public.grant_owner_permission_after_permission_insert()
  from public, anon, authenticated, service_role;

drop trigger if exists permissions_grant_owner_permission on public.permissions;
create trigger permissions_grant_owner_permission
  after insert on public.permissions
  for each row execute function public.grant_owner_permission_after_permission_insert();

comment on function public.grant_owner_permission_after_permission_insert() is
  'Keeps the protected owner role explicitly granted every permission added to the catalog.';

-- Record that the one-time legacy assignment transfer ran. This avoids moving a
-- second super_admin to owner if this migration is deliberately replayed later.
alter table public.first_admin_bootstrap_state
  add column if not exists owner_role_migration_completed boolean not null default false;

comment on column public.first_admin_bootstrap_state.owner_role_migration_completed is
  'One-time marker for the owner-role migration of any existing super_admin assignment.';

do $migrate_existing_first_admin_to_owner$
declare
  v_migration_completed boolean;
  v_first_user_id uuid;
  v_owner_role_id uuid;
  v_super_admin_role_id uuid;
  v_user_id uuid;
  v_rows_changed integer := 0;
begin
  perform pg_advisory_xact_lock(hashtextextended('admin_authority_invariant', 0));
  lock table public.user_roles, public.roles in share row exclusive mode;

  select s.owner_role_migration_completed, s.first_user_id
    into v_migration_completed, v_first_user_id
    from public.first_admin_bootstrap_state as s
   where s.singleton is true
   for update;

  if not found then
    raise exception 'First-admin signup state is missing; refusing owner-role migration.';
  end if;

  if v_migration_completed then
    return;
  end if;

  select r.id
    into v_owner_role_id
    from public.roles as r
   where r.slug = 'owner'
     and r.is_super_admin is true;

  select r.id
    into v_super_admin_role_id
    from public.roles as r
   where r.slug = 'super_admin'
     and r.is_super_admin is true;

  if v_owner_role_id is null or v_super_admin_role_id is null then
    raise exception 'The protected owner and super_admin roles are required before assignment migration.';
  end if;

  -- Prefer the first signup recorded by the existing trigger. On older projects
  -- whose state predates that ID, move only the oldest current super_admin
  -- assignment; never rewrite every role held by that user.
  select ur.user_id
    into v_user_id
    from public.user_roles as ur
   where ur.role_id = v_super_admin_role_id
   order by (ur.user_id = v_first_user_id) desc, ur.granted_at, ur.user_id
   limit 1
   for update;

  if v_user_id is not null then
    if exists (
      select 1
        from public.user_roles as ur
       where ur.user_id = v_user_id
         and ur.role_id = v_owner_role_id
    ) then
      delete from public.user_roles as ur
       where ur.user_id = v_user_id
         and ur.role_id = v_super_admin_role_id;
      get diagnostics v_rows_changed = row_count;

      if v_rows_changed > 0 then
        insert into public.audit_logs (
          actor_id, actor_type, actor_ref, action, entity, entity_id, metadata
        )
        values (
          null,
          'manual',
          session_user::text,
          'role.revoked'::public.audit_action,
          'user_roles',
          v_user_id::text,
          jsonb_build_object(
            'role_slugs', jsonb_build_array('super_admin'),
            'migration', '20261016120000_add_owner_role_and_grant_all_permissions.sql',
            'replacement_role', 'owner'
          )
        );
      end if;
    else
      update public.user_roles as ur
         set role_id = v_owner_role_id
       where ur.user_id = v_user_id
         and ur.role_id = v_super_admin_role_id;
      get diagnostics v_rows_changed = row_count;

      if v_rows_changed <> 1 then
        raise exception 'Could not transfer the existing super_admin assignment to owner.';
      end if;

      insert into public.audit_logs (
        actor_id, actor_type, actor_ref, action, entity, entity_id, metadata
      )
      values (
        null,
        'manual',
        session_user::text,
        'role.granted'::public.audit_action,
        'user_roles',
        v_user_id::text,
        jsonb_build_object(
          'role_slugs', jsonb_build_array('owner'),
          'target_user_id', v_user_id,
          'migration', '20261016120000_add_owner_role_and_grant_all_permissions.sql',
          'migrated_from', 'super_admin'
        )
      );
    end if;

    update public.first_admin_bootstrap_state
       set claimed = true,
           first_user_id = coalesce(first_user_id, v_user_id),
           claimed_at = coalesce(claimed_at, clock_timestamp()),
           owner_role_migration_completed = true
     where singleton is true;
  else
    update public.first_admin_bootstrap_state
       set owner_role_migration_completed = true
     where singleton is true;
  end if;
end;
$migrate_existing_first_admin_to_owner$;

-- Only an actually empty Auth table may claim the first signup. The durable
-- claimed bit prevents a later registration from being elevated after the
-- original account is removed. Counting is only needed in the unclaimed state.
create or replace function public.confirm_first_auth_user_email()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_claimed boolean;
  v_existing_auth_users bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended('admin_authority_invariant', 0));

  select s.claimed
    into v_claimed
    from public.first_admin_bootstrap_state as s
   where s.singleton is true
   for update;

  if not found then
    raise exception 'First-admin signup state is missing; refusing Auth signup.';
  end if;

  if not v_claimed then
    select count(*)
      into v_existing_auth_users
      from auth.users;

    if v_existing_auth_users = 0 then
      update public.first_admin_bootstrap_state
         set claimed = true,
             first_user_id = new.id,
             claimed_at = clock_timestamp()
       where singleton is true;

      new.email_confirmed_at := coalesce(new.email_confirmed_at, clock_timestamp());
    else
      -- Fail closed if an Auth user exists but the durable marker was cleared.
      update public.first_admin_bootstrap_state
         set claimed = true,
             first_user_id = null,
             claimed_at = coalesce(claimed_at, clock_timestamp())
       where singleton is true;
    end if;
  end if;

  return new;
end;
$$;

-- AFTER INSERT provisions the profile and role atomically. The first user must
-- still be the sole Auth row at grant time; all later users receive viewer.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_first_user_id uuid;
  v_auth_user_count bigint;
  v_role_id uuid;
  v_role_slug text;
  v_rows_inserted integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('admin_authority_invariant', 0));

  select s.first_user_id
    into v_first_user_id
    from public.first_admin_bootstrap_state as s
   where s.singleton is true
   for update;

  if not found then
    raise exception 'First-admin signup state is missing; refusing Auth signup.';
  end if;

  insert into public.profiles (id, email, full_name, avatar_url, status)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)),
    new.raw_user_meta_data ->> 'avatar_url',
    'active'
  )
  on conflict (id) do nothing;

  if v_first_user_id = new.id then
    select count(*)
      into v_auth_user_count
      from auth.users;

    if v_auth_user_count <> 1 then
      raise exception 'The first owner signup must be the only Auth user at grant time.';
    end if;

    if new.email_confirmed_at is null then
      raise exception 'The first Auth signup must have a confirmed email.';
    end if;

    select r.id
      into v_role_id
      from public.roles as r
     where r.slug = 'owner'
       and r.is_super_admin is true
       and exists (
         select 1 from public.permissions as p where p.slug = '*'
       )
       and not exists (
         select 1
           from public.permissions as p
          where not exists (
            select 1
              from public.role_permissions as rp
             where rp.role_id = r.id
               and rp.permission_id = p.id
          )
       );
    v_role_slug := 'owner';
  else
    select r.id
      into v_role_id
      from public.roles as r
     where r.slug = 'viewer'
       and r.is_super_admin is false;
    v_role_slug := 'viewer';
  end if;

  if v_role_id is null then
    raise exception 'Required signup role % is missing or incomplete.', v_role_slug;
  end if;

  insert into public.user_roles (user_id, role_id, granted_by)
  values (new.id, v_role_id, null)
  on conflict (user_id, role_id) do nothing;

  get diagnostics v_rows_inserted = row_count;
  if v_rows_inserted <> 1 then
    raise exception 'Signup role % was not newly assigned.', v_role_slug;
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
    'auth_signup_trigger',
    'auth.users.on_auth_user_created',
    'role.granted'::public.audit_action,
    'user_roles',
    new.id::text,
    jsonb_build_object(
      'role_slugs', jsonb_build_array(v_role_slug),
      'target_user_id', new.id,
      'assignment_source', 'auth.users.on_auth_user_created',
      'first_signup', v_first_user_id = new.id
    )
  );

  return new;
end;
$$;

revoke all on function public.confirm_first_auth_user_email()
  from public, anon, authenticated, service_role;
revoke all on function public.handle_new_user()
  from public, anon, authenticated, service_role;

drop trigger if exists on_auth_user_confirm_first_email on auth.users;
create trigger on_auth_user_confirm_first_email
  before insert on auth.users
  for each row execute function public.confirm_first_auth_user_email();

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

comment on function public.confirm_first_auth_user_email() is
  'Auth BEFORE INSERT trigger: only claims and confirms a first signup when auth.users was empty before insertion.';
comment on function public.handle_new_user() is
  'Auth AFTER INSERT trigger: first sole Auth user receives protected owner with all explicit permissions; later users receive viewer.';

-- Include protected owner accounts in the existing last-active-admin invariant.
create or replace function public.admin_set_user_status(
  p_user_id uuid,
  p_status public.user_status
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_target_status public.user_status;
  v_active_super_admin_count bigint;
  v_target_is_active_super_admin boolean;
begin
  perform pg_advisory_xact_lock(hashtextextended('admin_authority_invariant', 0));

  if v_actor is null or not public.is_admin() then
    raise exception 'admin_set_user_status: administrator privileges required'
      using errcode = '42501';
  end if;

  if p_user_id is null or p_status is null then
    raise exception 'admin_set_user_status: user id and status are required'
      using errcode = '22023';
  end if;

  if p_user_id = v_actor and p_status <> 'active' then
    raise exception 'admin_set_user_status: administrators cannot suspend themselves'
      using errcode = '42501';
  end if;

  lock table public.profiles,
             public.user_roles,
             public.roles,
             public.role_permissions
    in share row exclusive mode;

  select p.status
    into v_target_status
    from public.profiles as p
   where p.id = p_user_id
   for update;

  if not found then
    raise exception 'admin_set_user_status: user % not found', p_user_id
      using errcode = 'P0002';
  end if;

  select count(distinct p.id)
    into v_active_super_admin_count
    from public.profiles as p
    join public.user_roles as ur on ur.user_id = p.id
    join public.roles as r on r.id = ur.role_id
   where p.status = 'active'
     and r.is_super_admin;

  select exists (
    select 1
      from public.profiles as p
      join public.user_roles as ur on ur.user_id = p.id
      join public.roles as r on r.id = ur.role_id
     where p.id = p_user_id
       and p.status = 'active'
       and r.is_super_admin
  )
    into v_target_is_active_super_admin;

  if p_status = 'suspended'
     and v_active_super_admin_count = 1
     and v_target_is_active_super_admin then
    raise exception 'admin_set_user_status: last-admin-lockout — cannot suspend the only active protected administrator'
      using errcode = 'RBA02';
  end if;

  update public.profiles
     set status = p_status
   where id = p_user_id;

  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
  values (
    v_actor,
    case when p_status = 'suspended' then 'user.suspended'::public.audit_action
         else 'user.updated'::public.audit_action end,
    'profiles',
    p_user_id::text,
    jsonb_build_object('status', p_status, 'previous_status', v_target_status)
  );
end;
$$;

revoke all on function public.admin_set_user_status(uuid, public.user_status)
  from public, anon, service_role;
grant execute on function public.admin_set_user_status(uuid, public.user_status)
  to authenticated;

-- Fail closed on malformed or partially seeded databases and verify the
-- existing super_admin definition was not removed by this role addition.
do $assert_owner_role$
declare
  v_protected_roles integer;
  v_owner_roles integer;
  v_super_admin_roles integer;
  v_permission_count integer;
  v_owner_permission_count integer;
  v_owner_missing_count integer;
  v_owner_wildcard integer;
  v_super_admin_wildcard integer;
begin
  select count(*) into v_protected_roles
    from public.roles
   where is_super_admin is true;

  select count(*) into v_owner_roles
    from public.roles
   where slug = 'owner' and is_super_admin is true;

  select count(*) into v_super_admin_roles
    from public.roles
   where slug = 'super_admin' and is_super_admin is true;

  select count(*) into v_permission_count from public.permissions;

  select count(*) into v_owner_permission_count
    from public.role_permissions as rp
    join public.roles as r on r.id = rp.role_id
   where r.slug = 'owner';

  select count(*) into v_owner_missing_count
    from public.permissions as p
   where not exists (
     select 1
       from public.role_permissions as rp
       join public.roles as r on r.id = rp.role_id
      where r.slug = 'owner'
        and rp.permission_id = p.id
   );

  select count(*) into v_owner_wildcard
    from public.roles as r
    join public.role_permissions as rp on rp.role_id = r.id
    join public.permissions as p on p.id = rp.permission_id
   where r.slug = 'owner'
     and r.is_super_admin
     and p.slug = '*';

  select count(*) into v_super_admin_wildcard
    from public.roles as r
    join public.role_permissions as rp on rp.role_id = r.id
    join public.permissions as p on p.id = rp.permission_id
   where r.slug = 'super_admin'
     and r.is_super_admin
     and p.slug = '*';

  if v_protected_roles <> 2
     or v_owner_roles <> 1
     or v_super_admin_roles <> 1
     or v_owner_permission_count <> v_permission_count
     or v_owner_missing_count <> 0
     or v_owner_wildcard <> 1
     or v_super_admin_wildcard <> 1 then
    raise exception
      'Owner-role baseline incomplete: protected=%/2 owner=%/1 super_admin=%/1 permissions=% owner_grants=% owner_missing=% owner_wildcard=% super_admin_wildcard=%',
      v_protected_roles,
      v_owner_roles,
      v_super_admin_roles,
      v_permission_count,
      v_owner_permission_count,
      v_owner_missing_count,
      v_owner_wildcard,
      v_super_admin_wildcard;
  end if;
end;
$assert_owner_role$;

notify pgrst, 'reload schema';
