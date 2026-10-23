-- General & Branding Settings (screen 5 of 7).
--
--   * Typed singleton public.app_identity_settings (NOT the KV public.app_settings).
--   * Public-read storage bucket public-branding with INSERT-only writes under
--     identity/{logo|favicon}/{uuid}.{ext} — no UPDATE/DELETE from clients.
--   * SECURITY DEFINER RPC admin_update_app_identity is the sole write path.
--   * Realtime publication is an invalidation signal for every consumer
--     (login, sidebar, document title / favicon) — not a delta patcher.

-- ---------------------------------------------------------------------------
-- 1) Authorization helper
-- ---------------------------------------------------------------------------
create or replace function public.can_manage_app_identity()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce(public.is_active_user(), false)
     and (
       coalesce(public.is_admin(), false)
       or coalesce(public.has_permission('settings.manage'), false)
     );
$$;

revoke all on function public.can_manage_app_identity() from public, anon;
grant execute on function public.can_manage_app_identity() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2) Singleton identity row
-- ---------------------------------------------------------------------------
create table if not exists public.app_identity_settings (
  id boolean primary key default true check (id),
  name_ar text not null
    check (char_length(btrim(name_ar)) between 2 and 80 and name_ar !~ '[[:cntrl:]]'),
  name_en text not null
    check (char_length(btrim(name_en)) between 2 and 80 and name_en !~ '[[:cntrl:]]'),
  admin_email text
    check (
      admin_email is null
      or admin_email ~* '^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$'
    ),
  phone text
    check (phone is null or phone ~ '^\+[1-9][0-9]{7,14}$'),
  logo_path text
    check (
      logo_path is null
      or logo_path ~ '^identity/logo/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\.(png|jpe?g|webp|svg|ico)$'
    ),
  logo_hash text
    check (logo_hash is null or logo_hash ~ '^[0-9a-f]{64}$'),
  favicon_path text
    check (
      favicon_path is null
      or favicon_path ~ '^identity/favicon/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\.(png|jpe?g|webp|svg|ico)$'
    ),
  favicon_hash text
    check (favicon_hash is null or favicon_hash ~ '^[0-9a-f]{64}$'),
  assets_revision integer not null default 1 check (assets_revision >= 1),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles (id) on delete set null,
  constraint app_identity_logo_hash_matches_path check (
    (logo_path is null) = (logo_hash is null)
  ),
  constraint app_identity_favicon_hash_matches_path check (
    (favicon_path is null) = (favicon_hash is null)
  )
);

insert into public.app_identity_settings (id, name_ar, name_en, admin_email)
values (true, 'نظام الإدارة', 'Admin System', 'support@example.com')
on conflict (id) do nothing;

drop trigger if exists app_identity_settings_set_updated_at on public.app_identity_settings;
create trigger app_identity_settings_set_updated_at
  before update on public.app_identity_settings
  for each row execute function public.set_updated_at();

alter table public.app_identity_settings enable row level security;
alter table public.app_identity_settings force row level security;

revoke all on table public.app_identity_settings from public, anon, authenticated, service_role;
grant select on table public.app_identity_settings to anon, authenticated, service_role;

drop policy if exists app_identity_public_read on public.app_identity_settings;
create policy app_identity_public_read
  on public.app_identity_settings
  for select
  to anon, authenticated
  using (true);

-- No INSERT / UPDATE / DELETE policies: the seeded row is immortal and the
-- SECURITY DEFINER RPC is the only sanctioned writer.

