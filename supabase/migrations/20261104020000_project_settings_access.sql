-- Project Settings grants and dedicated, audited write path.
--
-- Existing RBAC tables, owner-protection triggers, app-identity RPCs and RLS
-- policies are not replaced. The legacy general-settings contract remains
-- intact; this migration adds the separate project.settings:manage surface.

-- Explicit default grants requested for both protected roles. The owner's
-- automatic all-permissions trigger is only one source of this grant; this
-- idempotent insert also repairs a missing explicit row and covers super_admin.
insert into public.role_permissions (role_id, permission_id)
select role.id, permission.id
  from public.roles as role
 cross join public.permissions as permission
 where role.slug in ('owner', 'super_admin')
   and permission.slug = 'project.settings:manage'
on conflict (role_id, permission_id) do nothing;

-- Display/storage gate for the dedicated project-settings surface.
create or replace function public.can_manage_project_settings()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce(public.is_active_user(), false)
     and coalesce(public.has_permission('project.settings:manage'), false);
$$;

revoke all on function public.can_manage_project_settings() from public, anon;
grant execute on function public.can_manage_project_settings() to authenticated, service_role;

-- The original INSERT-only branding policy remains unchanged. This additional
-- permissive policy lets a project-settings manager upload through the same
-- constrained bucket/prefix; it does not add UPDATE or DELETE access.
drop policy if exists branding_objects_project_settings_insert on storage.objects;
create policy branding_objects_project_settings_insert
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'public-branding'
    and name ~ '^identity/(logo|favicon)/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\.(png|jpe?g|webp|svg|ico)$'
    and public.can_manage_project_settings()
  );

-- app_identity_settings keeps ENABLE + FORCE RLS and no direct client UPDATE
-- grant. The following SECURITY DEFINER RPC is the project's only write path;
-- it repeats the established validation, object verification, optimistic lock,
-- and atomic audit insert rather than opening an unaudited table policy.