-- ---------------------------------------------------------------------------
-- 3) Public branding bucket (read: anyone, write: INSERT identity/* only)
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'public-branding',
  'public-branding',
  true,
  524288,
  array[
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/svg+xml',
    'image/x-icon',
    'image/vnd.microsoft.icon'
  ]
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- The backup migration revoked INSERT/UPDATE/DELETE on storage.objects from
-- API roles. Re-grant INSERT only; RLS below refuses every bucket except
-- public-branding, and refuses every path except a unique identity/* object.
grant usage on schema storage to anon, authenticated;
grant select on table storage.objects to anon, authenticated;
grant insert on table storage.objects to authenticated;

drop policy if exists branding_objects_public_read on storage.objects;
create policy branding_objects_public_read
  on storage.objects
  for select
  to anon, authenticated
  using (bucket_id = 'public-branding');

drop policy if exists branding_objects_authenticated_insert on storage.objects;
create policy branding_objects_authenticated_insert
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'public-branding'
    and name ~ '^identity/(logo|favicon)/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\.(png|jpe?g|webp|svg|ico)$'
    and public.can_manage_app_identity()
  );

-- Deliberately no UPDATE or DELETE policies on this bucket.

-- ---------------------------------------------------------------------------
-- 4) Atomic write RPC
-- ---------------------------------------------------------------------------
create or replace function public.admin_update_app_identity(
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
  if v_actor is null or not public.can_manage_app_identity() then
    raise exception 'admin_update_app_identity: administrator privileges required'
      using errcode = '42501';
  end if;

  if p_clear_logo and p_logo_path is not null then
    raise exception 'admin_update_app_identity: clear_logo conflicts with logo_path'
      using errcode = '22023';
  end if;
  if p_clear_favicon and p_favicon_path is not null then
    raise exception 'admin_update_app_identity: clear_favicon conflicts with favicon_path'
      using errcode = '22023';
  end if;
  if (p_logo_path is null) <> (p_logo_hash is null) then
    raise exception 'admin_update_app_identity: logo path and hash must be paired'
      using errcode = '22023';
  end if;
  if (p_favicon_path is null) <> (p_favicon_hash is null) then
    raise exception 'admin_update_app_identity: favicon path and hash must be paired'
      using errcode = '22023';
  end if;

  v_name_ar := btrim(coalesce(p_name_ar, ''));
  v_name_en := btrim(coalesce(p_name_en, ''));
  if char_length(v_name_ar) not between 2 and 80 or v_name_ar ~ '[[:cntrl:]]' then
    raise exception 'admin_update_app_identity: invalid name_ar'
      using errcode = '22023';
  end if;
  if char_length(v_name_en) not between 2 and 80 or v_name_en ~ '[[:cntrl:]]' then
    raise exception 'admin_update_app_identity: invalid name_en'
      using errcode = '22023';
  end if;

  v_email := nullif(btrim(coalesce(p_admin_email, '')), '');
  if v_email is not null then
    v_email := lower(v_email);
    if v_email !~* '^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$' then
      raise exception 'admin_update_app_identity: invalid admin_email'
        using errcode = '22023';
    end if;
  end if;

  v_phone := nullif(btrim(coalesce(p_phone, '')), '');
  if v_phone is not null and v_phone !~ '^\+[1-9][0-9]{7,14}$' then
    raise exception 'admin_update_app_identity: invalid phone'
      using errcode = '22023';
  end if;

  select *
    into v_row
    from public.app_identity_settings
   where id
   for update;

  if not found then
    raise exception 'admin_update_app_identity: singleton row missing'
      using errcode = 'P0002';
  end if;

  if p_expected_updated_at is not null and v_row.updated_at <> p_expected_updated_at then
    raise exception 'admin_update_app_identity: version-conflict'
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
      raise exception 'admin_update_app_identity: invalid logo asset'
        using errcode = 'BRD01';
    end if;

    select *
      into v_object
      from storage.objects
     where bucket_id = 'public-branding'
       and name = p_logo_path;

    if not found then
      raise exception 'admin_update_app_identity: logo object not found'
        using errcode = 'BRD01';
    end if;

    v_mime := coalesce(v_object.metadata ->> 'mimetype', v_object.metadata ->> 'mimeType');
    if v_mime is null or v_mime not in (
      'image/png', 'image/jpeg', 'image/webp', 'image/svg+xml',
      'image/x-icon', 'image/vnd.microsoft.icon'
    ) then
      raise exception 'admin_update_app_identity: logo mime is not allowed'
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
      raise exception 'admin_update_app_identity: invalid favicon asset'
        using errcode = 'BRD01';
    end if;

    select *
      into v_object
      from storage.objects
     where bucket_id = 'public-branding'
       and name = p_favicon_path;

    if not found then
      raise exception 'admin_update_app_identity: favicon object not found'
        using errcode = 'BRD01';
    end if;

    v_mime := coalesce(v_object.metadata ->> 'mimetype', v_object.metadata ->> 'mimeType');
    if v_mime is null or v_mime not in (
      'image/png', 'image/jpeg', 'image/webp', 'image/svg+xml',
      'image/x-icon', 'image/vnd.microsoft.icon'
    ) then
      raise exception 'admin_update_app_identity: favicon mime is not allowed'
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
      'changed_fields', to_jsonb(v_changed),
      'before', v_before,
      'after', v_after
    )
  );

  return to_jsonb(v_row);
end;
$$;

revoke all on function public.admin_update_app_identity(
  text, text, text, text, text, text, text, text, boolean, boolean, timestamptz
) from public, anon, service_role;
grant execute on function public.admin_update_app_identity(
  text, text, text, text, text, text, text, text, boolean, boolean, timestamptz
) to authenticated;

-- ---------------------------------------------------------------------------
-- 5) Realtime (invalidation signal only)
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1
      from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'app_identity_settings'
  ) then
    alter publication supabase_realtime add table public.app_identity_settings;
  end if;
end;
$$;