create or replace function public.admin_update_project_settings(
  p_name_ar text,
  p_name_en text,
  p_admin_email text default null,
  p_phone text default null,
  p_logo_path text default null,
  p_logo_hash text default null,
  p_favicon_path text default null,
  p_favicon_hash text default null,
  p_clear_logo boolean default false,
  p_clear_favicon boolean default false,
  p_expected_updated_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_row public.app_identity_settings%rowtype;
  v_name_ar text;
  v_name_en text;
  v_email text;
  v_phone text;
  v_logo_path text;
  v_logo_hash text;
  v_favicon_path text;
  v_favicon_hash text;
  v_object storage.objects%rowtype;
  v_mime text;
  v_changed text[] := array[]::text[];
  v_before jsonb;
  v_after jsonb;
begin
  if v_actor is null or not public.can_manage_project_settings() then
    raise exception 'admin_update_project_settings: administrator privileges required'
      using errcode = '42501';
  end if;

  if p_clear_logo and p_logo_path is not null then
    raise exception 'admin_update_project_settings: clear_logo conflicts with logo_path'
      using errcode = '22023';
  end if;
  if p_clear_favicon and p_favicon_path is not null then
    raise exception 'admin_update_project_settings: clear_favicon conflicts with favicon_path'
      using errcode = '22023';
  end if;
  if (p_logo_path is null) <> (p_logo_hash is null) then
    raise exception 'admin_update_project_settings: logo path and hash must be paired'
      using errcode = '22023';
  end if;
  if (p_favicon_path is null) <> (p_favicon_hash is null) then
    raise exception 'admin_update_project_settings: favicon path and hash must be paired'
      using errcode = '22023';
  end if;

  v_name_ar := btrim(coalesce(p_name_ar, ''));
  v_name_en := btrim(coalesce(p_name_en, ''));
  if char_length(v_name_ar) not between 2 and 80 or v_name_ar ~ '[[:cntrl:]]' then
    raise exception 'admin_update_project_settings: invalid name_ar'
      using errcode = '22023';
  end if;
  if char_length(v_name_en) not between 2 and 80 or v_name_en ~ '[[:cntrl:]]' then
    raise exception 'admin_update_project_settings: invalid name_en'
      using errcode = '22023';
  end if;

  v_email := nullif(btrim(coalesce(p_admin_email, '')), '');
  if v_email is not null then
    v_email := lower(v_email);
    if v_email !~* '^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$' then
      raise exception 'admin_update_project_settings: invalid admin_email'
        using errcode = '22023';
    end if;
  end if;

  v_phone := nullif(btrim(coalesce(p_phone, '')), '');
  if v_phone is not null and v_phone !~ '^\+[1-9][0-9]{7,14}$' then
    raise exception 'admin_update_project_settings: invalid phone'
      using errcode = '22023';
  end if;

  select *
    into v_row
    from public.app_identity_settings
   where id
   for update;

  if not found then
    raise exception 'admin_update_project_settings: singleton row missing'
      using errcode = 'P0002';
  end if;

  if p_expected_updated_at is not null and v_row.updated_at <> p_expected_updated_at then
    raise exception 'admin_update_project_settings: version-conflict'
      using errcode = 'BRD02';
  end if;

  v_logo_path := v_row.logo_path;
  v_logo_hash := v_row.logo_hash;
  v_favicon_path := v_row.favicon_path;
  v_favicon_hash := v_row.favicon_hash;

  if p_clear_logo then
    v_logo_path := null;
    v_logo_hash := null;
  elsif p_logo_path is not null then
    if p_logo_path !~ '^identity/logo/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\.(png|jpe?g|webp|svg|ico)$'
       or p_logo_hash !~ '^[0-9a-f]{64}$' then
      raise exception 'admin_update_project_settings: invalid logo asset'
        using errcode = 'BRD01';
    end if;

    select *
      into v_object
      from storage.objects
     where bucket_id = 'public-branding'
       and name = p_logo_path;

    if not found then
      raise exception 'admin_update_project_settings: logo object not found'
        using errcode = 'BRD01';
    end if;

    v_mime := coalesce(v_object.metadata ->> 'mimetype', v_object.metadata ->> 'mimeType');
    if v_mime is null or v_mime not in (
      'image/png', 'image/jpeg', 'image/webp', 'image/svg+xml',
      'image/x-icon', 'image/vnd.microsoft.icon'
    ) then
      raise exception 'admin_update_project_settings: logo mime is not allowed'
        using errcode = 'BRD01';
    end if;

    v_logo_path := p_logo_path;
    v_logo_hash := p_logo_hash;
  end if;

  if p_clear_favicon then
    v_favicon_path := null;
    v_favicon_hash := null;
  elsif p_favicon_path is not null then
    if p_favicon_path !~ '^identity/favicon/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\.(png|jpe?g|webp|svg|ico)$'
       or p_favicon_hash !~ '^[0-9a-f]{64}$' then
      raise exception 'admin_update_project_settings: invalid favicon asset'
        using errcode = 'BRD01';
    end if;

    select *
      into v_object
      from storage.objects
     where bucket_id = 'public-branding'
       and name = p_favicon_path;

    if not found then
      raise exception 'admin_update_project_settings: favicon object not found'
        using errcode = 'BRD01';
    end if;

    v_mime := coalesce(v_object.metadata ->> 'mimetype', v_object.metadata ->> 'mimeType');
    if v_mime is null or v_mime not in (
      'image/png', 'image/jpeg', 'image/webp', 'image/svg+xml',
      'image/x-icon', 'image/vnd.microsoft.icon'
    ) then
      raise exception 'admin_update_project_settings: favicon mime is not allowed'
        using errcode = 'BRD01';
    end if;

    v_favicon_path := p_favicon_path;
    v_favicon_hash := p_favicon_hash;
  end if;

  if v_name_ar is distinct from v_row.name_ar then
    v_changed := array_append(v_changed, 'name_ar');
  end if;
  if v_name_en is distinct from v_row.name_en then
    v_changed := array_append(v_changed, 'name_en');
  end if;
  if v_email is distinct from v_row.admin_email then
    v_changed := array_append(v_changed, 'admin_email');
  end if;
  if v_phone is distinct from v_row.phone then
    v_changed := array_append(v_changed, 'phone');
  end if;
  if v_logo_path is distinct from v_row.logo_path then
    v_changed := array_append(v_changed, 'logo_path');
  end if;
  if v_favicon_path is distinct from v_row.favicon_path then
    v_changed := array_append(v_changed, 'favicon_path');
  end if;

  if cardinality(v_changed) = 0 then
    return to_jsonb(v_row);
  end if;

  v_before := jsonb_build_object(
    'name_ar', v_row.name_ar,
    'name_en', v_row.name_en,
    'admin_email', v_row.admin_email,
    'phone', v_row.phone,
    'logo_path', v_row.logo_path,
    'logo_hash', v_row.logo_hash,
    'favicon_path', v_row.favicon_path,
    'favicon_hash', v_row.favicon_hash,
    'assets_revision', v_row.assets_revision
  );

  update public.app_identity_settings
     set name_ar = v_name_ar,
         name_en = v_name_en,
         admin_email = v_email,
         phone = v_phone,
         logo_path = v_logo_path,
         logo_hash = v_logo_hash,
         favicon_path = v_favicon_path,
         favicon_hash = v_favicon_hash,
         assets_revision = v_row.assets_revision + 1,
         updated_by = v_actor
   where id
  returning * into v_row;

  v_after := jsonb_build_object(
    'name_ar', v_row.name_ar,
    'name_en', v_row.name_en,
    'admin_email', v_row.admin_email,
    'phone', v_row.phone,
    'logo_path', v_row.logo_path,
    'logo_hash', v_row.logo_hash,
    'favicon_path', v_row.favicon_path,
    'favicon_hash', v_row.favicon_hash,
    'assets_revision', v_row.assets_revision
  );

  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
  values (
    v_actor,
    'settings.updated',
    'app_identity_settings',
    'singleton',
    jsonb_build_object(
      'event', 'project.settings_updated',
      'changed_fields', to_jsonb(v_changed),
      'before', v_before,
      'after', v_after
    )
  );

  return to_jsonb(v_row);
end;
$$;

revoke all on function public.admin_update_project_settings(
  text, text, text, text, text, text, text, text, boolean, boolean, timestamptz
) from public, anon, service_role;
grant execute on function public.admin_update_project_settings(
  text, text, text, text, text, text, text, text, boolean, boolean, timestamptz
) to authenticated;


do $verify_project_settings_grants$
begin
  if not exists (
    select 1 from public.permissions where slug = 'project.settings:manage'
  ) then
    raise exception 'Project settings permission is missing';
  end if;

  if exists (
    select 1
      from public.roles as role
     where role.slug in ('owner', 'super_admin')
       and not exists (
         select 1
           from public.role_permissions as rp
           join public.permissions as permission on permission.id = rp.permission_id
          where rp.role_id = role.id
            and permission.slug = 'project.settings:manage'
       )
  ) then
    raise exception 'Project settings default role grants are incomplete';
  end if;
end;
$verify_project_settings_grants$;

notify pgrst, 'reload schema';
